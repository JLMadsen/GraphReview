// What was posted to a PR/MR, so nothing is posted twice (DESIGN.md §6.23).
//
// Kept in `kv` (one record per review target) rather than on the finding:
// a re-run of the review writes new finding ids, so a posted finding is
// matched by id *or* by its fingerprint — category, file, line and summary.

import { createHash } from "node:crypto";
import { readKv, writeKv } from "@/lib/db";
import type { FindingRecord } from "@/lib/db";

export type PostVerdict = "comment" | "approve" | "request_changes";
export type PostHost = "github" | "gitlab";

export interface PostedFinding {
  findingId: string;
  fingerprint: string;
  postedAt: string;
  /** The inline comment's URL, or the review's when it went into the summary. */
  url: string;
  inline: boolean;
}

export interface PostedReview {
  postedAt: string;
  url: string;
  host: PostHost;
  verdict: PostVerdict;
  headSha?: string;
  /** Findings it carried (inline + in the summary). */
  findings: number;
}

export interface PostLog {
  findings: PostedFinding[];
  reviews: PostedReview[];
}

function key(repoId: string, targetKey: string): string {
  return `posted-review:${repoId}:${targetKey}`;
}

export function findingFingerprint(f: Pick<FindingRecord, "category" | "filePath" | "lineRange" | "summary">): string {
  return createHash("sha1")
    .update([f.category, f.filePath ?? "", f.lineRange ?? "", f.summary.replace(/\s+/g, " ").trim()].join("\u0000"))
    .digest("hex")
    .slice(0, 20);
}

export function readPostLog(repoId: string, targetKey: string): PostLog {
  const stored = readKv<PostLog>(key(repoId, targetKey));
  return { findings: stored?.findings ?? [], reviews: stored?.reviews ?? [] };
}

/** The post record of a finding, matched by id or fingerprint. */
export function postedRecordOf(log: PostLog, finding: FindingRecord): PostedFinding | undefined {
  const fingerprint = findingFingerprint(finding);
  return log.findings.find((p) => p.findingId === finding.id || p.fingerprint === fingerprint);
}

/** Adds to the log — called as each piece lands, so a failure midway still records what was posted. */
export function appendPostLog(repoId: string, targetKey: string, add: { findings?: PostedFinding[]; review?: PostedReview }): void {
  const log = readPostLog(repoId, targetKey);
  writeKv(key(repoId, targetKey), {
    findings: [...log.findings, ...(add.findings ?? [])],
    reviews: add.review ? [...log.reviews, add.review] : log.reviews,
  } satisfies PostLog);
}
