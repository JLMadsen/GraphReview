// The Files view's tree (DESIGN.md §6.14): the flat entry list as directories,
// the directories a change touches, and the fuzzy file search.

import type { RepoTreeEntryDTO } from "../files-types";

export interface FileEntry extends RepoTreeEntryDTO {
  name: string;
  /** Not in the analysed commit — the selected diff adds it. */
  added?: boolean;
}

export interface DirNode {
  path: string;
  name: string;
  dirs: string[];
  files: FileEntry[];
}

export const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function buildTree(entries: readonly FileEntry[]): Map<string, DirNode> {
  const dirs = new Map<string, DirNode>([["", { path: "", name: "", dirs: [], files: [] }]]);
  const ensure = (path: string): DirNode => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const node: DirNode = { path, name: nameOf(path), dirs: [], files: [] };
    dirs.set(path, node);
    ensure(parentOf(path)).dirs.push(path);
    return node;
  };
  for (const entry of entries) ensure(parentOf(entry.path)).files.push(entry);
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  for (const node of dirs.values()) {
    node.dirs.sort((a, b) => byName(nameOf(a), nameOf(b)));
    node.files.sort((a, b) => byName(a.name, b.name));
  }
  return dirs;
}

/** A folder holding nothing but one folder reads as one row: `src/main/java`. */
export function collapseChain(dirs: Map<string, DirNode>, path: string): string {
  let node = dirs.get(path);
  while (node && node.files.length === 0 && node.dirs.length === 1) {
    path = node.dirs[0];
    node = dirs.get(path);
  }
  return path;
}

/** Every folder above a changed file. */
export function changedDirsOf(files: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    let p = parentOf(f);
    while (p && !out.has(p)) {
      out.add(p);
      p = parentOf(p);
    }
  }
  return out;
}

/** The shortest stretch of `text` holding `q`'s characters in order, or `null` when it doesn't. */
export function tightestSpan(text: string, q: string): number | null {
  let best: number | null = null;
  for (let start = text.indexOf(q[0]); start !== -1; start = text.indexOf(q[0], start + 1)) {
    let i = 1;
    let end = start;
    while (i < q.length) {
      end = text.indexOf(q[i], end + 1);
      if (end === -1) return best;
      i++;
    }
    const span = end - start + 1;
    if (best === null || span < best) best = span;
  }
  return best;
}

/**
 * Fuzzy "go to file": the query's characters in order. A hit in the file's
 * name beats one across its folders, a run of them beats scattered ones.
 */
export function findFiles(entries: readonly FileEntry[], query: string, limit = 80): FileEntry[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return [];
  const scored: Array<{ entry: FileEntry; score: number }> = [];
  for (const entry of entries) {
    const path = entry.path.toLowerCase();
    const name = entry.name.toLowerCase();
    let score: number;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (path.includes(q)) score = 2;
    else {
      const inName = tightestSpan(name, q);
      const inPath = inName === null ? tightestSpan(path, q) : null;
      if (inName === null && inPath === null) continue;
      score = inName !== null ? 3 + inName / 1000 : 4 + inPath! / 10_000;
    }
    scored.push({ entry, score });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path));
  return scored.slice(0, limit).map((s) => s.entry);
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const README = /^readme(\.(md|markdown|mdx|txt|rst))?$/i;

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

/** Shown as a picture (lib/jobs/repo-tree.ts `IMAGE_TYPES`, served by `/raw`). */
export const isImage = (path: string) => /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(path);

export const rawUrl = (repoId: string, sha: string, path: string) =>
  `/api/repos/${encodeURIComponent(repoId)}/raw?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(sha)}`;
