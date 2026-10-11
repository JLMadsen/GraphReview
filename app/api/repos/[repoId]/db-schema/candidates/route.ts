// GET /api/repos/[repoId]/db-schema/candidates
//
// What the Data view offers to pin as the repo's schema source (DESIGN.md
// §6.13, pinned source): the files of the analysed commit that hold schema
// statements — `.sql`, `.prisma`, code with DDL literals — non-test first,
// by CREATE TABLE count (from the stored catalog), and every path of that
// commit for the search box (`git ls-tree`). Read-only.

import { NextResponse } from "next/server";
import { readDbSchema, readDbSource } from "@/lib/db";
import { listAnalysedFiles } from "@/lib/jobs/db-source";
import type { DbSourceCandidatesDTO } from "@/components/graph/db-types";
import { apiError, errorMessage, loadRepo } from "../../../_shared";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;
  try {
    const stored = readDbSchema(repoId);
    const listing = await listAnalysedFiles(loaded.repo).catch(() => null);
    const body: DbSourceCandidatesDTO = {
      candidates: stored?.schema.candidates ?? [],
      files: listing?.files ?? [],
      truncated: listing?.truncated ?? false,
      ...(listing?.sha ? { sha: listing.sha } : {}),
      pin: readDbSource(repoId)?.file ?? null,
    };
    return NextResponse.json(body);
  } catch (error) {
    return apiError(`Could not list the schema source candidates: ${errorMessage(error)}`, 500);
  }
}
