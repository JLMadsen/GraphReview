// What the base/head graph comparison of one review target found
// (lib/jobs/target-graph.ts): the structure diff and the call graph, as one
// JSON document per target, replaced whenever the target is recomputed.

import { get, run } from "./client";

export interface StoredTargetGraph<T> {
  baseSha: string;
  headSha: string;
  computedAt: string;
  data: T;
}

export function readTargetGraph<T>(repoId: string, targetKey: string): StoredTargetGraph<T> | null {
  const row = get<{ base_sha: string; head_sha: string; computed_at: string; data: string }>(
    `SELECT base_sha, head_sha, computed_at, data FROM target_graphs WHERE repo_id = ? AND target_key = ?`,
    repoId,
    targetKey
  );
  if (!row) return null;
  try {
    return { baseSha: row.base_sha, headSha: row.head_sha, computedAt: row.computed_at, data: JSON.parse(row.data) as T };
  } catch {
    return null;
  }
}

export function writeTargetGraph(repoId: string, targetKey: string, value: StoredTargetGraph<unknown>): void {
  run(
    `INSERT INTO target_graphs (repo_id, target_key, base_sha, head_sha, computed_at, data) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, target_key) DO UPDATE SET
       base_sha = excluded.base_sha, head_sha = excluded.head_sha,
       computed_at = excluded.computed_at, data = excluded.data`,
    repoId,
    targetKey,
    value.baseSha,
    value.headSha,
    value.computedAt,
    JSON.stringify(value.data)
  );
}

export function deleteTargetGraphsForRepo(repoId: string): number {
  return run(`DELETE FROM target_graphs WHERE repo_id = ?`, repoId);
}
