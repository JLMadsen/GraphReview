// The schema catalog of a repo's analysed commit (lib/analysis/db/,
// DESIGN.md §6.13): one JSON document per repo, replaced by every analysis.
// A review target's schema change is stored with its target graph
// (`target_graphs.data.db`), not here.

import type { DbSchema } from "@/lib/analysis/db/types";
import { get, run } from "./client";

export interface StoredDbSchema {
  sha: string;
  computedAt: string;
  schema: DbSchema;
}

export function readDbSchema(repoId: string): StoredDbSchema | null {
  const row = get<{ sha: string; computed_at: string; data: string }>(
    `SELECT sha, computed_at, data FROM db_schemas WHERE repo_id = ?`,
    repoId
  );
  if (!row) return null;
  try {
    return { sha: row.sha, computedAt: row.computed_at, schema: JSON.parse(row.data) as DbSchema };
  } catch {
    return null;
  }
}

export function writeDbSchema(repoId: string, sha: string, schema: DbSchema): void {
  run(
    `INSERT INTO db_schemas (repo_id, sha, computed_at, data) VALUES (?, ?, ?, ?)
     ON CONFLICT (repo_id) DO UPDATE SET sha = excluded.sha, computed_at = excluded.computed_at, data = excluded.data`,
    repoId,
    sha,
    new Date().toISOString(),
    JSON.stringify(schema)
  );
}
