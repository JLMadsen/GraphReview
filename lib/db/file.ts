// Typed repository functions for files, plus the relationships they own:
// BELONGS_TO (-> Component) and IMPORTS (-> File).

import { all, chunked, compareText, get, pack, placeholders, run, transaction, unpack } from "./client";
import type { FileRecord, ImportsProps } from "./types";

function toFileRecord(props: Record<string, unknown>): FileRecord {
  return {
    id: props.id as string,
    repoId: props.repoId as string,
    path: props.path as string,
    language: props.language as string,
    loc: Number(props.loc),
    lastSeenCommit: props.lastSeenCommit as string,
  };
}

function fileRows(rows: Array<{ data: unknown }>): FileRecord[] {
  return rows.map((row) => toFileRecord(unpack(row.data)));
}

function writeFile(record: FileRecord): void {
  run(
    `INSERT INTO files (id, repo_id, path, data) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET repo_id = excluded.repo_id, path = excluded.path, data = excluded.data`,
    record.id,
    record.repoId,
    record.path,
    pack(record)
  );
}

/** Creates or fully replaces a file, keyed on `id`. */
export async function upsertFile(input: FileRecord): Promise<FileRecord> {
  const record = toFileRecord({ ...input });
  writeFile(record);
  return record;
}

/** Bulk {@link upsertFile}, in one transaction. */
export async function upsertFiles(inputs: readonly FileRecord[]): Promise<void> {
  transaction(() => {
    for (const input of inputs) writeFile(toFileRecord({ ...input }));
  });
}

export async function getFileById(id: string): Promise<FileRecord | null> {
  const row = get<{ data: string }>(`SELECT data FROM files WHERE id = ?`, id);
  return row ? toFileRecord(unpack(row.data)) : null;
}

/** Looks a file up by its repo-relative path, since analyzers naturally key on path rather than id. */
export async function getFileByPath(repoId: string, path: string): Promise<FileRecord | null> {
  const row = get<{ data: string }>(`SELECT data FROM files WHERE repo_id = ? AND path = ?`, repoId, path);
  return row ? toFileRecord(unpack(row.data)) : null;
}

export async function listFilesByRepoId(repoId: string): Promise<FileRecord[]> {
  return fileRows(all(`SELECT data FROM files WHERE repo_id = ? ORDER BY path ASC`, repoId));
}

/** Lists the files belonging to a component (via `BELONGS_TO`). */
export async function listFilesByComponentId(componentId: string): Promise<FileRecord[]> {
  return fileRows(
    all(
      `SELECT f.data FROM file_owners o JOIN files f ON f.id = o.file_id
       WHERE o.component_id = ? ORDER BY f.path ASC`,
      componentId
    )
  );
}

export async function deleteFile(id: string): Promise<void> {
  run(`DELETE FROM files WHERE id = ?`, id);
}

/** Bulk {@link deleteFile}, in one transaction. */
export async function deleteFiles(ids: readonly string[]): Promise<void> {
  transaction(() => {
    for (const batch of chunked(ids)) {
      run(`DELETE FROM files WHERE id IN (${placeholders(batch.length)})`, ...batch);
    }
  });
}

/** `(File)-[:BELONGS_TO]->(Component)` — assigns a file to a component. Replaces any prior membership so a file belongs to exactly one component. */
export async function linkFileToComponent(fileId: string, componentId: string): Promise<void> {
  run(
    `INSERT INTO file_owners (file_id, component_id)
     SELECT ?, ? WHERE EXISTS (SELECT 1 FROM files WHERE id = ?)
                   AND EXISTS (SELECT 1 FROM components WHERE id = ?)
     ON CONFLICT (file_id) DO UPDATE SET component_id = excluded.component_id`,
    fileId,
    componentId,
    fileId,
    componentId
  );
}

export async function unlinkFileFromComponent(fileId: string): Promise<void> {
  run(`DELETE FROM file_owners WHERE file_id = ?`, fileId);
}

function insertImport(fromFileId: string, toFileId: string, kind: ImportsProps["kind"]): void {
  run(
    `INSERT INTO file_imports (from_id, to_id, kind)
     SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM files WHERE id = ?)
                      AND EXISTS (SELECT 1 FROM files WHERE id = ?)
     ON CONFLICT (from_id, to_id) DO UPDATE SET kind = excluded.kind`,
    fromFileId,
    toFileId,
    kind,
    fromFileId,
    toFileId
  );
}

/** `(File)-[:IMPORTS {kind}]->(File)` — one file-level dependency edge from static analysis. */
export async function linkFileImport(fromFileId: string, toFileId: string, props: ImportsProps): Promise<void> {
  insertImport(fromFileId, toFileId, props.kind);
}

