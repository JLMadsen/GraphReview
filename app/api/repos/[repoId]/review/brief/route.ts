// The change brief / release notes of a review target (DESIGN.md §6.23 §3).
//
//   GET  /api/repos/[repoId]/review/brief?prNumber=|baseRef=&headRef=   last generated for this head, else built from the review data
//   POST /api/repos/[repoId]/review/brief  {prNumber} | {baseRef, headRef}   one model call (the data-only brief when no provider is set)

import { NextResponse } from "next/server";
import { apiError, errorMessage, loadRepo, targetBodySchema, targetFromSearchParams, toReviewTarget } from "../../../_shared";
import { generateChangeBrief, readChangeBrief } from "@/lib/review-post/brief";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;
  const target = targetFromSearchParams(new URL(request.url).searchParams);
  if (!target) return apiError("Expected ?prNumber= or ?baseRef=&headRef=.", 400);
  try {
    return NextResponse.json(await readChangeBrief(loaded.repo, target));
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/review/brief failed:`, error);
    return apiError(`Could not build the brief: ${errorMessage(error)}`, 500);
  }
}

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
  const parsed = targetBodySchema.safeParse(raw);
  if (!parsed.success) return apiError("Expected {prNumber} or {baseRef, headRef}.", 400, parsed.error.issues);
  try {
    return NextResponse.json(await generateChangeBrief(loaded.repo, toReviewTarget(parsed.data), { signal: request.signal }));
  } catch (error) {
    console.error(`POST /api/repos/${repoId}/review/brief failed:`, error);
    return apiError(`Could not generate the brief: ${errorMessage(error)}`, 500);
  }
}
