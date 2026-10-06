/**
 * Splitting oversized folder modules (DESIGN.md §6.1).
 *
 * The module tier cuts the repo at a fixed folder depth, so one big flat
 * folder (`components/graph`, 48 files) is one module however many features
 * live in it — and a module is the unit of a review call, a PR map card and
 * a node in the app map. `splitLargeModules` runs right after
 * `clusterByFolderDepth` and only touches modules above
 * {@link MAX_MODULE_FILES}:
 *
 *   1. Folder cut — subfolders with at least {@link MIN_PART_FILES} files
 *      become modules of their own (`analysis/languages`), as long as no
 *      part keeps more than {@link MAX_PART_SHARE} of the files (a
 *      route tree of one-file folders stays whole).
 *   2. Name cut, for what is still too large and flat — files are grouped by
 *      their name's leading word(s) (`PrMapNode`, `usePrMap`, `pr-map-types`
 *      → "pr map"; a test is named for its subject); groups too small to
 *      stand alone join the group most of their imports go to, while it
 *      stays small. Hub files (barrels, a view that
 *      imports everything, `types` that everything imports) never drive a
 *      grouping and stay behind.
 *
 * What stays behind is the *core*: it keeps the module's name, folder and
 * `<folder>/**` pattern, so its id, description, findings and any new file
 * in the folder stay where they were. Split-off parts of a name cut list
 * their files exactly (`exactFiles`).
 *
 * Pure and deterministic: same files and edges in, same modules out — the
 * names (and so the component ids) only move when files are renamed or the
 * imports between them change shape.
 */
import type { ModuleCluster } from "./graph-builder";

/** Modules with more files than this are split. */
export const MAX_MODULE_FILES = 30;
/** The smallest part worth its own module. */
export const MIN_PART_FILES = 3;
/** A cut is only taken when no part (the core included) keeps more than this share of the files. */
const MAX_PART_SHARE = 0.75;
/** A small name group is never folded into a group that would grow past this. */
const MAX_FOLDED_PART_FILES = 12;
/** …and only into the group holding at least this share of its imports into other groups. */
const MIN_FOLD_SHARE = 0.5;
/**
 * A name cut needs at least this many imports between the folder's files per
 * file. Below it the folder is a library of independent pieces (a `ui/` of
 * primitives), and any grouping of them would be arbitrary.
 */
const MIN_LINKS_PER_FILE = 1;
/** A file importing, or imported by, at least this share of its module's files (and ≥ `HUB_MIN`) is a hub. */
const HUB_SHARE = 0.25;
const HUB_MIN = 6;
/** Barrel files: always hubs. */
const BARREL = /^(index\.[cm]?[jt]sx?|mod\.rs|__init__\.py|package-info\.java)$/i;
/** Separator between a module's name and a name-cut part's words. */
export const PART_SEPARATOR = " · ";

type Edge = { from: string; to: string };

function baseName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") && !/(ss|is|us|as)$/.test(word) ? word.slice(0, -1) : word;
}

/**
 * The words a file's name leads with — what groups it with its siblings:
 * `PrMapCanvas.tsx` → "pr map", `useChecklist.ts` → "checklist",
 * `review-visuals.ts` → "review". One word, or two when the first is short
 * (`pr`, `app`, `db`) and says too little alone, or repeats `moduleWord`,
 * the module's own name (`GraphCanvas` in `graph` → "graph canvas"). `""`
 * for a name with no letters.
 */
export function nameStem(filePath: string, moduleWord = ""): string {
  const stem = baseName(filePath)
    .split(".")[0]
    .replace(/^(smoke[-_]?)?tests?[-_]|[-_](test|spec)s?$|(Tests?|Spec|IT)$/g, "")
    .replace(/^use(?=[A-Z_-])/, "");
  const words = stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => /[a-z]/.test(w));
  if (words.length === 0) return "";
  const short = words[0].length <= 3 || singular(words[0]) === moduleWord;
  const lead = short && words.length > 1 ? words.slice(0, 2) : words.slice(0, 1);
  return lead.map(singular).join(" ");
}

/** Hubs among `files`: barrels, and files with an import fan-out or fan-in over the hub threshold. */
function findHubs(files: readonly string[], edges: readonly Edge[]): Set<string> {
  const threshold = Math.max(HUB_MIN, Math.ceil(files.length * HUB_SHARE));
  const out = new Map<string, number>();
  const into = new Map<string, number>();
  for (const { from, to } of edges) {
    out.set(from, (out.get(from) ?? 0) + 1);
    into.set(to, (into.get(to) ?? 0) + 1);
  }
  return new Set(
    files.filter(
      (f) => BARREL.test(baseName(f)) || (out.get(f) ?? 0) >= threshold || (into.get(f) ?? 0) >= threshold
    )
  );
}

