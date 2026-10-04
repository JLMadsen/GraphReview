// Queries behind the PR map (DESIGN.md §6.4): the one-hop import
// neighbourhood of a diff's changed files, the names of the components
// involved, and the stored record of the review job's AI grouping
// for one review target.
//
// What is stored is the *grouping* (card names, descriptions, which files
// each card holds, edge verbs), never the assembled map: cards, edges,
// context cards and +/- counts are re-derived on every read from the current
// diff and graph, so the stored part can only ever be the model's naming.

import { all, get, pack, run, unpack } from "./client";

export interface PrMapImportRecord {
  from: string;
  to: string;
  fromComponentId?: string;
  toComponentId?: string;
}

/** Every `IMPORTS` edge with at least one endpoint in `paths`, with both endpoints' owning components. Outbound edges first, then inbound. */
export async function listPrMapImports(
  repoId: string,
  paths: readonly string[]
): Promise<PrMapImportRecord[]> {
  if (paths.length === 0) return [];
  type Row = { source: string; target: string; sourceComponent: string | null; targetComponent: string | null };
  const select = `SELECT a.path AS source, b.path AS target, oa.component_id AS sourceComponent, ob.component_id AS targetComponent
     FROM file_imports i
     JOIN files a ON a.id = i.from_id
     JOIN files b ON b.id = i.to_id
     LEFT JOIN file_owners oa ON oa.file_id = a.id
     LEFT JOIN file_owners ob ON ob.file_id = b.id
     WHERE a.repo_id = ? AND b.repo_id = ?`;
  const rows: Row[] = [];
  for (const path of paths) rows.push(...all<Row>(`${select} AND a.path = ?`, repoId, repoId, path));
  for (const path of paths) rows.push(...all<Row>(`${select} AND b.path = ?`, repoId, repoId, path));
  return rows.map((row) => ({
    from: row.source,
    to: row.target,
    fromComponentId: row.sourceComponent ?? undefined,
    toComponentId: row.targetComponent ?? undefined,
  }));
}

/** Name and description of each component in `ids` that still exists. */
export async function listPrMapComponents(
  repoId: string,
  ids: readonly string[]
): Promise<Array<{ id: string; name: string; description?: string }>> {
  const out: Array<{ id: string; name: string; description?: string }> = [];
  for (const id of ids) {
    const row = get<{ data: string }>(`SELECT data FROM components WHERE id = ? AND repo_id = ?`, id, repoId);
    if (!row) continue;
    const props = unpack(row.data);
    out.push({
      id: props.id as string,
      name: props.name as string,
      description: (props.description as string | undefined) || undefined,
    });
  }
  return out;
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
  const row = get<{ data: string }>(`SELECT data FROM pr_maps WHERE id = ?`, prMapNodeId(repoId, targetKey));
  if (!row) return null;
  try {
    const props = unpack(row.data);
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

/** Stores (replacing) the AI grouping for a target. */
export async function savePrMapGrouping(record: PrMapGroupingRecord, prId?: string): Promise<void> {
  const id = prMapNodeId(record.repoId, record.targetKey);
  run(
    `INSERT INTO pr_maps (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
    id,
    pack({
      id,
      repoId: record.repoId,
      targetKey: record.targetKey,
      filesKey: record.filesKey,
      groupsJson: JSON.stringify(record.groups),
      edgeLabelsJson: JSON.stringify(record.edgeLabels),
      model: record.model,
      createdAt: record.createdAt,
      prId,
    })
  );
}
