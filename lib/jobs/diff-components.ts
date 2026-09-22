// Mapping a set of changed file paths onto the stored component graph —
// DESIGN.md §6, §7, §9.
//
// This is the one piece of logic shared by the two features that both start
// from "here are the files a diff touches": the Graph tab's diff-impact
// endpoint (`app/api/repos/[repoId]/diff-impact`), which only needs the
// touched component ids, and the AI review pipeline (`./review.ts`), which
// additionally needs to know *which* files landed in *which* component so it
// can send that component's diff hunks (and only those) to the model.
//
// Server-only — it queries Neo4j directly.

import { runRead } from "@/lib/neo4j";

/** The result of resolving changed paths against the stored graph. */
export interface DiffComponentMatch {
  /** Changed paths that matched a stored `(:File)` node, in input order. */
  touchedFiles: string[];
  /** Distinct `Component` ids reached from a matched file via `BELONGS_TO`. */
  touchedComponentIds: string[];
  /** Changed paths with no matching `(:File)` node — non-code files, or the repo needs re-analysis. */
  unmatchedFiles: string[];
  /**
   * Matched file path -> the id of the component that owns it. Omits files
   * that matched a `(:File)` node but have no `BELONGS_TO` edge (possible
   * mid-re-analysis, since analyze.ts writes nodes before edges).
   */
  componentIdByPath: Map<string, string>;
  /** The inverse of {@link componentIdByPath}, grouped — component id -> its touched file paths. */
  pathsByComponentId: Map<string, string[]>;
}

/**
 * Resolves each changed path to a `(:File)` node (if any) and its owning
 * `Component` (via `BELONGS_TO`), in one round-trip.
 *
 * No listing function in `lib/neo4j/file.ts` covers this "file path ->
 * owning component, bulk" shape, so this uses `runRead` directly — see
 * `app/api/repos/[repoId]/graph/route.ts`'s comment for why that is an
 * intended use of `lib/neo4j/client.ts`.
 */
export async function matchFilesToComponents(
  repoId: string,
  paths: readonly string[]
): Promise<DiffComponentMatch> {
  const empty: DiffComponentMatch = {
    touchedFiles: [],
    touchedComponentIds: [],
    unmatchedFiles: [],
    componentIdByPath: new Map(),
    pathsByComponentId: new Map(),
  };
  if (paths.length === 0) return empty;

  const result = await runRead(
    `
    UNWIND $paths AS path
    OPTIONAL MATCH (f:File {repoId: $repoId, path: path})
    OPTIONAL MATCH (f)-[:BELONGS_TO]->(c:Component)
    RETURN path, f.id AS fileId, c.id AS componentId
    `,
    { repoId, paths: [...paths] }
  );

  const touchedFiles: string[] = [];
  const unmatchedFiles: string[] = [];
  const touchedComponentIds = new Set<string>();
  const componentIdByPath = new Map<string, string>();
  const pathsByComponentId = new Map<string, string[]>();

  for (const record of result.records) {
    const path = record.get("path") as string;
    const fileId = record.get("fileId") as string | null;
    const componentId = record.get("componentId") as string | null;

    if (!fileId) {
      unmatchedFiles.push(path);
      continue;
    }
    touchedFiles.push(path);
    if (!componentId) continue;

    touchedComponentIds.add(componentId);
    componentIdByPath.set(path, componentId);
    const group = pathsByComponentId.get(componentId);
    if (group) group.push(path);
    else pathsByComponentId.set(componentId, [path]);
  }

  return {
    touchedFiles,
    touchedComponentIds: [...touchedComponentIds],
    unmatchedFiles,
    componentIdByPath,
    pathsByComponentId,
  };
}

/**
 * The JSON-serializable subset of a {@link DiffComponentMatch} that
 * `POST /api/repos/[repoId]/diff-impact` returns.
 *
 * Kept as an explicit projection rather than spreading the match object:
 * the `Map` fields would serialize as `{}` and silently become part of that
 * endpoint's response body.
 */
export function toDiffImpactResponse(match: DiffComponentMatch): {
  touchedFiles: string[];
  touchedComponentIds: string[];
  unmatchedFiles: string[];
} {
  return {
    touchedFiles: match.touchedFiles,
    touchedComponentIds: match.touchedComponentIds,
    unmatchedFiles: match.unmatchedFiles,
  };
}

/** The structural context §9 sends with every per-component review call: the component's own name/description plus its immediate dependency neighbourhood, by name. */
export interface ComponentReviewContext {
  id: string;
  name: string;
  description?: string;
  /** Names of components this one `DEPENDS_ON`. */
  dependsOn: string[];
  /** Names of components that `DEPENDS_ON` this one. */
  dependents: string[];
}

/**
 * Loads §9's "lightweight structural context" for a set of components in a
 * single query.
 *
 * Both directions of `DEPENDS_ON` are collected in the same statement. The
 * two `OPTIONAL MATCH`es do form a cartesian product per component, but
 * `collect(DISTINCT …)` folds it back down, and at component-graph scale
 * (tens to low hundreds of nodes, §3) that is far cheaper than a round-trip
 * per component.
 *
 * Components in `componentIds` that no longer exist are simply absent from
 * the result — callers should treat the returned array as authoritative
 * rather than assuming a 1:1 correspondence with their input.
 */
export async function getComponentReviewContexts(
  repoId: string,
  componentIds: readonly string[]
): Promise<ComponentReviewContext[]> {
  if (componentIds.length === 0) return [];

  const result = await runRead(
    `
    UNWIND $componentIds AS componentId
    MATCH (c:Component {id: componentId, repoId: $repoId})
    OPTIONAL MATCH (c)-[:DEPENDS_ON]->(downstream:Component)
    OPTIONAL MATCH (upstream:Component)-[:DEPENDS_ON]->(c)
    RETURN c.id AS id,
           c.name AS name,
           c.description AS description,
           collect(DISTINCT downstream.name) AS dependsOn,
           collect(DISTINCT upstream.name) AS dependents
    `,
    { repoId, componentIds: [...componentIds] }
  );

  return result.records.map((record) => ({
    id: record.get("id") as string,
    name: record.get("name") as string,
    description: (record.get("description") as string | null) ?? undefined,
    dependsOn: (record.get("dependsOn") as string[]).filter(Boolean),
    dependents: (record.get("dependents") as string[]).filter(Boolean),
  }));
}
