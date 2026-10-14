// Resolve / reopen one AI review finding, or reply to it.
//
//   PATCH /api/repos/[repoId]/review/findings/[findingId]   { resolved: boolean }
//   POST  /api/repos/[repoId]/review/findings/[findingId]   { kind: "fixing", body? }
//
// The POST is the command palette's "Mark fixing" (DESIGN.md §6.18): the
// same `fixing` reply a coding agent leaves over MCP, written by the reviewer.
//
// Only findings below `match` (mismatch, partial, unknown) can be resolved —
// a match has nothing to resolve. Resolving stamps `resolvedAt`; reopening
// removes it. The state lives on the finding itself, so a re-review (which
// replaces a target's findings) starts every finding unresolved again.

import { NextResponse } from "next/server";
import { z } from "zod";
import { addFindingResponse, getFindingById, setFindingResolved } from "@/lib/db";
import { apiError, errorMessage } from "../../../../_shared";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ resolved: z.boolean() });

export interface ResolveFindingResponse {
  id: string;
  /** ISO-8601; absent when the finding is (now) open. */
  resolvedAt?: string;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ repoId: string; findingId: string }> }
) {
  const { repoId, findingId } = await params;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError('Body must be { "resolved": true | false }.', 400);
  }

  try {
    const existing = await getFindingById(findingId);
    if (!existing || existing.repoId !== repoId) {
      return apiError(`No finding with id "${findingId}" in this repo.`, 404);
    }
    if (existing.assessment === "ok") {
      return apiError("Only findings that need a look (not OK) can be resolved.", 400);
    }

    const updated = await setFindingResolved(repoId, findingId, parsed.data.resolved);
    if (!updated) {
      // Deleted between the read and the write — a re-review replaced it.
      return apiError(`No finding with id "${findingId}" in this repo.`, 404);
    }
    const body: ResolveFindingResponse = {
      id: updated.id,
      ...(updated.resolvedAt ? { resolvedAt: updated.resolvedAt } : {}),
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
