// Typed repository functions for review findings.
//
// Findings are overwritten, not versioned, when a review is re-run —
// `syncFindingsForTargetComponent` rewrites a (repoId, targetKey,
// componentId) slot, where `targetKey` identifies *what* was reviewed
// (`pr:<number>` or `refs:<base>...<head>` — see `FindingRecord.targetKey`).
// A finding the new run says again keeps its id and the reviewer's triage
// (resolved, re-rated, replies — DESIGN.md §6.21); the rest are replaced.
//
// A finding refers to its component and PR by id only (the old ABOUT/FOR
// edges): deleting a component never deletes its findings, and
// `relinkFindings` (merge.ts) moves them when modules change.

import { all, compareText, get, pack, placeholders, run, transaction, unpack } from "./client";
import { CARRY_OVER_SIMILARITY, changeFindingId, normalizeFindingSummary, summarySimilarity } from "./review-loop";
import type { FindingCategory, FindingRecord, FindingResponse, FindingResponseKind } from "./types";

function toFindingRecord(props: Record<string, unknown>): FindingRecord {
  return {
    id: props.id as string,
    repoId: props.repoId as string,
    targetKey: (props.targetKey as string | undefined) ?? "",
    prId: (props.prId as string | undefined) ?? undefined,
    componentId: props.componentId as string,
    filePath: (props.filePath as string | undefined) ?? undefined,
    lineRange: (props.lineRange as string | undefined) ?? undefined,
    summary: props.summary as string,
    assessment: props.assessment as FindingRecord["assessment"],
    scope: (props.scope as FindingRecord["scope"] | undefined) ?? undefined,
    kind: (props.kind as FindingRecord["kind"] | undefined) ?? undefined,
    category: (props.category as FindingRecord["category"] | undefined) ?? "change",
    confidence: Number(props.confidence),
    rationale: props.rationale as string,
    model: props.model as string,
    createdAt: props.createdAt as string,
    reviewedBaseSha: (props.reviewedBaseSha as string | undefined) ?? undefined,
    reviewedHeadSha: (props.reviewedHeadSha as string | undefined) ?? undefined,
    reviewedAt: (props.reviewedAt as string | undefined) ?? undefined,
    resolvedAt: (props.resolvedAt as string | undefined) ?? undefined,
    reratedTo: (props.reratedTo as FindingRecord["reratedTo"] | undefined) ?? undefined,
    callFailed: props.callFailed === true || isLegacyFailurePlaceholder(props) ? true : undefined,
    responses: Array.isArray(props.responses) && props.responses.length ? (props.responses as FindingResponse[]) : undefined,
  };
}

/**
 * Failure placeholders written before `callFailed` existed: an `unknown`
 * finding whose rationale is the job's "call did not complete" text.
 */
function isLegacyFailurePlaceholder(props: Record<string, unknown>): boolean {
  return (
    props.assessment === "unknown" &&
    typeof props.rationale === "string" &&
    /^The AI (review|intent-check) call (for this component )?did not complete:/.test(props.rationale)
  );
}

function findingRows(rows: Array<{ data: unknown }>): FindingRecord[] {
  return rows.map((row) => toFindingRecord(unpack(row.data)));
}

/** Writes a full finding record (insert or replace by `id`). */
export function writeFinding(record: FindingRecord): void {
  run(
    `INSERT INTO findings (id, repo_id, target_key, pr_id, component_id, category, file_path, created_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       repo_id = excluded.repo_id, target_key = excluded.target_key, pr_id = excluded.pr_id,
       component_id = excluded.component_id, category = excluded.category,
       file_path = excluded.file_path, created_at = excluded.created_at, data = excluded.data`,
    record.id,
    record.repoId,
    record.targetKey,
    record.prId ?? null,
    record.componentId,
    record.category,
    record.filePath ?? null,
    record.createdAt,
    pack(record)
  );
}

/** Every finding of a repo, as full records. Used by `relinkFindings`. */
export function readRepoFindings(repoId: string): FindingRecord[] {
  return findingRows(all(`SELECT data FROM findings WHERE repo_id = ?`, repoId));
}

export type UpsertFindingInput = Omit<FindingRecord, "createdAt"> & {
  createdAt?: string;
};

