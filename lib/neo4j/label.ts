// Queries behind AI-assisted labeling — the domain tier
// that completes the Domain > Module > File hierarchy.
//
// These are the set-based reads/writes the labeling job needs and that the
// per-entity modules (component.ts, file.ts) deliberately don't expose:
// they are keyed by *repo* and cross two labels at once, where those modules
// are per-node helpers keyed by id. The node/relationship writes themselves
// still go through component.ts's typed functions (`upsertComponent`,
// `linkComponentChildOf`, `linkComponentToRepo`) — only the bulk read, the
// two domain-scoped deletes and the never-clobber description write live
// here.

import { runRead, runWrite } from "./client";

/** Neo4j returns lossless `Integer`s; every count/aggregate crosses this helper rather than being cast. */
function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Everything the labeler needs to know about one module-tier component (names, paths and dependencies only — never file contents). */
export interface ModuleLabelInput {
  id: string;
  name: string;
  /** The component's current description, so a labeling run can leave a non-empty one alone. */
  description?: string;
  fileCount: number;
  /** Every file path of the module, sorted ascending. The caller decides how many to sample. */
  filePaths: string[];
  /** Names of the components this module `DEPENDS_ON`, sorted. */
  dependsOn: string[];
}

/**
 * Loads every module-tier component of a repo with its file paths and its
 * outgoing dependency names, in one round-trip.
 *
 * The two `OPTIONAL MATCH`es form a cartesian product per component, which
 * `collect(DISTINCT …)` folds back down — the same trade-off
 * `lib/jobs/diff-components.ts` documents, and the same scale (tens to low
 * hundreds of components).
 */
export async function listModuleLabelInputs(
  repoId: string
): Promise<ModuleLabelInput[]> {
  const result = await runRead(
    `
    MATCH (c:Component {repoId: $repoId, tier: 'module'})
    OPTIONAL MATCH (f:File)-[:BELONGS_TO]->(c)
    OPTIONAL MATCH (c)-[:DEPENDS_ON]->(dep:Component)
    RETURN c.id AS id,
           c.name AS name,
           c.description AS description,
           collect(DISTINCT f.path) AS filePaths,
           collect(DISTINCT dep.name) AS dependsOn
    ORDER BY name ASC
    `,
    { repoId }
  );

  return result.records.map((record) => {
    const filePaths = (record.get("filePaths") as Array<string | null>)
      .filter((path): path is string => typeof path === "string")
      .sort((a, b) => a.localeCompare(b));
    const dependsOn = (record.get("dependsOn") as Array<string | null>)
      .filter((name): name is string => typeof name === "string")
      .sort((a, b) => a.localeCompare(b));

    return {
      id: record.get("id") as string,
      name: record.get("name") as string,
      description: (record.get("description") as string | null) ?? undefined,
      fileCount: filePaths.length,
      filePaths,
      dependsOn,
    };
  });
}

/**
 * Removes a repo's auto-generated domain-tier components, `DETACH` so their
 * `CHILD_OF`/`PART_OF` edges go with them.
 *
 * This is what makes a re-label a *replace* rather than a duplicate: the ids
 * are derived from the domain names the model picks, so a second run with
 * different names would otherwise leave the first run's boxes behind.
 * `createdBy: 'user'` domains are never touched.
 */
export async function deleteAutoDomainComponents(repoId: string): Promise<number> {
  const result = await runWrite(
    `
    MATCH (c:Component {repoId: $repoId, tier: 'domain'})
    WHERE c.createdBy = 'auto'
    WITH c, count(*) AS ignored
    DETACH DELETE c
    RETURN count(ignored) AS deleted
    `,
    { repoId }
  );
  return toNumber(result.records[0]?.get("deleted"));
}

/**
 * Removes auto domain components that have no children left.
 *
 * Called by the analysis job after it prunes modules:
 * re-analysis must not destroy the domain tier, but a domain whose every
 * module disappeared is an empty box with nothing to group, so it goes.
 */
export async function deleteEmptyAutoDomainComponents(
  repoId: string
): Promise<number> {
  const result = await runWrite(
    `
    MATCH (c:Component {repoId: $repoId, tier: 'domain'})
    WHERE c.createdBy = 'auto'
      AND NOT EXISTS { MATCH (:Component)-[:CHILD_OF]->(c) }
    WITH c, count(*) AS ignored
    DETACH DELETE c
    RETURN count(ignored) AS deleted
    `,
    { repoId }
  );
  return toNumber(result.records[0]?.get("deleted"));
}

/**
 * Writes a component's description, by default only when it doesn't have one.
 *
 * Descriptions are user-editable data (they live only in Neo4j
 * and are edited in-app). There is no description editor in the UI yet, but
 * an automatic labeling pass must not be the thing that establishes the
 * habit of overwriting curated text — so the default is never-clobber, and
 * `force` is the explicit way a user asks for a full relabel.
 *
 * Returns `true` when the node was actually updated.
 */
export async function setComponentDescription(
  componentId: string,
  description: string,
  options: { force?: boolean } = {}
): Promise<boolean> {
  const result = await runWrite(
    `
    MATCH (c:Component {id: $componentId})
    WHERE $force OR c.description IS NULL OR trim(c.description) = ''
    SET c.description = $description
    RETURN count(c) AS updated
    `,
    { componentId, description, force: options.force === true }
  );
  return toNumber(result.records[0]?.get("updated")) > 0;
}

/** What `GET /api/repos/[repoId]/label` reports about a repo's labeling state, independent of any job record. */
export interface LabelSummary {
  /** Domain-tier components (any `createdBy`). */
  domains: number;
  /** Module-tier components carrying a non-empty description. */
  describedModules: number;
  /** Module-tier components in total — the denominator for the above. */
  modules: number;
}

export async function getLabelSummary(repoId: string): Promise<LabelSummary> {
  const result = await runRead(
    `
    MATCH (c:Component {repoId: $repoId})
    RETURN
      count(CASE WHEN c.tier = 'domain' THEN 1 END) AS domains,
      count(CASE WHEN c.tier = 'module' THEN 1 END) AS modules,
      count(CASE WHEN c.tier = 'module' AND c.description IS NOT NULL
                  AND trim(c.description) <> '' THEN 1 END) AS describedModules
    `,
    { repoId }
  );
  const record = result.records[0];
  return {
    domains: toNumber(record?.get("domains")),
    modules: toNumber(record?.get("modules")),
    describedModules: toNumber(record?.get("describedModules")),
  };
}
