// Typed repository functions for the `(:Finding)` node label (DESIGN.md
// §7, §9), plus the relationships it participates in as the "owning"
// side: ABOUT (-> Component) and FOR (-> PullRequest).
//
// Findings are overwritten, not versioned, when a review is re-run (§10) —
// `replaceFindingsForTargetComponent` implements that overwrite-only
// semantics for a given (repoId, targetKey, componentId) triple, where
// `targetKey` identifies *what* was reviewed (`pr:<number>` or
// `refs:<base>...<head>` — see `FindingRecord.targetKey`).

import { runRead, runWrite } from "./client";
import type { FindingRecord } from "./types";

function toFindingRecord(props: Record<string, unknown>): FindingRecord {
  return {
    id: props.id as string,
    repoId: props.repoId as string,
    // Findings written before `targetKey` existed have none. Defaulting to
    // "" (rather than throwing) keeps a pre-existing database readable —
    // such a finding simply never matches a target lookup.
    targetKey: (props.targetKey as string | undefined) ?? "",
    prId: (props.prId as string | undefined) ?? undefined,
    componentId: props.componentId as string,
    filePath: (props.filePath as string | undefined) ?? undefined,
    lineRange: (props.lineRange as string | undefined) ?? undefined,
    summary: props.summary as string,
    intentMatch: props.intentMatch as FindingRecord["intentMatch"],
    confidence: Number(props.confidence),
    rationale: props.rationale as string,
    model: props.model as string,
    createdAt: props.createdAt as string,
    // Legacy findings (written before stale-review detection) have none of
    // these — leave them undefined rather than inventing values.
    reviewedBaseSha: (props.reviewedBaseSha as string | undefined) ?? undefined,
    reviewedHeadSha: (props.reviewedHeadSha as string | undefined) ?? undefined,
    reviewedAt: (props.reviewedAt as string | undefined) ?? undefined,
  };
}

export type UpsertFindingInput = Omit<FindingRecord, "createdAt"> & {
  createdAt?: string;
};

/** Creates or fully replaces a `(:Finding)` node, keyed on `id`. */
export async function upsertFinding(
  input: UpsertFindingInput
): Promise<FindingRecord> {
  const result = await runWrite(
    `
    MERGE (f:Finding {id: $id})
    SET f.repoId = $repoId,
        f.targetKey = $targetKey,
        f.prId = $prId,
        f.componentId = $componentId,
        f.filePath = $filePath,
        f.lineRange = $lineRange,
        f.summary = $summary,
        f.intentMatch = $intentMatch,
        f.confidence = $confidence,
        f.rationale = $rationale,
        f.model = $model,
        f.reviewedBaseSha = $reviewedBaseSha,
        f.reviewedHeadSha = $reviewedHeadSha,
        f.reviewedAt = $reviewedAt,
        f.createdAt = coalesce(f.createdAt, $createdAt)
    RETURN f
    `,
    {
      id: input.id,
      repoId: input.repoId,
      targetKey: input.targetKey,
      prId: input.prId ?? null,
      componentId: input.componentId,
      filePath: input.filePath ?? null,
      lineRange: input.lineRange ?? null,
      summary: input.summary,
      intentMatch: input.intentMatch,
      confidence: input.confidence,
      rationale: input.rationale,
      model: input.model,
      reviewedBaseSha: input.reviewedBaseSha ?? null,
      reviewedHeadSha: input.reviewedHeadSha ?? null,
      reviewedAt: input.reviewedAt ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
    }
  );
  return toFindingRecord(result.records[0].get("f").properties);
}

export async function getFindingById(
  id: string
): Promise<FindingRecord | null> {
  const result = await runRead(`MATCH (f:Finding {id: $id}) RETURN f`, {
    id,
  });
  const record = result.records[0];
  return record ? toFindingRecord(record.get("f").properties) : null;
}

export async function listFindingsByRepoId(
  repoId: string
): Promise<FindingRecord[]> {
  const result = await runRead(
    `MATCH (f:Finding {repoId: $repoId}) RETURN f ORDER BY f.createdAt DESC`,
    { repoId }
  );
  return result.records.map((record) =>
    toFindingRecord(record.get("f").properties)
  );
}

