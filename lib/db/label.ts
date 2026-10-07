// Queries behind AI-assisted labeling — the domain tier that completes the
// Domain > Module > File hierarchy.
//
// These are the set-based reads/writes the labeling job needs and that the
// per-entity modules (component.ts, file.ts) deliberately don't expose:
// they are keyed by *repo* and span several tables. The node/relationship
// writes themselves still go through component.ts's typed functions.

import { all, get, run, transaction, unpack } from "./client";
import { componentRows, toComponentRecord, writeComponent } from "./component";

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

/** Loads every module-tier component of a repo with its file paths and its outgoing dependency names. */
export async function listModuleLabelInputs(repoId: string): Promise<ModuleLabelInput[]> {
  const modules = componentRows(
    all(`SELECT data FROM components WHERE repo_id = ? AND tier = 'module' ORDER BY name ASC`, repoId)
  );
  return modules.map((module) => {
    const filePaths = all<{ path: string }>(
      `SELECT DISTINCT f.path FROM file_owners o JOIN files f ON f.id = o.file_id WHERE o.component_id = ?`,
      module.id
    )
      .map((row) => row.path)
      .sort((a, b) => a.localeCompare(b));
    const dependsOn = all<{ name: string }>(
      `SELECT DISTINCT n.name FROM component_deps d JOIN components n ON n.id = d.to_id WHERE d.from_id = ?`,
      module.id
    )
      .map((row) => row.name)
      .sort((a, b) => a.localeCompare(b));
    return {
      id: module.id,
      name: module.name,
      description: module.description,
      fileCount: filePaths.length,
      filePaths,
      dependsOn,
    };
  });
}

/**
 * Removes a repo's auto-generated domain-tier components, with their edges.
 *
 * This is what makes a re-label a *replace* rather than a duplicate: the ids
 * are derived from the domain names the model picks, so a second run with
 * different names would otherwise leave the first run's boxes behind.
 * `createdBy: 'user'` domains are never touched.
 */
export async function deleteAutoDomainComponents(repoId: string): Promise<number> {
  return run(
    `DELETE FROM components
     WHERE repo_id = ? AND tier = 'domain' AND json_extract(data, '$.createdBy') = 'auto'`,
    repoId
  );
}

/**
 * Removes auto domain components that have no children left.
 *
 * Called by the analysis job after it prunes modules: re-analysis must not
 * destroy the domain tier, but a domain whose every module disappeared is an
 * empty box with nothing to group, so it goes.
 */
export async function deleteEmptyAutoDomainComponents(repoId: string): Promise<number> {
  return run(
    `DELETE FROM components
     WHERE repo_id = ? AND tier = 'domain' AND json_extract(data, '$.createdBy') = 'auto'
       AND NOT EXISTS (SELECT 1 FROM component_parents p WHERE p.parent_id = components.id)`,
    repoId
  );
}

/**
 * Writes a component's description, by default only when it doesn't have one.
 *
 * Descriptions are user-editable data. An automatic labeling pass must not
 * be the thing that overwrites curated text — so the default is
 * never-clobber, and `force` is the explicit way a user asks for a full
 * relabel.
 *
 * Returns `true` when the component was actually updated.
 */
export async function setComponentDescription(
  componentId: string,
  description: string,
  options: { force?: boolean } = {}
): Promise<boolean> {
  return transaction(() => {
    const row = get<{ data: string }>(`SELECT data FROM components WHERE id = ?`, componentId);
    if (!row) return false;
    const component = toComponentRecord(unpack(row.data));
    if (!options.force && component.description && component.description.trim() !== "") return false;
    writeComponent({ ...component, description });
    return true;
  });
}

/** A repo's labeling state, independent of any job record — what the label route (removed for now, see lib/jobs/label-queue.ts) reported. */
export interface LabelSummary {
  /** Domain-tier components (any `createdBy`). */
  domains: number;
  /** Module-tier components carrying a non-empty description. */
  describedModules: number;
  /** Module-tier components in total — the denominator for the above. */
  modules: number;
}

export async function getLabelSummary(repoId: string): Promise<LabelSummary> {
  const row = get<{ domains: number; modules: number; describedModules: number }>(
    `SELECT
       COUNT(CASE WHEN tier = 'domain' THEN 1 END) AS domains,
       COUNT(CASE WHEN tier = 'module' THEN 1 END) AS modules,
       COUNT(CASE WHEN tier = 'module' AND trim(coalesce(json_extract(data, '$.description'), '')) <> ''
                  THEN 1 END) AS describedModules
     FROM components WHERE repo_id = ?`,
    repoId
  );
  return {
    domains: Number(row?.domains ?? 0),
    modules: Number(row?.modules ?? 0),
    describedModules: Number(row?.describedModules ?? 0),
  };
}
