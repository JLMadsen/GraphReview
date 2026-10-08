// POST /api/repos/[repoId]/api-catalog/infer  { endpointId }
//
// ✦ Infer: asks the model what one endpoint takes and returns, from its
// handler's code (lib/ai/api-shape.ts), when static analysis couldn't read
// it from types. Stored by the handler's text fingerprint, so it is paid
// once per version of the code. One short call, answered inline.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getRepoById } from "@/lib/db";
import { ApiInferenceError, inferEndpointShape } from "@/lib/jobs/api-catalog";
import type { ApiInferResponseDTO } from "@/components/graph/api-types";
import { apiError } from "../../../_shared";

export const dynamic = "force-dynamic";

const Body = z.object({ endpointId: z.string().min(1).max(2000) });

export async function POST(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("Pass { endpointId }.", 400);
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    const endpoint = await inferEndpointShape(repo, parsed.data.endpointId, request.signal);
    const body: ApiInferResponseDTO = { endpoint };
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof ApiInferenceError) return apiError(error.message, error.status);
    console.error(`POST /api/repos/${repoId}/api-catalog/infer failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not infer the shapes.", 502);
  }
}
