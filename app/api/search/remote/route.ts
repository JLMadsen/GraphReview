// Refreshes what the command palette knows of a repo's git host
// (DESIGN.md §6.18): its PRs/MRs (every state, most recent first), branches
// and the default branch's latest commits. The palette's only network call,
// made when the reviewer asks for it.
//
//   POST /api/search/remote  { repoId } → { prs, branches, commits, errors }

import { NextResponse } from "next/server";
import { z } from "zod";
import { getRepoBranches, getRepoCommits, getRepoPullRequests, rememberListing } from "@/lib/jobs";
import { apiError, errorMessage, loadRepo } from "../../repos/_shared";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ repoId: z.string().min(1) });

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("Body must be { repoId }.", 400);
  const loaded = await loadRepo(parsed.data.repoId);
  if ("response" in loaded) return loaded.response;
  const { repo } = loaded;

  const errors: string[] = [];
  const [prs, branches, commits] = await Promise.all([
    getRepoPullRequests(repo, "all", 300).catch((e: unknown) => ({ linked: true, error: errorMessage(e), state: "all" as const, pullRequests: [], rateLimit: null })),
    getRepoBranches(repo).catch((e: unknown) => ({ linked: true, error: errorMessage(e), branches: [], rateLimit: null })),
    getRepoCommits(repo, undefined, 100).catch((e: unknown) => ({ linked: true, error: errorMessage(e), ref: "", commits: [], rateLimit: null })),
  ]);
  if (prs.error) errors.push(`PRs: ${prs.error}`);
  if (branches.error) errors.push(`branches: ${branches.error}`);
  if (commits.error) errors.push(`commits: ${commits.error}`);

  rememberListing(repo.id, { pullRequests: prs, branches, commits });

  return NextResponse.json({
    prs: prs.pullRequests.length,
    branches: branches.branches.length,
    commits: commits.commits.length,
    errors,
  });
}