/** Creates or fully replaces a finding, keyed on `id`. `createdAt`, `resolvedAt` and `responses` are kept from the stored copy. */
export async function upsertFinding(input: UpsertFindingInput): Promise<FindingRecord> {
  const existing = get<{ data: string }>(`SELECT data FROM findings WHERE id = ?`, input.id);
  const previous = existing ? toFindingRecord(unpack(existing.data)) : undefined;
  const record = toFindingRecord({
    ...JSON.parse(pack(input)),
    createdAt: previous?.createdAt ?? input.createdAt ?? new Date().toISOString(),
    resolvedAt: previous?.resolvedAt,
    responses: previous?.responses,
  });
  writeFinding(record);
  return record;
}

export async function getFindingById(id: string): Promise<FindingRecord | null> {
  const row = get<{ data: string }>(`SELECT data FROM findings WHERE id = ?`, id);
  return row ? toFindingRecord(unpack(row.data)) : null;
}

export async function listFindingsByRepoId(repoId: string): Promise<FindingRecord[]> {
  return findingRows(all(`SELECT data FROM findings WHERE repo_id = ? ORDER BY created_at DESC`, repoId));
}

export async function listFindingsByPullRequestId(prId: string): Promise<FindingRecord[]> {
  return findingRows(all(`SELECT data FROM findings WHERE pr_id = ? ORDER BY created_at DESC`, prId));
}

export async function listFindingsByComponentId(componentId: string): Promise<FindingRecord[]> {
  return findingRows(all(`SELECT data FROM findings WHERE component_id = ? ORDER BY created_at DESC`, componentId));
}

/**
 * Marks one finding of `repoId` resolved (stamping `resolvedAt` with the
 * current time) or reopens it (removing `resolvedAt`). Returns `null` when
 * no such finding exists in that repo. Callers enforce which verdicts may be
 * resolved.
 */
export async function setFindingResolved(
  repoId: string,
  id: string,
  resolved: boolean
): Promise<FindingRecord | null> {
  const row = get<{ data: string }>(`SELECT data FROM findings WHERE id = ? AND repo_id = ?`, id, repoId);
  if (!row) return null;
  const record = toFindingRecord(unpack(row.data));
  record.resolvedAt = resolved ? new Date().toISOString() : undefined;
  writeFinding(record);
  return record;
}

/**
 * Appends a reply to one finding of `repoId`. An `answered` reply also
 * resolves the finding (keeping an earlier `resolvedAt`); `fixing` and
 * `comment` leave its resolved state alone. Returns `null` when no such
 * finding exists in that repo. Callers enforce which findings may be replied to.
 */
export async function addFindingResponse(
  repoId: string,
  id: string,
  reply: { kind: FindingResponseKind; author: string; body: string }
): Promise<FindingRecord | null> {
  return transaction(() => {
    const row = get<{ data: string }>(`SELECT data FROM findings WHERE id = ? AND repo_id = ?`, id, repoId);
    if (!row) return null;
    const record = toFindingRecord(unpack(row.data));
    const now = new Date().toISOString();
    record.responses = [...(record.responses ?? []), { id: crypto.randomUUID(), ...reply, createdAt: now }];
    if (reply.kind === "answered") record.resolvedAt ??= now;
    writeFinding(record);
    return record;
  });
}

/**
 * Changes one finding's verdict and records why as a `comment` reply (the
 * chat's re-rating, DESIGN.md §6.7). Like a reply, carried over by a
 * re-review that produces the finding again (`reratedTo`, DESIGN.md §6.21).
 * Returns `null` when no such finding exists in that repo.
 */
export async function rateFinding(
  repoId: string,
  id: string,
  assessment: FindingRecord["assessment"],
  reply: { author: string; body: string }
): Promise<FindingRecord | null> {
  return transaction(() => {
    const row = get<{ data: string }>(`SELECT data FROM findings WHERE id = ? AND repo_id = ?`, id, repoId);
    if (!row) return null;
    const record = toFindingRecord(unpack(row.data));
    const now = new Date().toISOString();
    record.assessment = assessment;
    record.reratedTo = assessment;
    // An OK finding has nothing left to resolve.
    if (assessment === "ok") record.resolvedAt = undefined;
    record.responses = [...(record.responses ?? []), { id: crypto.randomUUID(), kind: "comment", ...reply, createdAt: now }];
    writeFinding(record);
    return record;
  });
}

