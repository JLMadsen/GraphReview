// Typed repository functions for repos.

import { all, applyPatch, get, pack, run, unpack } from "./client";
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

/** Updates only `lastAnalyzedAt`/`lastAnalyzedSha` after a (re-)analysis run. */
export async function markRepoAnalyzed(
  id: string,
  lastAnalyzedSha: string,
  lastAnalyzedAt: string = new Date().toISOString()
): Promise<void> {
  patchRepo(id, { lastAnalyzedAt, lastAnalyzedSha });
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

export async function deleteRepo(id: string): Promise<void> {
  run(`DELETE FROM repos WHERE id = ?`, id);
}
