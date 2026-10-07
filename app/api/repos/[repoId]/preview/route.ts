// The before/after preview of one changed file (DESIGN.md §6.9).
//
//   POST /api/repos/[repoId]/preview  { path, prNumber | baseRef+headRef, inputs? }  enqueue a run
//   GET  /api/repos/[repoId]/preview?path=…&prNumber=N|baseRef=…&headRef=…[&logs=1]  state + result
//
// On demand only: a run spends a model call (unless every input was given)
// and two sandbox containers. This route never runs anything itself — the
// worker does, through lib/jobs/preview.ts.

import { NextResponse } from "next/server";
import { z } from "zod";
import { gitRefSchema } from "../../_shared";
import { enqueuePreview, getPreviewJob, getPreviewJobLogs, type ReviewTarget } from "@/lib/jobs";
import { getRepoById } from "@/lib/db";
import { getDockerStatus } from "@/lib/preview/sandbox";
import type { PreviewJobState, PreviewProgress, PreviewStatusDTO } from "@/lib/preview/types";

export const dynamic = "force-dynamic";

const inputSchema = z.object({
  args: z.array(z.unknown()).optional(),
  kwargs: z.record(z.string(), z.unknown()).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});
const casesSchema = z.array(z.object({ label: z.string().max(200), input: inputSchema })).max(12);

const targetFields = {
  prNumber: z.coerce.number().int().positive().optional(),
  baseRef: gitRefSchema.optional(),
  headRef: gitRefSchema.optional(),
};

const bodySchema = z.object({
  path: z.string().min(1),
  ...targetFields,
  inputs: z.record(z.string(), casesSchema).optional(),
  mocks: z.record(z.string(), z.unknown()).optional(),
});

const querySchema = z.object({ path: z.string().min(1), ...targetFields });

function errorResponse(error: string, status: number, code?: string): NextResponse {
  return NextResponse.json(code ? { error, code } : { error }, { status });
}

function toTarget(data: { prNumber?: number; baseRef?: string; headRef?: string }): ReviewTarget | null {
  if (data.prNumber) return { kind: "pr", prNumber: data.prNumber };
  if (data.baseRef && data.headRef) return { kind: "refs", baseRef: data.baseRef, headRef: data.headRef };
  return null;
}

function cleanPath(value: string): string | null {
  const clean = value.replace(/^\/+/, "");
  return clean && !clean.includes("..") && !clean.startsWith("-") ? clean : null;
}

export async function POST(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
  const target = parsed.success ? toTarget(parsed.data) : null;
  const filePath = parsed.success ? cleanPath(parsed.data.path) : null;
  if (!parsed.success || !target || !filePath) {
    return errorResponse("Body must be { path, prNumber } or { path, baseRef, headRef }, optionally with inputs.", 400);
  }
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return errorResponse("Repo not found.", 404);
    if (repo.provider === "local" && target.kind === "pr") {
      return errorResponse("A pull request can't be previewed on a repo with no git-host link — compare two refs instead.", 400);
    }
    const sandbox = await getDockerStatus();
    if (!sandbox.available) return errorResponse(sandbox.reason ?? "Docker isn't available.", 409, "sandbox_unavailable");
    const result = await enqueuePreview({ repoId, target, filePath, inputs: parsed.data.inputs, mocks: parsed.data.mocks });
    return NextResponse.json({ jobId: result.jobId, enqueued: result.enqueued });
  } catch (err) {
    console.error(`POST /api/repos/${repoId}/preview failed:`, err);
    return errorResponse(err instanceof Error ? err.message : "Failed to start the preview.", 500);
  }
}

function toState(jobState: string): PreviewJobState {
  switch (jobState) {
    case "waiting":
    case "waiting-children":
    case "delayed":
    case "prioritized":
      return "queued";
    case "active":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "none";
  }
}

function toProgress(raw: unknown): PreviewProgress | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Partial<PreviewProgress>;
  if (typeof p.message !== "string" || typeof p.stage !== "string") return undefined;
  return { stage: p.stage, message: p.message };
}

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  const target = parsed.success ? toTarget(parsed.data) : null;
  const filePath = parsed.success ? cleanPath(parsed.data.path) : null;
  if (!parsed.success || !target || !filePath) {
    return errorResponse("Query must include ?path= plus ?prNumber= or ?baseRef=&headRef=.", 400);
  }
  try {
    const [job, sandbox] = await Promise.all([getPreviewJob(repoId, target, filePath), getDockerStatus()]);
    if (!job) return NextResponse.json({ state: "none", sandbox } satisfies PreviewStatusDTO);
    const state = toState(await job.getState());
    const body: PreviewStatusDTO = { state, sandbox };
    if (state === "queued" || state === "running") body.progress = toProgress(job.progress);
    if (state === "completed" && job.returnvalue) body.result = job.returnvalue;
    if (state === "failed") body.error = job.failedReason || "The preview failed.";
    if (url.searchParams.get("logs") === "1") body.logs = await getPreviewJobLogs(repoId, target, filePath);
    return NextResponse.json(body);
  } catch (err) {
    console.error(`GET /api/repos/${repoId}/preview failed:`, err);
    return errorResponse(err instanceof Error ? err.message : "Failed to read the preview.", 500);
  }
}
