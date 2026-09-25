// `GET /api/repos/[repoId]/pull-requests?state=open|closed|all[&limit=N]` —
// the PR list behind the Pull Requests tab, and (with a `limit`, most
// recently updated first) the Graph tab's PR picker.
//
// `state` maps straight onto GitHub's own filter. Merged PRs come back under
// `closed`/`all`, with lib/github deriving the three-value
// `open | closed | merged` state on each item — so the UI can show a
// "merged" badge without a separate request.
//
// As with branches, a repo that isn't linked to GitHub returns
// `linked: false` rather than an error.

import { NextResponse } from "next/server";
import { getRepoPullRequests } from "@/lib/jobs";
import type { PullRequestListState } from "@/lib/github";
import { apiError, errorMessage, loadRepo } from "../../_shared";

export const dynamic = "force-dynamic";

const LIST_STATES: readonly PullRequestListState[] = ["open", "closed", "all"];

function parseState(value: string | null): PullRequestListState | undefined {
  if (value === null) return "open";
  return LIST_STATES.find((state) => state === value);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;

  const searchParams = new URL(request.url).searchParams;
  const state = parseState(searchParams.get("state"));
  const rawLimit = searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
    return apiError(`Invalid "limit". Expected an integer from 1 to 1000.`, 400);
  }
  if (!state) {
    return apiError(
      `Invalid "state" filter. Expected one of: ${LIST_STATES.join(", ")}.`,
      400
    );
  }

  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

  const result = await getRepoPullRequests(loaded.repo, state, limit).catch(
    (error: unknown) => ({
      linked: true as const,
      error: errorMessage(error),
      state,
      pullRequests: [],
      rateLimit: null,
    })
  );

  return NextResponse.json(result, { status: result.error ? 502 : 200 });
}
