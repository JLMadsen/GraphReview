// The app map's AI run (DESIGN.md §6.5).
//
//   POST   /api/repos/[repoId]/app-map/job  { level, mode? }  enqueue (on demand only);
//          mode "place" (features only) places the files the stored grouping doesn't cover
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
import { getActiveAiProvider, getAppMapRecords, getRepoById } from "@/lib/db";
import {
  isAppMapLevel,
  type AppMapJobStateDTO,
  type AppMapJobStatusDTO,
  type AppMapLevel,
  type AppMapRunMode,
} from "@/components/graph/app-map-types";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  level: z.enum(["architecture", "features", "modules"]),
  mode: z.enum(["full", "place"]).optional(),
});

function errorResponse(error: string, status: number, code?: string): NextResponse {
  return NextResponse.json(code ? { error, code } : { error }, { status });
}

async function isAiConfigured(): Promise<boolean> {
  const provider = await getActiveAiProvider();
  return Boolean(provider?.baseUrl && provider?.apiKeyEncrypted && provider?.model);
}

export async function POST(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return errorResponse("Body must be { level: architecture | features | modules, mode?: full | place }.", 400);
  }
  const { level, mode = "full" } = parsed.data;

  try {
    if (!(await getRepoById(repoId))) return errorResponse("Repo not found.", 404);
    if (!(await isAiConfigured())) {
      return errorResponse(
        "AI provider is not configured — set the base URL, API key and model in Settings.",
        400,
        "ai_not_configured"
      );
    }
    if (mode === "place") {
      if (level !== "features") return errorResponse("Only the features level can place files.", 400);
      const records = await getAppMapRecords(repoId);
      if (!records.some((r) => r.level === "features")) {
        return errorResponse("There is no features grouping to place files into yet — group the features first.", 400);
      }
    }
    const result = await enqueueAppMap(repoId, level, mode);
    return NextResponse.json({ jobId: result.jobId, enqueued: result.enqueued });
  } catch (err) {
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
    phase: p.phase === "placing" || p.phase === "explaining" || p.phase === "saving" ? p.phase : "grouping",
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
    let mode: AppMapRunMode | undefined;
    let progress: AppMapProgress | undefined;
    let error: string | undefined;
    let finishedAt: string | undefined;
    const job = await getAppMapJob(repoId);
    if (job) {
      state = toState(await job.getState());
      level = job.data.level;
      mode = job.data.mode ?? "full";
      progress = toProgress(job.progress);
      if (state === "failed" && job.failedReason === APP_MAP_CANCELLED_REASON) state = "cancelled";
      else if (state === "failed") error = job.failedReason || "The app map run failed.";
      if (job.finishedOn) finishedAt = new Date(job.finishedOn).toISOString();
    }

    let logs: string[] | undefined;
    if (includeLogs) logs = await getAppMapJobLogs(repoId).catch(() => []);

    const body: AppMapJobStatusDTO & { logs?: string[] } = {
      state,
      ...(level ? { level } : {}),
      ...(mode ? { mode } : {}),
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
    return errorResponse(err instanceof Error ? err.message : "Failed to cancel the app map run.", 500);
  }
}
