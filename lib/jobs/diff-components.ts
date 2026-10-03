// Mapping a set of changed file paths onto the stored component graph.
//
// This is the one piece of logic shared by the two features that both start
// from "here are the files a diff touches": the Graph tab's diff-impact
// endpoint (`app/api/repos/[repoId]/diff-impact`), which only needs the
// touched component ids, and the AI review pipeline (`./review.ts`), which
// additionally needs to know *which* files landed in *which* component so it
// can send that component's diff hunks (and only those) to the model.
//
// Server-only — it queries the database.

import { listComponentNeighbourSummaries, lookupFileOwners } from "@/lib/db";

/** The result of resolving changed paths against the stored graph. */
export interface DiffComponentMatch {
  /** Changed paths that matched a stored stored file, in input order. */
  touchedFiles: string[];
  /** Distinct `Component` ids reached from a matched file via `BELONGS_TO`. */
  touchedComponentIds: string[];
  /** Changed paths with no matching stored file — non-code files, or the repo needs re-analysis. */
  unmatchedFiles: string[];
  /**
   * Matched file path -> the id of the component that owns it. Omits files
   * that matched a stored file but have no `BELONGS_TO` edge (possible
   * mid-re-analysis, since analyze.ts writes nodes before edges).
   */
  componentIdByPath: Map<string, string>;
  /** The inverse of {@link componentIdByPath}, grouped — component id -> its touched file paths. */
  pathsByComponentId: Map<string, string[]>;
}

/**
 * Resolves each changed path to a stored file (if any) and its owning
 * component (via `BELONGS_TO`).
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

  const rows = await lookupFileOwners(repoId, paths);

  const touchedFiles: string[] = [];
  const unmatchedFiles: string[] = [];
  const touchedComponentIds = new Set<string>();
  const componentIdByPath = new Map<string, string>();
  const pathsByComponentId = new Map<string, string[]>();

  for (const { path, fileId, componentId } of rows) {
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

/** The structural context sent with every per-component review call: the component's own name/description plus its immediate dependency neighbourhood, by name. */
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
 * Loads the "lightweight structural context" for a set of components:
 * their names, descriptions and both directions of `DEPENDS_ON`.
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

  return listComponentNeighbourSummaries(repoId, componentIds);
}
