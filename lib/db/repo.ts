// Typed repository functions for repos.

import { all, applyPatch, get, pack, run, transaction, unpack } from "./client";
import type { RepoRecord } from "./types";

function toRepoRecord(props: Record<string, unknown>): RepoRecord {
  return {
    id: props.id as string,
    name: props.name as string,
    url: (props.url as string | undefined) ?? undefined,
    localPath: (props.localPath as string | undefined) ?? undefined,
    defaultBranch: props.defaultBranch as string,
    provider: props.provider as RepoRecord["provider"],
    createdAt: props.createdAt as string,
    lastAnalyzedAt: (props.lastAnalyzedAt as string | undefined) ?? undefined,
    lastAnalyzedSha: (props.lastAnalyzedSha as string | undefined) ?? undefined,
    analysisVersion: typeof props.analysisVersion === "number" ? props.analysisVersion : undefined,
    domainsStale: props.domainsStale === true ? true : undefined,
  };
}

/** The stored document, including fields other modules keep on it (e.g. `disabledChecklistItemIds`). */
export function readRepoDocument(id: string): Record<string, unknown> | undefined {
  const row = get<{ data: string }>(`SELECT data FROM repos WHERE id = ?`, id);
  return row ? unpack(row.data) : undefined;
}

export function writeRepoDocument(doc: Record<string, unknown>): void {
  run(
    `INSERT INTO repos (id, name, data) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, data = excluded.data`,
    doc.id as string,
    (doc.name as string) ?? "",
    pack(doc)
  );
}

export type UpsertRepoInput = Omit<RepoRecord, "createdAt"> & {
  createdAt?: string;
};

/** Creates or replaces a repo, keyed on `id`. `createdAt` is kept from the first write. */
export async function upsertRepo(input: UpsertRepoInput): Promise<RepoRecord> {
  const existing = readRepoDocument(input.id);
  const doc = applyPatch(existing, {
    id: input.id,
    name: input.name,
    url: input.url,
    localPath: input.localPath,
    defaultBranch: input.defaultBranch,
    provider: input.provider,
    createdAt: existing?.createdAt ?? input.createdAt ?? new Date().toISOString(),
    lastAnalyzedAt: input.lastAnalyzedAt,
    lastAnalyzedSha: input.lastAnalyzedSha,
  });
  writeRepoDocument(doc);
  return toRepoRecord(doc);
}

function patchRepo(id: string, patch: Record<string, unknown>): void {
  const existing = readRepoDocument(id);
  if (!existing) return;
  writeRepoDocument(applyPatch(existing, patch));
}

/** Updates only `lastAnalyzedAt`/`lastAnalyzedSha`/`analysisVersion` after a (re-)analysis run. */
export async function markRepoAnalyzed(
  id: string,
  lastAnalyzedSha: string,
  analysisVersion?: number,
  lastAnalyzedAt: string = new Date().toISOString()
): Promise<void> {
  patchRepo(id, { lastAnalyzedAt, lastAnalyzedSha, ...(analysisVersion !== undefined ? { analysisVersion } : {}) });
}

/** Updates a repo's default branch (re-detected for local repos added before graphs followed it). */
export async function setRepoDefaultBranch(id: string, defaultBranch: string): Promise<void> {
  patchRepo(id, { defaultBranch });
}

/** Sets or clears `Repo.domainsStale` (DESIGN.md §6.3). */
export async function setRepoDomainsStale(id: string, stale: boolean): Promise<void> {
  patchRepo(id, { domainsStale: stale ? true : null });
}

export async function getRepoById(id: string): Promise<RepoRecord | null> {
  const doc = readRepoDocument(id);
  return doc ? toRepoRecord(doc) : null;
}

/** Lists every tracked repo (one instance, multiple repos). */
export async function listRepos(): Promise<RepoRecord[]> {
  return all<{ data: string }>(`SELECT data FROM repos ORDER BY name ASC`).map((row) =>
    toRepoRecord(unpack(row.data))
  );
}

/**
 * Deletes a repo and everything stored for it: its graph, PRs, findings,
 * merge suggestions, checklist items and answers, chats, PR/app maps,
 * preview caches and its not-yet-running jobs. Atomic. Files on disk (the
 * clone cache) are the caller's to remove; a local checkout is never touched.
 */
export async function deleteRepo(id: string): Promise<void> {
  transaction(() => {
    // Graph: edge tables cascade with their endpoints.
    run(`DELETE FROM components WHERE repo_id = ?`, id);
    run(`DELETE FROM files WHERE repo_id = ?`, id);
    run(`DELETE FROM pull_requests WHERE repo_id = ?`, id);
    run(`DELETE FROM ref_snapshots WHERE repo_id = ?`, id);
    run(`DELETE FROM findings WHERE repo_id = ?`, id);
    run(`DELETE FROM merge_suggestions WHERE repo_id = ?`, id);
    run(`DELETE FROM checklist_answers WHERE repo_id = ?`, id);
    run(`DELETE FROM checklist_items WHERE scope = ?`, id);
    run(`DELETE FROM chat_messages WHERE repo_id = ?`, id);
    run(`DELETE FROM pr_maps WHERE json_extract(data, '$.repoId') = ?`, id);
    run(`DELETE FROM app_maps WHERE repo_id = ?`, id);
    run(`DELETE FROM target_graphs WHERE repo_id = ?`, id);
    run(`DELETE FROM api_catalogs WHERE repo_id = ?`, id);
    run(`DELETE FROM kv WHERE key LIKE ?`, `kv:api-shape:${id}:%`);
    run(`DELETE FROM kv WHERE key = ?`, `kv:preview:mocks:${id}`);
    // Queued work for the repo would only fail; a running job finishes and
    // its leftovers are removed by `deleteRepo` again (worker/index.ts).
    run(`DELETE FROM jobs WHERE json_extract(data, '$.repoId') = ? AND state <> 'active'`, id);
    run(`DELETE FROM repos WHERE id = ?`, id);
  });
}
