// The review loop's storage (DESIGN.md §6.21): how a finding is recognised
// again on the next run, what each component's last review call saw, and
// the per-repo memory of findings dismissed as "not a problem".
//
// A `change` finding's id is derived from what it is about — repo, target,
// component, file and its normalized summary — so a re-review that says the
// same thing writes the same id, and the reviewer's resolve, re-rate and
// replies (and the chat's triage records, which point at the id) stay put.
// Wording drifts between model calls, so `syncFindingsForTargetComponent`
// (finding.ts) also adopts the id of a close-enough finding on the same file.

import { createHash, randomUUID } from "node:crypto";
import { all, get, pack, placeholders, run, unpack } from "./client";

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Words that carry no meaning for "is this the same finding". */
const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "at", "for", "by", "with", "and", "or", "but",
  "is", "are", "was", "be", "it", "its", "this", "that", "now", "so", "as", "from", "into",
]);

/**
 * A summary reduced to what identifies it: lower case, punctuation and line
 * numbers dropped (they shift with every push), stopwords dropped, one space
 * between words. Identifiers (`get_user`, `a.b`) survive as single words.
 */
export function normalizeFindingSummary(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/^\[mock\]\s*/, "")
    .replace(/[^a-z0-9_.$]+/g, " ")
    .split(" ")
    .map((word) => word.replace(/^\.+|\.+$/g, ""))
    .filter((word) => word && !STOPWORDS.has(word) && !/^\d+$/.test(word))
    .join(" ");
}

