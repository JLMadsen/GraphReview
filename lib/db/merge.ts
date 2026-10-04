// Queries behind feature merges (DESIGN.md §6.3): the bulk reads/writes the
// module-tier writer needs (file ownership, dependency edges, findings
// following their files) and the merge-suggestion repository.

import { createHash } from "node:crypto";
import { all, chunked, compareText, get, pack, placeholders, run, transaction, unpack } from "./client";
import { componentRows } from "./component";
import { readRepoFindings, writeFinding } from "./finding";
import type {
  ComponentRecord,
  MergeSuggestionKind,
  MergeSuggestionRecord,
  MergeSuggestionStatus,
} from "./types";

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
): Promise<{ filePaths: string[]; edges: Array<{ from: string; to: string }> }> {
  const filePaths = all<{ path: string }>(`SELECT path FROM files WHERE repo_id = ? ORDER BY path`, repoId).map(
    (row) => row.path
  );
  const edges = all<{ source: string; target: string }>(
    `SELECT a.path AS source, b.path AS target
     FROM file_imports i
     JOIN files a ON a.id = i.from_id
     JOIN files b ON b.id = i.to_id
     WHERE a.repo_id = ? AND b.repo_id = ?`,
    repoId,
    repoId
  ).map((row) => ({ from: row.source, to: row.target }));
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

/** Points findings without a `filePath` of one component at another — used by Unmerge. */
export async function reassignFindingsWithoutFile(
  repoId: string,
  fromComponentId: string,
  toComponentId: string
): Promise<void> {
  transaction(() => {
    for (const finding of readRepoFindings(repoId)) {
      if (finding.componentId === fromComponentId && !finding.filePath) {
        writeFinding({ ...finding, componentId: toComponentId });
      }
    }
  });
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

function writeSuggestion(record: MergeSuggestionRecord): void {
  run(
    `INSERT INTO merge_suggestions (id, repo_id, data) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET repo_id = excluded.repo_id, data = excluded.data`,
    record.id,
    record.repoId,
    pack(record)
  );
}

export async function listMergeSuggestions(repoId: string): Promise<MergeSuggestionRecord[]> {
  return all<{ data: string }>(`SELECT data FROM merge_suggestions WHERE repo_id = ?`, repoId)
    .map((row) => toSuggestion(unpack(row.data)))
    .sort((a, b) => b.score - a.score || compareText(a.key, b.key));
}

export async function getMergeSuggestion(repoId: string, id: string): Promise<MergeSuggestionRecord | null> {
  const row = get<{ data: string }>(`SELECT data FROM merge_suggestions WHERE id = ? AND repo_id = ?`, id, repoId);
  return row ? toSuggestion(unpack(row.data)) : null;
}

export async function deleteMergeSuggestion(id: string): Promise<void> {
  run(`DELETE FROM merge_suggestions WHERE id = ?`, id);
}

/** Reject (remembering the score) or reopen a suggestion. */
export async function setMergeSuggestionStatus(
  repoId: string,
  id: string,
  status: MergeSuggestionStatus
): Promise<MergeSuggestionRecord | null> {
  const existing = await getMergeSuggestion(repoId, id);
  if (!existing) return null;
  const record: MergeSuggestionRecord = {
    ...existing,
    status,
    scoreAtRejection: status === "rejected" ? existing.score : undefined,
    updatedAt: new Date().toISOString(),
  };
  writeSuggestion(record);
  return record;
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
export async function syncMergeSuggestions(repoId: string, computed: readonly SuggestionInput[]): Promise<number> {
  const existing = new Map((await listMergeSuggestions(repoId)).map((s) => [s.key, s]));
  const now = new Date().toISOString();

  const rows: MergeSuggestionRecord[] = computed.map((s) => {
    const previous = existing.get(s.key);
    let status: MergeSuggestionStatus = "open";
    let scoreAtRejection: number | undefined;
    if (previous?.status === "rejected") {
      const rejectedAt = previous.scoreAtRejection ?? s.score;
      const reopen = s.score >= rejectedAt * REOPEN_SCORE_FACTOR;
      status = reopen ? "open" : "rejected";
      scoreAtRejection = reopen ? undefined : rejectedAt;
    }
    return {
      id: mergeSuggestionId(repoId, s.key),
      repoId,
      key: s.key,
      kind: s.kind,
      members: s.members,
      targetComponentId: s.targetComponentId,
      name: s.name,
      score: s.score,
      reasons: s.reasons,
      status,
      scoreAtRejection,
      updatedAt: now,
    };
  });

  const keep = new Set(computed.map((s) => s.key));
  const stale = [...existing.values()].filter((s) => s.status === "open" && !keep.has(s.key)).map((s) => s.id);

  transaction(() => {
    for (const batch of chunked(stale)) {
      run(`DELETE FROM merge_suggestions WHERE id IN (${placeholders(batch.length)})`, ...batch);
    }
    for (const row of rows) writeSuggestion(row);
  });

  return rows.filter((r) => r.status === "open").length;
}
