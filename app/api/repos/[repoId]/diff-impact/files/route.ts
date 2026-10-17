// GET /api/repos/[repoId]/diff-impact/files — every changed file's patch of
// a review target at once, for the all-files reader (DESIGN.md §6.24).
// `?prNumber=<n>` or `?baseRef=<ref>&headRef=<ref>`; `?w=1` leaves
// whitespace-only changes out (done by git when the diff comes from a
// local `git diff`, by the viewer when it had to come from the host's API).

import { NextResponse } from "next/server";
import { z } from "zod";
import { gitRefSchema } from "../../../_shared";
import { getRepoById } from "@/lib/db";
import { DiffFilesError, loadTargetDiff } from "@/lib/jobs/diff-files";
import type { DiffFilesResponseDTO } from "@/components/graph/types";

export const dynamic = "force-dynamic";

const querySchema = z.union([
  z.object({ prNumber: z.coerce.number().int().positive() }),
  z.object({ baseRef: gitRefSchema, headRef: gitRefSchema }),
]);

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);
  delete query.w;
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) {
    return NextResponse.json({ error: "Query must include ?prNumber=<n> or ?baseRef=<ref>&headRef=<ref>." }, { status: 400 });
  }
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return NextResponse.json({ error: "Repo not found." }, { status: 404 });
    const target =
      "prNumber" in parsed.data
        ? ({ kind: "pr", prNumber: parsed.data.prNumber } as const)
        : ({ kind: "refs", baseRef: parsed.data.baseRef, headRef: parsed.data.headRef } as const);
    const diff = await loadTargetDiff(repo, target, { ignoreWhitespace: url.searchParams.get("w") === "1" });
    const body: DiffFilesResponseDTO = diff;
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof DiffFilesError) return NextResponse.json({ error: err.message }, { status: 400 });
    console.error(`GET /api/repos/${repoId}/diff-impact/files failed:`, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load the diff." }, { status: 500 });
  }
}
