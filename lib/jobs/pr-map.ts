// The PR map builder (DESIGN.md §6.4) — turns one diff into a small card
// diagram: changed files grouped by the role they play in the change, and
// labelled edges between the groups.
//
// Two layers:
//   1. `loadPrMapInput` — the only Neo4j-touching part: which component owns
//      each changed file, and the `IMPORTS` edges into and out of the changed
//      files (one hop, so untouched neighbours can show up as context cards).
//   2. Everything else is pure. Files are classified by path (code / test /
//      dependency / config / docs), file-level *links* are collected once
//      (imports, "test covers its module", "code uses a dependency whose
//      manifest changed"), and `assemblePrMap` aggregates those links over
//      whatever grouping it is handed. The heuristic grouping and the AI
//      regrouping (lib/ai/pr-map.ts) both go through it, which is what stops
//      the model from inventing a relationship: it can only name edges the
//      links already justify.
//
// Server-only because of layer 1; the pure half is exported for the review
// job and for tests.

import path from "node:path";
import { listPrMapComponents, listPrMapImports } from "@/lib/neo4j";
import type {
  PrMapEdgeDTO,
  PrMapFileDTO,
  PrMapNodeDTO,
  PrMapRole,
} from "@/components/graph/pr-map-types";
import { matchFilesToComponents } from "./diff-components";

/** A changed file as every diff source reports it (a `LocalFilePatch` fits). */
export interface PrMapChangedFile extends PrMapFileDTO {
  /** Unified diff text, when the source has it — used to spot dependency usage. */
  patch?: string;
}

/** One `IMPORTS` edge with at least one changed endpoint, plus both endpoints' owning components. */
export interface PrMapImportRow {
  from: string;
  to: string;
  fromComponentId?: string;
  toComponentId?: string;
}

export interface PrMapComponentInfo {
  id: string;
  name: string;
  description?: string;
}

export interface PrMapInput {
  files: PrMapChangedFile[];
  /** Changed path → owning component id (only for files the analysis knows). */
  componentIdByPath: Map<string, string>;
  /** Every component that owns a changed file or sits one import away from one. */
  components: Map<string, PrMapComponentInfo>;
  imports: PrMapImportRow[];
}

/** The roles a changed file can have — every `PrMapRole` except `context`. */
export type PrMapFileRole = Exclude<PrMapRole, "context">;

type Endpoint = { file: string } | { component: string };

export interface PrMapLink {
  from: Endpoint;
  to: Endpoint;
  kind: "import" | "covers" | "uses";
}

/** A grouping of changed files — what `assemblePrMap` turns into cards. */
export interface PrMapGroup {
  id: string;
  name: string;
  description?: string;
  /** Derived from the files when absent. */
  role?: PrMapFileRole;
  files: string[];
}

/** Most context cards a map ever shows. */
const MAX_CONTEXT_NODES = 6;
/** Context cards stop being added once the map has this many cards of its own. */
const CONTEXT_CARD_CEILING = 14;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "bun.lockb",
  "bun.lock",
  "go.mod",
  "go.sum",
  "go.work",
  "cargo.toml",
  "cargo.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.lockfile",
  "libs.versions.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "pipfile",
  "pipfile.lock",
  "setup.py",
  "setup.cfg",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "packages.lock.json",
  "directory.packages.props",
  "mix.exs",
  "mix.lock",
  "pubspec.yaml",
  "pubspec.lock",
]);

const TEST_DIR = /(^|\/)(__tests__|__mocks__|tests?|specs?|testdata|e2e)\//i;
const TEST_FILE =
  /(\.(test|spec|e2e)\.[^./]+$)|(_test\.(go|py|rb|exs?)$)|(^test_[^/]+\.py$)|((Test|Tests|Spec|IT)\.(java|kt|kts|cs|scala|swift)$)/;
