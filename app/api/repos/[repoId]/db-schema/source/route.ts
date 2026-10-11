// PUT    /api/repos/[repoId]/db-schema/source   { file }   pin the schema source
// DELETE /api/repos/[repoId]/db-schema/source              back to auto-detection
//
// The repo's pinned schema source (DESIGN.md §6.13): one file that replaces
// auto-detection for the analysed commit and every review target. Either
// change re-runs the analysis and drops the stored base/head comparisons, so
// the Data view and every PR re-read the schema from the new source.

import { NextResponse } from "next/server";
import { z } from "zod";
import { listAnalysedFiles, setSchemaSource } from "@/lib/jobs/db-source";
import { apiError, errorMessage, loadRepo } from "../../../_shared";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  file: z
    .string()
    .min(1)
    .max(1000)
    .refine((p) => !p.startsWith("/") && !/^[a-zA-Z]:/.test(p) && !p.split("/").includes("..") && !p.includes("\\"), { message: "A repo-relative path with forward slashes." }),
});

export async function PUT(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return apiError("Invalid request body.", 400, parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  try {
    const listing = await listAnalysedFiles(loaded.repo).catch(() => null);
    if (listing && !listing.files.includes(parsed.data.file)) return apiError(`${parsed.data.file} isn't in the analysed commit.`, 400);
    return NextResponse.json(await setSchemaSource(loaded.repo, parsed.data.file));
  } catch (error) {
    return apiError(`Could not pin the schema source: ${errorMessage(error)}`, 500);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;
  try {
    return NextResponse.json(await setSchemaSource(loaded.repo, null));
  } catch (error) {
    return apiError(`Could not clear the schema source: ${errorMessage(error)}`, 500);
  }
}
