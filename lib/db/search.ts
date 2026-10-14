// What the command palette (DESIGN.md §6.18) searches that no other table
// keeps: the declarations of an analysed commit, the PRs/branches/commits
// last listed from the git host, and what the reviewer picked.

import { all, get, run, transaction } from "./client";
import { readKv, writeKv } from "./kv";

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

export interface SymbolIndexEntry {
  name: string;
  qualified: string;
  kind: string;
  file: string;
  line: number;
  exported: boolean;
}

/** How many review heads a repo keeps an index for, besides its tip. */
const KEEP_HEADS = 5;

/**
 * Replaces the symbol index of `sha`. `role` is `tip` for the repo's analysed
 * commit (the previous tip's index is dropped) or `head` for a review
 * target's head (only the newest few are kept).
 */
export function writeSymbolIndex(repoId: string, sha: string, role: "tip" | "head", entries: readonly SymbolIndexEntry[]): void {
  transaction(() => {
    run(`DELETE FROM symbol_index WHERE repo_id = ? AND sha = ?`, repoId, sha);
    for (const e of entries) {
      run(
        `INSERT INTO symbol_index (repo_id, sha, name, qualified, kind, file, line, exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        repoId,
        sha,
        e.name,
        e.qualified,
        e.kind,
        e.file,
        e.line,
        e.exported ? 1 : 0
      );
    }
    // The tip stays a tip even when a head is the same commit.
    const existing = get<{ role: string }>(`SELECT role FROM symbol_index_sets WHERE repo_id = ? AND sha = ?`, repoId, sha);
    const nextRole = existing?.role === "tip" || role === "tip" ? "tip" : "head";
    run(
      `INSERT INTO symbol_index_sets (repo_id, sha, role, built_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo_id, sha) DO UPDATE SET role = excluded.role, built_at = excluded.built_at`,
      repoId,
      sha,
      nextRole,
      Date.now()
    );
    if (role === "tip") {
      run(`UPDATE symbol_index_sets SET role = 'head' WHERE repo_id = ? AND role = 'tip' AND sha <> ?`, repoId, sha);
    }
    const stale = all<{ sha: string }>(
      `SELECT sha FROM symbol_index_sets WHERE repo_id = ? AND role = 'head' ORDER BY built_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
      repoId,
      KEEP_HEADS
    );
    for (const { sha: old } of stale) {
      run(`DELETE FROM symbol_index WHERE repo_id = ? AND sha = ?`, repoId, old);
      run(`DELETE FROM symbol_index_sets WHERE repo_id = ? AND sha = ?`, repoId, old);
    }
  });
}

export function hasSymbolIndex(repoId: string, sha: string): boolean {
  return Boolean(get(`SELECT 1 AS x FROM symbol_index_sets WHERE repo_id = ? AND sha = ?`, repoId, sha));
}

/** Declarations of `sha` whose name or qualified name is LIKE `pattern` (escape `\`), at most `limit`. */
export function findSymbols(repoId: string, sha: string, pattern: string, limit: number): SymbolIndexEntry[] {
  return all<{ name: string; qualified: string; kind: string; file: string; line: number; exported: number }>(
    `SELECT name, qualified, kind, file, line, exported FROM symbol_index
     WHERE repo_id = ? AND sha = ? AND (qualified LIKE ? ESCAPE '\\')
     LIMIT ?`,
    repoId,
    sha,
    pattern,
    limit
  ).map((r) => ({ ...r, exported: r.exported === 1 }));
}

// ---------------------------------------------------------------------------
// Files and components
// ---------------------------------------------------------------------------

/** Analysed files of the repo whose path is LIKE `pattern`, with their owning component. */
export function findFiles(repoId: string, pattern: string, limit: number): Array<{ path: string; componentId?: string }> {
  return all<{ path: string; componentId: string | null }>(
    `SELECT f.path AS path, o.component_id AS componentId
     FROM files f LEFT JOIN file_owners o ON o.file_id = f.id
     WHERE f.repo_id = ? AND f.path LIKE ? ESCAPE '\\'
     LIMIT ?`,
    repoId,
    pattern,
    limit
  ).map((r) => ({ path: r.path, ...(r.componentId ? { componentId: r.componentId } : {}) }));
}

// ---------------------------------------------------------------------------
// PRs, branches and commits as last listed (no network while typing)
// ---------------------------------------------------------------------------

export interface RemoteSnapshot {
  prs: Array<{ number: number; title: string; state: string; draft?: boolean; author: string | null; headRef: string; baseRef: string; url: string; updatedAt: string }>;
  branches: Array<{ name: string; commitSha: string }>;
  commits: Array<{ sha: string; subject: string; author: string | null; date: string; parent?: string }>;
  fetchedAt: { prs?: string; branches?: string; commits?: string };
}

const EMPTY_SNAPSHOT: RemoteSnapshot = { prs: [], branches: [], commits: [], fetchedAt: {} };
const MAX_PRS = 500;

function snapshotKey(repoId: string): string {
  return `palette:remote:${repoId}`;
}

export function readRemoteSnapshot(repoId: string): RemoteSnapshot {
  return { ...EMPTY_SNAPSHOT, ...(readKv<RemoteSnapshot>(snapshotKey(repoId)) ?? {}) };
}

/**
 * Folds a listing into the snapshot: PRs are merged by number (a listing is
 * often one state or a page of them); branches and the default branch's
 * commits replace what was there.
 */
export function rememberRemote(
  repoId: string,
  part: { prs?: RemoteSnapshot["prs"]; branches?: RemoteSnapshot["branches"]; commits?: RemoteSnapshot["commits"] }
): void {
  const snap = readRemoteSnapshot(repoId);
  const now = new Date().toISOString();
  if (part.prs) {
    const byNumber = new Map(snap.prs.map((p) => [p.number, p]));
    for (const pr of part.prs) byNumber.set(pr.number, pr);
    snap.prs = [...byNumber.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_PRS);
    snap.fetchedAt.prs = now;
  }
  if (part.branches) {
    snap.branches = part.branches;
    snap.fetchedAt.branches = now;
  }
  if (part.commits) {
    snap.commits = part.commits;
    snap.fetchedAt.commits = now;
  }
  writeKv(snapshotKey(repoId), snap);
}

// ---------------------------------------------------------------------------
// History: what was picked, for recents and ranking
// ---------------------------------------------------------------------------

const MAX_HISTORY = 200;

export interface PaletteHistoryRow<T> {
  key: string;
  item: T;
  uses: number;
  lastUsed: number;
}

/** Records a pick of `item` (stored as given) under `key`; `repoId` is `''` outside a repo. */
export function recordPalettePick(repoId: string, key: string, item: unknown): void {
  transaction(() => {
    run(
      `INSERT INTO palette_history (repo_id, key, item, uses, last_used) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (repo_id, key) DO UPDATE SET item = excluded.item, uses = uses + 1, last_used = excluded.last_used`,
      repoId,
      key,
      JSON.stringify(item),
      Date.now()
    );
    run(
      `DELETE FROM palette_history WHERE repo_id = ? AND key IN (
         SELECT key FROM palette_history WHERE repo_id = ? ORDER BY last_used DESC LIMIT -1 OFFSET ?)`,
      repoId,
      repoId,
      MAX_HISTORY
    );
  });
}

/** The most recent picks first. */
export function readPaletteHistory<T>(repoId: string, limit = MAX_HISTORY): PaletteHistoryRow<T>[] {
  const out: PaletteHistoryRow<T>[] = [];
  for (const row of all<{ key: string; item: string; uses: number; last_used: number }>(
    `SELECT key, item, uses, last_used FROM palette_history WHERE repo_id = ? ORDER BY last_used DESC LIMIT ?`,
    repoId,
    limit
  )) {
    try {
      out.push({ key: row.key, item: JSON.parse(row.item) as T, uses: row.uses, lastUsed: row.last_used });
    } catch {
      /* unreadable row: skipped */
    }
  }
  return out;
}
