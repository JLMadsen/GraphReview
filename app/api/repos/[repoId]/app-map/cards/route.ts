// POST /api/repos/[repoId]/app-map/cards  { action: "split" | "merge", card }
//
// Changes to one features card that need no model (DESIGN.md §6.5):
//   split  cut the card into parts by module and folder — what "Split up"
//          does when no AI provider is set up (with one, the app-map job's
//          `split` mode lets the model choose the parts);
//   merge  put a card that was split back together ("Merge back"): every
//          part of it, with the card's text and connection notes as they were.
// `card` is the stored group key (`feat:<key>` without the prefix). Refused
// while an app-map run is pending — its save would overwrite this one.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  applySplit,
  getAppMapJob,
  groupsForLevel,
  isPendingJobState,
  layerResolver,
  loadAppMapInput,
  mergeBack,
  splitByFolders,
  toStoredAppMaps,
} from "@/lib/jobs";
import { getAppMapRecords, getRepoById, saveAppMapRecord } from "@/lib/db";
import { MIN_SPLIT_FILES } from "@/components/graph/app-map-types";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["split", "merge"]),
  card: z.string().min(1).max(200),
});

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return errorResponse("Body must be { action: split | merge, card }.", 400);
  const { action, card } = parsed.data;

  try {
    if (!(await getRepoById(repoId))) return errorResponse("Repo not found.", 404);
    const job = await getAppMapJob(repoId);
    const state = job ? await job.getState() : undefined;
    if (state && isPendingJobState(state)) {
      return errorResponse("An app map run is in progress — wait for it to finish.", 409);
    }

    const stored = toStoredAppMaps(await getAppMapRecords(repoId));
    const features = stored.get("features") ?? null;

    if (action === "merge") {
      if (!features) return errorResponse("This map has no split cards.", 400);
      const merged = mergeBack(features, card);
      await saveAppMapRecord({ repoId, level: "features", groups: merged.groups, edges: merged.edges, model: features.model, createdAt: features.createdAt });
      return NextResponse.json({ ok: true, restored: merged.restored });
    }

    const input = await loadAppMapInput(repoId);
    const current = groupsForLevel(input, "features", features, layerResolver(stored.get("architecture") ?? null)).groups;
    const group = current.find((g) => g.key === card);
    if (!group) return errorResponse("That card is no longer on the map — reload the map and try again.", 404);
    if (group.files.length < MIN_SPLIT_FILES) return errorResponse(`"${group.name}" has only ${group.files.length} files — too few to split.`, 400);
    const parts = splitByFolders(input, group.files, group.name);
    if (parts.length < 2) return errorResponse(`"${group.name}" can't be split by folder — its files sit in one folder of one module.`, 400);
    const split = applySplit(input, features, group, parts);
    await saveAppMapRecord({
      repoId,
      level: "features",
      groups: split.groups,
      edges: split.edges,
      model: features?.model ?? "folders",
      createdAt: features?.createdAt ?? new Date().toISOString(),
    });
    return NextResponse.json({ ok: true, parts: parts.map((p) => p.name) });
  } catch (err) {
    console.error(`POST /api/repos/${repoId}/app-map/cards failed:`, err);
    return errorResponse(err instanceof Error ? err.message : "Failed to change the card.", 500);
  }
}
