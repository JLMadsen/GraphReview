// GET /api/repos/[repoId]/code-usages?id=<declaration id>[&sha=<commit>] —
// the usages dialog (DESIGN.md §6.28): a function's, method's or class's
// source and every place the repo uses it, with a few lines around each use.
// Without `sha` it is the repo's analysed commit; a review target's views
// pass its head or merge-base (lib/jobs/code-usages.ts).

import { NextResponse } from "next/server";
import { getRepoById } from "@/lib/db";
import { loadCodeUsages } from "@/lib/jobs/code-usages";
import { apiError } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const query = new URL(request.url).searchParams;
  const id = query.get("id")?.trim();
  const shaParam = query.get("sha")?.trim();
  if (!id || !id.includes("#")) return apiError("Query must include ?id=<file>#<name>.", 400);
  if (shaParam && !/^[0-9a-f]{7,64}$/.test(shaParam)) return apiError("`sha` must be a commit id.", 400);
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    const sha = shaParam ?? repo.lastAnalyzedSha;
    if (!sha) return NextResponse.json({ state: "none" });
    return NextResponse.json(await loadCodeUsages(repo, sha, id));
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/code-usages failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not read the usages.", 500);
  }
}
