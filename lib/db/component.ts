// Typed repository functions for components, plus the relationships they
// own: DEPENDS_ON and CHILD_OF. (A component's repo is its `repoId`.)

import { all, compareText, get, pack, run, unpack } from "./client";
import type { ComponentRecord, DependsOnProps } from "./types";

export function toComponentRecord(props: Record<string, unknown>): ComponentRecord {
  return {
    id: props.id as string,
    repoId: props.repoId as string,
    name: props.name as string,
    description: (props.description as string | undefined) ?? undefined,
    createdBy: props.createdBy as ComponentRecord["createdBy"],
    pathPatterns: (props.pathPatterns as string[] | undefined) ?? [],
    tier: props.tier as ComponentRecord["tier"],
    origin: (props.origin as ComponentRecord["origin"] | undefined) ?? undefined,
    absorbedModuleIds: (props.absorbedModuleIds as string[] | undefined) ?? undefined,
    absorbedDescriptions: (props.absorbedDescriptions as string | undefined) ?? undefined,
    lostFolders: (props.lostFolders as string | undefined) ?? undefined,
  };
}

/** Rows of `SELECT data FROM components …` as records. */
export function componentRows(rows: Array<{ data: unknown }>): ComponentRecord[] {
  return rows.map((row) => toComponentRecord(unpack(row.data)));
}

/** Writes a full component record (insert or replace by `id`). */
export function writeComponent(record: ComponentRecord): void {
  run(
    `INSERT INTO components (id, repo_id, tier, name, data) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       repo_id = excluded.repo_id, tier = excluded.tier, name = excluded.name, data = excluded.data`,
    record.id,
    record.repoId,
    record.tier,
    record.name,
    pack(record)
  );
}

export type UpsertComponentInput = ComponentRecord;

/** Creates or fully replaces a component, keyed on `id`. */
export async function upsertComponent(input: UpsertComponentInput): Promise<ComponentRecord> {
  const record = toComponentRecord(JSON.parse(pack(input)));
  writeComponent(record);
  return record;
}

export async function getComponentById(id: string): Promise<ComponentRecord | null> {
  const row = get<{ data: string }>(`SELECT data FROM components WHERE id = ?`, id);
  return row ? toComponentRecord(unpack(row.data)) : null;
}

/** Lists every component for a repo, optionally narrowed to one tier. */
export async function listComponentsByRepoId(
  repoId: string,
  tier?: ComponentRecord["tier"]
): Promise<ComponentRecord[]> {
  return componentRows(
    tier
      ? all(`SELECT data FROM components WHERE repo_id = ? AND tier = ? ORDER BY name ASC`, repoId, tier)
      : all(`SELECT data FROM components WHERE repo_id = ? ORDER BY name ASC`, repoId)
  );
}

/** Lists the direct children (`CHILD_OF` this component) — e.g. module-tier components under a domain-tier parent. */
export async function listChildComponents(parentComponentId: string): Promise<ComponentRecord[]> {
  return componentRows(
    all(
      `SELECT c.data FROM component_parents p JOIN components c ON c.id = p.child_id
       WHERE p.parent_id = ? ORDER BY c.name ASC`,
      parentComponentId
    )
  );
}

export async function deleteComponent(id: string): Promise<void> {
  run(`DELETE FROM components WHERE id = ?`, id);
}

/** `(Component)-[:DEPENDS_ON {weight}]->(Component)` — aggregated from file-level `IMPORTS` edges. */
export async function linkComponentDependency(
  fromComponentId: string,
  toComponentId: string,
  props: DependsOnProps
): Promise<void> {
  run(
    `INSERT INTO component_deps (from_id, to_id, weight)
     SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM components WHERE id = ?)
                      AND EXISTS (SELECT 1 FROM components WHERE id = ?)
     ON CONFLICT (from_id, to_id) DO UPDATE SET weight = excluded.weight`,
    fromComponentId,
    toComponentId,
    props.weight,
    fromComponentId,
    toComponentId
  );
}

export async function unlinkComponentDependency(fromComponentId: string, toComponentId: string): Promise<void> {
  run(`DELETE FROM component_deps WHERE from_id = ? AND to_id = ?`, fromComponentId, toComponentId);
}

/** `(Component)-[:CHILD_OF]->(Component)` — nests a module-tier component under its domain-tier parent. */
export async function linkComponentChildOf(childComponentId: string, parentComponentId: string): Promise<void> {
  run(
    `INSERT OR IGNORE INTO component_parents (child_id, parent_id)
     SELECT ?, ? WHERE EXISTS (SELECT 1 FROM components WHERE id = ?)
                   AND EXISTS (SELECT 1 FROM components WHERE id = ?)`,
    childComponentId,
    parentComponentId,
    childComponentId,
    parentComponentId
  );
}

export async function unlinkComponentChildOf(childComponentId: string, parentComponentId: string): Promise<void> {
  run(`DELETE FROM component_parents WHERE child_id = ? AND parent_id = ?`, childComponentId, parentComponentId);
}

