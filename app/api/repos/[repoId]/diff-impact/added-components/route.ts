// POST /api/repos/[repoId]/diff-impact/added-components — labels the
// `unmatchedFiles` from a prior `POST ../diff-impact` call (files a PR added
// that have no `(:File)` node in the persisted graph yet) as ephemeral,
// folder-clustered "components" with an AI-written description each.
//
// Sibling of `../route.ts`, same reasoning as `../file/route.ts`: this is a
// separate call rather than folded into the diff-impact response so the
// client can skip it entirely on a cache hit (see
// lib/jobs/added-components.ts's doc comment) instead of paying an AI call
// on every "Check impact" click. No Neo4j write — nothing here is persisted.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  describeAddedComponents,
  synthesizeAddedComponents,
} from "@/lib/jobs/added-components";
import { getRepoById } from "@/lib/neo4j";
import type { AddedComponentsResponseDTO } from "@/components/graph/types";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ filePaths: z.array(z.string()) });

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
      { error: "Body must be { filePaths: string[] }." },
      { status: 400 }
    );
  }

  try {
    const repo = await getRepoById(repoId);
    if (!repo) {
      return NextResponse.json({ error: "Repo not found." }, { status: 404 });
    }

    const paths = Array.from(
      new Set(parsed.data.filePaths.map((p) => p.trim()).filter(Boolean))
    );
    const synthesized = synthesizeAddedComponents(repoId, paths);
    const descriptions = await describeAddedComponents(repo.name, synthesized);

    const body: AddedComponentsResponseDTO = {
      components: synthesized.map((c) => ({
        id: c.id,
        name: c.name,
        filePaths: c.filePaths,
        fileCount: c.filePaths.length,
        description: descriptions.get(c.id),
      })),
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error(
      `POST /api/repos/${repoId}/diff-impact/added-components failed:`,
      err
    );
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to label added files.",
      },
      { status: 500 }
    );
  }
}
