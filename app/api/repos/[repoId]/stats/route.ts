// GET /api/repos/[repoId]/stats
//
// The git-only stats for the Graph tab's Stats view (DESIGN.md §6.19):
// languages, contributors, commits and lines per day at the last analysed
// commit. `stats` is null before the first analysis has cloned the repo.
// The CI runs come from ./ci, apart, since they need the network.

import { NextResponse } from "next/server";
import { getRepoById } from "@/lib/db";
import { loadRepoStats } from "@/lib/jobs/repo-stats";
import { apiError } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    const ciHost = repo.provider === "local" || repo.provider === "git" ? null : repo.provider === "gitlab" ? "GitLab" : "GitHub";
    return NextResponse.json({ stats: await loadRepoStats(repo), ciHost });
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/stats failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not read the repo's history.", 500);
  }
}
