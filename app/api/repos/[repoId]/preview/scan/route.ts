// Changed UI components of a target, for the Graph tab's "Looks different"
// section (DESIGN.md §6.9).
//
//   POST /api/repos/[repoId]/preview/scan  { prNumber | baseRef+headRef }
//        the scan (started or refreshed by this call) joined with each
//        file's last preview run: which components render differently
//   POST /api/repos/[repoId]/preview/scan  { …, previewAll: true }
//        "Preview all": start a preview run for every scanned file
//
// The scan only parses code (no Docker, no model), so asking for it starts
// it — a POST, since a GET with side effects can be fired cross-origin
// (DESIGN.md §6.26 §3). Plain function changes are deliberately not listed
// here.

import { NextResponse } from "next/server";
import { z } from "zod";
import { gitRefSchema } from "../../../_shared";
import { enqueuePreview, ensurePreviewScan, getPreviewJob, readsInPlace, type ReviewTarget } from "@/lib/jobs";
import { getRepoById } from "@/lib/db";
import { symbolStatus } from "@/lib/preview/compare";
import { getDockerStatus } from "@/lib/preview/sandbox";
import type {
  PreviewJobState,
  PreviewProgress,
  PreviewResult,
  PreviewScanDTO,
  PreviewScanFileDTO,
  PreviewScanResult,
} from "@/lib/preview/types";

export const dynamic = "force-dynamic";

const targetSchema = z.object({
  prNumber: z.coerce.number().int().positive().optional(),
  baseRef: gitRefSchema.optional(),
  headRef: gitRefSchema.optional(),
});

function toTarget(data: z.infer<typeof targetSchema>): ReviewTarget | null {
  if (data.prNumber) return { kind: "pr", prNumber: data.prNumber };
  if (data.baseRef && data.headRef) return { kind: "refs", baseRef: data.baseRef, headRef: data.headRef };
  return null;
}

function errorResponse(error: string, status: number, code?: string): NextResponse {
  return NextResponse.json(code ? { error, code } : { error }, { status });
}

function toState(jobState: string): PreviewJobState {
  if (["waiting", "waiting-children", "delayed", "prioritized"].includes(jobState)) return "queued";
  if (jobState === "active") return "running";
  if (jobState === "completed" || jobState === "failed") return jobState;
  return "none";
}

/** How one component came out of a finished preview run. */
function looksOf(result: PreviewResult, name: string): PreviewScanFileDTO["components"][number]["looks"] {
  const symbol = result.symbols.find((s) => s.name === name);
  // A partial result's symbol that hasn't rendered on both sides yet.
  if (!symbol || symbol.pending) return undefined;
  // A side that didn't render (load error, a throw, notFound()) is a failure,
  // never "looks different" — see lib/preview/compare.ts.
  switch (symbolStatus(symbol)) {
    case "failed":
    case "breaks":
    case "recovers":
      return "failed";
    case "same":
      return "same";
    default:
      return "different";
  }
}

async function loadScan(repoId: string, target: ReviewTarget): Promise<{ state: PreviewJobState; scan?: PreviewScanResult; error?: string }> {
  const job = await ensurePreviewScan(repoId, target);
  const state = toState(await job.getState());
  if (state === "completed") return { state, scan: job.returnvalue };
  if (state === "failed") return { state, error: job.failedReason || "The scan failed." };
  return { state };
}

async function loadTarget(raw: unknown, repoId: string) {
  const parsed = targetSchema.safeParse(raw);
  const target = parsed.success ? toTarget(parsed.data) : null;
  if (!target) return { response: errorResponse("Pass prNumber, or baseRef and headRef.", 400) };
  const repo = await getRepoById(repoId);
  if (!repo) return { response: errorResponse("Repo not found.", 404) };
  if (readsInPlace(repo) && target.kind === "pr") {
    return { response: errorResponse("A pull request can't be previewed on a repo with no git-host link.", 400) };
  }
  return { target };
}

async function readScan(repoId: string, target: ReviewTarget) {
  {
    const [{ state, scan, error }, sandbox] = await Promise.all([loadScan(repoId, target), getDockerStatus()]);
    const files: PreviewScanFileDTO[] = [];
    for (const file of scan?.files ?? []) {
      const job = await getPreviewJob(repoId, target, file.filePath);
      const preview = job ? toState(await job.getState()) : "none";
      // A running preview streams its components (PreviewProgress.partial): the finished ones show at once.
      const partial = preview === "running" ? (job?.progress as PreviewProgress | undefined)?.partial : undefined;
      const result = job?.returnvalue ?? partial ?? undefined;
      files.push({
        filePath: file.filePath,
        preview,
        components: file.components.map((c) => ({ ...c, ...(result ? { looks: looksOf(result, c.name) } : {}) })),
      });
    }
    return NextResponse.json({ state, files, sandbox, ...(error ? { error } : {}) } satisfies PreviewScanDTO);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const raw = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  try {
    const { target, response } = await loadTarget(raw, repoId);
    if (!target) return response;
    if (raw?.previewAll !== true) return await readScan(repoId, target);
    const { scan } = await loadScan(repoId, target);
    if (!scan) return errorResponse("The scan hasn't finished yet.", 409);
    const sandbox = await getDockerStatus();
    if (!sandbox.available) return errorResponse(sandbox.reason ?? "Docker isn't available.", 409, "sandbox_unavailable");
    let enqueued = 0;
    for (const file of scan.files) {
      // Keeps any inputs the user edited for that file's last run.
      const previous = (await getPreviewJob(repoId, target, file.filePath))?.returnvalue;
      const inputs = previous?.inputsSource === "user" ? previous.inputs : undefined;
      // Server responses are reused too: they only depend on what the code calls, and new calls still get mocked.
      const mocks = previous?.mocks && Object.keys(previous.mocks).length > 0 ? previous.mocks : undefined;
      if ((await enqueuePreview({ repoId, target, filePath: file.filePath, inputs, mocks })).enqueued) enqueued += 1;
    }
    return NextResponse.json({ enqueued });
  } catch (err) {
    console.error(`POST /api/repos/${repoId}/preview/scan failed:`, err);
    return errorResponse(err instanceof Error ? err.message : "Failed to start the previews.", 500);
  }
}
