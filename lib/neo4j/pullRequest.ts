// Typed repository functions for the `(:PullRequest)` node label,
// plus the relationships it participates in as the
// "owning" side: BELONGS_TO (-> Repo) and CHANGES (-> File).

import { runRead, runWrite } from "./client";
import type { ChangesProps, PullRequestRecord } from "./types";

function toPullRequestRecord(
  props: Record<string, unknown>
): PullRequestRecord {
  return {
    id: props.id as string,
    repoId: props.repoId as string,
    number: Number(props.number),
    title: props.title as string,
    description: (props.description as string | undefined) ?? undefined,
    author: props.author as string,
    state: props.state as PullRequestRecord["state"],
    baseRef: props.baseRef as string,
    headRef: props.headRef as string,
    headSha: props.headSha as string,
    url: props.url as string,
    createdAt: props.createdAt as string,
    updatedAt: props.updatedAt as string,
  };
}

/** Creates or fully replaces a `(:PullRequest)` node, keyed on `id`. */
export async function upsertPullRequest(
  input: PullRequestRecord
): Promise<PullRequestRecord> {
  const result = await runWrite(
    `
    MERGE (p:PullRequest {id: $id})
    SET p.repoId = $repoId,
        p.number = $number,
        p.title = $title,
        p.description = $description,
        p.author = $author,
        p.state = $state,
        p.baseRef = $baseRef,
        p.headRef = $headRef,
        p.headSha = $headSha,
        p.url = $url,
        p.createdAt = $createdAt,
        p.updatedAt = $updatedAt
    RETURN p
    `,
    {
      id: input.id,
      repoId: input.repoId,
      number: input.number,
      title: input.title,
      description: input.description ?? null,
      author: input.author,
      state: input.state,
      baseRef: input.baseRef,
      headRef: input.headRef,
      headSha: input.headSha,
      url: input.url,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    }
  );
  return toPullRequestRecord(result.records[0].get("p").properties);
}

export async function getPullRequestById(
  id: string
): Promise<PullRequestRecord | null> {
  const result = await runRead(`MATCH (p:PullRequest {id: $id}) RETURN p`, {
    id,
  });
  const record = result.records[0];
  return record ? toPullRequestRecord(record.get("p").properties) : null;
}

/** Looks a PR up by repo + number, the natural key a reviewer navigates by. */
export async function getPullRequestByNumber(
  repoId: string,
  number: number
): Promise<PullRequestRecord | null> {
  const result = await runRead(
    `MATCH (p:PullRequest {repoId: $repoId, number: $number}) RETURN p`,
    { repoId, number }
  );
  const record = result.records[0];
  return record ? toPullRequestRecord(record.get("p").properties) : null;
}

/** Lists PRs for a repo, optionally filtered by state (the Pull Requests tab). */
export async function listPullRequestsByRepoId(
  repoId: string,
  state?: PullRequestRecord["state"]
): Promise<PullRequestRecord[]> {
  const result = await runRead(
    `
    MATCH (p:PullRequest {repoId: $repoId})
    WHERE $state IS NULL OR p.state = $state
    RETURN p
    ORDER BY p.number DESC
    `,
    { repoId, state: state ?? null }
  );
  return result.records.map((record) =>
    toPullRequestRecord(record.get("p").properties)
  );
}

export async function deletePullRequest(id: string): Promise<void> {
  await runWrite(`MATCH (p:PullRequest {id: $id}) DETACH DELETE p`, { id });
}

/** `(PullRequest)-[:BELONGS_TO]->(Repo)` */
export async function linkPullRequestToRepo(
  pullRequestId: string,
  repoId: string
): Promise<void> {
  await runWrite(
    `
    MATCH (p:PullRequest {id: $pullRequestId})
    MATCH (r:Repo {id: $repoId})
    MERGE (p)-[:BELONGS_TO]->(r)
    `,
    { pullRequestId, repoId }
  );
}

/** `(PullRequest)-[:CHANGES {additions, deletions}]->(File)` — one edge per file touched by the PR. */
export async function linkPullRequestChangesFile(
  pullRequestId: string,
  fileId: string,
  props: ChangesProps
): Promise<void> {
  await runWrite(
    `
    MATCH (p:PullRequest {id: $pullRequestId})
    MATCH (f:File {id: $fileId})
    MERGE (p)-[rel:CHANGES]->(f)
    SET rel.additions = $additions,
        rel.deletions = $deletions
    `,
    {
      pullRequestId,
      fileId,
      additions: props.additions,
      deletions: props.deletions,
    }
  );
}

/** Removes every outgoing `CHANGES` edge from a PR — useful before re-writing its changed-file set when the head SHA moves. */
export async function clearPullRequestChanges(
  pullRequestId: string
): Promise<void> {
  await runWrite(
    `MATCH (:PullRequest {id: $pullRequestId})-[rel:CHANGES]->(:File) DELETE rel`,
    { pullRequestId }
  );
}

interface ChangedFile {
  fileId: string;
  additions: number;
  deletions: number;
}

/** Lists the files a PR changes, with per-file additions/deletions. */
export async function listPullRequestChangedFiles(
  pullRequestId: string
): Promise<ChangedFile[]> {
  const result = await runRead(
    `
    MATCH (:PullRequest {id: $pullRequestId})-[rel:CHANGES]->(f:File)
    RETURN f.id AS fileId, rel.additions AS additions, rel.deletions AS deletions
    `,
    { pullRequestId }
  );
  return result.records.map((record) => ({
    fileId: record.get("fileId") as string,
    additions: Number(record.get("additions")),
    deletions: Number(record.get("deletions")),
  }));
}
