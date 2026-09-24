// POST /api/repos/[repoId]/merges/suggestions/[suggestionId]
//   {action: "accept"}  create/extend the merged module, then regroup (synchronous — seconds)
//   {action: "reject"}  remember the rejection (it comes back only if its score rises ≥ 1.5×)
//   {action: "reopen"}  undo a rejection
//
// Accepting never calls the AI: the heuristic name is used until the client
// asks for AI naming on the new module (../../modules/[componentId]).

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MergeActionError,
  acceptMergeSuggestion,
  rejectMergeSuggestion,
  reopenMergeSuggestion,
} from "@/lib/jobs/merges";
import { apiError, errorMessage, loadRepo } from "@/app/api/repos/_shared";
import type { AcceptSuggestionResponseDTO } from "@/components/graph/merge-types";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ action: z.enum(["accept", "reject", "reopen"]) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ repoId: string; suggestionId: string }> }
): Promise<NextResponse> {
  const { repoId, suggestionId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError('Expected {action: "accept" | "reject" | "reopen"}.', 400);

  try {
    switch (parsed.data.action) {
      case "accept": {
        const result = await acceptMergeSuggestion(repoId, suggestionId, (message) =>
          console.log(`[merges] ${repoId} · ${message}`)
        );
        const body: AcceptSuggestionResponseDTO = { componentId: result.componentId };
        return NextResponse.json(body);
      }
      case "reject":
        return NextResponse.json(await rejectMergeSuggestion(repoId, suggestionId));
      case "reopen":
        return NextResponse.json(await reopenMergeSuggestion(repoId, suggestionId));
    }
  } catch (error) {
    if (error instanceof MergeActionError) return apiError(error.message, error.status);
    return apiError(`Could not update the suggestion: ${errorMessage(error)}`, 500);
  }
}
