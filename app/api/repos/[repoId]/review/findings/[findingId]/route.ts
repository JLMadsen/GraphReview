// Resolve / reopen one AI review finding.
//
//   PATCH /api/repos/[repoId]/review/findings/[findingId]   { resolved: boolean }
//
// Only findings below `match` (mismatch, partial, unknown) can be resolved —
// a match has nothing to resolve. Resolving stamps `resolvedAt`; reopening
// removes it. The state lives on the finding itself, so a re-review (which
// replaces a target's findings) starts every finding unresolved again.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getFindingById, setFindingResolved } from "@/lib/neo4j";
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
    if (existing.intentMatch === "match") {
      return apiError("Only findings below match can be resolved.", 400);
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
