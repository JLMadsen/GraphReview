// `POST /api/repos/[repoId]/refresh` — force a re-analysis regardless of
//        staleness. This is the escape hatch for a repo stuck in `error`
//        status: a failed job is cleared and re-queued.
// `POST /api/repos/[repoId]/refresh` `{ "ifStale": true }` — run the
//        staleness check (cheap HEAD probe) and enqueue a re-analysis only
//        if the stored graph is behind; the same helper the repo detail
//        endpoint uses, exposed on its own for polling and debugging.
//
// Both queue work, so neither is a GET (DESIGN.md §6.26 §3): the
// middleware blocks cross-origin non-GET requests, not GETs.

import { NextResponse } from "next/server";
import { checkAndEnqueueIfStaleForRepo, enqueueAnalysis } from "@/lib/jobs";
import { apiError, errorMessage, loadRepo } from "../../_shared";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;

  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

  const body = (await request.json().catch(() => null)) as { ifStale?: unknown } | null;
  if (body?.ifStale === true) {
    try {
      return NextResponse.json(await checkAndEnqueueIfStaleForRepo(loaded.repo, { enqueue: true }));
    } catch (error) {
      return apiError(`Staleness check failed: ${errorMessage(error)}`, 503);
    }
  }

  try {
    const result = await enqueueAnalysis(loaded.repo.id);
    return NextResponse.json({
      ...result,
      // `enqueued: false` means a job was already pending — from the
      // caller's point of view a refresh is happening either way.
      refreshing: true,
    });
  } catch (error) {
    return apiError(`Could not queue the analysis: ${errorMessage(error)}`, 503);
  }
}
