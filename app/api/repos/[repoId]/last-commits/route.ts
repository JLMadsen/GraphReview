// GET /api/repos/[repoId]/last-commits?dir=<folder>&sha=<commit>
//
// The Files view's per-row commit messages: for each entry directly inside
// `dir` ("" or absent = the root), the newest commit at or before `sha` (the
// tree's) that touched it — lib/jobs/repo-tree.ts `lastCommitsIn`. A commit's
// history never changes, so responses are cached as immutable.

import { NextResponse } from "next/server";
import { getRepoById } from "@/lib/db";
import { lastCommitsIn } from "@/lib/jobs/repo-tree";
import type { LastCommitsResponseDTO } from "@/components/graph/files-types";
import { apiError } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const query = new URL(request.url).searchParams;
  const dir = (query.get("dir") ?? "").trim().replace(/^\/+|\/+$/g, "");
  const sha = query.get("sha")?.trim();
  if (!sha) return apiError("Query must include ?sha=<commit>.", 400);
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    const commits = await lastCommitsIn(repo, sha, dir);
    if (!commits) return apiError(`"${dir}" isn't a folder at ${sha.slice(0, 7)}.`, 404);
    const body: LastCommitsResponseDTO = { commits };
    return NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=31536000, immutable" } });
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/last-commits failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not read the folder's history.", 500);
  }
}
