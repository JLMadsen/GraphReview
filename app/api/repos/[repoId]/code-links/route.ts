// GET /api/repos/[repoId]/code-links?path=<file>[&sha=<commit>] — the code
// views' links for one file (DESIGN.md §6.28): import specifiers that open
// another repo file and names that lead to their declaration, and the
// file's functions, methods and classes with their usage count. Without `sha`
// it is the repo's analysed commit; a review target's views pass its head or
// merge-base. Built by the analysis and target-graph jobs; read-only here.
// `state: "none"` — that commit has no link set yet (analysed before links
// existed): the view shows plain code.

import { NextResponse } from "next/server";
import { getRepoById, readCodeLinks } from "@/lib/db";
import type { CodeLinksResponseDTO } from "@/components/graph/code-links";
import { apiError } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const query = new URL(request.url).searchParams;
  const path = query.get("path")?.trim();
  const shaParam = query.get("sha")?.trim();
  if (!path) return apiError("Query must include ?path=<file path>.", 400);
  if (shaParam && !/^[0-9a-f]{7,64}$/.test(shaParam)) return apiError("`sha` must be a commit id.", 400);
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    const sha = shaParam ?? repo.lastAnalyzedSha;
    const stored = sha ? readCodeLinks(repoId, sha, path) : null;
    const body: CodeLinksResponseDTO = stored === null ? { state: "none", links: [], decls: [] } : { state: "ready", sha: sha!, ...stored };
    return NextResponse.json(body);
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/code-links failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not read the code links.", 500);
  }
}
