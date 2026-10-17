// GET /api/repos/[repoId]/tests/plan?prNumber=N|baseRef=…&headRef=…
//
// The AI test plan of a review target (DESIGN.md §6.22 §5), made by the
// last review's test-plan pass. Read-only; `{ plan: null }` before one ran.

import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, gitRefSchema } from "../../../_shared";
import { reviewTargetKey, type ReviewTarget } from "@/lib/jobs";
import { getRepoById } from "@/lib/db";
import { loadTestPlan } from "@/lib/jobs/test-plan";
import type { TestPlanResponseDTO } from "@/components/graph/tests-types";

export const dynamic = "force-dynamic";

const targetSchema = z.object({
  prNumber: z.coerce.number().int().positive().optional(),
  baseRef: gitRefSchema.optional(),
  headRef: gitRefSchema.optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  try {
    const parsed = targetSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    const data = parsed.success ? parsed.data : {};
    const target: ReviewTarget | null = data.prNumber
      ? { kind: "pr", prNumber: data.prNumber }
      : data.baseRef && data.headRef
        ? { kind: "refs", baseRef: data.baseRef, headRef: data.headRef }
        : null;
    if (!target) return apiError("Pass prNumber, or baseRef and headRef.", 400);
    if (!(await getRepoById(repoId))) return apiError("Repo not found.", 404);
    return NextResponse.json({ plan: loadTestPlan(repoId, reviewTargetKey(target)) } satisfies TestPlanResponseDTO);
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/tests/plan failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not read the test plan.", 500);
  }
}
