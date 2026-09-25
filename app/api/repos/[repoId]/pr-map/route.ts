// POST /api/repos/[repoId]/pr-map — the Graph tab's PR view (DESIGN.md §6.4):
// the changed files of one diff grouped into cards, with labelled edges.
//
// Accepts the same three body shapes as diff-impact. Read-only: it fetches
// the diff's files (status and +/- counts), maps them onto the stored graph
// and assembles the map. When the review job has stored an AI grouping for
// this target *and* the changed files are still exactly the ones it grouped,
// that grouping names the cards; otherwise the heuristic grouping is served
// (with `aiOutdated` set if a now-stale AI grouping exists). Pasted paths have
// no review, so they always get the heuristic map, with no statuses or counts.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  ChangedFilesError,
  applyPrMapGrouping,
  buildHeuristicPrMap,
  collectPrMapLinks,
  listTargetChangedFiles,
  loadPrMapInput,
  reviewTargetKey,
  type PrMapChangedFile,
  type ReviewTarget,
} from "@/lib/jobs";
import { getPrMapGrouping, getRepoById, prMapFilesKey } from "@/lib/neo4j";
import type { PrMapResponseDTO } from "@/components/graph/pr-map-types";

export const dynamic = "force-dynamic";

const bodySchema = z.union([
  z.object({ prNumber: z.number().int().positive() }),
  z.object({ baseRef: z.string().min(1), headRef: z.string().min(1) }),
  z.object({ filePaths: z.array(z.string()) }),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) {
  const { repoId } = await params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Body must be { prNumber } or { baseRef, headRef } or { filePaths }." },
      { status: 400 }
    );
  }

  try {
    const repo = await getRepoById(repoId);
    if (!repo) return NextResponse.json({ error: "Repo not found." }, { status: 404 });

    let target: ReviewTarget | null = null;
    let files: PrMapChangedFile[];
    if ("filePaths" in parsed.data) {
      const paths = [...new Set(parsed.data.filePaths.map((p) => p.trim()).filter(Boolean))];
      files = paths.map((path) => ({ path, status: "changed", additions: 0, deletions: 0 }));
    } else {
      target =
        "prNumber" in parsed.data
          ? { kind: "pr", prNumber: parsed.data.prNumber }
          : { kind: "refs", baseRef: parsed.data.baseRef, headRef: parsed.data.headRef };
      const seen = new Set<string>();
      files = (await listTargetChangedFiles(repo, target)).filter((file) =>
        seen.has(file.path) ? false : (seen.add(file.path), true)
      );
    }

    const input = await loadPrMapInput(repoId, files);
    const grouping = target ? await getPrMapGrouping(repoId, reviewTargetKey(target)) : null;
    const current = grouping?.filesKey === prMapFilesKey(files.map((f) => f.path));

    let body: PrMapResponseDTO;
    if (grouping && current) {
      body = {
        ...applyPrMapGrouping(input, collectPrMapLinks(input), grouping),
        source: "ai",
        model: grouping.model || undefined,
      };
    } else {
      body = {
        ...buildHeuristicPrMap(input),
        source: "heuristic",
        ...(grouping ? { aiOutdated: true } : {}),
      };
    }
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof ChangedFilesError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error(`POST /api/repos/${repoId}/pr-map failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build the PR map." },
      { status: 500 }
    );
  }
}
