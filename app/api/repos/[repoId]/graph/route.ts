// GET /api/repos/[repoId]/graph
//
// Returns every `(:Component)` for the repo plus the `DEPENDS_ON` edges
// between them, in the flat DTO shape `components/graph/` renders. The
// domain tier is populated on demand by the AI labeling job
// (lib/jobs/label.ts), so a repo may legitimately have none: a component
// simply has no `parentId` when no `CHILD_OF` edge exists, and the canvas
// renders a flat graph in that case.
//
// Domain-tier nodes carry no files of their own — `BELONGS_TO` only ever
// points at a module — so their `fileCount` is **summed from their
// children**. Reporting the raw 0 would size every domain box's label as
// "0 files" and, worse, feed a 0 into the canvas's node-size scale.
//
// `lib/neo4j`'s repository functions (component.ts, file.ts) don't expose
// a "list DEPENDS_ON edges for a repo" or "list CHILD_OF parents for a
// repo" query — only per-node helpers keyed by id. Rather than add new
// exports to that module (out of this task's owned paths), this route
// uses `runRead` directly, which `lib/neo4j/client.ts` explicitly documents
// route handlers as an intended caller of alongside the repository
// modules.

import { NextResponse } from "next/server";
import { listComponentsByRepoId, listFilesByComponentId, runRead } from "@/lib/neo4j";
import type { GraphEdgeDTO, GraphNodeDTO, GraphResponseDTO } from "@/components/graph/types";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) {
  const { repoId } = await params;

  try {
    const components = await listComponentsByRepoId(repoId);

    const [fileCountEntries, parentResult, dependsOnResult] = await Promise.all([
      Promise.all(
        components.map(async (c) => {
          const files = await listFilesByComponentId(c.id);
          return [c.id, files.length] as const;
        })
      ),
      runRead(
        `
        MATCH (child:Component {repoId: $repoId})-[:CHILD_OF]->(parent:Component)
        RETURN child.id AS childId, parent.id AS parentId
        `,
        { repoId }
      ),
      runRead(
        `
        MATCH (a:Component {repoId: $repoId})-[dep:DEPENDS_ON]->(b:Component {repoId: $repoId})
        RETURN a.id AS source, b.id AS target, dep.weight AS weight
        `,
        { repoId }
      ),
    ]);

    const fileCountById = new Map(fileCountEntries);
    const parentById = new Map(
      parentResult.records.map((record) => [
        record.get("childId") as string,
        record.get("parentId") as string,
      ])
    );

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
    }));

    const edges: GraphEdgeDTO[] = dependsOnResult.records.map((record) => ({
      source: record.get("source") as string,
      target: record.get("target") as string,
      weight: Number(record.get("weight")),
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
