// The infra catalog of a repo's analysed commit (lib/analysis/infra/,
// DESIGN.md §6.12): one JSON document per repo, replaced by every analysis.
// A review target's infra change is stored with its target graph
// (`target_graphs.data.infra`), not here.

import type { InfraCatalog } from "@/lib/analysis/infra/types";
import { get, run } from "./client";

export interface StoredInfraCatalog {
  sha: string;
  computedAt: string;
  catalog: InfraCatalog;
}

export function readInfraCatalog(repoId: string): StoredInfraCatalog | null {
  const row = get<{ sha: string; computed_at: string; data: string }>(
    `SELECT sha, computed_at, data FROM infra_catalogs WHERE repo_id = ?`,
    repoId
  );
  if (!row) return null;
  try {
    return { sha: row.sha, computedAt: row.computed_at, catalog: JSON.parse(row.data) as InfraCatalog };
  } catch {
    return null;
  }
}

export function writeInfraCatalog(repoId: string, sha: string, catalog: InfraCatalog): void {
  run(
    `INSERT INTO infra_catalogs (repo_id, sha, computed_at, data) VALUES (?, ?, ?, ?)
     ON CONFLICT (repo_id) DO UPDATE SET sha = excluded.sha, computed_at = excluded.computed_at, data = excluded.data`,
    repoId,
    sha,
    new Date().toISOString(),
    JSON.stringify(catalog)
  );
}
