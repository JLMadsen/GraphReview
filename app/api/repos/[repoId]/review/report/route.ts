// GET /api/repos/[repoId]/review/report?prNumber=|baseRef=&headRef=
//
// The full Markdown report of a review (DESIGN.md §6.23 §2), built from
// stored data: no model call, no clone.

import { NextResponse } from "next/server";
import { apiError, errorMessage, loadRepo, targetFromSearchParams } from "../../../_shared";
import { exportFilename, loadReportContext, renderReport } from "@/lib/review-post/report";
import type { ReportResponse } from "@/lib/review-post/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const loaded = await loadRepo(repoId);
  if ("response" in loaded) return loaded.response;
  const target = targetFromSearchParams(new URL(request.url).searchParams);
  if (!target) return apiError("Expected ?prNumber= or ?baseRef=&headRef=.", 400);
  try {
    const ctx = await loadReportContext(loaded.repo, target);
    const { markdown, sections } = await renderReport(ctx);
    const body: ReportResponse = { markdown, sections, filename: exportFilename("graphreview-report", target) };
    return NextResponse.json(body);
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/review/report failed:`, error);
    return apiError(`Could not build the report: ${errorMessage(error)}`, 500);
  }
}
