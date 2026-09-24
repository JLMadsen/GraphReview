// GET  /api/repos/[repoId]/merges
// POST /api/repos/[repoId]/merges  {action: "accept-all"}
//
// POST accepts every open suggestion at once (strongest first, overlapping
// ones skipped), with a single regroup — see acceptAllMergeSuggestions.
//
// Feature merges (DESIGN.md §6.3): the open and rejected merge suggestions
// the free heuristics produced after the last analysis/regroup, the merged
// modules that exist, whether the domain tier is out of date because of a
// merge, and whether AI naming is available.
//
// Each suggestion carries `memberComponentIds` — the graph nodes that
// currently own its files — so the Graph tab can highlight what a merge
// would combine before anything changes.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getActiveAiProvider,
  getFileOwnerMap,
  listMergeSuggestions,
  listMergedModules,
} from "@/lib/neo4j";
import { folderOfPattern, isUnderFolder } from "@/lib/jobs/ownership";
import { acceptAllMergeSuggestions } from "@/lib/jobs/merges";
import { apiError, errorMessage, loadRepo } from "@/app/api/repos/_shared";
import type { AcceptAllResponseDTO, MergesResponseDTO } from "@/components/graph/merge-types";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

  try {
    const [suggestions, merged, owners, provider] = await Promise.all([
      listMergeSuggestions(repoId),
      listMergedModules(repoId),
      getFileOwnerMap(repoId),
      getActiveAiProvider(),
    ]);

    const ownersOf = (members: readonly string[]): string[] => {
      const ids = new Set<string>();
      for (const [path, owner] of owners) {
        const hit = members.some((member) => {
          const dir = folderOfPattern(member);
          return dir === null ? path === member : isUnderFolder(path, dir);
        });
        if (hit) ids.add(owner);
      }
      return [...ids];
    };

    // An extend/move-file suggestion stores its target's name from when it
    // was computed; show the current one (it may have been renamed since).
    const mergedNameById = new Map(merged.map((m) => [m.id, m.name]));

    const body: MergesResponseDTO = {
      suggestions: suggestions.map((s) => ({
        id: s.id,
        kind: s.kind,
        members: s.members,
        targetComponentId: s.targetComponentId,
        name: (s.targetComponentId && mergedNameById.get(s.targetComponentId)) || s.name,
        score: s.score,
        reasons: s.reasons,
        status: s.status,
        memberComponentIds: [
          ...new Set([...ownersOf(s.members), ...(s.targetComponentId ? [s.targetComponentId] : [])]),
        ],
      })),
      merged: merged.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        pathPatterns: m.pathPatterns,
      })),
      domainsStale: loaded.repo.domainsStale === true,
      aiConfigured: Boolean(provider?.baseUrl && provider.apiKeyEncrypted && provider.model),
    };
    return NextResponse.json(body);
  } catch (error) {
    return apiError(`Could not load merges: ${errorMessage(error)}`, 503);
  }
}

const postSchema = z.object({ action: z.literal("accept-all") });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
): Promise<NextResponse> {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError('Expected {action: "accept-all"}.', 400);

  try {
    const result = await acceptAllMergeSuggestions(repoId, (message) =>
      console.log(`[merges] ${repoId} · ${message}`)
    );
    const body: AcceptAllResponseDTO = {
      accepted: result.accepted,
      skipped: result.skipped,
      createdComponentIds: result.createdComponentIds,
    };
    return NextResponse.json(body);
  } catch (error) {
    return apiError(`Could not accept the suggestions: ${errorMessage(error)}`, 500);
  }
}
