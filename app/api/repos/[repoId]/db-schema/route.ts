// GET /api/repos/[repoId]/db-schema
//
// The Data view (DESIGN.md §6.13): the tables the repo's analysed commit
// declares — migrations replayed, schema files and ORM models merged — with
// drift, migration order problems and the code's links to them. Each table
// carries the component that owns it (its model's, else its migration's).
// Built by static analysis during the analysis job; read-only and free. A
// review target's schema change rides on the target graph (`/target-graph`).

import { NextResponse } from "next/server";
import { getFileOwnerMap, getRepoById, listComponentsByRepoId, readDbSchema } from "@/lib/db";
import { EMPTY_DB_SCHEMA } from "@/lib/analysis/db/types";
import { ownerLookup } from "@/lib/jobs/target-graph";
import type { DbSchemaResponseDTO } from "@/components/graph/db-types";
import { apiError } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    const stored = readDbSchema(repoId);
    if (!stored) return NextResponse.json({ state: "none", ...EMPTY_DB_SCHEMA } satisfies DbSchemaResponseDTO);
    const [owners, components] = await Promise.all([getFileOwnerMap(repoId), listComponentsByRepoId(repoId)]);
    const ownerOf = ownerLookup(owners);
    const nameOf = new Map(components.map((c) => [c.id, c.name]));
    for (const db of stored.schema.databases) {
      for (const t of db.tables) {
        const id = t.models.map((m) => ownerOf(m.file)).find(Boolean) ?? ownerOf(t.definedAt.file);
        if (id) t.component = { id, name: nameOf.get(id) ?? id };
      }
    }
    const body: DbSchemaResponseDTO = { state: "ready", sha: stored.sha, computedAt: stored.computedAt, ...stored.schema };
    return NextResponse.json(body);
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/db-schema failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not read the schema catalog.", 500);
  }
}
