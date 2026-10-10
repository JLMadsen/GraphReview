// GET /api/repos/[repoId]/tree
//
// The Files view: every file of the repo at the last analysed commit (paths,
// sizes, symlinks, submodules) and that commit's subject line. Read with
// `git ls-tree` from the app's clone (a local repo: the repo itself); the
// view opens files through `/file`, which reads the same commit.

import { NextResponse } from "next/server";
import { getRepoById } from "@/lib/db";
import { listRepoTree } from "@/lib/jobs/repo-tree";
import type { RepoTreeResponseDTO } from "@/components/graph/files-types";
import { apiError } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    const tree = await listRepoTree(repo);
    if (!tree) return apiError("The repo hasn't been fetched yet — its files appear once the first analysis has cloned it.", 409);
    const body: RepoTreeResponseDTO = tree;
    return NextResponse.json(body);
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/tree failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not list the repo's files.", 500);
  }
}
