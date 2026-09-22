// `GET /api/repos/[repoId]/branches` — branch list for the Branches tab.
//
// For a `github` repo this decrypts the stored PAT and calls
// lib/github's `listBranches`. A `local` repo with no GitHub URL on file is
// not an error: it returns `linked: false, reason: "not_linked"` so the UI
// can render the "not linked to GitHub" state.

import { NextResponse } from "next/server";
import { getRepoBranches } from "@/lib/jobs";
import { errorMessage, loadRepo } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;

  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

  const result = await getRepoBranches(loaded.repo).catch((error: unknown) => ({
    linked: true as const,
    error: errorMessage(error),
    branches: [],
    rateLimit: null,
  }));

  // A GitHub-side failure keeps the same body shape (so the UI has one
  // thing to render) but is not reported as a success.
  return NextResponse.json(result, { status: result.error ? 502 : 200 });
}
