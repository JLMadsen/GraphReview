// GET /api/repos/[repoId]/graph
//
// Returns every component of the repo plus the `DEPENDS_ON` edges
// between them, in the flat DTO shape `components/graph/` reads (the Graph
// tab uses it to resolve component ids to names). The domain tier is only
// written by the AI labeling job (lib/jobs/label.ts), so a repo may
// legitimately have none: a component simply has no `parentId` when no
// `CHILD_OF` edge exists.
//
// Domain-tier nodes carry no files of their own — `BELONGS_TO` only ever
// points at a module — so their `fileCount` is **summed from their
// children** rather than reported as a raw 0.

import { NextResponse } from "next/server";
import {
  countFilesByComponent,
  listComponentDependencies,
  listComponentParents,
  listComponentsByRepoId,
} from "@/lib/db";
import type { GraphEdgeDTO, GraphNodeDTO, GraphResponseDTO } from "@/components/graph/types";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) {
  const { repoId } = await params;

  try {
    const components = await listComponentsByRepoId(repoId);

    const [fileCountById, parents, dependencies] = await Promise.all([
      countFilesByComponent(repoId),
      listComponentParents(repoId),
      listComponentDependencies(repoId),
    ]);

    const parentById = new Map(parents.map((p) => [p.childId, p.parentId]));

    // A domain's file count is the sum of its children's (see the header).
    // Computed from the same `parentById` map the nesting uses, so the two
    // can never disagree about who belongs to which box.
    const childFileTotals = new Map<string, number>();
    for (const component of components) {
      const parentId = parentById.get(component.id);
      if (!parentId) continue;
      childFileTotals.set(
        parentId,
        (childFileTotals.get(parentId) ?? 0) + (fileCountById.get(component.id) ?? 0)
      );
    }

    const nodes: GraphNodeDTO[] = components.map((c) => ({
      id: c.id,
      name: c.name,
      tier: c.tier,
      parentId: parentById.get(c.id),
      fileCount:
        c.tier === "domain"
          ? (childFileTotals.get(c.id) ?? 0)
          : (fileCountById.get(c.id) ?? 0),
      description: c.description,
      origin: c.origin === "merge" ? "merge" : undefined,
    }));

    const edges: GraphEdgeDTO[] = dependencies.map((d) => ({
      source: d.source,
      target: d.target,
      weight: d.weight,
    }));

    const body: GraphResponseDTO = { nodes, edges };
    return NextResponse.json(body);
  } catch (err) {
    console.error(`GET /api/repos/${repoId}/graph failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load graph." },
      { status: 500 }
    );
  }
}
