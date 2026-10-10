// The app map builder (DESIGN.md §6.5) — the whole analyzed codebase drawn
// the way the PR map (./pr-map.ts) draws one diff: cards of files, and
// labelled edges between cards, at one of three levels of detail
// (architecture layers, features, modules).
//
// Same split as the PR map:
//   1. `loadAppMapInput` is the only database-touching part — every analyzed
//      file, its owning module, and every file-level `IMPORTS` edge.
//   2. Everything else is pure. A *grouping* (which files go on which card)
//      comes either from the heuristics here or from a stored AI run
//      (lib/jobs/app-map-job.ts), and `assembleAppMap` turns any grouping into
//      cards and edges. Edges are always aggregated from the import graph, so
//      the AI can name and explain a connection but never invent one.
//
// Stored AI groupings hold *members* — file paths or `dir/` prefixes — not a
// frozen file list, so files added after the run land on the right card when
// they sit under a known folder, and the rest fall back to the heuristic.

import path from "node:path";
import { getFileOwnerMap, getStoredImportGraph, listComponentsByRepoId } from "@/lib/db";
import {
  APP_LAYERS,
  APP_LAYER_ORDER,
  type AppLayerId,
  type AppMapEdgeDTO,
  type AppMapKeyFileDTO,
  type AppMapLevel,
  type AppMapNodeDTO,
} from "@/components/graph/app-map-types";
import { GENERIC_KEYS, LAYER_SEGMENTS, normaliseSegment } from "./merge-heuristics";
import { classifyPath } from "./pr-map";

export interface AppMapComponentInfo {
  id: string;
  name: string;
  description?: string;
}

export interface AppMapInput {
  /** Every analyzed file path, sorted. */
  files: string[];
  /** File path → owning module id. */
  ownerByPath: Map<string, string>;
  /** Module-tier components by id. */
  components: Map<string, AppMapComponentInfo>;
  /** File-level `IMPORTS` edges. */
  imports: Array<{ from: string; to: string }>;
}

/** One card's worth of files, before assembly. */
export interface AppMapGroup {
  /** Stable key within the level — also how stored AI edges refer to the card. */
  key: string;
  name: string;
  description?: string;
  explanation?: string;
  keyFiles?: AppMapKeyFileDTO[];
  /** Architecture cards: the layer itself. */
  layer?: AppLayerId;
  files: string[];
  /** The name of the card this one was split out of. */
  splitFrom?: string;
}

/**
 * The card a split replaced, kept on each of its parts so "Merge back"
 * restores it exactly: its text, its members and the connection notes it had.
 */
export interface AppMapSplitOrigin {
  key: string;
  name: string;
  description?: string;
  explanation?: string;
  keyFiles?: AppMapKeyFileDTO[];
  members: string[];
  edges: StoredAppMapEdge[];
  /** It was itself split out of another card. */
  splitFrom?: AppMapSplitOrigin;
}

/** An AI card as the app-map job stores it (lib/db/app-map.ts). */
export interface StoredAppMapGroup {
  key: string;
  name: string;
  description?: string;
  explanation?: string;
  keyFiles?: AppMapKeyFileDTO[];
  /** Architecture only: the layer this group is. */
  layer?: AppLayerId;
  /** File paths, or folder prefixes ending in `/`. The longest match across all groups wins. Empty on the modules level (membership is the module's). */
  members: string[];
  /** Features split out of a bigger card ("Split up"): that card. */
  splitFrom?: AppMapSplitOrigin;
}

export interface StoredAppMapEdge {
  /** Group keys. */
  from: string;
  to: string;
  label: string;
  explanation?: string;
}

