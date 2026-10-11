// Queries behind the module tier (DESIGN.md §6.3): the bulk reads/writes
// lib/jobs/module-tier.ts needs — merged modules, file ownership, dependency
// edges, domains, findings following their files. They are keyed by repo and
// span several tables, which the per-entity modules (component.ts, file.ts)
// deliberately don't expose.

import { all, run, transaction } from "./client";
import { componentRows } from "./component";
import { readRepoFindings, writeFinding } from "./finding";
import type { ComponentRecord } from "./types";

// ---------------------------------------------------------------------------
// Module tier
// ---------------------------------------------------------------------------

/** Every merged (feature) module of a repo. */
export async function listMergedModules(repoId: string): Promise<ComponentRecord[]> {
  return componentRows(
    all(
      `SELECT data FROM components
       WHERE repo_id = ? AND tier = 'module' AND json_extract(data, '$.origin') = 'merge'
       ORDER BY name`,
      repoId
    )
  );
}

/** File path → id of the component it currently `BELONGS_TO`. */
export async function getFileOwnerMap(repoId: string): Promise<Map<string, string>> {
  const rows = all<{ path: string; componentId: string }>(
    `SELECT f.path AS path, o.component_id AS componentId
     FROM files f JOIN file_owners o ON o.file_id = f.id
     WHERE f.repo_id = ?`,
    repoId
  );
  return new Map(rows.map((row) => [row.path, row.componentId]));
}

/** Every stored file path and file-level import edge of a repo — enough to regroup without re-parsing. */
export async function getStoredImportGraph(
  repoId: string
): Promise<{ filePaths: string[]; edges: Array<{ from: string; to: string; weight: number }> }> {
  const filePaths = all<{ path: string }>(`SELECT path FROM files WHERE repo_id = ? ORDER BY path`, repoId).map(
    (row) => row.path
  );
  const edges = all<{ source: string; target: string; weight: number }>(
    `SELECT a.path AS source, b.path AS target, i.weight AS weight
     FROM file_imports i
     JOIN files a ON a.id = i.from_id
     JOIN files b ON b.id = i.to_id
     WHERE a.repo_id = ? AND b.repo_id = ?`,
    repoId,
    repoId
  ).map((row) => ({ from: row.source, to: row.target, weight: Number(row.weight) || 1 }));
  return { filePaths, edges };
}

/** Points each listed file's single `BELONGS_TO` at the given component. */
export async function setFileOwners(
  repoId: string,
  owners: ReadonlyArray<{ path: string; componentId: string }>
): Promise<void> {
  transaction(() => {
    for (const owner of owners) {
      run(
        `INSERT INTO file_owners (file_id, component_id)
         SELECT f.id, c.id FROM files f, components c
         WHERE f.repo_id = ? AND f.path = ? AND c.id = ?
         ON CONFLICT (file_id) DO UPDATE SET component_id = excluded.component_id`,
        repoId,
        owner.path,
        owner.componentId
      );
    }
  });
}

/** Replaces a repo's `DEPENDS_ON` edges. */
export async function replaceComponentDependencies(
  repoId: string,
  edges: ReadonlyArray<{ from: string; to: string; weight: number }>
): Promise<void> {
  transaction(() => {
    run(`DELETE FROM component_deps WHERE from_id IN (SELECT id FROM components WHERE repo_id = ?)`, repoId);
    for (const edge of edges) {
      run(
        `INSERT INTO component_deps (from_id, to_id, weight)
         SELECT a.id, b.id, ? FROM components a, components b WHERE a.id = ? AND b.id = ?
         ON CONFLICT (from_id, to_id) DO UPDATE SET weight = excluded.weight`,
        edge.weight,
        edge.from,
        edge.to
      );
    }
  });
}

/** Module id → id of the domain it is `CHILD_OF`. */
export async function getDomainByModule(repoId: string): Promise<Map<string, string>> {
  const rows = all<{ moduleId: string; domainId: string }>(
    `SELECT m.id AS moduleId, d.id AS domainId
     FROM component_parents p
     JOIN components m ON m.id = p.child_id
     JOIN components d ON d.id = p.parent_id
     WHERE m.repo_id = ? AND m.tier = 'module' AND d.tier = 'domain'`,
    repoId
  );
  return new Map(rows.map((row) => [row.moduleId, row.domainId]));
}

/**
 * Makes findings follow their files (DESIGN.md §6.3):
 *
 *   1. a finding with a `filePath` moves to whichever component owns that file now;
 *   2. any other finding whose component is gone (no file path, or its file
 *      is gone too) moves to the merged module that absorbed that component.
 *
 * Returns how many findings changed component.
 */
export async function relinkFindings(repoId: string): Promise<number> {
  return transaction(() => {
    const owners = new Map(
      all<{ path: string; componentId: string }>(
        `SELECT f.path AS path, o.component_id AS componentId
         FROM files f JOIN file_owners o ON o.file_id = f.id WHERE f.repo_id = ?`,
        repoId
      ).map((row) => [row.path, row.componentId])
    );
    const existing = new Set(
      all<{ id: string }>(`SELECT id FROM components WHERE repo_id = ?`, repoId).map((row) => row.id)
    );
    const merged = componentRows(
      all(
        `SELECT data FROM components WHERE repo_id = ? AND json_extract(data, '$.origin') = 'merge' ORDER BY id`,
        repoId
      )
    );

    let moved = 0;
    for (const finding of readRepoFindings(repoId)) {
      let target: string | undefined;
      const owner = finding.filePath ? owners.get(finding.filePath) : undefined;
      if (owner) {
        if (owner !== finding.componentId) target = owner;
      } else if (!existing.has(finding.componentId)) {
        // No file to follow (none recorded, or it's gone): fall back to the
        // merged module that absorbed the finding's vanished component.
        target = merged.find((m) => (m.absorbedModuleIds ?? []).includes(finding.componentId))?.id;
      }
      if (target) {
        writeFinding({ ...finding, componentId: target });
        moved++;
      }
    }
    return moved;
  });
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
