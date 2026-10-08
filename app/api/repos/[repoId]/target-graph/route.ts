// A review target's base-vs-head comparison (lib/jobs/target-graph.ts):
// the structure change and the call graph of the functions it touches.
//
//   GET /api/repos/[repoId]/target-graph?prNumber=N | baseRef=…&headRef=…
//
// Reading it is what starts (or refreshes) the comparison — static analysis
// only, no model. The last stored result is returned while a newer one is
// computed, with the job's state alongside.

import { NextResponse } from "next/server";
import { getRepoById, readTargetGraph } from "@/lib/db";
import { ensureTargetGraph, reviewTargetKey, type TargetGraphData } from "@/lib/jobs";
import { apiError, targetFromSearchParams } from "../../_shared";
import type { TargetGraphResponseDTO } from "@/components/graph/target-graph-types";

export const dynamic = "force-dynamic";

function toState(jobState: string): TargetGraphResponseDTO["state"] {
  if (jobState === "waiting" || jobState === "delayed") return "queued";
  if (jobState === "active") return "running";
  if (jobState === "completed" || jobState === "failed") return jobState;
  return "none";
}

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const target = targetFromSearchParams(new URL(request.url).searchParams);
  if (!target) return apiError("Pass prNumber, or baseRef and headRef.", 400);
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    if (repo.provider === "local" && target.kind === "pr") {
      return apiError("A pull request can't be compared on a repo with no git-host link.", 400);
    }
    const job = await ensureTargetGraph(repoId, target);
    const state = toState(await job.getState());
    const stored = readTargetGraph<TargetGraphData>(repoId, reviewTargetKey(target));
    const body: TargetGraphResponseDTO = {
      state,
      ...(state === "failed" ? { error: job.failedReason || "The comparison failed." } : {}),
      ...(stored
        ? { baseSha: stored.baseSha, headSha: stored.headSha, computedAt: stored.computedAt, data: stored.data }
        : {}),
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/target-graph failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not read the comparison.", 500);
  }
}
