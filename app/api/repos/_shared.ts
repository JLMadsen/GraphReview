// Small helpers shared by the route handlers under app/api/repos.
//
// Not a route itself — only `route.ts` files are routable in the App Router,
// so this module is invisible to the router.

import { NextResponse } from "next/server";
import { getRepoById } from "@/lib/neo4j";
import type { RepoRecord } from "@/lib/neo4j";

export interface ApiErrorBody {
  error: string;
  details?: unknown;
}

export function apiError(
  message: string,
  status: number,
  details?: unknown
): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error: message, details }, { status });
}

/** Loads a repo or returns the 404 response to hand straight back to the client. */
export async function loadRepo(
  repoId: string
): Promise<{ repo: RepoRecord } | { response: NextResponse<ApiErrorBody> }> {
  let repo: RepoRecord | null;
  try {
    repo = await getRepoById(repoId);
  } catch (error) {
    return {
      response: apiError(
        `Could not reach the graph database: ${(error as Error).message}`,
        503
      ),
    };
  }
  if (!repo) {
    return { response: apiError(`No repo with id "${repoId}".`, 404) };
  }
  return { repo };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
