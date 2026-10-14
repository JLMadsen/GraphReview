// The env catalog of a repo's analysed commit (lib/analysis/env/,
// DESIGN.md §6.15): one JSON document per repo, replaced by every analysis.
// A review target's env change is stored with its target graph
// (`target_graphs.data.env`), not here.

import type { EnvCatalog } from "@/lib/analysis/env/types";
import { get, run } from "./client";

export interface StoredEnvCatalog {
  sha: string;
  computedAt: string;
  catalog: EnvCatalog;
}

export function readEnvCatalog(repoId: string): StoredEnvCatalog | null {
  const row = get<{ sha: string; computed_at: string; data: string }>(
    `SELECT sha, computed_at, data FROM env_catalogs WHERE repo_id = ?`,
    repoId
  );
  if (!row) return null;
  try {
    return { sha: row.sha, computedAt: row.computed_at, catalog: JSON.parse(row.data) as EnvCatalog };
  } catch {
    return null;
  }
}

export function writeEnvCatalog(repoId: string, sha: string, catalog: EnvCatalog): void {
  run(
    `INSERT INTO env_catalogs (repo_id, sha, computed_at, data) VALUES (?, ?, ?, ?)
     ON CONFLICT (repo_id) DO UPDATE SET sha = excluded.sha, computed_at = excluded.computed_at, data = excluded.data`,
    repoId,
    sha,
    new Date().toISOString(),
    JSON.stringify(catalog)
  );
}
