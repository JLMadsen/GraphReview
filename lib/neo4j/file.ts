// Typed repository functions for the `(:File)` node label, plus the
// relationships it participates in as the "owning" side:
// BELONGS_TO (-> Component) and IMPORTS (-> File).

import { runRead, runWrite } from "./client";
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

/** Creates or fully replaces a `(:File)` node, keyed on `id`. */
export async function upsertFile(input: FileRecord): Promise<FileRecord> {
  const result = await runWrite(
    `
    MERGE (f:File {id: $id})
    SET f.repoId = $repoId,
        f.path = $path,
        f.language = $language,
        f.loc = $loc,
        f.lastSeenCommit = $lastSeenCommit
    RETURN f
    `,
    {
      id: input.id,
      repoId: input.repoId,
      path: input.path,
      language: input.language,
      loc: input.loc,
      lastSeenCommit: input.lastSeenCommit,
    }
  );
  return toFileRecord(result.records[0].get("f").properties);
}

export async function getFileById(id: string): Promise<FileRecord | null> {
  const result = await runRead(`MATCH (f:File {id: $id}) RETURN f`, { id });
  const record = result.records[0];
  return record ? toFileRecord(record.get("f").properties) : null;
}

/** Looks a file up by its repo-relative path, since analyzers naturally key on path rather than id. */
export async function getFileByPath(
  repoId: string,
  path: string
): Promise<FileRecord | null> {
  const result = await runRead(
    `MATCH (f:File {repoId: $repoId, path: $path}) RETURN f`,
    { repoId, path }
  );
  const record = result.records[0];
  return record ? toFileRecord(record.get("f").properties) : null;
}

export async function listFilesByRepoId(repoId: string): Promise<FileRecord[]> {
  const result = await runRead(
    `MATCH (f:File {repoId: $repoId}) RETURN f ORDER BY f.path ASC`,
    { repoId }
  );
  return result.records.map((record) => toFileRecord(record.get("f").properties));
}

/** Lists the files belonging to a component (via `BELONGS_TO`). */
export async function listFilesByComponentId(
  componentId: string
): Promise<FileRecord[]> {
  const result = await runRead(
    `
    MATCH (f:File)-[:BELONGS_TO]->(:Component {id: $componentId})
    RETURN f
    ORDER BY f.path ASC
    `,
    { componentId }
  );
  return result.records.map((record) => toFileRecord(record.get("f").properties));
}

export async function deleteFile(id: string): Promise<void> {
  await runWrite(`MATCH (f:File {id: $id}) DETACH DELETE f`, { id });
}

/** `(File)-[:BELONGS_TO]->(Component)` — assigns a file to a component from folder/community clustering. Replaces any prior membership so a file belongs to exactly one component at a given tier. */
export async function linkFileToComponent(
  fileId: string,
  componentId: string
): Promise<void> {
  await runWrite(
    `
    MATCH (f:File {id: $fileId})
    MATCH (c:Component {id: $componentId})
    OPTIONAL MATCH (f)-[old:BELONGS_TO]->(:Component)
    DELETE old
    MERGE (f)-[:BELONGS_TO]->(c)
    `,
    { fileId, componentId }
  );
}

export async function unlinkFileFromComponent(fileId: string): Promise<void> {
  await runWrite(
    `MATCH (:File {id: $fileId})-[rel:BELONGS_TO]->(:Component) DELETE rel`,
    { fileId }
  );
}

/** `(File)-[:IMPORTS {kind}]->(File)` — one file-level dependency edge from static analysis. */
export async function linkFileImport(
  fromFileId: string,
  toFileId: string,
  props: ImportsProps
): Promise<void> {
  await runWrite(
    `
    MATCH (from:File {id: $fromFileId})
    MATCH (to:File {id: $toFileId})
    MERGE (from)-[rel:IMPORTS]->(to)
    SET rel.kind = $kind
    `,
    { fromFileId, toFileId, kind: props.kind }
  );
}

/** Removes every outgoing `IMPORTS` edge from a file — useful before re-writing a file's import set on re-analysis. */
export async function clearFileImports(fileId: string): Promise<void> {
  await runWrite(
    `MATCH (:File {id: $fileId})-[rel:IMPORTS]->(:File) DELETE rel`,
    { fileId }
  );
}

interface FileImportEdge {
  fromFileId: string;
  toFileId: string;
  kind: ImportsProps["kind"];
}

/** Lists the outgoing `IMPORTS` edges for a file, e.g. to feed `DEPENDS_ON` aggregation. */
export async function listFileImports(fileId: string): Promise<FileImportEdge[]> {
  const result = await runRead(
    `
    MATCH (from:File {id: $fileId})-[rel:IMPORTS]->(to:File)
    RETURN to.id AS toFileId, rel.kind AS kind
    `,
    { fileId }
  );
  return result.records.map((record) => ({
    fromFileId: fileId,
    toFileId: record.get("toFileId") as string,
    kind: record.get("kind") as ImportsProps["kind"],
  }));
}