export interface StoredAppMap {
  level: AppMapLevel;
  groups: StoredAppMapGroup[];
  edges: StoredAppMapEdge[];
  model: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Lower-case words of a path segment or file stem: `PrMapCanvas` → pr, map, canvas; `gitlab-access` → gitlab, access. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

function stemOf(filePath: string): string {
  const base = path.posix.basename(filePath);
  return base.replace(/\.(test|spec|e2e|stories|d)\.[^.]+$/i, "").replace(/\.[^.]+$/, "");
}

function dirSegments(filePath: string): string[] {
  const parts = filePath.split("/");
  parts.pop();
  return parts;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const INFRA_DIR = /(^|\/)(worker|workers|cmd|bin|scripts?|deploy|deployment|infra|infrastructure|terraform|k8s|kubernetes|helm|docker|\.github|\.gitlab|ci)\//i;
/** Infrastructure-as-code files (DESIGN.md §6.12): Terraform, Nomad, Dockerfiles, Helm / Kustomize. */
const INFRA_FILE = /(\.tf|\.tfvars|\.tf\.json|\.tfvars\.json|\.nomad|\.hcl|\.dockerfile)$|(^|\/)(dockerfile|containerfile)(\.[^/]*)?$|(^|\/)(chart|kustomization|values[^/]*)\.ya?ml$/i;
const INFRA_WORDS = new Set(["queue", "queues", "worker", "workers", "cron", "scheduler", "instrumentation", "middleware", "bootstrap", "server"]);
const SERVER_DIR = /(^|\/)(api|routes?|controllers?|handlers?|endpoints?|resolvers?|rpc|trpc|graphql)\//i;
const SERVER_STEM = /^(route|actions?|server-actions?|handler|controller|resolver|endpoint)s?$|\.(actions?|controller|handler|resolver|route)$/i;
const DATA_WORDS = new Set([
  "db", "database", "databases", "neo4j", "prisma", "drizzle", "orm", "model", "models", "entity", "entities",
  "repository", "repositories", "repo-store", "schema", "schemas", "migration", "migrations", "dao", "store", "stores",
  "persistence", "sql", "sqlite", "postgres", "mysql", "redis", "mongo", "mongodb", "cache", "storage", "cypher",
]);
const INTEGRATION_WORDS = new Set([
  "github", "gitlab", "bitbucket", "slack", "stripe", "openai", "anthropic", "ai", "llm", "s3", "aws", "gcp",
  "azure", "firebase", "supabase", "twilio", "sendgrid", "mailgun", "auth0", "clerk", "oauth", "webhook", "webhooks",
  "integration", "integrations", "adapter", "adapters", "sdk", "external", "octokit", "jira", "linear", "notion",
]);
const UI_DIR = /(^|\/)(components?|pages|views?|screens?|ui|hooks|styles|layouts?|widgets?|templates?|public|assets)\//i;
const UI_EXT = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)$/i;
const UI_STEM = /^use[A-Z]|^(page|layout|loading|error|not-found|template|global-error)$/;

/**
 * Which layer a file belongs to, from its path alone — the architecture
 * level's heuristic, and the hint the AI pass starts from. First match wins,
 * in the order tests → infrastructure → server → data → integrations → UI;
 * everything else is logic.
 */
export function classifyLayer(filePath: string): AppLayerId {
  const role = classifyPath(filePath);
  const stem = stemOf(filePath);
  const lowerSegments = dirSegments(filePath).map((s) => s.toLowerCase());
  const stemWords = words(stem);
  const all = new Set([...lowerSegments, ...stemWords]);

  if (role === "test" || /^smoke-test/i.test(stem) || lowerSegments.includes("__fixtures__")) return "tests";
  // Migrations and schema files (DESIGN.md §6.13) are the data layer wherever they live.
  if (/\.(sql|prisma)$/i.test(filePath)) return "data";
  if (role === "config" || role === "dependency" || INFRA_DIR.test(filePath) || INFRA_FILE.test(filePath)) return "infrastructure";
  if (/(^|\/)pages\/api\//.test(filePath) || SERVER_STEM.test(stem) || SERVER_DIR.test(filePath)) return "server";
  // A component file is UI wherever it lives (`github-notice.tsx` is a banner, not an integration).
  if (/\.(tsx|jsx|vue|svelte|astro)$/i.test(filePath)) return "ui";
  if ([...all].some((w) => DATA_WORDS.has(w))) return "data";
  if ([...all].some((w) => INTEGRATION_WORDS.has(w))) return "integrations";
  if (UI_EXT.test(filePath) || UI_STEM.test(stem) || UI_DIR.test(filePath)) return "ui";
  if (stemWords.some((w) => INFRA_WORDS.has(w))) return "infrastructure";
  return "logic";
}

// ---------------------------------------------------------------------------
// Heuristic features
// ---------------------------------------------------------------------------

/** Stem words that name a file's *kind*, not a feature (`ReviewPanel` is about review, not panels). */
const KIND_WORDS = new Set([
  "index", "type", "types", "util", "utils", "helper", "helpers", "route", "page", "layout", "client", "server",
  "error", "errors", "constant", "constants", "config", "readme", "main", "mod", "lib", "init", "test", "spec",
  "smoke", "shared", "common", "base", "core", "hook", "hooks", "use", "panel", "view", "control", "controls",
  "canvas", "node", "dialog", "button", "card", "badge", "modal", "viewer", "handle", "hover", "form", "state",
  "context", "provider", "action", "actions", "item", "list", "table", "shim", "shims", "visual", "visuals", "queries",
  "query", "schema", "d", "the", "a", "of", "and", "to", "in", "for", "by", "new", "get", "set",
]);

/** Most cards the no-model feature grouping produces. */
const MAX_HEURISTIC_FEATURES = 16;

/** Display casing for words that aren't just capitalised. */
const WORD_CASING: Record<string, string> = {
  github: "GitHub", gitlab: "GitLab", ai: "AI", pr: "PR", api: "API", ui: "UI", neo4j: "Neo4j", jvm: "JVM",
  url: "URL", id: "ID", ir: "IR", db: "DB", llm: "LLM", mr: "MR", ci: "CI", sql: "SQL", oauth: "OAuth",
};

function featureWords(stem: string): string[] {
  const all = words(stem);
  // `smoke-test-pr-map` → pr, map; `usePrMap` → pr, map; `pr-map-types` → pr, map.
  const kept = all.filter((w) => !KIND_WORDS.has(w) && !/^\d+$/.test(w));
  return kept;
}

function titleFor(rawWords: string[]): string {
  const text = rawWords.map((w) => WORD_CASING[w] ?? w).join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isFeatureDirSegment(segment: string): boolean {
  if (/^\(.*\)$/.test(segment) || /^\[.*\]$/.test(segment) || segment.startsWith("@") || segment.startsWith(".")) return false;
  const lower = segment.toLowerCase();
  return !LAYER_SEGMENTS.has(lower) && !GENERIC_KEYS.has(normaliseSegment(lower)) && !KIND_WORDS.has(lower);
}

interface FileKeys {
  path: string;
  /** Whole feature-word compound, when it has two or more words. */
  compound?: { key: string; words: string[] };
  stemWords: Array<{ key: string; word: string }>;
  /** Feature-like folder segments, outermost first. */
  dirs: Array<{ key: string; word: string; prefix: string }>;
  /** Single words of multi-word folder names (`diff-impact` → diff, impact) — only used to test "cross-cutting". */
  dirWords: string[];
}

function keysOf(filePath: string): FileKeys {
  const fw = featureWords(stemOf(filePath));
  const segments = dirSegments(filePath);
  const dirs: FileKeys["dirs"] = [];
  segments.forEach((segment, index) => {
    if (!isFeatureDirSegment(segment)) return;
    dirs.push({
      key: normaliseSegment(segment),
      word: segment,
      prefix: `${segments.slice(0, index + 1).join("/")}/`,
    });
  });
  return {
    path: filePath,
    dirWords: segments.filter(isFeatureDirSegment).flatMap((segment) => words(segment).map(normaliseSegment)),
    compound: fw.length >= 2 ? { key: fw.map(normaliseSegment).join(""), words: fw } : undefined,
    stemWords: fw.map((word) => ({ key: normaliseSegment(word), word })),
    dirs,
  };
}

/**
 * The feature grouping that needs no model. Each file gets one feature key,
 * tried in this order:
 *   1. its whole feature-word compound (`pr-map-types`, `PrMapCanvas` → "prmap"),
 *      when at least two files share it;
 *   2. its most widely shared feature word (`gitlab-access` → "gitlab",
 *      `ReviewPanel` → "review") — but not one that only ever appears as the
 *      same file name in different folders (`resolve.ts` × 6 is a convention);
 *   3. the deepest folder whose name also appears elsewhere in the repo
 *      (`app/api/repos/[id]/review/route.ts` → "review"), else the outermost
 *      feature-like folder (`lib/analysis/languages/go/…` → "analysis");
 *   4. its owning module.
 * One-file features are folded into whatever feature most of their module
 * ended up in.
 */
export function heuristicFeatureGroups(input: AppMapInput): AppMapGroup[] {
  const keyed = input.files.map(keysOf);

  // How many files mention each key, and how many distinct basenames carry it as a stem word.
  const fileCount = new Map<string, number>();
  const stemNames = new Map<string, Set<string>>();
  const dirPrefixes = new Map<string, Set<string>>();
  const display = new Map<string, string[]>();
  for (const file of keyed) {
    const seen = new Set<string>();
    const note = (key: string, rawWords: string[]) => {
      if (!display.has(key)) display.set(key, rawWords);
      if (seen.has(key)) return;
      seen.add(key);
      fileCount.set(key, (fileCount.get(key) ?? 0) + 1);
    };
    if (file.compound) note(file.compound.key, file.compound.words);
    for (const { key, word } of file.stemWords) {
      note(key, [word]);
      const names = stemNames.get(key) ?? new Set<string>();
      names.add(path.posix.basename(file.path));
      stemNames.set(key, names);
    }
    for (const { key, word, prefix } of file.dirs) {
      note(key, words(word));
      const prefixes = dirPrefixes.get(key) ?? new Set<string>();
      prefixes.add(prefix);
      dirPrefixes.set(key, prefixes);
    }
  }
  const count = (key: string) => fileCount.get(key) ?? 0;
  const mentions = (f: FileKeys, key: string) =>
    f.compound?.key === key || f.stemWords.some((w) => w.key === key) || f.dirs.some((d) => d.key === key) || f.dirWords.includes(key);
  const crossCutting = (key: string, prefix: string) => keyed.some((f) => !f.path.startsWith(prefix) && mentions(f, key));
  // A stem word that is only ever one file name repeated in different
  // folders (`resolve.ts` × 6) is a naming convention, not a feature — unless
  // a folder carries the name too (`lib/gitlab/` + `gitlab-access.ts`).
  const isConvention = (key: string) => (stemNames.get(key)?.size ?? 0) <= 1 && !dirPrefixes.has(key);

  const assignment = new Map<string, string>();
  for (const file of keyed) {
    let key: string | undefined;
    if (file.compound && count(file.compound.key) >= 2) key = file.compound.key;
    if (!key) {
      const candidates = file.stemWords
        .filter((w) => count(w.key) >= 2 && !isConvention(w.key))
        .sort((a, b) => count(b.key) - count(a.key));
      key = candidates[0]?.key;
    }
    if (!key && file.dirs.length > 0) {
      // Deepest folder shared with the rest of the repo — by its whole name,
      // or by one of its words (`diff-impact/` joins "diff").
      for (const dir of [...file.dirs].reverse()) {
        if (crossCutting(dir.key, dir.prefix)) {
          key = dir.key;
          break;
        }
        const word = words(dir.word)
          .map(normaliseSegment)
          .filter((w) => !KIND_WORDS.has(w) && !GENERIC_KEYS.has(w) && w !== dir.key)
          .find((w) => crossCutting(w, dir.prefix));
        if (word) {
          key = word;
          if (!display.has(word)) display.set(word, [word]);
          break;
        }
      }
      key ??= file.dirs[0].key;
    }
    if (!key) {
      const owner = input.ownerByPath.get(file.path);
      key = owner ? `mod:${owner}` : `dir:${dirSegments(file.path)[0] ?? "(root)"}`;
    }
    assignment.set(file.path, key);
  }

  // Fold one-file features into their module's most common feature.
  const members = new Map<string, string[]>();
  for (const [file, key] of assignment) members.set(key, [...(members.get(key) ?? []), file]);
  for (const [key, files] of [...members]) {
    if (files.length >= 2) continue;
    const file = files[0];
    const owner = input.ownerByPath.get(file);
    const tally = new Map<string, number>();
    for (const [other, otherKey] of assignment) {
      if (other === file || otherKey === key || input.ownerByPath.get(other) !== owner || !owner) continue;
      tally.set(otherKey, (tally.get(otherKey) ?? 0) + 1);
    }
    const best = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!best) continue;
    assignment.set(file, best);
    members.delete(key);
    members.get(best)!.push(file);
  }

  // Too many cards is a hairball, not a map: fold the least feature-like
  // group into the one its files are most connected to by imports (else the
  // one most of its module is in, else the biggest) until few enough are
  // left. Fallback groups (named after a module or folder) go first; groups
  // spanning several top-level folders — `lib/gitlab/` + `lib/jobs/gitlab-access.ts`,
  // the whole point of this level — go last.
  const foldRank = ([key, files]: [string, string[]]) => {
    const tops = new Set(files.map((f) => dirSegments(f).slice(0, 2).join("/")));
    return files.length + (tops.size > 1 ? 1000 : 0) - (key.startsWith("mod:") || key.startsWith("dir:") ? 500 : 0);
  };
  while (members.size > MAX_HEURISTIC_FEATURES) {
    const [smallKey, smallFiles] = [...members].sort((a, b) => foldRank(a) - foldRank(b) || a[0].localeCompare(b[0]))[0];
    const inSmall = new Set(smallFiles);
    const weight = new Map<string, number>();
    const bump = (key: string | undefined, by: number) => {
      if (key && key !== smallKey) weight.set(key, (weight.get(key) ?? 0) + by);
    };
    for (const { from, to } of input.imports) {
      if (inSmall.has(from) && !inSmall.has(to)) bump(assignment.get(to), 1);
      else if (inSmall.has(to) && !inSmall.has(from)) bump(assignment.get(from), 1);
    }
    if (weight.size === 0) {
      const owners = new Set(smallFiles.map((f) => input.ownerByPath.get(f)).filter(Boolean));
      for (const [file, key] of assignment) if (owners.has(input.ownerByPath.get(file))) bump(key, 0.001);
    }
    const target =
      [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      [...members].filter(([k]) => k !== smallKey).sort((a, b) => b[1].length - a[1].length)[0][0];
    for (const file of smallFiles) assignment.set(file, target);
    members.get(target)!.push(...smallFiles);
    members.delete(smallKey);
  }

  const groups: AppMapGroup[] = [];
  for (const [key, files] of members) {
    let name: string;
    if (key.startsWith("mod:")) name = input.components.get(key.slice(4))?.name ?? key.slice(4);
    else if (key.startsWith("dir:")) name = key.slice(4);
    else name = titleFor(display.get(key) ?? [key]);
    const folders = [...new Set(files.map((f) => dirSegments(f).slice(0, 2).join("/") || "(root)"))];
    groups.push({
      key: `h:${key}`,
      name,
      description: `${files.length} file${files.length === 1 ? "" : "s"} in ${folders.slice(0, 3).join(", ")}${folders.length > 3 ? ` +${folders.length - 3} more` : ""}`,
      files: files.sort(),
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Groupings per level
// ---------------------------------------------------------------------------

/** The longest member (exact path or `dir/` prefix) that matches `filePath`, across every group. */
export function matchMember(
  filePath: string,
  groups: ReadonlyArray<{ key: string; members: string[] }>
): string | undefined {
  let best: { key: string; length: number } | undefined;
  for (const group of groups) {
    for (const member of group.members) {
      const hit = member.endsWith("/") ? filePath.startsWith(member) : filePath === member;
      if (!hit) continue;
      // An exact path beats any prefix of equal length.
      const length = member.length + (member.endsWith("/") ? 0 : 1);
      if (!best || length > best.length) best = { key: group.key, length };
    }
  }
  return best?.key;
}

/** The files no member of `groups` covers. */
export function uncoveredFiles(
  files: readonly string[],
  groups: ReadonlyArray<{ key: string; members: string[] }>
): string[] {
  return files.filter((f) => matchMember(f, groups) === undefined);
}

/**
 * Members to add per group key for files placed one by one (`placements`:
 * file → group key). A folder prefix stands in for its files when *every*
 * file under it was placed into the same group — the shortest such folder —
 * so the stored rule stays short and files added there later follow it.
 * Anything else is listed by exact path. Only placed files can make a folder
 * uniform, so a new prefix never takes a file another member already covers.
 */
export function compactPlacements(
  files: readonly string[],
  placements: ReadonlyMap<string, string>
): Map<string, string[]> {
  const MIXED = "\u0000";
  const owner = new Map<string, string>();
  for (const file of files) {
    const key = placements.get(file) ?? MIXED;
    const parts = dirSegments(file);
    for (let i = 1; i <= parts.length; i++) {
      const prefix = `${parts.slice(0, i).join("/")}/`;
      const seen = owner.get(prefix);
      owner.set(prefix, seen === undefined || seen === key ? key : MIXED);
    }
  }
  const added = new Map<string, Set<string>>();
  for (const [file, key] of placements) {
    const parts = dirSegments(file);
    let member = file;
    for (let i = 1; i <= parts.length; i++) {
      const prefix = `${parts.slice(0, i).join("/")}/`;
      if (owner.get(prefix) === key) {
        member = prefix;
        break;
      }
    }
    added.set(key, (added.get(key) ?? new Set()).add(member));
  }
  return new Map([...added].map(([key, members]) => [key, [...members].sort()]));
}

/** Each file's layer: the stored architecture run's placement when there is one, the path heuristic otherwise. */
export function layerResolver(architecture: StoredAppMap | null): (filePath: string) => AppLayerId {
  if (!architecture) return classifyLayer;
  const groups = architecture.groups.filter((g) => g.layer);
  const layerOfKey = new Map(groups.map((g) => [g.key, g.layer!]));
  return (filePath) => {
    const key = matchMember(filePath, groups);
    return (key && layerOfKey.get(key)) || classifyLayer(filePath);
  };
}

export interface ResolvedGrouping {
  groups: AppMapGroup[];
  /** Files the stored grouping didn't place, so the heuristic did. */
  unplaced: number;
}

/**
 * The cards for one level: from the stored AI run when there is one, else
 * heuristic. `layerOf` must already reflect a stored architecture run.
 */
export function groupsForLevel(
  input: AppMapInput,
  level: AppMapLevel,
  stored: StoredAppMap | null,
  layerOf: (filePath: string) => AppLayerId
): ResolvedGrouping {
  if (level === "architecture") {
    const byLayer = new Map<AppLayerId, string[]>();
    for (const file of input.files) {
      const layer = layerOf(file);
      byLayer.set(layer, [...(byLayer.get(layer) ?? []), file]);
    }
    const storedByLayer = new Map((stored?.groups ?? []).filter((g) => g.layer).map((g) => [g.layer!, g]));
    const groups = APP_LAYER_ORDER.filter((layer) => byLayer.has(layer)).map((layer): AppMapGroup => {
      const info = storedByLayer.get(layer);
      return {
        key: layer,
        layer,
        name: APP_LAYERS[layer].name,
        description: info?.description || APP_LAYERS[layer].blurb,
        explanation: info?.explanation,
        keyFiles: info?.keyFiles,
        files: byLayer.get(layer)!,
      };
    });
    return { groups, unplaced: 0 };
  }

  if (level === "modules") {
    const storedByKey = new Map((stored?.groups ?? []).map((g) => [g.key, g]));
    const byOwner = new Map<string, string[]>();
    for (const file of input.files) {
      const owner = input.ownerByPath.get(file);
      const key = owner ?? `dir:${dirSegments(file)[0] ?? "(root)"}`;
      byOwner.set(key, [...(byOwner.get(key) ?? []), file]);
    }
    const groups = [...byOwner].map(([key, files]): AppMapGroup => {
      const component = input.components.get(key);
      const info = storedByKey.get(key);
      return {
        key,
        name: component?.name ?? `${key.slice(4)} (not in a module)`,
        description: component?.description || info?.description,
        explanation: info?.explanation,
        keyFiles: info?.keyFiles,
        files,
      };
    });
    return { groups, unplaced: 0 };
  }

  // Features.
  if (!stored || stored.groups.length === 0) return { groups: heuristicFeatureGroups(input), unplaced: 0 };
  const placed = new Map<string, string[]>();
  const leftovers: string[] = [];
  for (const file of input.files) {
    const key = matchMember(file, stored.groups);
    if (key) placed.set(key, [...(placed.get(key) ?? []), file]);
    else leftovers.push(file);
  }
  const groups: AppMapGroup[] = stored.groups
    .filter((g) => placed.has(g.key))
    .map((g) => ({
      key: g.key,
      name: g.name,
      description: g.description,
      explanation: g.explanation,
      keyFiles: g.keyFiles,
      files: placed.get(g.key)!,
      ...(g.splitFrom ? { splitFrom: g.splitFrom.name } : {}),
    }));
  if (leftovers.length > 0) {
    const fallback = heuristicFeatureGroups({ ...input, files: leftovers });
    const used = new Set(groups.map((g) => g.name.toLowerCase()));
    for (const group of fallback) {
      groups.push({
        ...group,
        name: used.has(group.name.toLowerCase()) ? `${group.name} (new)` : group.name,
        description: `Not in the AI grouping — ${group.description}`,
      });
    }
  }
  return { groups, unplaced: leftovers.length };
}

// ---------------------------------------------------------------------------
// Splitting a card ("Split up") and merging it back
// ---------------------------------------------------------------------------

/** A group key from a feature name: `App Foundation & Infra` → `app-foundation-infra`. */
export function featureSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "feature"
  );
}

const MAX_SPLIT_PARTS = 8;
/** A part smaller than this joins the "Other" part (unless that would leave fewer than two). */
const MIN_SPLIT_PART = 3;

const titleCase = (text: string) =>
  words(text)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ") || text;

/**
 * Parts for a card without a model: by owning module when the card spans
 * several, else by the folder under the files' common folder. Small parts go
 * to "Other …". Fewer than two parts means it can't be split this way (`[]`).
 */
export function splitByFolders(input: AppMapInput, files: readonly string[], cardName: string): Array<{ name: string; files: string[] }> {
  const bucket = (keyOf: (f: string) => string, nameOf: (key: string) => string) => {
    const byKey = new Map<string, string[]>();
    for (const f of files) byKey.set(keyOf(f), [...(byKey.get(keyOf(f)) ?? []), f]);
    return [...byKey].map(([key, fs]) => ({ name: nameOf(key), files: fs })).sort((a, b) => b.files.length - a.files.length);
  };
  let parts = bucket(
    (f) => input.ownerByPath.get(f) ?? "",
    (id) => input.components.get(id)?.name ?? "Loose files"
  );
  // One module (or nearly) holds the card: split by folder instead.
  if (parts.length < 2 || parts[0].files.length > files.length * 0.7) {
    const dirs = files.map(dirSegments);
    let common = 0;
    while (dirs.every((d) => d.length > common && d[common] === dirs[0][common])) common++;
    const top = dirs[0].slice(0, common).pop();
    parts = bucket(
      (f) => dirSegments(f)[common] ?? "",
      (seg) => (seg ? titleCase(seg) : top ? `${titleCase(top)} (top level)` : "Root files")
    );
  }
  const keep: typeof parts = [];
  const other: string[] = [];
  for (const part of parts) {
    if (keep.length < MAX_SPLIT_PARTS - 1 && part.files.length >= MIN_SPLIT_PART) keep.push(part);
    else other.push(...part.files);
  }
  if (other.length > 0) {
    if (keep.length === 1 && parts.length > 1) return parts.slice(0, MAX_SPLIT_PARTS);
    keep.push({ name: `Other ${cardName}`.slice(0, 40), files: other });
  }
  return keep.length >= 2 ? keep : [];
}

/** Whether `group` was split, at any depth, out of the card `key`. */
function descendsFrom(group: StoredAppMapGroup, key: string): boolean {
  for (let o = group.splitFrom; o; o = o.splitFrom) if (o.key === key) return true;
  return false;
}

/**
 * The stored grouping with `card` replaced by `parts`. Each part's members
 * are its files compacted to folders where a folder holds only that part's
 * files (`compactPlacements`), so nothing outside the card moves. With no
 * stored run the heuristic grouping is stored first, so the split has
 * something to live in.
 */
export function applySplit(
  input: AppMapInput,
  stored: StoredAppMap | null,
  card: AppMapGroup,
  parts: ReadonlyArray<{ name: string; description?: string; files: string[] }>
): { groups: StoredAppMapGroup[]; edges: StoredAppMapEdge[]; newKeys: string[] } {
  const base: StoredAppMapGroup[] =
    stored && stored.groups.length > 0
      ? stored.groups.map((g) => ({ ...g, members: [...g.members] }))
      : heuristicFeatureGroups(input).map((g) => ({ key: g.key, name: g.name, description: g.description, members: [...g.files] }));
  const edges = stored?.edges ?? [];
  const at = base.findIndex((g) => g.key === card.key);
  const existing = at >= 0 ? base[at] : undefined;
  const origin: AppMapSplitOrigin = {
    key: card.key,
    name: existing?.name ?? card.name,
    description: existing?.description ?? card.description,
    explanation: existing?.explanation ?? card.explanation,
    keyFiles: existing?.keyFiles ?? card.keyFiles,
    members: existing?.members ?? [...card.files],
    edges: edges.filter((e) => e.from === card.key || e.to === card.key),
    ...(existing?.splitFrom ? { splitFrom: existing.splitFrom } : {}),
  };
  const used = new Set(base.map((g) => g.key));
  const placements = new Map<string, string>();
  const made: StoredAppMapGroup[] = [];
  const names = new Set<string>();
  for (const part of parts) {
    if (part.files.length === 0) continue;
    let name = part.name;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${part.name} ${n}`;
    names.add(name.toLowerCase());
    let key = `${card.key}--${featureSlug(name)}`;
    for (let n = 2; used.has(key); n++) key = `${card.key}--${featureSlug(name)}-${n}`;
    used.add(key);
    for (const f of part.files) if (!placements.has(f)) placements.set(f, key);
    made.push({ key, name, ...(part.description ? { description: part.description } : {}), members: [], splitFrom: origin });
  }
  const compacted = compactPlacements(input.files, placements);
  for (const group of made) group.members = compacted.get(group.key) ?? [];
  const parted = made.filter((g) => g.members.length > 0);
  const groups = [...base];
  if (at >= 0) groups.splice(at, 1, ...parted);
  else groups.push(...parted);
  return {
    groups,
    edges: edges.filter((e) => e.from !== card.key && e.to !== card.key),
    newKeys: parted.map((g) => g.key),
  };
}

/**
 * The stored grouping with the split card `key` belongs to merged back into
 * the card it came from — every part, and parts of parts — with that card's
 * text, members and connection notes as they were.
 */
export function mergeBack(stored: StoredAppMap, key: string): { groups: StoredAppMapGroup[]; edges: StoredAppMapEdge[]; restored: string } {
  const origin = stored.groups.find((g) => g.key === key)?.splitFrom;
  if (!origin) throw new Error("That card wasn't split out of another one.");
  const parts = new Set(stored.groups.filter((g) => descendsFrom(g, origin.key)).map((g) => g.key));
  const restored: StoredAppMapGroup = {
    key: origin.key,
    name: origin.name,
    description: origin.description,
    explanation: origin.explanation,
    keyFiles: origin.keyFiles,
    members: origin.members,
    ...(origin.splitFrom ? { splitFrom: origin.splitFrom } : {}),
  };
  const groups: StoredAppMapGroup[] = [];
  for (const g of stored.groups) {
    if (!parts.has(g.key)) groups.push(g);
    else if (!groups.includes(restored)) groups.push(restored);
  }
  const edges = [...stored.edges.filter((e) => !parts.has(e.from) && !parts.has(e.to)), ...origin.edges];
  return { groups, edges, restored: origin.name };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const MAX_EDGE_SAMPLES = 3;
const HEURISTIC_KEY_FILES = 3;

export function cardId(level: AppMapLevel, key: string): string {
  return `${level === "architecture" ? "layer" : level === "features" ? "feat" : "mod"}:${key}`;
}

/** Cards and edges for one grouping. A file listed in two groups stays in the first. */
export function assembleAppMap(
  input: AppMapInput,
  level: AppMapLevel,
  groups: AppMapGroup[],
  layerOf: (filePath: string) => AppLayerId,
  storedEdges: StoredAppMapEdge[] = []
): { nodes: AppMapNodeDTO[]; edges: AppMapEdgeDTO[] } {
  const cardOfFile = new Map<string, string>();
  const keyOfCard = new Map<string, string>();
  const nodes: AppMapNodeDTO[] = [];

  // In-degree from files on other cards — the heuristic "start here" signal.
  const groupOfFile = new Map<string, string>();
  for (const group of groups) for (const f of group.files) if (!groupOfFile.has(f)) groupOfFile.set(f, group.key);
  const inbound = new Map<string, number>();
  for (const { from, to } of input.imports) {
    const a = groupOfFile.get(from);
    const b = groupOfFile.get(to);
    if (!a || !b || a === b) continue;
    inbound.set(to, (inbound.get(to) ?? 0) + 1);
  }

  for (const group of groups) {
    const files = group.files.filter((f) => groupOfFile.get(f) === group.key).sort();
    if (files.length === 0) continue;
    const id = cardId(level, group.key);
    for (const f of files) cardOfFile.set(f, id);
    keyOfCard.set(id, group.key);

    const layerCounts = new Map<AppLayerId, number>();
    const moduleCounts = new Map<string, number>();
    const fileLayers: Record<string, AppLayerId> = {};
    for (const f of files) {
      const layer = layerOf(f);
      fileLayers[f] = layer;
      layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
      const owner = input.ownerByPath.get(f);
      if (owner) moduleCounts.set(owner, (moduleCounts.get(owner) ?? 0) + 1);
    }
    const layers = [...layerCounts]
      .sort((a, b) => b[1] - a[1] || APP_LAYER_ORDER.indexOf(a[0]) - APP_LAYER_ORDER.indexOf(b[0]))
      .map(([layer, count]) => ({ layer, files: count }));

    const onCard = new Set(files);
    const keyFiles =
      group.keyFiles && group.keyFiles.length > 0
        ? group.keyFiles.filter((k) => onCard.has(k.path))
        : files
            .filter((f) => (inbound.get(f) ?? 0) > 0)
            .sort((a, b) => (inbound.get(b) ?? 0) - (inbound.get(a) ?? 0) || a.localeCompare(b))
            .slice(0, HEURISTIC_KEY_FILES)
            .map((f) => {
              const n = inbound.get(f)!;
              return { path: f, role: `Imported by ${n} file${n === 1 ? "" : "s"} on other cards` };
            });

    nodes.push({
      id,
      name: group.name,
      description: group.description || undefined,
      explanation: group.explanation || undefined,
      keyFiles,
      layer: group.layer ?? layers[0]?.layer ?? "logic",
      layers,
      files,
      ...(layers.length > 1 ? { fileLayers } : {}),
      modules: [...moduleCounts]
        .sort((a, b) => b[1] - a[1])
        .map(([moduleId, count]) => ({
          id: moduleId,
          name: input.components.get(moduleId)?.name ?? moduleId,
          files: count,
        })),
      ...(group.splitFrom ? { splitFrom: group.splitFrom } : {}),
    });
  }

  type Pending = { source: string; target: string; weight: number; samples: Array<{ from: string; to: string }> };
  const pending = new Map<string, Pending>();
  for (const { from, to } of input.imports) {
    const source = cardOfFile.get(from);
    const target = cardOfFile.get(to);
    if (!source || !target || source === target) continue;
    const key = `${source}\u0000${target}`;
    const entry = pending.get(key) ?? { source, target, weight: 0, samples: [] };
    entry.weight += 1;
    if (entry.samples.length < MAX_EDGE_SAMPLES) entry.samples.push({ from, to });
    pending.set(key, entry);
  }

  const storedByPair = new Map(storedEdges.map((e) => [`${e.from}\u0000${e.to}`, e]));
  const edges: AppMapEdgeDTO[] = [...pending.values()].map((edge) => {
    const stored = storedByPair.get(`${keyOfCard.get(edge.source)}\u0000${keyOfCard.get(edge.target)}`);
    return {
      source: edge.source,
      target: edge.target,
      label: stored?.label ?? "uses",
      weight: edge.weight,
      explanation: stored?.explanation,
      samples: edge.samples,
    };
  });

  if (level === "architecture") {
    nodes.sort((a, b) => APP_LAYER_ORDER.indexOf(a.layer) - APP_LAYER_ORDER.indexOf(b.layer));
  } else if (level === "features") {
    nodes.sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name));
  } else {
    nodes.sort(
      (a, b) =>
        APP_LAYER_ORDER.indexOf(a.layer) - APP_LAYER_ORDER.indexOf(b.layer) || a.name.localeCompare(b.name)
    );
  }
  edges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  return { nodes, edges };
}

/** The full map for one level, from whatever is stored (either may be `null`). */
export function buildAppMap(
  input: AppMapInput,
  level: AppMapLevel,
  stored: StoredAppMap | null,
  storedArchitecture: StoredAppMap | null
): { nodes: AppMapNodeDTO[]; edges: AppMapEdgeDTO[]; unplaced: number } {
  const layerOf = layerResolver(storedArchitecture);
  const { groups, unplaced } = groupsForLevel(input, level, stored, layerOf);
  return { ...assembleAppMap(input, level, groups, layerOf, stored?.edges ?? []), unplaced };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadAppMapInput(repoId: string): Promise<AppMapInput> {
  const [graph, owners, components] = await Promise.all([
    getStoredImportGraph(repoId),
    getFileOwnerMap(repoId),
    listComponentsByRepoId(repoId),
  ]);
  return {
    files: [...graph.filePaths].sort(),
    ownerByPath: owners,
    components: new Map(
      components
        .filter((c) => c.tier === "module")
        .map((c) => [c.id, { id: c.id, name: c.name, description: c.description || undefined }])
    ),
    imports: graph.edges,
  };
}

// ---------------------------------------------------------------------------
// Stored runs
// ---------------------------------------------------------------------------

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStoredEdges(value: unknown): StoredAppMapEdge[] {
  return Array.isArray(value)
    ? value.filter(
        (e): e is StoredAppMapEdge =>
          isRecordLike(e) && typeof e.from === "string" && typeof e.to === "string" && typeof e.label === "string"
      )
    : [];
}

function toSplitOrigin(value: unknown, depth = 0): AppMapSplitOrigin | undefined {
  if (!isRecordLike(value) || typeof value.key !== "string" || typeof value.name !== "string" || depth > 8) return undefined;
  const parent = toSplitOrigin(value.splitFrom, depth + 1);
  return {
    key: value.key,
    name: value.name,
    description: typeof value.description === "string" ? value.description : undefined,
    explanation: typeof value.explanation === "string" ? value.explanation : undefined,
    keyFiles: Array.isArray(value.keyFiles)
      ? value.keyFiles.filter((k): k is AppMapKeyFileDTO => isRecordLike(k) && typeof k.path === "string" && typeof k.role === "string")
      : undefined,
    members: Array.isArray(value.members) ? value.members.filter((m): m is string => typeof m === "string") : [],
    edges: toStoredEdges(value.edges),
    ...(parent ? { splitFrom: parent } : {}),
  };
}

/** Validates the JSON blobs lib/db/app-map.ts hands back; anything malformed is dropped, never thrown. */
export function toStoredAppMaps(
  records: ReadonlyArray<{ level: string; groups: unknown[]; edges: unknown[]; model: string; createdAt: string }>
): Map<AppMapLevel, StoredAppMap> {
  const out = new Map<AppMapLevel, StoredAppMap>();
  for (const record of records) {
    if (record.level !== "architecture" && record.level !== "features" && record.level !== "modules") continue;
    const groups: StoredAppMapGroup[] = [];
    for (const g of record.groups) {
      if (!isRecordLike(g) || typeof g.key !== "string" || typeof g.name !== "string") continue;
      groups.push({
        key: g.key,
        name: g.name,
        description: typeof g.description === "string" ? g.description : undefined,
        explanation: typeof g.explanation === "string" ? g.explanation : undefined,
        keyFiles: Array.isArray(g.keyFiles)
          ? g.keyFiles.filter(
              (k): k is AppMapKeyFileDTO => isRecordLike(k) && typeof k.path === "string" && typeof k.role === "string"
            )
          : undefined,
        layer: typeof g.layer === "string" && g.layer in APP_LAYERS ? (g.layer as AppLayerId) : undefined,
        members: Array.isArray(g.members) ? g.members.filter((m): m is string => typeof m === "string") : [],
        ...(toSplitOrigin(g.splitFrom) ? { splitFrom: toSplitOrigin(g.splitFrom) } : {}),
      });
    }
    const edges = toStoredEdges(record.edges);
    out.set(record.level, { level: record.level, groups, edges, model: record.model, createdAt: record.createdAt });
  }
  return out;
}
