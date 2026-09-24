// Queries behind feature merges (DESIGN.md §6.3): the bulk reads/writes the
// module-tier writer needs (file ownership, dependency edges, findings
// following their files) and the `(:MergeSuggestion)` repository.
//
// Bulk writes are single `UNWIND` statements run one after another — never
// in parallel — so they stay clear of Neo4j Community's parallel
// relationship-write deadlock (DESIGN.md §17).

import { createHash } from "node:crypto";
import { runRead, runWrite } from "./client";
import { toComponentRecord } from "./component";
import type {
  ComponentRecord,
  MergeSuggestionKind,
  MergeSuggestionRecord,
  MergeSuggestionStatus,
} from "./types";

const BATCH_SIZE = 500;

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function chunks<T>(items: readonly T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Module tier
// ---------------------------------------------------------------------------

/** Every merged (feature) module of a repo. */
export async function listMergedModules(repoId: string): Promise<ComponentRecord[]> {
  const result = await runRead(
    `MATCH (c:Component {repoId: $repoId, tier: 'module', origin: 'merge'}) RETURN c ORDER BY c.name`,
    { repoId }
  );
  return result.records.map((record) => toComponentRecord(record.get("c").properties));
}

/** File path → id of the component it currently `BELONGS_TO`. */
export async function getFileOwnerMap(repoId: string): Promise<Map<string, string>> {
  const result = await runRead(
    `
    MATCH (f:File {repoId: $repoId})-[:BELONGS_TO]->(c:Component)
    RETURN f.path AS path, c.id AS componentId
    `,
    { repoId }
  );
  return new Map(
    result.records.map((r) => [r.get("path") as string, r.get("componentId") as string])
  );
}

/** Every stored file path and file-level import edge of a repo — enough to regroup without re-parsing. */
export async function getStoredImportGraph(
  repoId: string
): Promise<{ filePaths: string[]; edges: Array<{ from: string; to: string }> }> {
  const [files, edges] = await Promise.all([
    runRead(`MATCH (f:File {repoId: $repoId}) RETURN f.path AS path ORDER BY path`, { repoId }),
    runRead(
      `
      MATCH (a:File {repoId: $repoId})-[:IMPORTS]->(b:File {repoId: $repoId})
      RETURN a.path AS source, b.path AS target
      `,
      { repoId }
    ),
  ]);
  return {
    filePaths: files.records.map((r) => r.get("path") as string),
    edges: edges.records.map((r) => ({
      from: r.get("source") as string,
      to: r.get("target") as string,
    })),
  };
}

/** Points each listed file's single `BELONGS_TO` at the given component. */
export async function setFileOwners(
  repoId: string,
  owners: ReadonlyArray<{ path: string; componentId: string }>
): Promise<void> {
  for (const batch of chunks(owners)) {
    await runWrite(
      `
      UNWIND $owners AS row
      MATCH (f:File {repoId: $repoId, path: row.path})
      MATCH (c:Component {id: row.componentId})
      OPTIONAL MATCH (f)-[old:BELONGS_TO]->(:Component)
      DELETE old
      WITH DISTINCT f, c
      MERGE (f)-[:BELONGS_TO]->(c)
      `,
      { repoId, owners: batch }
    );
  }
}

/** Replaces a repo's `DEPENDS_ON` edges. */
export async function replaceComponentDependencies(
  repoId: string,
  edges: ReadonlyArray<{ from: string; to: string; weight: number }>
): Promise<void> {
  await runWrite(
    `MATCH (:Component {repoId: $repoId})-[rel:DEPENDS_ON]->(:Component) DELETE rel`,
    { repoId }
  );
  for (const batch of chunks(edges)) {
    await runWrite(
      `
      UNWIND $edges AS row
      MATCH (a:Component {id: row.from})
      MATCH (b:Component {id: row.to})
      MERGE (a)-[dep:DEPENDS_ON]->(b)
      SET dep.weight = row.weight
      `,
      { edges: batch }
    );
  }
}

/** Module id → id of the domain it is `CHILD_OF`. */
export async function getDomainByModule(repoId: string): Promise<Map<string, string>> {
  const result = await runRead(
    `
    MATCH (m:Component {repoId: $repoId, tier: 'module'})-[:CHILD_OF]->(d:Component {tier: 'domain'})
    RETURN m.id AS moduleId, d.id AS domainId
    `,
    { repoId }
  );
  return new Map(
    result.records.map((r) => [r.get("moduleId") as string, r.get("domainId") as string])
  );
}

/**
 * Makes findings follow their files (DESIGN.md §6.3):
 *
 *   1. a finding with a `filePath` moves to whichever component owns that file now;
 *   2. a finding without one, whose component is gone, moves to the merged
 *      module that absorbed that component;
 *   3. any finding left without an `ABOUT` edge whose component exists
 *      (e.g. after an Unmerge brought the folder module back) is relinked.
 *
 * Returns how many findings changed component.
 */
export async function relinkFindings(repoId: string): Promise<number> {
  const byFile = await runWrite(
    `
    MATCH (f:Finding {repoId: $repoId})
    WHERE f.filePath IS NOT NULL
    MATCH (:File {repoId: $repoId, path: f.filePath})-[:BELONGS_TO]->(c:Component)
    WHERE f.componentId <> c.id
    OPTIONAL MATCH (f)-[old:ABOUT]->(:Component)
    DELETE old
    WITH DISTINCT f, c
    SET f.componentId = c.id
    MERGE (f)-[:ABOUT]->(c)
    RETURN count(f) AS moved
    `,
    { repoId }
  );
  const byAbsorbed = await runWrite(
    `
    MATCH (f:Finding {repoId: $repoId})
    WHERE NOT EXISTS { MATCH (:Component {id: f.componentId}) }
    MATCH (m:Component {repoId: $repoId, origin: 'merge'})
    WHERE f.componentId IN coalesce(m.absorbedModuleIds, [])
    WITH f, head(collect(m)) AS m
    SET f.componentId = m.id
    MERGE (f)-[:ABOUT]->(m)
    RETURN count(f) AS moved
    `,
    { repoId }
  );
  await runWrite(
    `
    MATCH (f:Finding {repoId: $repoId})
    WHERE NOT (f)-[:ABOUT]->(:Component)
    MATCH (c:Component {id: f.componentId})
    MERGE (f)-[:ABOUT]->(c)
    `,
    { repoId }
  );
  return (
    toNumber(byFile.records[0]?.get("moved")) + toNumber(byAbsorbed.records[0]?.get("moved"))
  );
}

/** Points findings without a `filePath` of one component at another — used by Unmerge. */
export async function reassignFindingsWithoutFile(
  repoId: string,
  fromComponentId: string,
  toComponentId: string
): Promise<void> {
  await runWrite(
    `
    MATCH (f:Finding {repoId: $repoId, componentId: $fromComponentId})
    WHERE f.filePath IS NULL
    SET f.componentId = $toComponentId
    `,
    { repoId, fromComponentId, toComponentId }
  );
}

// ---------------------------------------------------------------------------
// Merge suggestions
// ---------------------------------------------------------------------------

export function mergeSuggestionId(repoId: string, key: string): string {
  return `${repoId}:suggestion:${createHash("sha1").update(key).digest("hex").slice(0, 16)}`;
}

function toSuggestion(props: Record<string, unknown>): MergeSuggestionRecord {
  return {
    id: props.id as string,
    repoId: props.repoId as string,
    key: props.key as string,
    kind: props.kind as MergeSuggestionKind,
    members: (props.members as string[] | undefined) ?? [],
    targetComponentId: (props.targetComponentId as string | null) ?? undefined,
    name: (props.name as string | undefined) ?? "",
    score: Number(props.score),
    reasons: (props.reasons as string[] | undefined) ?? [],
    status: props.status as MergeSuggestionStatus,
    scoreAtRejection:
      props.scoreAtRejection === null || props.scoreAtRejection === undefined
        ? undefined
        : Number(props.scoreAtRejection),
    updatedAt: props.updatedAt as string,
  };
}

export async function listMergeSuggestions(repoId: string): Promise<MergeSuggestionRecord[]> {
  const result = await runRead(
    `MATCH (s:MergeSuggestion {repoId: $repoId}) RETURN s ORDER BY s.score DESC, s.key ASC`,
    { repoId }
  );
  return result.records.map((r) => toSuggestion(r.get("s").properties));
}

export async function getMergeSuggestion(
  repoId: string,
  id: string
): Promise<MergeSuggestionRecord | null> {
  const result = await runRead(`MATCH (s:MergeSuggestion {id: $id, repoId: $repoId}) RETURN s`, {
    id,
    repoId,
  });
  const record = result.records[0];
  return record ? toSuggestion(record.get("s").properties) : null;
}

export async function deleteMergeSuggestion(id: string): Promise<void> {
  await runWrite(`MATCH (s:MergeSuggestion {id: $id}) DELETE s`, { id });
}

/** Reject (remembering the score) or reopen a suggestion. */
export async function setMergeSuggestionStatus(
  repoId: string,
  id: string,
  status: MergeSuggestionStatus
): Promise<MergeSuggestionRecord | null> {
  const result = await runWrite(
    `
    MATCH (s:MergeSuggestion {id: $id, repoId: $repoId})
    SET s.status = $status,
        s.scoreAtRejection = CASE WHEN $status = 'rejected' THEN s.score ELSE null END,
        s.updatedAt = $now
    RETURN s
    `,
    { id, repoId, status, now: new Date().toISOString() }
  );
  const record = result.records[0];
  return record ? toSuggestion(record.get("s").properties) : null;
}

/** A rejected suggestion comes back once its score reaches this multiple of the score it was rejected at. */
export const REOPEN_SCORE_FACTOR = 1.5;

export interface SuggestionInput {
  key: string;
  kind: MergeSuggestionKind;
  members: string[];
  targetComponentId?: string;
  name: string;
  score: number;
  reasons: string[];
}

/**
 * Stores the latest heuristic run's suggestions:
 *
 * - new ones are created `open`;
 * - open ones are refreshed, and dropped when the heuristics no longer produce them;
 * - rejected ones are kept (that is how a rejection is remembered), their
 *   score refreshed, and reopened once it reaches {@link REOPEN_SCORE_FACTOR}×
 *   the score they were rejected at.
 *
 * Returns the number of open suggestions afterwards.
 */
export async function syncMergeSuggestions(
  repoId: string,
  computed: readonly SuggestionInput[]
): Promise<number> {
  const existing = new Map((await listMergeSuggestions(repoId)).map((s) => [s.key, s]));
  const now = new Date().toISOString();

  const rows = computed.map((s) => {
    const previous = existing.get(s.key);
    let status: MergeSuggestionStatus = "open";
    let scoreAtRejection: number | null = null;
    if (previous?.status === "rejected") {
      const rejectedAt = previous.scoreAtRejection ?? s.score;
      const reopen = s.score >= rejectedAt * REOPEN_SCORE_FACTOR;
      status = reopen ? "open" : "rejected";
      scoreAtRejection = reopen ? null : rejectedAt;
    }
    return {
      id: mergeSuggestionId(repoId, s.key),
      key: s.key,
      kind: s.kind,
      members: s.members,
      targetComponentId: s.targetComponentId ?? null,
      name: s.name,
      score: s.score,
      reasons: s.reasons,
      status,
      scoreAtRejection,
    };
  });

  const keep = new Set(computed.map((s) => s.key));
  const stale = [...existing.values()]
    .filter((s) => s.status === "open" && !keep.has(s.key))
    .map((s) => s.id);
  if (stale.length > 0) {
    await runWrite(`MATCH (s:MergeSuggestion) WHERE s.id IN $ids DELETE s`, { ids: stale });
  }

  for (const batch of chunks(rows)) {
    await runWrite(
      `
      UNWIND $rows AS row
      MERGE (s:MergeSuggestion {id: row.id})
      SET s.repoId = $repoId,
          s.key = row.key,
          s.kind = row.kind,
          s.members = row.members,
          s.targetComponentId = row.targetComponentId,
          s.name = row.name,
          s.score = row.score,
          s.reasons = row.reasons,
          s.status = row.status,
          s.scoreAtRejection = row.scoreAtRejection,
          s.updatedAt = $now
      `,
      { repoId, rows: batch, now }
    );
  }

  return rows.filter((r) => r.status === "open").length;
}
