// GET /api/repos/[repoId]/app-map?level=architecture|features|modules
//
// The Graph tab's App map view (DESIGN.md §6.5): the whole analyzed codebase
// as cards with labelled edges, at one level of detail. Read-only and free:
// cards come from the level's stored AI run when there is one, from the
// path/name heuristics otherwise, and edges are always re-aggregated from the
// current import graph (lib/jobs/app-map.ts). Any level's file→layer colouring
// follows the stored architecture run when one exists.

import { NextResponse } from "next/server";
import { buildAppMap, loadAppMapInput, toStoredAppMaps } from "@/lib/jobs";
import { getAppMapRecords, getRepoById } from "@/lib/neo4j";
import { isAppMapLevel, type AppMapResponseDTO } from "@/components/graph/app-map-types";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) {
  const { repoId } = await params;
  const level = new URL(request.url).searchParams.get("level") ?? "architecture";
  if (!isAppMapLevel(level)) {
    return NextResponse.json({ error: "level must be architecture, features or modules." }, { status: 400 });
  }

  try {
    const repo = await getRepoById(repoId);
    if (!repo) return NextResponse.json({ error: "Repo not found." }, { status: 404 });

    const [input, records] = await Promise.all([loadAppMapInput(repoId), getAppMapRecords(repoId)]);
    const stored = toStoredAppMaps(records);
    const run = stored.get(level) ?? null;
    const { nodes, edges, unplaced } = buildAppMap(input, level, run, stored.get("architecture") ?? null);

    const body: AppMapResponseDTO = {
      level,
      nodes,
      edges,
      source: run ? "ai" : "heuristic",
      ...(run ? { model: run.model || undefined, generatedAt: run.createdAt || undefined } : {}),
      ...(unplaced > 0 ? { newFiles: unplaced } : {}),
      totalFiles: input.files.length,
      fileOwners: Object.fromEntries(input.ownerByPath),
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error(`GET /api/repos/${repoId}/app-map failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build the app map." },
      { status: 500 }
    );
  }
}
