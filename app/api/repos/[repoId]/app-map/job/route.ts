// The app map's AI run (DESIGN.md §6.5).
//
//   POST   /api/repos/[repoId]/app-map/job  { level }  enqueue (on demand only)
//   GET    /api/repos/[repoId]/app-map/job             state + progress + which levels have a run
//   DELETE /api/repos/[repoId]/app-map/job             cancel
//
// On demand like labeling (see that route's header): the UI only POSTs when
// someone presses "Explain with AI". This route never calls the model itself.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  APP_MAP_CANCELLED_REASON,
  cancelAppMap,
  enqueueAppMap,
  getAppMapJob,
  getAppMapJobLogs,
  type AppMapProgress,
} from "@/lib/jobs";
import { getActiveAiProvider, getAppMapRecords, getRepoById } from "@/lib/neo4j";
import {
  isAppMapLevel,
  type AppMapJobStateDTO,
  type AppMapJobStatusDTO,
  type AppMapLevel,
} from "@/components/graph/app-map-types";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ level: z.enum(["architecture", "features", "modules"]) });

function errorResponse(error: string, status: number, code?: string): NextResponse {
  return NextResponse.json(code ? { error, code } : { error }, { status });
}

function isRedisUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|max retries per request|Connection is closed|Stream isn't writeable|Redis/i.test(
    message
  );
}

async function isAiConfigured(): Promise<boolean> {
  const provider = await getActiveAiProvider();
  return Boolean(provider?.baseUrl && provider?.apiKeyEncrypted && provider?.model);
}

export async function POST(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return errorResponse("Body must be { level: architecture | features | modules }.", 400);

  try {
    if (!(await getRepoById(repoId))) return errorResponse("Repo not found.", 404);
    if (!(await isAiConfigured())) {
      return errorResponse(
        "AI provider is not configured — set the base URL, API key and model in Settings.",
        400,
        "ai_not_configured"
      );
    }
    const result = await enqueueAppMap(repoId, parsed.data.level);
    return NextResponse.json({ jobId: result.jobId, enqueued: result.enqueued });
  } catch (err) {
    if (isRedisUnavailable(err)) {
      return errorResponse("The job queue is unavailable — is Redis running?", 503, "queue_unavailable");
    }
    console.error(`POST /api/repos/${repoId}/app-map/job failed:`, err);
    return errorResponse(err instanceof Error ? err.message : "Failed to start the app map run.", 500);
  }
}

function toState(jobState: string): AppMapJobStateDTO {
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

function toProgress(raw: unknown): AppMapProgress | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Partial<AppMapProgress>;
  if (typeof p.done !== "number" || typeof p.total !== "number" || !isAppMapLevel(p.level)) return undefined;
  return {
    level: p.level,
    phase: p.phase === "explaining" || p.phase === "saving" ? p.phase : "grouping",
    done: p.done,
    total: p.total,
    calls: p.calls ?? 0,
    promptTokens: p.promptTokens ?? 0,
    completionTokens: p.completionTokens ?? 0,
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const includeLogs = new URL(request.url).searchParams.get("logs") === "1";
  try {
    if (!(await getRepoById(repoId))) return errorResponse("Repo not found.", 404);
    const [records, aiConfigured] = await Promise.all([getAppMapRecords(repoId), isAiConfigured()]);
    const generated: AppMapJobStatusDTO["generated"] = {};
    for (const record of records) {
      if (isAppMapLevel(record.level)) {
        generated[record.level] = { generatedAt: record.createdAt, model: record.model };
      }
    }

    let state: AppMapJobStateDTO = "none";
    let level: AppMapLevel | undefined;
    let progress: AppMapProgress | undefined;
    let error: string | undefined;
    let finishedAt: string | undefined;
    try {
      const job = await getAppMapJob(repoId);
      if (job) {
        state = toState(await job.getState());
        level = job.data.level;
        progress = toProgress(job.progress);
        if (state === "failed" && job.failedReason === APP_MAP_CANCELLED_REASON) state = "cancelled";
        else if (state === "failed") error = job.failedReason || "The app map run failed.";
        if (job.finishedOn) finishedAt = new Date(job.finishedOn).toISOString();
      }
    } catch (queueError) {
      if (!isRedisUnavailable(queueError)) throw queueError;
      error = "The job queue is unavailable — live progress could not be read.";
    }

    let logs: string[] | undefined;
    if (includeLogs) logs = await getAppMapJobLogs(repoId).catch(() => []);

    const body: AppMapJobStatusDTO & { logs?: string[] } = {
      state,
      ...(level ? { level } : {}),
      ...(progress ? { progress } : {}),
      ...(error ? { error } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      aiConfigured,
      generated,
      ...(logs ? { logs } : {}),
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error(`GET /api/repos/${repoId}/app-map/job failed:`, err);
    return errorResponse(err instanceof Error ? err.message : "Failed to read the app map run.", 500);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  try {
    return NextResponse.json(await cancelAppMap(repoId));
  } catch (err) {
    if (isRedisUnavailable(err)) {
      return errorResponse("The job queue is unavailable — is Redis running?", 503, "queue_unavailable");
    }
    return errorResponse(err instanceof Error ? err.message : "Failed to cancel the app map run.", 500);
  }
}
