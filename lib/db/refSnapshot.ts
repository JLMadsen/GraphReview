// Typed repository functions for ref snapshots: a PR's base/head commit and
// ad-hoc ref-to-ref comparisons, keyed on `(repoId, sha)`.

import { all, get, pack, run, unpack } from "./client";
import type { RefSnapshotRecord } from "./types";

function toRefSnapshotRecord(props: Record<string, unknown>): RefSnapshotRecord {
  return {
    sha: props.sha as string,
    repoId: props.repoId as string,
    ref: props.ref as string,
    message: props.message as string,
    author: props.author as string,
    timestamp: props.timestamp as string,
  };
}

/** Creates or fully replaces a snapshot, keyed on `(repoId, sha)`. */
export async function upsertRefSnapshot(input: RefSnapshotRecord): Promise<RefSnapshotRecord> {
  const record = toRefSnapshotRecord({ ...input });
  run(
    `INSERT INTO ref_snapshots (repo_id, sha, ref, timestamp, data) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, sha) DO UPDATE SET ref = excluded.ref, timestamp = excluded.timestamp, data = excluded.data`,
    record.repoId,
    record.sha,
    record.ref,
    record.timestamp,
    pack(record)
  );
  return record;
}

export async function getRefSnapshotBySha(repoId: string, sha: string): Promise<RefSnapshotRecord | null> {
  const row = get<{ data: string }>(`SELECT data FROM ref_snapshots WHERE repo_id = ? AND sha = ?`, repoId, sha);
  return row ? toRefSnapshotRecord(unpack(row.data)) : null;
}

/** Lists snapshots recorded for a given ref (e.g. all snapshots seen for `main`), most recent first. */
export async function listRefSnapshotsByRef(repoId: string, ref: string): Promise<RefSnapshotRecord[]> {
  return all<{ data: string }>(
    `SELECT data FROM ref_snapshots WHERE repo_id = ? AND ref = ? ORDER BY timestamp DESC`,
    repoId,
    ref
  ).map((row) => toRefSnapshotRecord(unpack(row.data)));
}

export async function listRefSnapshotsByRepoId(repoId: string): Promise<RefSnapshotRecord[]> {
  return all<{ data: string }>(
    `SELECT data FROM ref_snapshots WHERE repo_id = ? ORDER BY timestamp DESC`,
    repoId
  ).map((row) => toRefSnapshotRecord(unpack(row.data)));
}

export async function deleteRefSnapshot(repoId: string, sha: string): Promise<void> {
  run(`DELETE FROM ref_snapshots WHERE repo_id = ? AND sha = ?`, repoId, sha);
}