export async function deleteFinding(id: string): Promise<void> {
  run(`DELETE FROM findings WHERE id = ?`, id);
}

/**
 * Deletes every existing finding for a given `(prId, componentId)` pair.
 * Call this immediately before writing fresh findings for that pair to
 * implement the "overwritten, not versioned" behavior when a PR's head SHA
 * changes.
 */
export async function deleteFindingsForPullRequestComponent(prId: string, componentId: string): Promise<void> {
  run(`DELETE FROM findings WHERE pr_id = ? AND component_id = ?`, prId, componentId);
}

// ---------------------------------------------------------------------------
// Target-scoped findings — one "review target" is a PR or a
// base...head ref comparison, identified by `targetKey`.
// ---------------------------------------------------------------------------

/** A finding joined with the display name of the component it is about. */
export interface FindingWithComponent extends FindingRecord {
  /** The component's name, or `""` when the component has since been pruned by a re-analysis. */
  componentName: string;
}

/**
 * Every finding persisted so far for one review target, joined with its
 * component's name, ordered by component name, file path and creation time
 * (findings of a missing component, and findings without a file, last).
 *
 * Deliberately a plain read with no job/queue awareness: the review job
 * writes findings per component *as it goes*, so polling this while a job is
 * running is exactly how the UI streams them.
 */
export async function listFindingsByTargetKey(repoId: string, targetKey: string): Promise<FindingWithComponent[]> {
  const rows = all<{ data: string; componentName: string | null }>(
    `SELECT f.data AS data, c.name AS componentName
     FROM findings f LEFT JOIN components c ON c.id = f.component_id
     WHERE f.repo_id = ? AND f.target_key = ?`,
    repoId,
    targetKey
  );
  return rows
    .map((row) => ({ record: toFindingRecord(unpack(row.data)), componentName: row.componentName }))
    .sort(
      (a, b) =>
        compareText(a.componentName, b.componentName) ||
        compareText(a.record.filePath, b.record.filePath) ||
        compareText(a.record.createdAt, b.record.createdAt)
    )
    .map(({ record, componentName }) => ({ ...record, componentName: componentName ?? "" }));
}

/** The per-finding payload `replaceFindingsForTargetComponent` writes — everything on a `FindingRecord` except the properties that identify the (target, component) slot, which are passed separately. */
export type TargetFindingInput = Omit<
  FindingRecord,
  "repoId" | "targetKey" | "componentId" | "createdAt" | "category"
> & { createdAt?: string };

function toStoredFinding(
  finding: TargetFindingInput,
  slot: { repoId: string; targetKey: string; componentId: string; category: FindingCategory },
  now: string
): FindingRecord {
  return toFindingRecord({
    ...JSON.parse(pack(finding)),
    createdAt: finding.createdAt ?? now,
    ...slot,
  });
}

/**
 * Overwrite-only persistence for one (target, component) slot: deletes
 * whatever `change` findings exist for `(repoId, targetKey, componentId)`
 * and writes `findings` in their place, atomically.
 *
 * A missing component (or PR) is not an error: the findings are still
 * written, so a review never loses data because the graph was re-analyzed
 * underneath it.
 */
export async function replaceFindingsForTargetComponent(
  repoId: string,
  targetKey: string,
  componentId: string,
  findings: readonly TargetFindingInput[]
): Promise<FindingRecord[]> {
  const now = new Date().toISOString();
  const records = findings.map((finding) =>
    toStoredFinding(finding, { repoId, targetKey, componentId, category: "change" }, now)
  );
  transaction(() => {
    run(
      `DELETE FROM findings WHERE repo_id = ? AND target_key = ? AND component_id = ? AND category = 'change'`,
      repoId,
      targetKey,
      componentId
    );
    for (const record of records) writeFinding(record);
  });
  return records;
}

/**
 * The review job's write for one (target, component) slot: like
 * {@link replaceFindingsForTargetComponent}, but a finding the run says
 * again is recognised and keeps the reviewer's triage (DESIGN.md §6.21).
 *
 * Each finding's id is derived from what it is about (`changeFindingId`);
 * the incoming `id` is ignored. A finding whose id is new adopts the id of
 * the closest unclaimed stored finding on the same file when their
 * summaries are similar enough — the model rarely words a point the same
 * way twice. A recognised finding keeps `createdAt`, `resolvedAt`,
 * `responses` and a re-rating (`reratedTo`, which also overrides the
 * model's new verdict); stored findings nobody claimed are deleted. Atomic.
 */