const DOC_EXT = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const DOC_FILES = /^(license|licence|notice|authors|contributors|changelog|codeowners)(\.[^/]*)?$/i;
const CONFIG_DIR = /(^|\/)(\.github|\.gitlab|\.circleci|\.husky|\.vscode|\.devcontainer|docker)\//;
const CONFIG_FILE =
  /(^dockerfile)|(^docker-compose[^/]*\.ya?ml$)|(^compose[^/]*\.ya?ml$)|(^makefile$)|(^tsconfig[^/]*\.json$)|(^jsconfig[^/]*\.json$)|(\.config\.[cm]?[jt]s$)|(^\.[^/]+$)|(\.(ya?ml|toml|ini|cfg|conf|env)$)/i;

/** Which role a changed file plays, from its path alone. */
export function classifyPath(filePath: string): PrMapFileRole {
  const base = path.posix.basename(filePath);
  const lower = base.toLowerCase();
  if (DEPENDENCY_FILES.has(lower) || lower.endsWith(".csproj")) return "dependency";
  if (TEST_FILE.test(base) || TEST_DIR.test(filePath)) return "test";
  if (DOC_EXT.test(base) || DOC_FILES.test(base) || /(^|\/)docs?\//.test(filePath)) {
    // A `docs/` folder can hold a docs *site's* code — only prose counts.
    return DOC_EXT.test(base) || DOC_FILES.test(base) ? "docs" : "code";
  }
  if (CONFIG_DIR.test(filePath) || CONFIG_FILE.test(base)) return "config";
  return "code";
}

// ---------------------------------------------------------------------------
// Dependency usage: which packages a manifest diff changed, and which code
// diffs import them
// ---------------------------------------------------------------------------

function changedLines(patch: string | undefined): string[] {
  if (!patch) return [];
  return patch
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---"))
    .map((line) => line.slice(1));
}

const VERSION_LIKE = /^(\^|~|>|<|=|\*|\d|workspace:|npm:|file:|link:|git|github:|latest$|next$)/;

