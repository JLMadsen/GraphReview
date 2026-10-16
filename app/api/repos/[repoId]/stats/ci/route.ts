// GET /api/repos/[repoId]/stats/ci
//
// CI runs on the default branch for the Stats page's timeline (DESIGN.md
// §6.19): GitHub Actions workflow runs or GitLab pipelines. Fetched apart
// from the git-only stats, which the page renders on the server, because
// this one needs the network and may be slow or unavailable.

import { NextResponse } from "next/server";
import { getRepoById } from "@/lib/db";
import { loadCiRuns } from "@/lib/jobs/repo-stats";
import { apiError } from "../../../_shared";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    return NextResponse.json(await loadCiRuns(repo));
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/stats/ci failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not read CI runs.", 500);
  }
}