export async function syncFindingsForTargetComponent(
  repoId: string,
  targetKey: string,
  componentId: string,
  findings: readonly TargetFindingInput[]
): Promise<FindingRecord[]> {
  const now = new Date().toISOString();
  const slot = { repoId, targetKey, componentId, category: "change" as const };
  return transaction(() => {
    const stored = findingRows(
      all(
        `SELECT data FROM findings WHERE repo_id = ? AND target_key = ? AND component_id = ? AND category = 'change'`,
        repoId,
        targetKey,
        componentId
      )
    );
    const byId = new Map(stored.map((f) => [f.id, f]));
    const ids = new Set<string>();
    // Exact ids first, so a fuzzy match never takes a finding another
    // incoming one names exactly.
    const planned = findings.map((finding) => {
      const base = changeFindingId(repoId, targetKey, componentId, finding.filePath, finding.summary);
      let id = base;
      // Two findings saying the same thing about the same file: keep both, apart.
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id);
      return { finding, id, previous: byId.get(id) };
    });
    const claimed = new Set(planned.filter((p) => p.previous).map((p) => p.id));
    for (const plan of planned) {
      if (plan.previous || plan.finding.callFailed) continue;
      const normalized = normalizeFindingSummary(plan.finding.summary);
      let bestScore = 0;
      for (const candidate of stored) {
        if (claimed.has(candidate.id) || ids.has(candidate.id) || candidate.callFailed) continue;
        if ((candidate.filePath ?? "") !== (plan.finding.filePath ?? "")) continue;
        const score = summarySimilarity(normalized, normalizeFindingSummary(candidate.summary));
        if (score >= CARRY_OVER_SIMILARITY && score > bestScore) {
          plan.previous = candidate;
          bestScore = score;
        }
      }
      if (plan.previous) {
        claimed.add(plan.previous.id);
        plan.id = plan.previous.id;
      }
    }
    const records = planned.map(({ finding, id, previous }) => {
      const assessment = previous?.reratedTo ?? finding.assessment;
      return toStoredFinding(
        {
          ...finding,
          id,
          assessment,
          createdAt: previous?.createdAt ?? finding.createdAt,
          // An OK finding has nothing left to resolve.
          resolvedAt: assessment === "ok" ? undefined : previous?.resolvedAt,
          reratedTo: previous?.reratedTo,
          responses: previous?.responses,
        },
        slot,
        now
      );
    });
    const keep = records.map((r) => r.id);
    run(
      `DELETE FROM findings WHERE repo_id = ? AND target_key = ? AND component_id = ? AND category = 'change'
         AND id NOT IN (${keep.length ? placeholders(keep.length) : "SELECT NULL WHERE 0"})`,
      repoId,
      targetKey,
      componentId,
      ...keep
    );
    for (const record of records) writeFinding(record);
    return records;
  });
}

/**
 * Stamps a component's kept findings with the run that re-checked them: an
 * incremental re-review found its patch unchanged at the new head, so they
 * describe that head too (DESIGN.md §6.21). Returns the findings.
 */
export async function restampFindingsForTargetComponent(
  repoId: string,
  targetKey: string,
  componentId: string,
  revision: Pick<FindingRecord, "reviewedBaseSha" | "reviewedHeadSha" | "reviewedAt">
): Promise<FindingRecord[]> {
  return transaction(() => {
    const stored = findingRows(
      all(
        `SELECT data FROM findings WHERE repo_id = ? AND target_key = ? AND component_id = ? AND category = 'change'`,
        repoId,
        targetKey,
        componentId
      )
    );
    for (const record of stored) {
      if (revision.reviewedBaseSha) record.reviewedBaseSha = revision.reviewedBaseSha;
      if (revision.reviewedHeadSha) record.reviewedHeadSha = revision.reviewedHeadSha;
      if (revision.reviewedAt) record.reviewedAt = revision.reviewedAt;
      writeFinding(record);
    }
    return stored;
  });
}

