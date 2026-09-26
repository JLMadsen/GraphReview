// The PR prerequisite checklist for one review target (DESIGN.md §6.6).
//
//   GET  /api/repos/[repoId]/checklist?prNumber=12            evaluate (no AI call)
//   GET  …?baseRef=main&headRef=feature[&fresh=1]              `fresh` bypasses the short diff cache
//   POST /api/repos/[repoId]/checklist  {target, action: "run-ai"}
//        one model call answering every AI item, then the fresh evaluation
//
// A failing item is only a badge — nothing here blocks anything.

import { NextResponse } from "next/server";
import { z } from "zod";
import { evaluateChecklist, runAiChecklist } from "@/lib/jobs/checklist";
import {
  apiError,
  errorMessage,
  loadRepo,
  targetBodySchema,
  targetFromSearchParams,
  toReviewTarget,
} from "@/app/api/repos/_shared";
import type { ChecklistEvaluationDTO } from "@/components/graph/checklist-types";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

  const searchParams = new URL(request.url).searchParams;
  const target = targetFromSearchParams(searchParams);
  if (!target) return apiError("Expected ?prNumber= or ?baseRef=&headRef=.", 400);

  try {
    const body: ChecklistEvaluationDTO = await evaluateChecklist(loaded.repo, target, undefined, {
      fresh: searchParams.get("fresh") === "1",
    });
    return NextResponse.json(body);
  } catch (error) {
    return apiError(`Could not evaluate the checklist: ${errorMessage(error)}`, 502);
  }
}

const postSchema = z.object({ target: targetBodySchema, action: z.literal("run-ai") });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError('Expected {target, action: "run-ai"}.', 400);
  const target = toReviewTarget(parsed.data.target);

  const log = (message: string) => console.log(`[checklist] ${repoId} · ${message}`);
  try {
    await runAiChecklist(loaded.repo, target, log);
    const body: ChecklistEvaluationDTO = await evaluateChecklist(loaded.repo, target, log);
    return NextResponse.json(body);
  } catch (error) {
    return apiError(`The AI checks failed: ${errorMessage(error)}`, 502);
  }
}
