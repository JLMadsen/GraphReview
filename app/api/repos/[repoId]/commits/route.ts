// `GET /api/repos/[repoId]/commits?ref=<branch>&limit=N` — the newest commits
// of one branch (the host's own default branch when `ref` is omitted — not
// the stored `defaultBranch`, which can be stale), newest first. Backs the
// Graph tab's "compare two commits" picker; the comparison itself goes through the existing `{ baseRef, headRef }` diff shape, which
// already accepts commit shas.
//
// Same envelope as branches/pull-requests: a repo that isn't linked returns
// `linked: false` rather than an error.

import { NextResponse } from "next/server";
import { getRepoCommits } from "@/lib/jobs";
import { apiError, errorMessage, loadRepo } from "../../_shared";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;
  const searchParams = new URL(request.url).searchParams;

  const rawLimit = searchParams.get("limit");
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return apiError(`Invalid "limit". Expected an integer from 1 to ${MAX_LIMIT}.`, 400);
  }

  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

  const ref = searchParams.get("ref")?.trim() || undefined;
  if (ref?.startsWith("-")) return apiError(`"${ref}" is not a valid ref.`, 400);

  const result = await getRepoCommits(loaded.repo, ref, limit).catch((error: unknown) => ({
    linked: true as const,
    error: errorMessage(error),
    ref: ref ?? "",
    commits: [],
    rateLimit: null,
  }));

  return NextResponse.json(result, { status: result.error ? 502 : 200 });
}
