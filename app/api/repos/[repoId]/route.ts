// `GET /api/repos/[repoId]` — one repo plus its derived status.
//
// Response contract (depended on by the Graph tab):
//
//   { id, name, provider: "local" | "github" | "gitlab", url?, localPath?,
//     defaultBranch?, lastAnalyzedAt?, lastAnalyzedSha?,
//     status: "analyzing" | "up_to_date" | "stale" | "error" }
//
// Optional fields are omitted rather than sent as `null`.
//
// Reading this endpoint is also §10's auto-refresh trigger: the status is
// computed with a *cheap* HEAD probe (`git ls-remote` for URL repos, a local
// `rev-parse` for bind-mounted ones — never a clone), and when the stored
// graph is behind, a background job is enqueued and `"stale"` is returned
// immediately. The caller is never blocked on the re-analysis.

import { NextResponse } from "next/server";
import { getAnalysisJobLogs, getRepoDto } from "@/lib/jobs";
import { apiError, errorMessage, loadRepo } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;

  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

  try {
    const dto = await getRepoDto(loaded.repo, { autoEnqueue: true });

    // `?logs=1` is a separate, on-demand read (the "hover the Analyzing
    // badge" affordance) rather than part of the regular status payload —
    // fetching a job's log tail on every poll would be wasted work for the
    // common case where nobody is looking. Best-effort: a Redis hiccup here
    // must not hide the status this endpoint otherwise successfully read.
    if (new URL(request.url).searchParams.get("logs") === "1") {
      try {
        return NextResponse.json({ ...dto, logs: await getAnalysisJobLogs(repoId) });
      } catch (error) {
        console.error(`GET /api/repos/${repoId}?logs=1 — could not read job logs:`, error);
        return NextResponse.json({ ...dto, logs: [] });
      }
    }

    return NextResponse.json(dto);
  } catch (error) {
    return apiError(
      `Could not determine repo status: ${errorMessage(error)}`,
      503
    );
  }
}
