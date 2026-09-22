// Typed repository functions for the `(:Repo)` node label (DESIGN.md §7).

import { runRead, runWrite } from "./client";
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
  };
}

export type UpsertRepoInput = Omit<RepoRecord, "createdAt"> & {
  createdAt?: string;
};

/** Creates or fully replaces a `(:Repo)` node, keyed on `id`. */
export async function upsertRepo(input: UpsertRepoInput): Promise<RepoRecord> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const result = await runWrite(
    `
    MERGE (r:Repo {id: $id})
    SET r.name = $name,
        r.url = $url,
        r.localPath = $localPath,
        r.defaultBranch = $defaultBranch,
        r.provider = $provider,
        r.createdAt = coalesce(r.createdAt, $createdAt),
        r.lastAnalyzedAt = $lastAnalyzedAt,
        r.lastAnalyzedSha = $lastAnalyzedSha
    RETURN r
    `,
    {
      id: input.id,
      name: input.name,
      url: input.url ?? null,
      localPath: input.localPath ?? null,
      defaultBranch: input.defaultBranch,
      provider: input.provider,
      createdAt,
      lastAnalyzedAt: input.lastAnalyzedAt ?? null,
      lastAnalyzedSha: input.lastAnalyzedSha ?? null,
    }
  );
  return toRepoRecord(result.records[0].get("r").properties);
}

/** Updates only `lastAnalyzedAt`/`lastAnalyzedSha` after a (re-)analysis run (§10). */
export async function markRepoAnalyzed(
  id: string,
  lastAnalyzedSha: string,
  lastAnalyzedAt: string = new Date().toISOString()
): Promise<void> {
  await runWrite(
    `
    MATCH (r:Repo {id: $id})
    SET r.lastAnalyzedAt = $lastAnalyzedAt,
        r.lastAnalyzedSha = $lastAnalyzedSha
    `,
    { id, lastAnalyzedAt, lastAnalyzedSha }
  );
}

export async function getRepoById(id: string): Promise<RepoRecord | null> {
  const result = await runRead(`MATCH (r:Repo {id: $id}) RETURN r`, { id });
  const record = result.records[0];
  return record ? toRepoRecord(record.get("r").properties) : null;
}

/** Lists every tracked repo (decision #12: one instance, multiple repos). */
export async function listRepos(): Promise<RepoRecord[]> {
  const result = await runRead(`MATCH (r:Repo) RETURN r ORDER BY r.name ASC`);
  return result.records.map((record) => toRepoRecord(record.get("r").properties));
}

export async function deleteRepo(id: string): Promise<void> {
  await runWrite(`MATCH (r:Repo {id: $id}) DETACH DELETE r`, { id });
}