export async function listFindingsByPullRequestId(
  prId: string
): Promise<FindingRecord[]> {
  const result = await runRead(
    `MATCH (f:Finding {prId: $prId}) RETURN f ORDER BY f.createdAt DESC`,
    { prId }
  );
  return result.records.map((record) =>
    toFindingRecord(record.get("f").properties)
  );
}

export async function listFindingsByComponentId(
  componentId: string
): Promise<FindingRecord[]> {
  const result = await runRead(
    `MATCH (f:Finding {componentId: $componentId}) RETURN f ORDER BY f.createdAt DESC`,
    { componentId }
  );
  return result.records.map((record) =>
    toFindingRecord(record.get("f").properties)
  );
}

export async function deleteFinding(id: string): Promise<void> {
  await runWrite(`MATCH (f:Finding {id: $id}) DETACH DELETE f`, { id });
}

/**
 * Deletes every existing `(:Finding)` for a given `(prId, componentId)`
 * pair. Call this immediately before writing fresh findings for that pair
 * to implement §10's "overwritten, not versioned" behavior when a PR's
 * head SHA changes.
 */
export async function deleteFindingsForPullRequestComponent(
  prId: string,
  componentId: string
): Promise<void> {
  await runWrite(
    `
    MATCH (f:Finding {prId: $prId, componentId: $componentId})
    DETACH DELETE f
    `,
    { prId, componentId }
  );
}

// ---------------------------------------------------------------------------
// Target-scoped findings (§9, §10) — one "review target" is a PR or a
// base...head ref comparison, identified by `targetKey`.
// ---------------------------------------------------------------------------

/** A finding joined with the display name of the `Component` it is `ABOUT`. The UI lists findings per target and needs the component's name, which lives on the component node, not the finding. */
export interface FindingWithComponent extends FindingRecord {
  /** `Component.name`, or `""` when the component has since been pruned by a re-analysis. */
  componentName: string;
}

/**
 * Every finding persisted so far for one review target, joined with its
 * component's name.
 *
 * Deliberately a plain read with no job/queue awareness: the review job
 * writes findings per component *as it goes* (§9 — "findings stream into the
 * UI per node as they complete"), so polling this while a job is running is
 * exactly how the UI streams them.
 */
export async function listFindingsByTargetKey(
  repoId: string,
  targetKey: string
): Promise<FindingWithComponent[]> {
  const result = await runRead(
    `
    MATCH (f:Finding {repoId: $repoId, targetKey: $targetKey})
    OPTIONAL MATCH (c:Component {id: f.componentId})
    RETURN f, c.name AS componentName
    ORDER BY componentName ASC, f.filePath ASC, f.createdAt ASC
    `,
    { repoId, targetKey }
  );
  return result.records.map((record) => ({
    ...toFindingRecord(record.get("f").properties),
    componentName: (record.get("componentName") as string | null) ?? "",
  }));
}

/** The per-finding payload `replaceFindingsForTargetComponent` writes — everything on a `FindingRecord` except the three properties that identify the (target, component) slot, which are passed separately. */
export type TargetFindingInput = Omit<
  FindingRecord,
  "repoId" | "targetKey" | "componentId" | "createdAt"
> & { createdAt?: string };

/**
 * Overwrite-only persistence for one (target, component) slot (§10):
 * deletes whatever findings exist for `(repoId, targetKey, componentId)` and
 * writes `findings` in their place, wiring up `ABOUT -> (:Component)` and,
 * when a `(:PullRequest)` node with the finding's `prId` exists, `FOR ->
 * (:PullRequest)` (§7).
 *
 * Written as exactly two statements — one delete, one `UNWIND` insert —
 * rather than a node upsert plus a relationship call per finding. Beyond
 * being fewer round-trips, that matters for correctness on Neo4j Community:
 * relationship-creating writes that share an endpoint (every finding for a
 * component MERGEs an edge to the *same* component node) deadlock under
 * Forseti locking when run concurrently, so the whole component's batch is
 * one statement and callers must still run these serially across components.
 * See `NEO4J_RELATIONSHIP_WRITE_CONCURRENCY` in lib/jobs/analyze.ts.
 *
 * A missing component (or PR) node is not an error: the findings are still
 * written, just without that edge, so a review never loses data because the
 * graph was re-analyzed underneath it.
 */
