// The repo's memory of findings dismissed as "not a problem" (DESIGN.md §6.21).
//
//   GET    /api/repos/[repoId]/review/suppressions          every suppression, newest first
//   DELETE /api/repos/[repoId]/review/suppressions?id=<id>  un-suppress one
//
// Suppressions are made by dismissing a finding (PATCH …/review/findings/[id]
// with `dismiss`). Un-suppressing shows the findings it hid again, on every
// review of the repo, and stops telling the model about it. The finding it
// was made from stays resolved — reopen it to have it count again.

import { NextResponse } from "next/server";
import { deleteFindingSuppression, getRepoById, listFindingSuppressions, type FindingSuppression } from "@/lib/db";
import { apiError, errorMessage } from "../../../_shared";

export const dynamic = "force-dynamic";

export interface SuppressionsResponse {
  suppressions: FindingSuppression[];
}

export async function GET(_request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  try {
    if (!(await getRepoById(repoId))) return apiError("Repo not found.", 404);
    const body: SuppressionsResponse = { suppressions: listFindingSuppressions(repoId) };
    return NextResponse.json(body);
  } catch (error) {
    return apiError(`Could not read the suppressions: ${errorMessage(error)}`, 503);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return apiError("Query must be ?id=<suppression id>.", 400);
  try {
    if (!deleteFindingSuppression(repoId, id)) return apiError(`No suppression with id "${id}" in this repo.`, 404);
    return NextResponse.json({ id, deleted: true });
  } catch (error) {
    return apiError(`Could not un-suppress: ${errorMessage(error)}`, 503);
  }
}
