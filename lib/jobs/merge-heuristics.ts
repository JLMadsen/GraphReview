// Free, deterministic merge suggestions (DESIGN.md §6.3). Runs after every
// analysis and regroup; no AI, no disk, no Neo4j — the caller hands in the
// file list, the import edges and who owns which file, and stores what
// comes back as `(:MergeSuggestion)` nodes.
//
// Four kinds of signal:
//
//   1. Shared feature name — strip layer folders (`app`, `components`,
//      `api`, …) from a folder's path; folders left with the same name are
//      one feature: `app/map`, `components/map`, `app/api/map` → "map".
//   2. Import-only — folder B is imported mostly (≥ 70 %) by one other
//      module A, e.g. `components/map` used only by `app/map`.
//   3. Move file (split) — a file of a folder module whose imports go
//      mostly (≥ 60 %) to one merged feature.
//   4. Rename — a merged module lost a folder, and a new folder holds
//      mostly (≥ 70 %) the same file names.
//
// Folders imported by many modules are shared foundation and are never
// suggested as part of a feature.

import type { LostFolder, MergeSuggestionKind } from "@/lib/neo4j/types";
import { folderOfPattern, folderPattern, isUnderFolder } from "./ownership";

/** Suggestions below this score are not shown. */
export const MIN_SUGGESTION_SCORE = 0.5;
/** A folder imported by at least this share of all modules (and ≥ 3) is shared foundation. */
const SHARED_MODULE_SHARE = 0.3;
const SHARED_MIN_MODULES = 3;
/** Import-only: the share of B's incoming imports that must come from one module. */
const IMPORT_ONLY_SHARE = 0.7;
const IMPORT_ONLY_MIN_EDGES = 3;
/** Move file: the share of a file's imports that must touch one merged feature. */
const MOVE_FILE_SHARE = 0.6;
const MOVE_FILE_MIN_EDGES = 2;
/** Rename: the share of a lost folder's file names found again in a new folder. */
const RENAME_NAME_SHARE = 0.7;

/**
 * Path segments that name a layer, not a feature. Next.js route groups
 * `(group)` and dynamic segments `[id]` are stripped too (see `featureKey`).
 */
const LAYER_SEGMENTS = new Set([
  "app", "src", "source", "components", "component", "lib", "libs", "api", "pages", "page",
  "hooks", "services", "service", "routes", "route", "server", "client", "features", "feature",
  "modules", "module", "ui", "views", "view", "screens", "screen", "controllers", "controller",
  "models", "model", "store", "stores", "handlers", "handler", "main", "java", "kotlin", "go",
  "internal", "pkg", "cmd", "web", "frontend", "backend", "actions", "action", "contexts",
  "context", "providers", "provider", "types", "workers", "worker",
]);

/** Feature names too generic to mean "the same feature" when two folders share them. */
const GENERIC_KEYS = new Set([
  "util", "utils", "helper", "common", "shared", "type", "constant", "config", "style", "asset",
  "test", "__tests__", "__test__", "__fixtures__", "__mocks__", "fixture", "mock", "doc", "script",
  "public", "static", "vendor", "generated", "core", "index", "base", "misc", "tmp", "example",
]);

export interface HeuristicModule {
  id: string;
  name: string;
  origin: "folder" | "merge";
  pathPatterns: readonly string[];
  /** Merged modules only: parsed `lostFolders`. */
  lostFolders?: readonly LostFolder[];
}

export interface HeuristicInput {
  filePaths: readonly string[];
  edges: ReadonlyArray<{ from: string; to: string }>;
  /** File path → owning module id, after ownership resolution. */
  ownerByFile: ReadonlyMap<string, string>;
  /** Every live module-tier component. */
  modules: readonly HeuristicModule[];
  moduleDepth: number;
}

