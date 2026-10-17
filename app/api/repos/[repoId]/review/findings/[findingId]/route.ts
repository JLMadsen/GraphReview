// Resolve / reopen one AI review finding, or reply to it.
//
//   PATCH /api/repos/[repoId]/review/findings/[findingId]   { resolved: boolean, dismiss?: { reason?: string } }
//   POST  /api/repos/[repoId]/review/findings/[findingId]   { kind: "fixing", body? }
//
// The POST is the command palette's "Mark fixing" (DESIGN.md §6.18): the
// same `fixing` reply a coding agent leaves over MCP, written by the reviewer.
//
// Only findings below `match` (mismatch, partial, unknown) can be resolved —
// a match has nothing to resolve. Resolving stamps `resolvedAt`; reopening
// removes it. A re-review that produces the same finding again keeps it
// (DESIGN.md §6.21).
//
// `dismiss` resolves it as "not a problem": the reason (optional) is added
// as an answered reply, and the finding is remembered for the repo — later
// reviews hide near-identical findings on the same file and tell the model
// about it (lib/db/review-loop.ts). Reopening a dismissed finding forgets it.

import { NextResponse } from "next/server";
import { z } from "zod";
import { addFindingResponse, addFindingSuppression, deleteSuppressionsForFinding, getFindingById, setFindingResolved } from "@/lib/db";
import { apiError, errorMessage } from "../../../../_shared";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  resolved: z.boolean(),
  dismiss: z.object({ reason: z.string().max(1000).optional() }).optional(),
});

export interface ResolveFindingResponse {
  id: string;
  /** ISO-8601; absent when the finding is (now) open. */
  resolvedAt?: string;
  /** `dismiss` only: the suppression it made. */
  suppressionId?: string;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ repoId: string; findingId: string }> }
) {
  const { repoId, findingId } = await params;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError('Body must be { "resolved": true | false, "dismiss"?: { "reason"?: string } }.', 400);
  }

  try {
    const existing = await getFindingById(findingId);
    if (!existing || existing.repoId !== repoId) {
      return apiError(`No finding with id "${findingId}" in this repo.`, 404);
    }
    if (existing.assessment === "ok") {
      return apiError("Only findings that need a look (not OK) can be resolved.", 400);
    }

    const { resolved, dismiss } = parsed.data;
    if (dismiss && !resolved) return apiError("Only resolving can dismiss a finding.", 400);
    if (dismiss && (!existing.filePath || existing.category === "intent")) {
      return apiError("Only findings about a file can be dismissed as not a problem.", 400);
    }

    const reason = dismiss?.reason?.trim();
    const updated = dismiss
      ? await addFindingResponse(repoId, findingId, {
          kind: "answered",
          author: "reviewer",
          body: reason ? `Not a problem: ${reason}` : "Not a problem.",
        })
      : await setFindingResolved(repoId, findingId, resolved);
    if (!updated) {
      // Deleted between the read and the write — a re-review replaced it.
      return apiError(`No finding with id "${findingId}" in this repo.`, 404);
    }
    const suppression = dismiss
      ? addFindingSuppression({
          repoId,
          filePath: existing.filePath!,
          summary: existing.summary,
          ...(reason ? { reason } : {}),
          findingId,
          targetKey: existing.targetKey,
        })
      : undefined;
    if (!resolved) deleteSuppressionsForFinding(repoId, findingId);
    const body: ResolveFindingResponse = {
      id: updated.id,
      ...(updated.resolvedAt ? { resolvedAt: updated.resolvedAt } : {}),
      ...(suppression ? { suppressionId: suppression.id } : {}),
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error(`PATCH /api/repos/${repoId}/review/findings/${findingId} failed:`, error);
    return apiError(`Could not update the finding: ${errorMessage(error)}`, 503);
  }
}

const replySchema = z.object({ kind: z.literal("fixing"), body: z.string().max(2000).optional() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ repoId: string; findingId: string }> }
) {
  const { repoId, findingId } = await params;
  const parsed = replySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError('Body must be { "kind": "fixing", "body"?: string }.', 400);
  try {
    const existing = await getFindingById(findingId);
    if (!existing || existing.repoId !== repoId) return apiError(`No finding with id "${findingId}" in this repo.`, 404);
    if (existing.assessment === "ok") return apiError("An OK finding has nothing to fix.", 400);
    const updated = await addFindingResponse(repoId, findingId, {
      kind: "fixing",
      author: "reviewer",
      body: parsed.data.body?.trim() || "Marked as fixing.",
    });
    if (!updated) return apiError(`No finding with id "${findingId}" in this repo.`, 404);
    return NextResponse.json({ id: updated.id, responses: updated.responses ?? [] });
  } catch (error) {
    console.error(`POST /api/repos/${repoId}/review/findings/${findingId} failed:`, error);
    return apiError(`Could not reply to the finding: ${errorMessage(error)}`, 503);
  }
}
