// `GET  /api/repos/[repoId]/refresh` — run the §10 staleness check (cheap
//        HEAD probe) and auto-enqueue a re-analysis if the stored graph is
//        behind. This is the same helper the repo detail endpoint and the
//        Graph tab use, exposed on its own for polling and debugging.
// `POST /api/repos/[repoId]/refresh` — force a re-analysis regardless of
//        staleness. This is the escape hatch for a repo stuck in `error`
//        status: a failed job is cleared and re-queued.

import { NextResponse } from "next/server";
import { checkAndEnqueueIfStaleForRepo, enqueueAnalysis } from "@/lib/jobs";
import { apiError, errorMessage, loadRepo } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;

  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

  try {
    return NextResponse.json(
      await checkAndEnqueueIfStaleForRepo(loaded.repo, { enqueue: true })
    );
  } catch (error) {
    return apiError(`Staleness check failed: ${errorMessage(error)}`, 503);
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;

  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

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
