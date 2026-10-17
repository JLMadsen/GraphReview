// Post picked findings to the PR/MR as a review (DESIGN.md §6.23 §1).
//
//   GET  /api/repos/[repoId]/review/post?prNumber=12   the draft the dialog previews
//   POST /api/repos/[repoId]/review/post               { prNumber, findingIds, summary, verdict, headSha }
//
// Only ever the user's click: nothing calls the POST but the dialog
// (locked decision #10 — the review never auto-posts).

import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, errorMessage, loadRepo } from "../../../_shared";
import { PostReviewError, buildPostDraft, postReview } from "@/lib/review-post/post";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;
  const prNumber = Number(new URL(request.url).searchParams.get("prNumber"));
  if (!Number.isInteger(prNumber) || prNumber <= 0) return apiError("Posting needs ?prNumber= — a ref comparison has no PR to post to.", 400);
  try {
    return NextResponse.json(await buildPostDraft(loaded.repo, prNumber));
  } catch (error) {
    if (error instanceof PostReviewError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    console.error(`GET /api/repos/${repoId}/review/post failed:`, error);
    return apiError(`Could not build the draft: ${errorMessage(error)}`, 502);
  }
}

const bodySchema = z.object({
  prNumber: z.number().int().positive(),
  findingIds: z.array(z.string().min(1)).max(500),
  summary: z.string().max(60_000),
  verdict: z.enum(["comment", "approve", "request_changes"]),
  headSha: z.string().max(64).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError("Invalid JSON body.", 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return apiError("Invalid body.", 400, parsed.error.issues);
  try {
    return NextResponse.json(await postReview(loaded.repo, parsed.data));
  } catch (error) {
    if (error instanceof PostReviewError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    console.error(`POST /api/repos/${repoId}/review/post failed:`, error);
    return apiError(`Could not post the review: ${errorMessage(error)}`, 502);
  }
}
