// Typed repository functions for the `(:RefSnapshot)` node label.
// Covers both a PR's base/head commit and ad-hoc
// ref-to-ref comparisons. This label has no relationships of its own —
// callers correlate a snapshot with a PR or repo via the
// shared `repoId`/`sha` values rather than a graph edge.

import { runRead, runWrite } from "./client";
import type { RefSnapshotRecord } from "./types";

function toRefSnapshotRecord(
  props: Record<string, unknown>
): RefSnapshotRecord {
  return {
    sha: props.sha as string,
    repoId: props.repoId as string,
    ref: props.ref as string,
    message: props.message as string,
    author: props.author as string,
    timestamp: props.timestamp as string,
  };
}

/**
 * Creates or fully replaces a `(:RefSnapshot)` node. Unlike the other
 * labels, `RefSnapshot` has no separate `id` property — `sha` is its
 * natural key, so upserts and lookups key on `(repoId, sha)` at the
 * application level (the DB-level constraint is on `sha` alone; see the
 * Community Edition note in schema.ts).
 */
export async function upsertRefSnapshot(
  input: RefSnapshotRecord
): Promise<RefSnapshotRecord> {
  const result = await runWrite(
    `
    MERGE (s:RefSnapshot {repoId: $repoId, sha: $sha})
    SET s.ref = $ref,
        s.message = $message,
        s.author = $author,
        s.timestamp = $timestamp
    RETURN s
    `,
    {
      repoId: input.repoId,
      sha: input.sha,
      ref: input.ref,
      message: input.message,
      author: input.author,
      timestamp: input.timestamp,
    }
  );
  return toRefSnapshotRecord(result.records[0].get("s").properties);
}

export async function getRefSnapshotBySha(
  repoId: string,
  sha: string
): Promise<RefSnapshotRecord | null> {
  const result = await runRead(
    `MATCH (s:RefSnapshot {repoId: $repoId, sha: $sha}) RETURN s`,
    { repoId, sha }
  );
  const record = result.records[0];
  return record ? toRefSnapshotRecord(record.get("s").properties) : null;
}

/** Lists snapshots recorded for a given ref (e.g. all snapshots seen for `main`), most recent first. */
export async function listRefSnapshotsByRef(
  repoId: string,
  ref: string
): Promise<RefSnapshotRecord[]> {
  const result = await runRead(
    `
    MATCH (s:RefSnapshot {repoId: $repoId, ref: $ref})
    RETURN s
    ORDER BY s.timestamp DESC
    `,
    { repoId, ref }
  );
  return result.records.map((record) =>
    toRefSnapshotRecord(record.get("s").properties)
  );
}

export async function listRefSnapshotsByRepoId(
  repoId: string
): Promise<RefSnapshotRecord[]> {
  const result = await runRead(
    `
    MATCH (s:RefSnapshot {repoId: $repoId})
    RETURN s
    ORDER BY s.timestamp DESC
    `,
    { repoId }
  );
  return result.records.map((record) =>
    toRefSnapshotRecord(record.get("s").properties)
  );
}

export async function deleteRefSnapshot(
  repoId: string,
  sha: string
): Promise<void> {
  await runWrite(
    `MATCH (s:RefSnapshot {repoId: $repoId, sha: $sha}) DETACH DELETE s`,
    { repoId, sha }
  );
}
