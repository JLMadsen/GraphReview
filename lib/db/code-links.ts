// The code views' links and usages (DESIGN.md §6.28): per analysed commit,
// each file's import specifiers and names that lead to another file or a
// declaration, and its declarations with a usage count (one row per file, so
// a viewer reads only the file it shows); and per declaration, where it is
// used (one row per declaration, read when its usages dialog opens).
// Built by lib/analysis/code-links.ts.

import type { CodeDecl, CodeLink, CodeLinkIndex, CodeUsageIndex, UsageFile } from "@/lib/analysis/code-links";
import { all, get, run, transaction } from "./client";

/** How many review-target commits (heads and merge-bases) a repo keeps links for, besides its tip. */
const KEEP_TARGET_SHAS = 10;

export interface StoredFileLinks {
  links: CodeLink[];
  decls: CodeDecl[];
}

function dropSet(repoId: string, sha: string): void {
  run(`DELETE FROM code_links WHERE repo_id = ? AND sha = ?`, repoId, sha);
  run(`DELETE FROM code_usages WHERE repo_id = ? AND sha = ?`, repoId, sha);
}

/**
 * Replaces the links and usages of `sha`. `role` is `tip` for the repo's
 * analysed commit (the previous tip's set is dropped) or `target` for a
 * review target's head or merge-base (only the newest few are kept).
 */
export function writeCodeLinks(repoId: string, sha: string, role: "tip" | "target", links: CodeLinkIndex, usages: CodeUsageIndex): void {
  transaction(() => {
    dropSet(repoId, sha);
    for (const file of new Set([...links.keys(), ...usages.decls.keys()])) {
      const row: StoredFileLinks = { links: links.get(file) ?? [], decls: usages.decls.get(file) ?? [] };
      run(`INSERT INTO code_links (repo_id, sha, file, links) VALUES (?, ?, ?, ?)`, repoId, sha, file, JSON.stringify(row));
    }
    for (const [id, files] of usages.usages) {
      run(`INSERT INTO code_usages (repo_id, sha, decl_id, data) VALUES (?, ?, ?, ?)`, repoId, sha, id, JSON.stringify(files));
    }
    // The tip stays a tip even when a target end is the same commit.
    const existing = get<{ role: string }>(`SELECT role FROM code_link_sets WHERE repo_id = ? AND sha = ?`, repoId, sha);
    const nextRole = existing?.role === "tip" || role === "tip" ? "tip" : "target";
    run(
      `INSERT INTO code_link_sets (repo_id, sha, role, built_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo_id, sha) DO UPDATE SET role = excluded.role, built_at = excluded.built_at`,
      repoId,
      sha,
      nextRole,
      Date.now()
    );
    if (role === "tip") {
      run(`UPDATE code_link_sets SET role = 'target' WHERE repo_id = ? AND role = 'tip' AND sha <> ?`, repoId, sha);
    }
    const stale = all<{ sha: string }>(
      `SELECT sha FROM code_link_sets WHERE repo_id = ? AND role = 'target' ORDER BY built_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
      repoId,
      KEEP_TARGET_SHAS
    );
    for (const { sha: old } of stale) {
      dropSet(repoId, old);
      run(`DELETE FROM code_link_sets WHERE repo_id = ? AND sha = ?`, repoId, old);
    }
  });
}

function hasSet(repoId: string, sha: string): boolean {
  return Boolean(get(`SELECT 1 AS x FROM code_link_sets WHERE repo_id = ? AND sha = ?`, repoId, sha));
}

/** The links and declarations of `file` at `sha`: `null` when that commit has no set (not analysed since links were added). */
export function readCodeLinks(repoId: string, sha: string, file: string): StoredFileLinks | null {
  if (!hasSet(repoId, sha)) return null;
  const row = get<{ links: string }>(`SELECT links FROM code_links WHERE repo_id = ? AND sha = ? AND file = ?`, repoId, sha, file);
  if (!row) return { links: [], decls: [] };
  try {
    const parsed = JSON.parse(row.links) as StoredFileLinks | CodeLink[];
    // A set written before declarations were stored: links only.
    return Array.isArray(parsed) ? { links: parsed, decls: [] } : parsed;
  } catch {
    return { links: [], decls: [] };
  }
}

/** Where declaration `id` is used at `sha`: `null` when that commit has no set, `[]` when nothing uses it. */
export function readCodeUsages(repoId: string, sha: string, id: string): UsageFile[] | null {
  if (!hasSet(repoId, sha)) return null;
  const row = get<{ data: string }>(`SELECT data FROM code_usages WHERE repo_id = ? AND sha = ? AND decl_id = ?`, repoId, sha, id);
  if (!row) return [];
  try {
    return JSON.parse(row.data) as UsageFile[];
  } catch {
    return [];
  }
}