/**
 * Drops `change` findings for components a target no longer touches
 * (impact and intent findings are replaced wholesale by their own pass).
 *
 * Run at the end of a review, not the start: clearing everything up front
 * would blank the UI for the whole duration of a re-run, whereas per-slot
 * replacement plus this final sweep means the only findings that ever
 * disappear are the ones that are genuinely obsolete.
 */
export async function deleteFindingsForTargetExceptComponents(
  repoId: string,
  targetKey: string,
  keepComponentIds: readonly string[]
): Promise<number> {
  const keep = [...keepComponentIds];
  return run(
    `DELETE FROM findings WHERE repo_id = ? AND target_key = ? AND category = 'change'
       AND component_id NOT IN (${keep.length ? placeholders(keep.length) : "SELECT NULL WHERE 0"})`,
    repoId,
    targetKey,
    ...keep
  );
}

/**
 * Overwrite-only persistence for a whole pass that isn't per component —
 * `impact` (stale usages, each attached to the *caller's* component) or
 * `intent` (one PR-level verdict, with an empty `componentId`). Deletes
 * every finding of that category for the target and writes `findings` in
 * their place, atomically.
 */
export async function replaceFindingsForTargetCategory(
  repoId: string,
  targetKey: string,
  category: Exclude<FindingCategory, "change">,
  findings: ReadonlyArray<TargetFindingInput & { componentId: string }>
): Promise<FindingRecord[]> {
  const now = new Date().toISOString();
  const records = findings.map((finding) =>
    toStoredFinding(finding, { repoId, targetKey, componentId: finding.componentId, category }, now)
  );
  transaction(() => {
    run(`DELETE FROM findings WHERE repo_id = ? AND target_key = ? AND category = ?`, repoId, targetKey, category);
    for (const record of records) writeFinding(record);
  });
  return records;
}

/**
 * Like {@link replaceFindingsForTargetCategory}, for findings whose ids are
 * stable across runs (derived from what they are about — a cycle's files):
 * findings no longer produced are deleted, the rest are rewritten in place,
 * keeping their `createdAt`, `resolvedAt` and replies. A cycle someone
 * already answered stays answered when the target is recomputed.
 */
export async function syncFindingsForTargetCategory(
  repoId: string,
  targetKey: string,
  category: Exclude<FindingCategory, "change">,
  findings: ReadonlyArray<TargetFindingInput & { componentId: string }>
): Promise<FindingRecord[]> {
  const now = new Date().toISOString();
  const keep = findings.map((f) => f.id);
  const records: FindingRecord[] = [];
  transaction(() => {
    run(
      `DELETE FROM findings WHERE repo_id = ? AND target_key = ? AND category = ?
         AND id NOT IN (${keep.length ? placeholders(keep.length) : "SELECT NULL WHERE 0"})`,
      repoId,
      targetKey,
      category,
      ...keep
    );
    for (const finding of findings) {
      const existing = get<{ data: string }>(`SELECT data FROM findings WHERE id = ?`, finding.id);
      const previous = existing ? toFindingRecord(unpack(existing.data)) : undefined;
      const record = toStoredFinding(
        { ...finding, createdAt: previous?.createdAt ?? finding.createdAt, resolvedAt: previous?.resolvedAt, responses: previous?.responses },
        { repoId, targetKey, componentId: finding.componentId, category },
        now
      );
      writeFinding(record);
      records.push(record);
    }
  });
  return records;
}

/** `(Finding)-[:ABOUT]->(Component)`. Sets the finding's `componentId`. */
export async function linkFindingAboutComponent(findingId: string, componentId: string): Promise<void> {
  const row = get<{ data: string }>(`SELECT data FROM findings WHERE id = ?`, findingId);
  if (!row || !get(`SELECT 1 FROM components WHERE id = ?`, componentId)) return;
  writeFinding({ ...toFindingRecord(unpack(row.data)), componentId });
}

/** `(Finding)-[:FOR]->(PullRequest)`. Sets the finding's `prId`. */
export async function linkFindingForPullRequest(findingId: string, pullRequestId: string): Promise<void> {
  const row = get<{ data: string }>(`SELECT data FROM findings WHERE id = ?`, findingId);
  if (!row || !get(`SELECT 1 FROM pull_requests WHERE id = ?`, pullRequestId)) return;
  writeFinding({ ...toFindingRecord(unpack(row.data)), prId: pullRequestId });
}
