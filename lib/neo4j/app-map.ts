// Storage for the app map's AI runs (DESIGN.md §6.5): one `(:AppMap)` node
// per repo and level, holding the model's grouping (card names, members,
// explanations, key files) and edge verbs/explanations as JSON.
//
// Like `(:PrMap)`, what is stored is never the assembled map: cards, edges,
// file lists and counts are re-derived on every read from the current graph
// (lib/jobs/app-map.ts), so a re-analysis never leaves a stale picture behind
// — only the naming and explaining can age.

import { runRead, runWrite } from "./client";

export interface AppMapRecord {
  repoId: string;
  level: string;
  groups: unknown[];
  edges: unknown[];
  model: string;
  createdAt: string;
}

function appMapNodeId(repoId: string, level: string): string {
  return `${repoId}:appmap:${level}`;
}

export async function getAppMapRecords(repoId: string): Promise<AppMapRecord[]> {
  const result = await runRead(`MATCH (m:AppMap {repoId: $repoId}) RETURN m`, { repoId });
  const records: AppMapRecord[] = [];
  for (const record of result.records) {
    const props = record.get("m").properties as Record<string, unknown>;
    try {
      records.push({
        repoId: props.repoId as string,
        level: props.level as string,
        groups: JSON.parse(props.groupsJson as string),
        edges: JSON.parse((props.edgesJson as string) || "[]"),
        model: (props.model as string) ?? "",
        createdAt: (props.createdAt as string) ?? "",
      });
    } catch {
      // A corrupt blob is just "no AI map for this level" — the heuristic one still renders.
    }
  }
  return records;
}

/** Stores (replacing) one level's AI run. */
export async function saveAppMapRecord(record: AppMapRecord): Promise<void> {
  await runWrite(
    `
    MERGE (m:AppMap {id: $id})
    SET m.repoId = $repoId,
        m.level = $level,
        m.groupsJson = $groupsJson,
        m.edgesJson = $edgesJson,
        m.model = $model,
        m.createdAt = $createdAt
    `,
    {
      id: appMapNodeId(record.repoId, record.level),
      repoId: record.repoId,
      level: record.level,
      groupsJson: JSON.stringify(record.groups),
      edgesJson: JSON.stringify(record.edges),
      model: record.model,
      createdAt: record.createdAt,
    }
  );
}