export interface ComputedSuggestion {
  key: string;
  kind: MergeSuggestionKind;
  members: string[];
  targetComponentId?: string;
  name: string;
  score: number;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Feature keys
// ---------------------------------------------------------------------------

function normaliseSegment(segment: string): string {
  let s = segment.toLowerCase().replace(/[-_\s.]/g, "");
  if (s.length > 3 && s.endsWith("s") && !/(ss|is|us)$/.test(s)) s = s.slice(0, -1);
  return s;
}

function isStrippedSegment(segment: string): boolean {
  if (/^\(.*\)$/.test(segment) || /^\[.*\]$/.test(segment) || segment.startsWith("@")) return true;
  return LAYER_SEGMENTS.has(segment.toLowerCase());
}

/**
 * The feature a folder stands for, or `""` when it names none: a pure layer
 * folder (`app/api`), a folder whose last segment is stripped, or a generic
 * name (`lib/utils`). `app/api/map` → `map`, `components/user-profile` → `userprofile`.
 */
export function featureKey(dir: string): string {
  const segments = dir.split("/").filter(Boolean);
  if (segments.length === 0) return "";
  if (isStrippedSegment(segments[segments.length - 1])) return "";
  const kept = segments.filter((s) => !isStrippedSegment(s)).map(normaliseSegment);
  const key = kept.join("/");
  return GENERIC_KEYS.has(kept[kept.length - 1]) ? "" : key;
}

/** `user-profile` → `User profile`. */
export function displayName(dir: string): string {
  const leaf = dir.split("/").filter(Boolean).pop() ?? dir;
  const words = leaf
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function suggestionKey(kind: MergeSuggestionKind, targetComponentId: string | undefined, members: readonly string[]): string {
  return `${kind}|${targetComponentId ?? ""}|${[...members].sort().join(",")}`;
}

function parentDirs(filePath: string): string[] {
  const parts = filePath.split("/");
  parts.pop();
  const dirs: string[] = [];
  for (let i = 1; i <= parts.length; i++) dirs.push(parts.slice(0, i).join("/"));
  return dirs;
}

function baseName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function computeMergeSuggestions(input: HeuristicInput): ComputedSuggestion[] {
  const ctx = new Context(input);
  const byKey = new Map<string, ComputedSuggestion>();
  const add = (suggestion: ComputedSuggestion | null) => {
    if (!suggestion || suggestion.members.length === 0) return;
    if (suggestion.score < MIN_SUGGESTION_SCORE) return;
    const existing = byKey.get(suggestion.key);
    if (!existing || existing.score < suggestion.score) byKey.set(suggestion.key, suggestion);
  };

  const nameGroupDirs = new Set<string>();
  for (const suggestion of ctx.sharedNameSuggestions()) {
    add(suggestion);
    for (const member of suggestion.members) nameGroupDirs.add(member);
  }
  for (const suggestion of ctx.importOnlySuggestions(nameGroupDirs)) add(suggestion);
  for (const suggestion of ctx.moveFileSuggestions()) add(suggestion);
  for (const suggestion of ctx.renameSuggestions()) add(suggestion);

  return [...byKey.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

class Context {
  private readonly moduleById: Map<string, HeuristicModule>;
  private readonly candidateDirs: string[];
  private readonly filesByDir = new Map<string, string[]>();
  private readonly sharedDirs = new Set<string>();
  /** File path → paths of the files it imports or is imported by (both directions, no self). */
  private readonly neighbours = new Map<string, string[]>();

  constructor(private readonly input: HeuristicInput) {
    this.moduleById = new Map(input.modules.map((m) => [m.id, m]));

    const maxDepth = Math.max(1, input.moduleDepth) + 1;
    for (const filePath of input.filePaths) {
      for (const dir of parentDirs(filePath)) {
        if (dir.split("/").length > maxDepth) break;
        const files = this.filesByDir.get(dir);
        if (files) files.push(filePath);
        else this.filesByDir.set(dir, [filePath]);
      }
    }
    this.candidateDirs = [...this.filesByDir.keys()].sort();

    for (const { from, to } of input.edges) {
      if (from === to) continue;
      this.pushNeighbour(from, to);
      this.pushNeighbour(to, from);
    }

    // Shared foundation: imported from many distinct other modules.
    const threshold = Math.max(SHARED_MIN_MODULES, Math.ceil(input.modules.length * SHARED_MODULE_SHARE));
    for (const dir of this.candidateDirs) {
      const inside = new Set(this.filesByDir.get(dir));
      const importers = new Set<string>();
      for (const { from, to } of input.edges) {
        if (!inside.has(to) || inside.has(from)) continue;
        const owner = input.ownerByFile.get(from);
        if (owner) importers.add(owner);
      }
      if (importers.size >= threshold) this.sharedDirs.add(dir);
    }
  }

  private pushNeighbour(a: string, b: string): void {
    const list = this.neighbours.get(a);
    if (list) list.push(b);
    else this.neighbours.set(a, [b]);
  }

  /** The merged module that owns every file under `dir`, if there is one. */
  private mergedOwnerOfDir(dir: string): string | null {
    const files = this.filesByDir.get(dir) ?? [];
    let owner: string | null = null;
    for (const file of files) {
      const id = this.input.ownerByFile.get(file);
      if (!id || this.moduleById.get(id)?.origin !== "merge") return null;
      if (owner && owner !== id) return null;
      owner = id;
    }
    return owner;
  }

  /**
   * How to refer to a folder module in a suggestion. Normally its folder
   * pattern — but a module shallower than the module depth only holds the
   * files sitting *directly* in its folder (`app/page.tsx`, while `app/map`
   * is its own module), and `app/**` would claim the whole tree. Those are
   * listed file by file instead.
   */
  private membersOf(mod: HeuristicModule): string[] {
    const dir = folderOfPattern(mod.pathPatterns[0] ?? "");
    if (dir === null) return [];
    if (dir.split("/").length >= this.input.moduleDepth) return [folderPattern(dir)];
    return [...this.input.ownerByFile]
      .filter(([, owner]) => owner === mod.id)
      .map(([file]) => file)
      .sort();
  }

  /** Imports inside the group ÷ imports touching it. 0 when nothing touches it. */
  private cohesion(files: ReadonlySet<string>): { inside: number; touching: number; value: number } {
    let inside = 0;
    let touching = 0;
    for (const { from, to } of this.input.edges) {
      const a = files.has(from);
      const b = files.has(to);
      if (!a && !b) continue;
      touching++;
      if (a && b) inside++;
    }
    return { inside, touching, value: touching === 0 ? 0 : inside / touching };
  }

  private filesUnder(dirs: readonly string[]): Set<string> {
    const files = new Set<string>();
    for (const dir of dirs) for (const f of this.filesByDir.get(dir) ?? []) files.add(f);
    return files;
  }

  private cohesionReason(c: { inside: number; touching: number }): string {
    return c.touching === 0 ? "no imports touch these folders yet" : `${c.inside} of ${c.touching} imports stay inside`;
  }

  // --- 1. shared feature name ---------------------------------------------

  sharedNameSuggestions(): ComputedSuggestion[] {
    const dirsByKey = new Map<string, string[]>();
    for (const dir of this.candidateDirs) {
      if (this.sharedDirs.has(dir)) continue;
      const key = featureKey(dir);
      if (!key) continue;
      const list = dirsByKey.get(key);
      if (list) list.push(dir);
      else dirsByKey.set(key, [dir]);
    }

    const out: ComputedSuggestion[] = [];
    for (const [key, dirs] of dirsByKey) {
      // Keep the shallowest of nested folders (`app/map` over `app/map/[id]`).
      const roots = dirs.filter((dir) => !dirs.some((other) => other !== dir && isUnderFolder(dir, other)));
      if (roots.length < 2) continue;

      const owners = new Set(roots.map((dir) => this.mergedOwnerOfDir(dir)));
      const mergedOwners = [...owners].filter((o): o is string => o !== null);
      if (mergedOwners.length > 1) continue; // two features already — merging features isn't offered
      const target = mergedOwners[0];
      const newDirs = target ? roots.filter((dir) => this.mergedOwnerOfDir(dir) !== target) : roots;
      if (newDirs.length === 0) continue;

      const c = this.cohesion(this.filesUnder(roots));
      const members = newDirs.map(folderPattern).sort();
      const kind: MergeSuggestionKind = target ? "extend" : "merge";
      out.push({
        key: suggestionKey(kind, target, members),
        kind,
        members,
        targetComponentId: target,
        name: target ? (this.moduleById.get(target)?.name ?? displayName(roots[0])) : displayName(roots[0]),
        score: 0.5 + 0.5 * c.value,
        reasons: [`shared name "${key.split("/").pop()}"`, this.cohesionReason(c)],
      });
    }
    return out;
  }

  // --- 2. import-only ---------------------------------------------------------

  importOnlySuggestions(alreadySuggested: ReadonlySet<string>): ComputedSuggestion[] {
    const out: ComputedSuggestion[] = [];
    for (const mod of this.input.modules) {
      if (mod.origin !== "folder") continue;
      const dir = folderOfPattern(mod.pathPatterns[0] ?? "");
      if (dir === null || dir === "" || this.sharedDirs.has(dir)) continue;
      if (alreadySuggested.has(folderPattern(dir))) continue;

      const incoming = new Map<string, number>();
      let total = 0;
      for (const { from, to } of this.input.edges) {
        if (this.input.ownerByFile.get(to) !== mod.id) continue;
        const source = this.input.ownerByFile.get(from);
        if (!source || source === mod.id) continue;
        total++;
        incoming.set(source, (incoming.get(source) ?? 0) + 1);
      }
      if (total < IMPORT_ONLY_MIN_EDGES) continue;
      const [topId, topCount] = [...incoming].sort((a, b) => b[1] - a[1])[0];
      const share = topCount / total;
      if (share < IMPORT_ONLY_SHARE) continue;
      const top = this.moduleById.get(topId);
      if (!top) continue;

      const groupFiles = new Set<string>();
      for (const [file, owner] of this.input.ownerByFile) {
        if (owner === mod.id || owner === topId) groupFiles.add(file);
      }
      const c = this.cohesion(groupFiles);
      const reasons = [`${Math.round(share * 100)}% of ${mod.name}'s imports come from ${top.name}`, this.cohesionReason(c)];
      const score = 0.5 * share + 0.5 * c.value;

      const members = this.membersOf(mod);
      if (top.origin === "merge") {
        // Individual files (a shallow module) are a file move, and share a
        // key with the same move found by the move-file heuristic.
        const kind: MergeSuggestionKind = members.every((m) => folderOfPattern(m) === null) ? "move-file" : "extend";
        out.push({ key: suggestionKey(kind, topId, members), kind, members, targetComponentId: topId, name: top.name, score, reasons });
        continue;
      }
      const topDir = folderOfPattern(top.pathPatterns[0] ?? "");
      if (topDir === null || topDir === "") continue;
      // A folder and its own subfolder, or a folder already in a shared-name
      // suggestion (which covers it better), is not a separate suggestion.
      if (isUnderFolder(dir, topDir) || isUnderFolder(topDir, dir)) continue;
      if (alreadySuggested.has(folderPattern(topDir))) continue;
      const merged = [...this.membersOf(top), ...members].sort();
      // Name it after whichever folder names a feature (`components/home`, not the `app` layer).
      const nameDir = featureKey(topDir) ? topDir : featureKey(dir) ? dir : topDir;
      out.push({ key: suggestionKey("merge", undefined, merged), kind: "merge", members: merged, name: displayName(nameDir), score, reasons });
    }
    return out;
  }

  // --- 3. move file (split) ---------------------------------------------------

  moveFileSuggestions(): ComputedSuggestion[] {
    const merged = this.input.modules.filter((m) => m.origin === "merge");
    if (merged.length === 0) return [];
    const mergedIds = new Set(merged.map((m) => m.id));

    // (folder module, target feature) → files and their shares
    const groups = new Map<string, { folder: HeuristicModule; target: HeuristicModule; files: string[]; shares: number[] }>();
    for (const mod of this.input.modules) {
      if (mod.origin !== "folder") continue;
      const dir = folderOfPattern(mod.pathPatterns[0] ?? "");
      if (dir !== null && this.sharedDirs.has(dir)) continue;

      for (const [file, owner] of this.input.ownerByFile) {
        if (owner !== mod.id) continue;
        const neighbours = this.neighbours.get(file) ?? [];
        if (neighbours.length < MOVE_FILE_MIN_EDGES) continue;
        const counts = new Map<string, number>();
        for (const n of neighbours) {
          const o = this.input.ownerByFile.get(n);
          if (o && mergedIds.has(o)) counts.set(o, (counts.get(o) ?? 0) + 1);
        }
        const best = [...counts].sort((a, b) => b[1] - a[1])[0];
        if (!best || best[1] < MOVE_FILE_MIN_EDGES) continue;
        const share = best[1] / neighbours.length;
        if (share < MOVE_FILE_SHARE) continue;

        const groupKey = `${mod.id}→${best[0]}`;
        const group = groups.get(groupKey) ?? { folder: mod, target: this.moduleById.get(best[0])!, files: [], shares: [] };
        group.files.push(file);
        group.shares.push(share);
        groups.set(groupKey, group);
      }
    }

    return [...groups.values()].map(({ folder, target, files, shares }) => {
      const members = files.sort();
      const score = shares.reduce((a, b) => a + b, 0) / shares.length;
      return {
        key: suggestionKey("move-file", target.id, members),
        kind: "move-file" as const,
        members,
        targetComponentId: target.id,
        name: target.name,
        score,
        reasons: [
          `${members.length} file(s) in ${folder.name} mostly import or are imported by ${target.name}`,
        ],
      };
    });
  }

  // --- 4. rename --------------------------------------------------------------

  renameSuggestions(): ComputedSuggestion[] {
    const out: ComputedSuggestion[] = [];
    for (const mod of this.input.modules) {
      if (mod.origin !== "merge" || !mod.lostFolders?.length) continue;
      for (const lost of mod.lostFolders) {
        if (lost.fileNames.length === 0) continue;
        const lostNames = new Set(lost.fileNames);
        let best: { dir: string; share: number } | null = null;
        for (const dir of this.candidateDirs) {
          if (this.sharedDirs.has(dir) || this.mergedOwnerOfDir(dir) === mod.id) continue;
          const names = new Set((this.filesByDir.get(dir) ?? []).map(baseName));
          let hit = 0;
          for (const name of lostNames) if (names.has(name)) hit++;
          const share = hit / lostNames.size;
          if (share < RENAME_NAME_SHARE) continue;
          // Prefer the higher share, then the deeper (more specific) folder.
          if (!best || share > best.share || (share === best.share && dir.length > best.dir.length)) best = { dir, share };
        }
        if (!best) continue;
        const members = [folderPattern(best.dir)];
        out.push({
          key: suggestionKey("extend", mod.id, members),
          kind: "extend",
          members,
          targetComponentId: mod.id,
          name: mod.name,
          score: best.share,
          reasons: [`looks like ${lost.pattern} moved here (${Math.round(best.share * 100)}% same file names)`],
        });
      }
    }
    return out;
  }
}
