// The app map builder (DESIGN.md §6.5) — the whole analyzed codebase drawn
// the way the PR map (./pr-map.ts) draws one diff: cards of files, and
// labelled edges between cards, at one of three levels of detail
// (architecture layers, features, modules).
//
// Same split as the PR map:
//   1. `loadAppMapInput` is the only Neo4j-touching part — every analyzed
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
import { getFileOwnerMap, getStoredImportGraph, listComponentsByRepoId } from "@/lib/neo4j";
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
}

/** An AI card as the app-map job stores it (lib/neo4j/app-map.ts). */
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
  if (role === "config" || role === "dependency" || INFRA_DIR.test(filePath)) return "infrastructure";
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

/** Validates the JSON blobs lib/neo4j/app-map.ts hands back; anything malformed is dropped, never thrown. */
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
      });
    }
    const edges: StoredAppMapEdge[] = record.edges.filter(
      (e): e is StoredAppMapEdge =>
        isRecordLike(e) && typeof e.from === "string" && typeof e.to === "string" && typeof e.label === "string"
    );
    out.set(record.level, { level: record.level, groups, edges, model: record.model, createdAt: record.createdAt });
  }
  return out;
}