/** Distinct import edges with both ends in `files`, self-imports dropped. */
function edgesWithin(files: ReadonlySet<string>, edges: readonly Edge[]): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const edge of edges) {
    if (edge.from === edge.to || !files.has(edge.from) || !files.has(edge.to)) continue;
    const key = `${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

/** Path below `folder`, or the path itself for the root folder. */
function relativeTo(folder: string, filePath: string): string {
  return folder === "" ? filePath : filePath.slice(folder.length + 1);
}

/** Step 1. `null` when no acceptable folder cut exists. */
function folderCut(cluster: ModuleCluster): ModuleCluster[] | null {
  const bySub = new Map<string, string[]>();
  const rest: string[] = [];
  for (const filePath of cluster.filePaths) {
    const rel = relativeTo(cluster.folder, filePath);
    const slash = rel.indexOf("/");
    if (slash === -1) {
      rest.push(filePath);
      continue;
    }
    const sub = rel.slice(0, slash);
    const list = bySub.get(sub);
    if (list) list.push(filePath);
    else bySub.set(sub, [filePath]);
  }
  const parts: ModuleCluster[] = [];
  for (const [sub, files] of [...bySub].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (files.length < MIN_PART_FILES) {
      rest.push(...files);
      continue;
    }
    parts.push({
      name: `${cluster.name}/${sub}`,
      folder: cluster.folder === "" ? sub : `${cluster.folder}/${sub}`,
      filePaths: files,
    });
  }
  if (parts.length === 0 || parts.length + (rest.length > 0 ? 1 : 0) < 2) return null;
  const largest = Math.max(rest.length, ...parts.map((p) => p.filePaths.length));
  if (largest > cluster.filePaths.length * MAX_PART_SHARE) return null;
  return [...(rest.length > 0 ? [{ ...cluster, filePaths: rest.sort() }] : []), ...parts];
}

/** Step 2. `null` when the names and imports give no useful cut. */
function nameCut(cluster: ModuleCluster, edges: readonly Edge[]): ModuleCluster[] | null {
  const files = cluster.filePaths;
  const inside = edgesWithin(new Set(files), edges);
  if (inside.length < files.length * MIN_LINKS_PER_FILE) return null;
  const moduleWord = singular(
    (cluster.folder.split("/").pop() ?? "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").pop()?.toLowerCase() ?? ""
  );
  const hubs = findHubs(files, inside);
  const links = inside.filter((e) => !hubs.has(e.from) && !hubs.has(e.to));

  const groups = new Map<string, Set<string>>();
  const core: string[] = [...hubs];
  for (const filePath of files) {
    if (hubs.has(filePath)) continue;
    const key = nameStem(filePath, moduleWord);
    if (!key) {
      core.push(filePath);
      continue;
    }
    const group = groups.get(key);
    if (group) group.add(filePath);
    else groups.set(key, new Set([filePath]));
  }

  // Fold groups too small to stand alone into the group they share most
  // imports with; a small group sharing none stays in the core.
  for (;;) {
    const small = [...groups]
      .filter(([, members]) => members.size < MIN_PART_FILES)
      .sort((a, b) => a[1].size - b[1].size || a[0].localeCompare(b[0]))[0];
    if (!small) break;
    const [key, members] = small;
    groups.delete(key);
    const affinity = new Map<string, number>();
    for (const { from, to } of links) {
      const other = members.has(from) ? to : members.has(to) ? from : null;
      if (!other || members.has(other)) continue;
      for (const [otherKey, otherMembers] of groups) {
        if (otherMembers.has(other)) affinity.set(otherKey, (affinity.get(otherKey) ?? 0) + 1);
      }
    }
    // Shared helpers (links spread over several groups) and folds that would
    // snowball one group into a grab bag stay in the core instead.
    const total = [...affinity.values()].reduce((sum, n) => sum + n, 0);
    const best = [...affinity]
      .filter(([otherKey]) => groups.get(otherKey)!.size + members.size <= MAX_FOLDED_PART_FILES)
      .sort((a, b) => b[1] - a[1] || groups.get(a[0])!.size - groups.get(b[0])!.size || a[0].localeCompare(b[0]))[0];
    if (best && best[1] >= total * MIN_FOLD_SHARE) for (const m of members) groups.get(best[0])!.add(m);
    else core.push(...members);
  }

  if (groups.size === 0 || (groups.size === 1 && core.length === 0)) return null;
  const largest = Math.max(core.length, ...[...groups.values()].map((g) => g.size));
  if (largest > files.length * MAX_PART_SHARE) return null;
  const parts: ModuleCluster[] = [...groups]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, members]) => ({
      name: `${cluster.name}${PART_SEPARATOR}${key}`,
      folder: cluster.folder,
      filePaths: [...members].sort(),
      exactFiles: true as const,
    }));
  return [...(core.length > 0 ? [{ ...cluster, filePaths: core.sort() }] : []), ...parts];
}

function splitOne(cluster: ModuleCluster, edges: readonly Edge[], depth: number): ModuleCluster[] {
  if (cluster.filePaths.length <= MAX_MODULE_FILES || depth > 8 || cluster.exactFiles) return [cluster];
  const byFolder = folderCut(cluster);
  if (byFolder) {
    // The core (same folder) only re-splits by name: its subfolders were all too small to cut.
    return byFolder.flatMap((part) =>
      part.folder === cluster.folder
        ? (part.filePaths.length > MAX_MODULE_FILES ? (nameCut(part, edges) ?? [part]) : [part])
        : splitOne(part, edges, depth + 1)
    );
  }
  return nameCut(cluster, edges) ?? [cluster];
}

/**
 * Splits every module above {@link MAX_MODULE_FILES} files; smaller ones
 * pass through untouched. Names stay unique (a clash gets " (2)", …), and
 * the result is sorted by name like `clusterByFolderDepth`'s.
 */
export function splitLargeModules(
  clusters: readonly ModuleCluster[],
  edges: readonly Edge[]
): ModuleCluster[] {
  const out = clusters.flatMap((cluster) => splitOne(cluster, edges, 0));
  const used = new Set<string>();
  // Untouched and core modules claim their names first, so a part never renames one.
  const original = new Set(clusters.map((c) => `${c.name}\u0000${c.folder}`));
  const isOriginal = (m: ModuleCluster): boolean => !m.exactFiles && original.has(`${m.name}\u0000${m.folder}`);
  const order = [...out.keys()].sort(
    (a, b) => Number(!isOriginal(out[a])) - Number(!isOriginal(out[b])) || a - b
  );
  for (const i of order) {
    const base = out[i].name;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    out[i] = { ...out[i], name };
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