/** Bulk {@link linkFileImport}, in one transaction. */
export async function linkFileImports(
  edges: ReadonlyArray<{ fromFileId: string; toFileId: string; kind: ImportsProps["kind"] }>
): Promise<void> {
  transaction(() => {
    for (const edge of edges) insertImport(edge.fromFileId, edge.toFileId, edge.kind);
  });
}

/** Removes every outgoing `IMPORTS` edge from a file — useful before re-writing a file's import set on re-analysis. */
export async function clearFileImports(fileId: string): Promise<void> {
  run(`DELETE FROM file_imports WHERE from_id = ?`, fileId);
}

/** Removes every `IMPORTS` edge leaving a file of `repoId`. */
export async function clearRepoFileImports(repoId: string): Promise<void> {
  run(`DELETE FROM file_imports WHERE from_id IN (SELECT id FROM files WHERE repo_id = ?)`, repoId);
}

interface FileImportEdge {
  fromFileId: string;
  toFileId: string;
  kind: ImportsProps["kind"];
}

/** Lists the outgoing `IMPORTS` edges for a file, e.g. to feed `DEPENDS_ON` aggregation. */
export async function listFileImports(fileId: string): Promise<FileImportEdge[]> {
  return all<{ toFileId: string; kind: ImportsProps["kind"] }>(
    `SELECT to_id AS toFileId, kind FROM file_imports WHERE from_id = ?`,
    fileId
  ).map((row) => ({ fromFileId: fileId, toFileId: row.toFileId, kind: row.kind }));
}

// ---------------------------------------------------------------------------
// Path-keyed reads for the review pipeline.
// ---------------------------------------------------------------------------

/** For each path: the file's id and owning component, when they exist. One entry per path, in order. */
export async function lookupFileOwners(
  repoId: string,
  paths: readonly string[]
): Promise<Array<{ path: string; fileId?: string; componentId?: string }>> {
  return paths.map((path) => {
    const row = get<{ fileId: string; componentId: string | null }>(
      `SELECT f.id AS fileId, o.component_id AS componentId
       FROM files f LEFT JOIN file_owners o ON o.file_id = f.id
       WHERE f.repo_id = ? AND f.path = ?`,
      repoId,
      path
    );
    return { path, fileId: row?.fileId, componentId: row?.componentId ?? undefined };
  });
}

/** For each existing file in `paths`: the paths it imports. */
export async function listImportsByPath(repoId: string, paths: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const path of paths) {
    const file = get<{ id: string }>(`SELECT id FROM files WHERE repo_id = ? AND path = ?`, repoId, path);
    if (!file) continue;
    const imports = all<{ path: string }>(
      `SELECT DISTINCT g.path FROM file_imports i JOIN files g ON g.id = i.to_id WHERE i.from_id = ?`,
      file.id
    ).map((row) => row.path);
    out.set(path, imports);
  }
  return out;
}

/**
 * Files one import hop away from any of `changedPaths` (either direction),
 * that aren't themselves changed and have an owning component — with that
 * component's name. Ordered by relation, then files of other components
 * before `componentId`'s own, then path.
 */
export async function listRelatedFiles(
  repoId: string,
  componentId: string,
  changedPaths: readonly string[]
): Promise<Array<{ path: string; componentName: string; relation: "imported" | "importer" }>> {
  const changed = new Set(changedPaths);
  const seen = new Set<string>();
  const rows: Array<{ path: string; componentName: string; relation: "imported" | "importer"; same: number }> = [];
  for (const changedPath of changedPaths) {
    const file = get<{ id: string }>(`SELECT id FROM files WHERE repo_id = ? AND path = ?`, repoId, changedPath);
    if (!file) continue;
    const related = all<{ path: string; componentId: string; componentName: string; relation: "imported" | "importer" }>(
      `SELECT g.path AS path, c.id AS componentId, c.name AS componentName, 'imported' AS relation
       FROM file_imports i JOIN files g ON g.id = i.to_id
       JOIN file_owners o ON o.file_id = g.id JOIN components c ON c.id = o.component_id
       WHERE i.from_id = ?
       UNION
       SELECT g.path, c.id, c.name, 'importer'
       FROM file_imports i JOIN files g ON g.id = i.from_id
       JOIN file_owners o ON o.file_id = g.id JOIN components c ON c.id = o.component_id
       WHERE i.to_id = ?`,
      file.id,
      file.id
    );
    for (const row of related) {
      if (changed.has(row.path)) continue;
      const key = `${row.path}\u0000${row.componentName}\u0000${row.relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ path: row.path, componentName: row.componentName, relation: row.relation, same: row.componentId === componentId ? 1 : 0 });
    }
  }
  rows.sort((a, b) => compareText(a.relation, b.relation) || a.same - b.same || compareText(a.path, b.path));
  return rows.map(({ path, componentName, relation }) => ({ path, componentName, relation }));
}