export async function replaceFindingsForTargetComponent(
  repoId: string,
  targetKey: string,
  componentId: string,
  findings: readonly TargetFindingInput[]
): Promise<FindingRecord[]> {
  await runWrite(
    `
    MATCH (f:Finding {repoId: $repoId, targetKey: $targetKey, componentId: $componentId})
    DETACH DELETE f
    `,
    { repoId, targetKey, componentId }
  );

  if (findings.length === 0) return [];

  const now = new Date().toISOString();
  const rows = findings.map((finding) => ({
    id: finding.id,
    prId: finding.prId ?? null,
    filePath: finding.filePath ?? null,
    lineRange: finding.lineRange ?? null,
    summary: finding.summary,
    intentMatch: finding.intentMatch,
    confidence: finding.confidence,
    rationale: finding.rationale,
    model: finding.model,
    // `SET f += row` with a null removes the property, so a finding without
    // shas simply has none (the "legacy" shape) rather than a stored null.
    reviewedBaseSha: finding.reviewedBaseSha ?? null,
    reviewedHeadSha: finding.reviewedHeadSha ?? null,
    reviewedAt: finding.reviewedAt ?? null,
    createdAt: finding.createdAt ?? now,
  }));

  const result = await runWrite(
    `
    OPTIONAL MATCH (c:Component {id: $componentId})
    WITH c
    UNWIND $rows AS row
    CREATE (f:Finding)
    SET f += row,
        f.repoId = $repoId,
        f.targetKey = $targetKey,
        f.componentId = $componentId
    FOREACH (target IN CASE WHEN c IS NULL THEN [] ELSE [c] END |
      MERGE (f)-[:ABOUT]->(target)
    )
    WITH f
    // A PR node only exists once the review pipeline has upserted it, and
    // ref-comparison findings have no prId at all — so this is a lookup that
    // is allowed to find nothing rather than a required join.
    OPTIONAL MATCH (p:PullRequest {id: f.prId})
    FOREACH (target IN CASE WHEN p IS NULL THEN [] ELSE [p] END |
      MERGE (f)-[:FOR]->(target)
    )
    RETURN f
    `,
    { repoId, targetKey, componentId, rows }
  );

  return result.records.map((record) =>
    toFindingRecord(record.get("f").properties)
  );
}

/**
 * Drops findings for components a target no longer touches.
 *
 * Run at the end of a review, not the start: clearing everything up front
 * would blank the UI for the whole duration of a re-run, whereas per-slot
 * replacement plus this final sweep means the only findings that ever
 * disappear are the ones that are genuinely obsolete (a file moved out of a
 * component, or the diff itself changed).
 */
export async function deleteFindingsForTargetExceptComponents(
  repoId: string,
  targetKey: string,
  keepComponentIds: readonly string[]
): Promise<number> {
  const result = await runWrite(
    `
    MATCH (f:Finding {repoId: $repoId, targetKey: $targetKey})
    WHERE NOT f.componentId IN $keepComponentIds
    // Collect first, then delete inside FOREACH: this always yields exactly
    // one row (so the count is readable even when nothing matched), and
    // avoids returning anything derived from an already-deleted node.
    WITH collect(f) AS doomed
    FOREACH (f IN doomed | DETACH DELETE f)
    RETURN size(doomed) AS deleted
    `,
    { repoId, targetKey, keepComponentIds: [...keepComponentIds] }
  );
  const record = result.records[0];
  return record ? Number(record.get("deleted")) : 0;
}

/** `(Finding)-[:ABOUT]->(Component)` */
export async function linkFindingAboutComponent(
  findingId: string,
  componentId: string
): Promise<void> {
  await runWrite(
    `
    MATCH (f:Finding {id: $findingId})
    MATCH (c:Component {id: $componentId})
    MERGE (f)-[:ABOUT]->(c)
    `,
    { findingId, componentId }
  );
}

/** `(Finding)-[:FOR]->(PullRequest)` */
export async function linkFindingForPullRequest(
  findingId: string,
  pullRequestId: string
): Promise<void> {
  await runWrite(
    `
    MATCH (f:Finding {id: $findingId})
    MATCH (p:PullRequest {id: $pullRequestId})
    MERGE (f)-[:FOR]->(p)
    `,
    { findingId, pullRequestId }
  );
}
