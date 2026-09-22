// Typed repository functions for the `(:Component)` node label (DESIGN.md
// §7, §6/§6.1), plus the relationships it participates in as the "owning"
// side: DEPENDS_ON, CHILD_OF, and PART_OF.

import { runRead, runWrite } from "./client";
import type { ComponentRecord, DependsOnProps } from "./types";

function toComponentRecord(props: Record<string, unknown>): ComponentRecord {
  return {
    id: props.id as string,
    repoId: props.repoId as string,
    name: props.name as string,
    description: (props.description as string | undefined) ?? undefined,
    createdBy: props.createdBy as ComponentRecord["createdBy"],
    pathPatterns: (props.pathPatterns as string[] | undefined) ?? [],
    tier: props.tier as ComponentRecord["tier"],
  };
}

export type UpsertComponentInput = ComponentRecord;

/** Creates or fully replaces a `(:Component)` node, keyed on `id`. */
export async function upsertComponent(
  input: UpsertComponentInput
): Promise<ComponentRecord> {
  const result = await runWrite(
    `
    MERGE (c:Component {id: $id})
    SET c.repoId = $repoId,
        c.name = $name,
        c.description = $description,
        c.createdBy = $createdBy,
        c.pathPatterns = $pathPatterns,
        c.tier = $tier
    RETURN c
    `,
    {
      id: input.id,
      repoId: input.repoId,
      name: input.name,
      description: input.description ?? null,
      createdBy: input.createdBy,
      pathPatterns: input.pathPatterns,
      tier: input.tier,
    }
  );
  return toComponentRecord(result.records[0].get("c").properties);
}

export async function getComponentById(
  id: string
): Promise<ComponentRecord | null> {
  const result = await runRead(`MATCH (c:Component {id: $id}) RETURN c`, {
    id,
  });
  const record = result.records[0];
  return record ? toComponentRecord(record.get("c").properties) : null;
}

/** Lists every component for a repo, optionally narrowed to one tier (§6.1). */
export async function listComponentsByRepoId(
  repoId: string,
  tier?: ComponentRecord["tier"]
): Promise<ComponentRecord[]> {
  const result = await runRead(
    `
    MATCH (c:Component {repoId: $repoId})
    WHERE $tier IS NULL OR c.tier = $tier
    RETURN c
    ORDER BY c.name ASC
    `,
    { repoId, tier: tier ?? null }
  );
  return result.records.map((record) =>
    toComponentRecord(record.get("c").properties)
  );
}

/** Lists the direct children (`CHILD_OF` this component) — e.g. module-tier components under a domain-tier parent (§6.1). */
export async function listChildComponents(
  parentComponentId: string
): Promise<ComponentRecord[]> {
  const result = await runRead(
    `
    MATCH (child:Component)-[:CHILD_OF]->(:Component {id: $parentComponentId})
    RETURN child
    ORDER BY child.name ASC
    `,
    { parentComponentId }
  );
  return result.records.map((record) =>
    toComponentRecord(record.get("child").properties)
  );
}

export async function deleteComponent(id: string): Promise<void> {
  await runWrite(`MATCH (c:Component {id: $id}) DETACH DELETE c`, { id });
}

/** `(Component)-[:DEPENDS_ON {weight}]->(Component)` — aggregated from file-level `IMPORTS` edges (§7). */
export async function linkComponentDependency(
  fromComponentId: string,
  toComponentId: string,
  props: DependsOnProps
): Promise<void> {
  await runWrite(
    `
    MATCH (from:Component {id: $fromComponentId})
    MATCH (to:Component {id: $toComponentId})
    MERGE (from)-[dep:DEPENDS_ON]->(to)
    SET dep.weight = $weight
    `,
    { fromComponentId, toComponentId, weight: props.weight }
  );
}

export async function unlinkComponentDependency(
  fromComponentId: string,
  toComponentId: string
): Promise<void> {
  await runWrite(
    `
    MATCH (:Component {id: $fromComponentId})-[dep:DEPENDS_ON]->(:Component {id: $toComponentId})
    DELETE dep
    `,
    { fromComponentId, toComponentId }
  );
}

/** `(Component)-[:CHILD_OF]->(Component)` — nests a module-tier component under its domain-tier parent (§6.1). */
export async function linkComponentChildOf(
  childComponentId: string,
  parentComponentId: string
): Promise<void> {
  await runWrite(
    `
    MATCH (child:Component {id: $childComponentId})
    MATCH (parent:Component {id: $parentComponentId})
    MERGE (child)-[:CHILD_OF]->(parent)
    `,
    { childComponentId, parentComponentId }
  );
}

export async function unlinkComponentChildOf(
  childComponentId: string,
  parentComponentId: string
): Promise<void> {
  await runWrite(
    `
    MATCH (:Component {id: $childComponentId})-[rel:CHILD_OF]->(:Component {id: $parentComponentId})
    DELETE rel
    `,
    { childComponentId, parentComponentId }
  );
}

/** `(Component)-[:PART_OF]->(Repo)` */
export async function linkComponentToRepo(
  componentId: string,
  repoId: string
): Promise<void> {
  await runWrite(
    `
    MATCH (c:Component {id: $componentId})
    MATCH (r:Repo {id: $repoId})
    MERGE (c)-[:PART_OF]->(r)
    `,
    { componentId, repoId }
  );
}