// ---------------------------------------------------------------------------
// Repo-wide reads for the graph view and the review/chat context.
// ---------------------------------------------------------------------------

/** Every `CHILD_OF` edge among a repo's components. */
export async function listComponentParents(repoId: string): Promise<Array<{ childId: string; parentId: string }>> {
  return all<{ childId: string; parentId: string }>(
    `SELECT p.child_id AS childId, p.parent_id AS parentId
     FROM component_parents p JOIN components c ON c.id = p.child_id
     WHERE c.repo_id = ?`,
    repoId
  );
}

/** Every `DEPENDS_ON` edge between two components of a repo. */
export async function listComponentDependencies(
  repoId: string
): Promise<Array<{ source: string; target: string; weight: number }>> {
  return all<{ source: string; target: string; weight: number }>(
    `SELECT d.from_id AS source, d.to_id AS target, d.weight AS weight
     FROM component_deps d
     JOIN components a ON a.id = d.from_id
     JOIN components b ON b.id = d.to_id
     WHERE a.repo_id = ? AND b.repo_id = ?`,
    repoId,
    repoId
  ).map((row) => ({ ...row, weight: Number(row.weight) }));
}

/** Component id → number of files that `BELONGS_TO` it, for one repo. */
export async function countFilesByComponent(repoId: string): Promise<Map<string, number>> {
  const rows = all<{ componentId: string; files: number }>(
    `SELECT o.component_id AS componentId, COUNT(*) AS files
     FROM file_owners o JOIN components c ON c.id = o.component_id
     WHERE c.repo_id = ? GROUP BY o.component_id`,
    repoId
  );
  return new Map(rows.map((row) => [row.componentId, Number(row.files)]));
}

/** Names of the components `componentId` depends on, and of those depending on it. */
function neighbourNames(componentId: string): { dependsOn: string[]; dependents: string[] } {
  const dependsOn = all<{ name: string }>(
    `SELECT DISTINCT n.name FROM component_deps d JOIN components n ON n.id = d.to_id WHERE d.from_id = ?`,
    componentId
  ).map((row) => row.name);
  const dependents = all<{ name: string }>(
    `SELECT DISTINCT n.name FROM component_deps d JOIN components n ON n.id = d.from_id WHERE d.to_id = ?`,
    componentId
  ).map((row) => row.name);
  return { dependsOn, dependents };
}

export interface ComponentNeighbourSummary {
  id: string;
  name: string;
  description?: string;
  dependsOn: string[];
  dependents: string[];
}

/** For each existing component in `componentIds` (of `repoId`): its name, description and neighbours' names. */
export async function listComponentNeighbourSummaries(
  repoId: string,
  componentIds: readonly string[]
): Promise<ComponentNeighbourSummary[]> {
  const out: ComponentNeighbourSummary[] = [];
  for (const id of componentIds) {
    const row = get<{ data: string }>(`SELECT data FROM components WHERE id = ? AND repo_id = ?`, id, repoId);
    if (!row) continue;
    const component = toComponentRecord(unpack(row.data));
    out.push({
      id: component.id,
      name: component.name,
      description: component.description,
      ...neighbourNames(component.id),
    });
  }
  return out;
}

/** One component's file paths and neighbour names (the chat's `get_component` lookup). */
export async function getComponentOverview(
  componentId: string
): Promise<{ files: string[]; deps: string[]; users: string[] }> {
  const files = all<{ path: string }>(
    `SELECT f.path FROM file_owners o JOIN files f ON f.id = o.file_id WHERE o.component_id = ?`,
    componentId
  ).map((row) => row.path);
  const { dependsOn, dependents } = neighbourNames(componentId);
  return { files, deps: dependsOn, users: dependents };
}

/** A component's direct neighbours over `DEPENDS_ON`, both directions, sorted by direction then name. */
export async function listComponentNeighbours(
  repoId: string,
  componentId: string
): Promise<Array<{ name: string; description?: string; direction: "dependsOn" | "dependent" }>> {
  if (!get(`SELECT 1 FROM components WHERE id = ? AND repo_id = ?`, componentId, repoId)) return [];
  const rows = all<{ data: string; direction: "dependsOn" | "dependent" }>(
    `SELECT n.data, 'dependsOn' AS direction FROM component_deps d JOIN components n ON n.id = d.to_id WHERE d.from_id = ?
     UNION
     SELECT n.data, 'dependent' AS direction FROM component_deps d JOIN components n ON n.id = d.from_id WHERE d.to_id = ?`,
    componentId,
    componentId
  );
  return rows
    .map((row) => {
      const c = toComponentRecord(unpack(row.data));
      return { name: c.name, description: c.description, direction: row.direction };
    })
    .sort((a, b) =>
      compareText(a.direction, b.direction) || compareText(a.name, b.name)
    );
}
