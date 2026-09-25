// Queries behind the PR map (DESIGN.md §6.4): the one-hop import
// neighbourhood of a diff's changed files, the names of the components
// involved, and the `(:PrMap)` node that stores the review job's AI grouping
// for one review target.
//
// What is stored is the *grouping* (card names, descriptions, which files
// each card holds, edge verbs), never the assembled map: cards, edges,
// context cards and +/- counts are re-derived on every read from the current
// diff and graph, so the stored part can only ever be the model's naming.

import { runRead, runWrite } from "./client";

export interface PrMapImportRecord {
  from: string;
  to: string;
  fromComponentId?: string;
  toComponentId?: string;
}

/**
 * Every `IMPORTS` edge with at least one endpoint in `paths`, with both
 * endpoints' owning components. Outbound and inbound are separate
 * statements: a single `(a)-[:IMPORTS]-(b)` match with an `OR` on the two
 * endpoints can't use the `path` lookup for either side.
 */
export async function listPrMapImports(
  repoId: string,
  paths: readonly string[]
): Promise<PrMapImportRecord[]> {
  if (paths.length === 0) return [];
  const [outbound, inbound] = await Promise.all([
    runRead(
      `
      UNWIND $paths AS path
      MATCH (a:File {repoId: $repoId, path: path})-[:IMPORTS]->(b:File {repoId: $repoId})
      OPTIONAL MATCH (a)-[:BELONGS_TO]->(ca:Component)
      OPTIONAL MATCH (b)-[:BELONGS_TO]->(cb:Component)
      RETURN a.path AS source, b.path AS target, ca.id AS sourceComponent, cb.id AS targetComponent
      `,
      { repoId, paths: [...paths] }
    ),
    runRead(
      `
      UNWIND $paths AS path
      MATCH (a:File {repoId: $repoId})-[:IMPORTS]->(b:File {repoId: $repoId, path: path})
      OPTIONAL MATCH (a)-[:BELONGS_TO]->(ca:Component)
      OPTIONAL MATCH (b)-[:BELONGS_TO]->(cb:Component)
      RETURN a.path AS source, b.path AS target, ca.id AS sourceComponent, cb.id AS targetComponent
      `,
      { repoId, paths: [...paths] }
    ),
  ]);
  return [...outbound.records, ...inbound.records].map((record) => ({
    from: record.get("source") as string,
    to: record.get("target") as string,
    fromComponentId: (record.get("sourceComponent") as string | null) ?? undefined,
    toComponentId: (record.get("targetComponent") as string | null) ?? undefined,
  }));
}

/** Name and description of each component in `ids` that still exists. */
export async function listPrMapComponents(
  repoId: string,
  ids: readonly string[]
): Promise<Array<{ id: string; name: string; description?: string }>> {
  if (ids.length === 0) return [];
  const result = await runRead(
    `
    UNWIND $ids AS id
    MATCH (c:Component {id: id, repoId: $repoId})
    RETURN c.id AS id, c.name AS name, c.description AS description
    `,
    { repoId, ids: [...ids] }
  );
  return result.records.map((record) => ({
    id: record.get("id") as string,
    name: record.get("name") as string,
    description: (record.get("description") as string | null) || undefined,
  }));
}

/** The AI grouping the review job stored for one target. */
export interface PrMapGroupingRecord {
  repoId: string;
  targetKey: string;
  /** {@link prMapFilesKey} of the changed files the grouping was made for. */
  filesKey: string;
  groups: Array<{ name: string; description?: string; files: string[] }>;
  edgeLabels: Array<{ from: string; to: string; label: string }>;
  model: string;
  createdAt: string;
}

function prMapNodeId(repoId: string, targetKey: string): string {
  return `${repoId}:prmap:${targetKey}`;
}

/** Order-independent fingerprint of a set of changed paths. */
export function prMapFilesKey(paths: readonly string[]): string {
  return [...new Set(paths)].sort().join("\n");
}

export async function getPrMapGrouping(
  repoId: string,
  targetKey: string
): Promise<PrMapGroupingRecord | null> {
  const result = await runRead(`MATCH (m:PrMap {id: $id}) RETURN m`, {
    id: prMapNodeId(repoId, targetKey),
  });
  const record = result.records[0];
  if (!record) return null;
  const props = record.get("m").properties as Record<string, unknown>;
  try {
    return {
      repoId: props.repoId as string,
      targetKey: props.targetKey as string,
      filesKey: props.filesKey as string,
      groups: JSON.parse(props.groupsJson as string),
      edgeLabels: JSON.parse((props.edgeLabelsJson as string) || "[]"),
      model: (props.model as string) ?? "",
      createdAt: (props.createdAt as string) ?? "",
    };
  } catch {
    // A corrupt blob is just "no AI grouping" — the heuristic map still renders.
    return null;
  }
}

/**
 * Stores (replacing) the AI grouping for a target, linked to its
 * `(:PullRequest)` node when there is one. Arrays of maps aren't a Neo4j
 * property type, hence the JSON strings.
 */
export async function savePrMapGrouping(
  record: PrMapGroupingRecord,
  prId?: string
): Promise<void> {
  await runWrite(
    `
    MERGE (m:PrMap {id: $id})
    SET m.repoId = $repoId,
        m.targetKey = $targetKey,
        m.filesKey = $filesKey,
        m.groupsJson = $groupsJson,
        m.edgeLabelsJson = $edgeLabelsJson,
        m.model = $model,
        m.createdAt = $createdAt
    WITH m
    OPTIONAL MATCH (p:PullRequest {id: $prId})
    FOREACH (_ IN CASE WHEN p IS NULL THEN [] ELSE [1] END | MERGE (m)-[:FOR]->(p))
    `,
    {
      id: prMapNodeId(record.repoId, record.targetKey),
      repoId: record.repoId,
      targetKey: record.targetKey,
      filesKey: record.filesKey,
      groupsJson: JSON.stringify(record.groups),
      edgeLabelsJson: JSON.stringify(record.edgeLabels),
      model: record.model,
      createdAt: record.createdAt,
      prId: prId ?? null,
    }
  );
}