/** Package names added, removed or re-versioned by one manifest's diff. Lockfiles contribute nothing — they name every transitive package. */
export function changedPackages(filePath: string, patch: string | undefined): string[] {
  const base = path.posix.basename(filePath).toLowerCase();
  const names = new Set<string>();
  for (const line of changedLines(patch)) {
    let match: RegExpExecArray | null = null;
    if (base === "package.json" || base === "composer.json") {
      match = /^\s*"(@?[\w.-]+(?:\/[\w.-]+)?)"\s*:\s*"([^"]*)"/.exec(line);
      if (match && !VERSION_LIKE.test(match[2])) match = null;
    } else if (base === "go.mod") {
      match = /^\s*(?:require\s+)?([\w.-]+\.[\w-]+\/[\w./-]+)\s+v\d/.exec(line);
    } else if (base === "cargo.toml") {
      match = /^\s*([\w-]+)\s*=\s*(?:"[\d^~*=<>]|\{)/.exec(line);
    } else if (base.startsWith("requirements")) {
      match = /^\s*([A-Za-z0-9][\w.-]*)\s*(?:\[[^\]]*\])?\s*(?:[=<>~!]=|[<>]|$)/.exec(line);
    } else if (base === "pyproject.toml") {
      match = /^\s*"([A-Za-z0-9][\w.-]*)\s*(?:\[[^\]]*\])?\s*[=<>~!]/.exec(line);
    } else if (base === "gemfile") {
      match = /^\s*gem\s+["']([\w.-]+)["']/.exec(line);
    }
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

const DECLARATION =
  /^\s*(export\s|public\s|protected\s|private\s|internal\s|pub\s|func\s|def\s|fn\s|class\s|interface\s|type\s|struct\s|enum\s|trait\s|impl\s|async\s+function\s|function\s|const\s+\w+\s*=\s*(async\s*)?\()/;

/** Up to `max` changed declaration lines of a diff (`+`/`-` kept) — the AI pass's hint at what a file does. */
export function patchHighlights(patch: string | undefined, max = 6): string[] {
  if (!patch || max <= 0) return [];
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    if (!/^[+-]/.test(line) || line.startsWith("+++") || line.startsWith("---")) continue;
    if (!DECLARATION.test(line.slice(1))) continue;
    out.push(`${line[0]} ${line.slice(1).trim()}`);
    if (out.length >= max) break;
  }
  return out;
}

const IMPORT_HINT =/\b(import|require|from|use|using|extern crate|include)\b/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a code diff's changed lines import `pkg` (or a subpath of it). */
function patchUsesPackage(patch: string | undefined, pkg: string): boolean {
  const variants = new Set([pkg, pkg.replace(/-/g, "_")]);
  const patterns = [...variants].map(
    (name) => new RegExp(`(^|[\\s"'\`(<,:])${escapeRegExp(name)}($|[\\s"'\`/)>;,.:])`)
  );
  return changedLines(patch).some(
    (line) => IMPORT_HINT.test(line) && patterns.some((re) => re.test(line))
  );
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Every file-level relationship the diff justifies:
 *   - `import` — an `IMPORTS` edge from or to a changed file. The far end is
 *     the changed file itself, or else its owning component (which becomes an
 *     edge to the card holding that component, or a context card);
 *   - `covers` — a changed test file whose module also has changed code;
 *   - `uses`   — a changed code line importing a package whose manifest
 *     entry this diff also changed.
 */
export function collectPrMapLinks(input: PrMapInput): PrMapLink[] {
  const changed = new Map(input.files.map((file) => [file.path, file]));
  const links: PrMapLink[] = [];
  const seen = new Set<string>();
  const push = (link: PrMapLink): void => {
    const key = JSON.stringify(link);
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };
  const endpoint = (filePath: string, componentId: string | undefined): Endpoint | null => {
    if (changed.has(filePath)) return { file: filePath };
    return componentId ? { component: componentId } : null;
  };

  for (const row of input.imports) {
    if (row.from === row.to) continue;
    const from = endpoint(row.from, row.fromComponentId);
    const to = endpoint(row.to, row.toComponentId);
    if (!from || !to) continue;
    if (!("file" in from) && !("file" in to)) continue;
    push({ from, to, kind: "import" });
  }

  const roles = new Map(input.files.map((file) => [file.path, classifyPath(file.path)]));
  const componentsWithCode = new Set<string>();
  for (const file of input.files) {
    const owner = input.componentIdByPath.get(file.path);
    if (owner && roles.get(file.path) === "code") componentsWithCode.add(owner);
  }
  // A test that already imports changed code has its edge; only a test with
  // no such import gets the inferred "covers its own module" link.
  const testsWithImports = new Set(
    links
      .filter((link) => "file" in link.from && "file" in link.to)
      .map((link) => (link.from as { file: string }).file)
      .filter((p) => roles.get(p) === "test")
  );
  for (const file of input.files) {
    if (roles.get(file.path) !== "test" || testsWithImports.has(file.path)) continue;
    const owner = input.componentIdByPath.get(file.path);
    if (owner && componentsWithCode.has(owner)) {
      push({ from: { file: file.path }, to: { component: owner }, kind: "covers" });
    }
  }

  const manifests = input.files
    .filter((file) => roles.get(file.path) === "dependency")
    .map((file) => ({ path: file.path, packages: changedPackages(file.path, file.patch) }))
    .filter((manifest) => manifest.packages.length > 0);
  if (manifests.length > 0) {
    for (const file of input.files) {
      if (roles.get(file.path) !== "code" || !file.patch) continue;
      for (const manifest of manifests) {
        if (manifest.packages.some((pkg) => patchUsesPackage(file.patch, pkg))) {
          push({ from: { file: file.path }, to: { file: manifest.path }, kind: "uses" });
        }
      }
    }
  }

  return links;
}

// ---------------------------------------------------------------------------
// Heuristic grouping
// ---------------------------------------------------------------------------

function folderKey(filePath: string): string {
  const dirs = filePath.split("/").slice(0, -1);
  return dirs.length === 0 ? "(root)" : dirs.slice(0, 2).join("/");
}

/**
 * The grouping that needs no model: one card per owning component for code
 * and for tests, one per top folder for files the analysis doesn't know yet,
 * and one each for dependencies, config and docs.
 */
export function heuristicPrMapGroups(input: PrMapInput): PrMapGroup[] {
  const groups = new Map<string, PrMapGroup>();
  const add = (id: string, init: () => Omit<PrMapGroup, "id" | "files">, filePath: string): void => {
    const group = groups.get(id);
    if (group) group.files.push(filePath);
    else groups.set(id, { id, ...init(), files: [filePath] });
  };
  const componentName = (id: string): string => input.components.get(id)?.name ?? id;

  const packages = new Set<string>();
  for (const file of input.files) {
    const role = classifyPath(file.path);
    const owner = input.componentIdByPath.get(file.path);
    if (role === "dependency") {
      for (const pkg of changedPackages(file.path, file.patch)) packages.add(pkg);
      add("dep", () => ({ name: "Dependencies", role }), file.path);
    } else if (role === "config") {
      add("config", () => ({ name: "Build & config", description: "Tooling, CI and runtime configuration", role }), file.path);
    } else if (role === "docs") {
      add("docs", () => ({ name: "Documentation", description: "Docs and other prose", role }), file.path);
    } else if (role === "test") {
      const key = owner ?? folderKey(file.path);
      add(
        `test:${key}`,
        () => ({
          name: owner ? `${componentName(owner)} tests` : `Tests (${key})`,
          description: "Tests changed alongside the code",
          role,
        }),
        file.path
      );
    } else if (owner) {
      add(
        `code:${owner}`,
        () => ({ name: componentName(owner), description: input.components.get(owner)?.description, role }),
        file.path
      );
    } else {
      const key = folderKey(file.path);
      add(
        `new:${key}`,
        () => ({ name: key, description: "Not in the analyzed graph yet", role }),
        file.path
      );
    }
  }

  const dep = groups.get("dep");
  if (dep) {
    const list = [...packages];
    dep.description =
      list.length === 0
        ? "Package manifests and lockfiles"
        : `Changes ${list.slice(0, 3).join(", ")}${list.length > 3 ? ` +${list.length - 3} more` : ""}`;
  }

  // New files that all landed in one folder read better named as such.
  for (const group of groups.values()) {
    if (!group.id.startsWith("new:")) continue;
    const statuses = new Set(group.files.map((p) => input.files.find((f) => f.path === p)?.status));
    if (statuses.size === 1 && statuses.has("added")) group.description = "New files";
  }

  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const ROLE_ORDER: PrMapRole[] = ["code", "test", "dependency", "config", "docs", "context"];

function dominantRole(files: string[]): PrMapFileRole {
  const counts = new Map<PrMapFileRole, number>();
  for (const file of files) {
    const role = classifyPath(file);
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  let best: PrMapFileRole = "code";
  let bestCount = -1;
  for (const role of ROLE_ORDER) {
    if (role === "context") continue;
    const count = counts.get(role) ?? 0;
    if (count > bestCount) {
      best = role;
      bestCount = count;
    }
  }
  return best;
}

function edgeLabel(link: PrMapLink, sourceRole: PrMapRole, targetRole: PrMapRole): string {
  if (link.kind === "covers" || sourceRole === "test") return "covers";
  if (link.kind === "uses" || targetRole === "dependency") return "uses";
  return "imports";
}

/** `"source name→target name"`, lower-cased — how AI-chosen edge labels are looked up. */
export function edgeLabelKey(sourceName: string, targetName: string): string {
  return `${sourceName.trim().toLowerCase()}→${targetName.trim().toLowerCase()}`;
}

export interface AssembleOptions {
  /** Edge labels by {@link edgeLabelKey}; an edge with no entry keeps its heuristic verb. */
  edgeLabels?: Map<string, string>;
}

/**
 * Cards and edges for one grouping of the changed files. Files missing from
 * `groups` are dropped; a file listed twice stays in its first group.
 */
export function assemblePrMap(
  input: PrMapInput,
  links: PrMapLink[],
  groups: PrMapGroup[],
  options: AssembleOptions = {}
): { nodes: PrMapNodeDTO[]; edges: PrMapEdgeDTO[] } {
  const fileByPath = new Map(input.files.map((file) => [file.path, file]));
  const nodeOfFile = new Map<string, string>();
  const nodes: PrMapNodeDTO[] = [];

  for (const group of groups) {
    const files = group.files.filter((p) => fileByPath.has(p) && !nodeOfFile.has(p));
    if (files.length === 0) continue;
    for (const p of files) nodeOfFile.set(p, group.id);
    const ownerCounts = new Map<string, number>();
    for (const p of files) {
      const owner = input.componentIdByPath.get(p);
      if (owner) ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
    }
    nodes.push({
      id: group.id,
      name: group.name,
      description: group.description || undefined,
      role: group.role ?? dominantRole(files),
      componentIds: [...ownerCounts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id),
      files: files
        .map((p) => {
          const { path: filePath, status, additions, deletions } = fileByPath.get(p)!;
          return { path: filePath, status, additions, deletions };
        })
        .sort((a, b) => a.path.localeCompare(b.path)),
    });
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  // A component endpoint lands on the card holding most of that component's
  // changed code; failing that, any card holding its files.
  const nodeOfComponent = new Map<string, string>();
  for (const role of ["code", undefined] as const) {
    for (const node of nodes) {
      if (role && node.role !== role) continue;
      for (const id of node.componentIds) {
        if (!nodeOfComponent.has(id)) nodeOfComponent.set(id, node.id);
      }
    }
  }

  const resolve = (end: Endpoint): { node?: string; context?: string } => {
    if ("file" in end) return { node: nodeOfFile.get(end.file) };
    const node = nodeOfComponent.get(end.component);
    return node ? { node } : { context: end.component };
  };

  type Pending = { source: string; target: string; link: PrMapLink; weight: number };
  const pending = new Map<string, Pending>();
  const contextWeight = new Map<string, number>();
  const contextLinks: Array<{ source: string; target: string; link: PrMapLink }> = [];

  for (const link of links) {
    const from = resolve(link.from);
    const to = resolve(link.to);
    if (from.node && to.node) {
      if (from.node === to.node) continue;
      const key = `${from.node}\u0000${to.node}`;
      const entry = pending.get(key);
      if (entry) entry.weight += 1;
      else pending.set(key, { source: from.node, target: to.node, link, weight: 1 });
      continue;
    }
    // Context: only code cards reach out to untouched modules — a test's
    // fixtures or a config file's imports are not what the change sits next to.
    const own = from.node ?? to.node;
    const other = from.context ?? to.context;
    if (!own || !other || nodeById.get(own)?.role !== "code") continue;
    if (!input.components.has(other)) continue;
    contextWeight.set(other, (contextWeight.get(other) ?? 0) + 1);
    contextLinks.push(
      from.node
        ? { source: own, target: `ctx:${other}`, link }
        : { source: `ctx:${other}`, target: own, link }
    );
  }

  const contextBudget = Math.min(MAX_CONTEXT_NODES, Math.max(0, CONTEXT_CARD_CEILING - nodes.length));
  const chosenContext = [...contextWeight.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1] ||
        (input.components.get(a[0])?.name ?? "").localeCompare(input.components.get(b[0])?.name ?? "")
    )
    .slice(0, contextBudget)
    .map(([id]) => id);
  for (const id of chosenContext) {
    const info = input.components.get(id)!;
    const node: PrMapNodeDTO = {
      id: `ctx:${id}`,
      name: info.name,
      description: info.description,
      role: "context",
      componentIds: [id],
      files: [],
    };
    nodes.push(node);
    nodeById.set(node.id, node);
  }
  for (const { source, target, link } of contextLinks) {
    if (!nodeById.has(source) || !nodeById.has(target)) continue;
    const key = `${source}\u0000${target}`;
    const entry = pending.get(key);
    if (entry) entry.weight += 1;
    else pending.set(key, { source, target, link, weight: 1 });
  }

  const edges: PrMapEdgeDTO[] = [];
  for (const { source, target, link, weight } of pending.values()) {
    const sourceNode = nodeById.get(source)!;
    const targetNode = nodeById.get(target)!;
    const custom =
      options.edgeLabels?.get(edgeLabelKey(sourceNode.name, targetNode.name)) ??
      options.edgeLabels?.get(edgeLabelKey(targetNode.name, sourceNode.name));
    edges.push({
      source,
      target,
      label: custom ?? edgeLabel(link, sourceNode.role, targetNode.role),
      weight,
    });
  }

  nodes.sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name)
  );
  edges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  return { nodes, edges };
}

/** The map that needs no model — what the API serves until an AI map exists. */
export function buildHeuristicPrMap(input: PrMapInput): { nodes: PrMapNodeDTO[]; edges: PrMapEdgeDTO[] } {
  return assemblePrMap(input, collectPrMapLinks(input), heuristicPrMapGroups(input));
}

/** An AI grouping as lib/ai/pr-map.ts returns it and lib/neo4j stores it. */
export interface PrMapAiGrouping {
  groups: Array<{ name: string; description?: string; files: string[] }>;
  edgeLabels: Array<{ from: string; to: string; label: string }>;
}

/**
 * The map for an AI grouping. Any changed file the grouping doesn't place
 * keeps its heuristic card, so a partial answer still shows every file.
 */
export function applyPrMapGrouping(
  input: PrMapInput,
  links: PrMapLink[],
  grouping: PrMapAiGrouping
): { nodes: PrMapNodeDTO[]; edges: PrMapEdgeDTO[] } {
  const groups: PrMapGroup[] = grouping.groups.map((group, index) => ({
    id: `ai:${index}`,
    name: group.name,
    description: group.description,
    files: group.files,
  }));
  const placed = new Set(groups.flatMap((group) => group.files));
  const leftovers = heuristicPrMapGroups({
    ...input,
    files: input.files.filter((file) => !placed.has(file.path)),
  });
  const edgeLabels = new Map(
    grouping.edgeLabels.map((edge) => [edgeLabelKey(edge.from, edge.to), edge.label])
  );
  return assemblePrMap(input, links, [...groups, ...leftovers], { edgeLabels });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Resolves the changed files against the stored graph: owners, one-hop imports, and the names of every component involved. */
export async function loadPrMapInput(
  repoId: string,
  files: PrMapChangedFile[]
): Promise<PrMapInput> {
  const paths = files.map((file) => file.path);
  const [match, imports] = await Promise.all([
    matchFilesToComponents(repoId, paths),
    listPrMapImports(repoId, paths),
  ]);
  const componentIds = new Set<string>(match.touchedComponentIds);
  for (const row of imports) {
    if (row.fromComponentId) componentIds.add(row.fromComponentId);
    if (row.toComponentId) componentIds.add(row.toComponentId);
  }
  const components = await listPrMapComponents(repoId, [...componentIds]);
  return {
    files,
    componentIdByPath: match.componentIdByPath,
    components: new Map(components.map((c) => [c.id, c])),
    imports,
  };
}
