// Typed repository functions for pull requests, plus the relationship they
// own: CHANGES (-> File). A PR's repo is its `repoId`.

import { all, get, pack, run, unpack } from "./client";
import type { ChangesProps, PullRequestRecord } from "./types";

function toPullRequestRecord(props: Record<string, unknown>): PullRequestRecord {
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

/** Creates or fully replaces a pull request, keyed on `id`. */
export async function upsertPullRequest(input: PullRequestRecord): Promise<PullRequestRecord> {
  const record = toPullRequestRecord({ ...input });
  run(
    `INSERT INTO pull_requests (id, repo_id, number, state, data) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       repo_id = excluded.repo_id, number = excluded.number, state = excluded.state, data = excluded.data`,
    record.id,
    record.repoId,
    record.number,
    record.state,
    pack(record)
  );
  return record;
}

export async function getPullRequestById(id: string): Promise<PullRequestRecord | null> {
  const row = get<{ data: string }>(`SELECT data FROM pull_requests WHERE id = ?`, id);
  return row ? toPullRequestRecord(unpack(row.data)) : null;
}

/** Looks a PR up by repo + number, the natural key a reviewer navigates by. */
export async function getPullRequestByNumber(repoId: string, number: number): Promise<PullRequestRecord | null> {
  const row = get<{ data: string }>(
    `SELECT data FROM pull_requests WHERE repo_id = ? AND number = ?`,
    repoId,
    number
  );
  return row ? toPullRequestRecord(unpack(row.data)) : null;
}

/** Lists PRs for a repo, optionally filtered by state (the Pull Requests tab). */
export async function listPullRequestsByRepoId(
  repoId: string,
  state?: PullRequestRecord["state"]
): Promise<PullRequestRecord[]> {
  const rows = state
    ? all<{ data: string }>(
        `SELECT data FROM pull_requests WHERE repo_id = ? AND state = ? ORDER BY number DESC`,
        repoId,
        state
      )
    : all<{ data: string }>(`SELECT data FROM pull_requests WHERE repo_id = ? ORDER BY number DESC`, repoId);
  return rows.map((row) => toPullRequestRecord(unpack(row.data)));
}

export async function deletePullRequest(id: string): Promise<void> {
  run(`DELETE FROM pull_requests WHERE id = ?`, id);
}

/** `(PullRequest)-[:CHANGES {additions, deletions}]->(File)` — one edge per file touched by the PR. */
export async function linkPullRequestChangesFile(
  pullRequestId: string,
  fileId: string,
  props: ChangesProps
): Promise<void> {
  run(
    `INSERT INTO pr_changes (pr_id, file_id, additions, deletions)
     SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pull_requests WHERE id = ?)
                         AND EXISTS (SELECT 1 FROM files WHERE id = ?)
     ON CONFLICT (pr_id, file_id) DO UPDATE SET additions = excluded.additions, deletions = excluded.deletions`,
    pullRequestId,
    fileId,
    props.additions,
    props.deletions,
    pullRequestId,
    fileId
  );
}

/** Removes every outgoing `CHANGES` edge from a PR — useful before re-writing its changed-file set when the head SHA moves. */
export async function clearPullRequestChanges(pullRequestId: string): Promise<void> {
  run(`DELETE FROM pr_changes WHERE pr_id = ?`, pullRequestId);
}

interface ChangedFile {
  fileId: string;
  additions: number;
  deletions: number;
}

/** Lists the files a PR changes, with per-file additions/deletions. */
export async function listPullRequestChangedFiles(pullRequestId: string): Promise<ChangedFile[]> {
  return all<ChangedFile>(
    `SELECT file_id AS fileId, additions, deletions FROM pr_changes WHERE pr_id = ?`,
    pullRequestId
  ).map((row) => ({ fileId: row.fileId, additions: Number(row.additions), deletions: Number(row.deletions) }));
}