/** Jaccard similarity of two normalized summaries' word sets, 0..1. */
export function summarySimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = new Set(a.split(" ").filter(Boolean));
  const right = new Set(b.split(" ").filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

/** Close enough to carry a reviewer's triage over to a re-worded finding on the same file. */
export const CARRY_OVER_SIMILARITY = 0.6;
/** Close enough for a suppression to hide a later finding on the same file ("near-identical"). */
export const SUPPRESS_SIMILARITY = 0.8;

/** The deterministic id of a `change` finding. */
export function changeFindingId(
  repoId: string,
  targetKey: string,
  componentId: string,
  filePath: string | undefined,
  summary: string
): string {
  const key = [repoId, targetKey, componentId, filePath ?? "", normalizeFindingSummary(summary)].join("\0");
  return `chg-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Review slots — what each component's last review call saw
// ---------------------------------------------------------------------------

export interface ReviewSlot {
  componentId: string;
  /** Hash of the component's changed files and their patches, plus model and effort. */
  patchHash: string;
  /** The head commit that call reviewed. */
  headSha: string;
  reviewedAt: string;
}

export function listReviewSlots(repoId: string, targetKey: string): Map<string, ReviewSlot> {
  const rows = all<{ component_id: string; patch_hash: string; head_sha: string; reviewed_at: string }>(
    `SELECT component_id, patch_hash, head_sha, reviewed_at FROM review_slots WHERE repo_id = ? AND target_key = ?`,
    repoId,
    targetKey
  );
  return new Map(
    rows.map((row) => [
      row.component_id,
      { componentId: row.component_id, patchHash: row.patch_hash, headSha: row.head_sha, reviewedAt: row.reviewed_at },
    ])
  );
}

export function writeReviewSlot(repoId: string, targetKey: string, slot: ReviewSlot): void {
  run(
    `INSERT INTO review_slots (repo_id, target_key, component_id, patch_hash, head_sha, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, target_key, component_id) DO UPDATE SET
       patch_hash = excluded.patch_hash, head_sha = excluded.head_sha, reviewed_at = excluded.reviewed_at`,
    repoId,
    targetKey,
    slot.componentId,
    slot.patchHash,
    slot.headSha,
    slot.reviewedAt
  );
}

/** Forgets a component's slot — its call failed, so the next run must make it. */
export function deleteReviewSlot(repoId: string, targetKey: string, componentId: string): void {
  run(`DELETE FROM review_slots WHERE repo_id = ? AND target_key = ? AND component_id = ?`, repoId, targetKey, componentId);
}

/** Drops the slots of components the target no longer touches. */
export function deleteReviewSlotsExcept(repoId: string, targetKey: string, keepComponentIds: readonly string[]): void {
  const keep = [...keepComponentIds];
  run(
    `DELETE FROM review_slots WHERE repo_id = ? AND target_key = ?
       AND component_id NOT IN (${keep.length ? placeholders(keep.length) : "SELECT NULL WHERE 0"})`,
    repoId,
    targetKey,
    ...keep
  );
}

// ---------------------------------------------------------------------------
// Suppressions — findings the reviewer dismissed as "not a problem"
// ---------------------------------------------------------------------------

export interface FindingSuppression {
  id: string;
  repoId: string;
  filePath: string;
  /** The dismissed finding's summary, as shown. */
  summary: string;
  /** `normalizeFindingSummary(summary)`, what later findings are matched against. */
  normalized: string;
  /** Why it isn't a problem, in the reviewer's words. Optional. */
  reason?: string;
  /** The finding it was made from, and the review that finding was in. */
  findingId?: string;
  targetKey?: string;
  createdAt: string;
}

export function listFindingSuppressions(repoId: string): FindingSuppression[] {
  return all<{ data: string }>(
    `SELECT data FROM finding_suppressions WHERE repo_id = ? ORDER BY created_at DESC`,
    repoId
  ).map((row) => unpack<FindingSuppression>(row.data));
}

export function getFindingSuppression(repoId: string, id: string): FindingSuppression | undefined {
  const row = get<{ data: string }>(`SELECT data FROM finding_suppressions WHERE id = ? AND repo_id = ?`, id, repoId);
  return row ? unpack<FindingSuppression>(row.data) : undefined;
}

/**
 * Remembers a dismissed finding. One suppression per finding: dismissing it
 * again replaces the reason rather than adding a second entry.
 */
export function addFindingSuppression(input: {
  repoId: string;
  filePath: string;
  summary: string;
  reason?: string;
  findingId?: string;
  targetKey?: string;
}): FindingSuppression {
  const existing = input.findingId
    ? get<{ data: string }>(`SELECT data FROM finding_suppressions WHERE repo_id = ? AND finding_id = ?`, input.repoId, input.findingId)
    : undefined;
  const previous = existing ? unpack<FindingSuppression>(existing.data) : undefined;
  const reason = input.reason?.trim();
  const record: FindingSuppression = {
    id: previous?.id ?? randomUUID(),
    repoId: input.repoId,
    filePath: input.filePath,
    summary: input.summary,
    normalized: normalizeFindingSummary(input.summary),
    ...(reason ? { reason: reason.slice(0, 1000) } : {}),
    ...(input.findingId ? { findingId: input.findingId } : {}),
    ...(input.targetKey ? { targetKey: input.targetKey } : {}),
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
  run(
    `INSERT INTO finding_suppressions (id, repo_id, file_path, finding_id, created_at, data) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET file_path = excluded.file_path, data = excluded.data`,
    record.id,
    record.repoId,
    record.filePath,
    record.findingId ?? null,
    record.createdAt,
    pack(record)
  );
  return record;
}

/** Un-suppresses: the matching findings show again on every review of the repo. */
export function deleteFindingSuppression(repoId: string, id: string): boolean {
  return run(`DELETE FROM finding_suppressions WHERE id = ? AND repo_id = ?`, id, repoId) > 0;
}

/** Drops the suppression made from one finding — it was reopened. */
export function deleteSuppressionsForFinding(repoId: string, findingId: string): number {
  return run(`DELETE FROM finding_suppressions WHERE repo_id = ? AND finding_id = ?`, repoId, findingId);
}

/**
 * The suppression that hides `finding`, if any: one on the same file whose
 * summary is near-identical. Findings without a file (the PR-level intent
 * verdict) and failed-call placeholders are never suppressed.
 */
export function matchSuppression(
  finding: { filePath?: string; summary: string; category?: string; callFailed?: boolean },
  suppressions: readonly FindingSuppression[]
): FindingSuppression | undefined {
  if (!finding.filePath || finding.category === "intent" || finding.callFailed) return undefined;
  const normalized = normalizeFindingSummary(finding.summary);
  let best: FindingSuppression | undefined;
  let bestScore = 0;
  for (const s of suppressions) {
    if (s.filePath !== finding.filePath) continue;
    const score = summarySimilarity(normalized, s.normalized);
    if (score >= SUPPRESS_SIMILARITY && score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}
