// The endpoint catalog of a repo's analysed commit (lib/analysis/api/,
// DESIGN.md §6.11): one JSON document per repo, replaced by every analysis.
// Shapes a model inferred for untyped handlers live in `kv` under
// `api-shape:<repoId>:<handler hash>`, so they survive re-analysis while the
// handler's code stays the same.

import type { ApiCatalog, ApiShape, ApiParam } from "@/lib/analysis/api/types";
import { get, run } from "./client";
import { readKv, writeKv } from "./kv";

export interface StoredApiCatalog {
  sha: string;
  computedAt: string;
  catalog: ApiCatalog;
}

export function readApiCatalog(repoId: string): StoredApiCatalog | null {
  const row = get<{ sha: string; computed_at: string; data: string }>(
    `SELECT sha, computed_at, data FROM api_catalogs WHERE repo_id = ?`,
    repoId
  );
  if (!row) return null;
  try {
    return { sha: row.sha, computedAt: row.computed_at, catalog: JSON.parse(row.data) as ApiCatalog };
  } catch {
    return null;
  }
}

export function writeApiCatalog(repoId: string, sha: string, catalog: ApiCatalog): void {
  run(
    `INSERT INTO api_catalogs (repo_id, sha, computed_at, data) VALUES (?, ?, ?, ?)
     ON CONFLICT (repo_id) DO UPDATE SET sha = excluded.sha, computed_at = excluded.computed_at, data = excluded.data`,
    repoId,
    sha,
    new Date().toISOString(),
    JSON.stringify(catalog)
  );
}

/** What a model made of an untyped handler (✦): its inputs and the body it takes and returns. */
export interface InferredApiShape {
  params?: ApiParam[];
  request?: ApiShape;
  response?: ApiShape;
  /** One sentence on what the endpoint does. */
  summary?: string;
  model: string;
  inferredAt: string;
}

const shapeKey = (repoId: string, hash: string) => `api-shape:${repoId}:${hash}`;

export function readInferredApiShape(repoId: string, hash: string): InferredApiShape | undefined {
  return readKv<InferredApiShape>(shapeKey(repoId, hash));
}

export function writeInferredApiShape(repoId: string, hash: string, shape: InferredApiShape): void {
  writeKv(shapeKey(repoId, hash), shape);
}
