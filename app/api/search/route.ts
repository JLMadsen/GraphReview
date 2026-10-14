// The command palette's search (DESIGN.md §6.18).
//
//   POST /api/search  { repoId?, q, scope, targetKey?, touched? } → SearchResponse
//
// A POST because `touched` (the open change's paths) can be long. Reads the
// database only — never the network.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getRepoById } from "@/lib/db";
import { search } from "@/lib/search/server";
import { apiError, errorMessage } from "../repos/_shared";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  repoId: z.string().min(1).optional(),
  q: z.string().max(200),
  scope: z.enum(["all", "files", "symbols", "refs", "findings", "findings-all", "endpoints", "repos"]),
  targetKey: z.string().max(600).optional(),
  touched: z.array(z.string().max(1000)).max(5000).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("Invalid search request.", 400, parsed.error.issues);
  try {
    const repo = parsed.data.repoId ? await getRepoById(parsed.data.repoId) : null;
    if (parsed.data.repoId && !repo) return apiError(`No repo with id "${parsed.data.repoId}".`, 404);
    return NextResponse.json(await search(parsed.data, repo));
  } catch (error) {
    console.error("POST /api/search failed:", error);
    return apiError(`Search failed: ${errorMessage(error)}`, 500);
  }
}
