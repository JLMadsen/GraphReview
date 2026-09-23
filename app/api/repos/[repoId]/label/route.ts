// The AI labeling endpoint.
//
//   POST   /api/repos/[repoId]/label   enqueue a labeling run (on demand only)
//   GET    /api/repos/[repoId]/label   job state + progress + what exists today
//   DELETE /api/repos/[repoId]/label   cancel a queued or running run
//
// Deliberately **not** automatic, unlike the review endpoint. The "no
// confirmation dialog, no cap" policy is about a review that follows an explicit
// diff selection; labeling is triggered by nothing in particular and
// re-analysis happens constantly (the staleness sweep), so running it
// automatically would spend tokens nobody asked for. The UI only ever POSTs
// here when someone presses "Generate labels".
//
// This route never talks to the AI provider itself — all of that happens in
// the worker (`lib/jobs/label.ts`). It validates, checks that a run *could*
// succeed, enqueues, and reads back.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  LABEL_CANCELLED_REASON,
  cancelLabel,
  enqueueLabel,
  getLabelJob,
  getLabelJobLogs,
  isLabelCancelRequested,
  type CancelLabelResult,
  type LabelProgress,
} from "@/lib/jobs";
import { getActiveAiProvider, getLabelSummary, getRepoById } from "@/lib/neo4j";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Response contract
// ---------------------------------------------------------------------------

/** Lifecycle of a repo's labeling run, collapsed from BullMQ's finer-grained job states. `"none"` means "never labeled". */
export type LabelState = "none" | "queued" | "running" | "completed" | "failed" | "cancelled";

export interface LabelStatusResponse {
  state: LabelState;
  progress?: LabelProgress;
  /** The failed job's `failedReason`, or a degraded-read note (e.g. Redis down). */
  error?: string;
  /** `running` only: the user asked to cancel and the worker hasn't stopped yet. */
  cancelRequested?: boolean;
  /** ISO-8601 time the last run finished (completed, failed or cancelled), while its job is still retained. */
  finishedAt?: string;
  /** A completed run that still needs a word of explanation — e.g. no usable domains, so the old ones were kept. */
  warning?: string;
  /** Whether all three AI provider settings are present — `false` means the UI must not POST. */
  aiConfigured: boolean;
  /** Domain-tier components that exist right now. */
  domains: number;
  /** Module-tier components carrying a non-empty description right now. */
  describedModules: number;
  /** Module-tier components in total — the denominator for `describedModules`. */
  modules: number;
  /** Recent `job.log()` lines from the worker, oldest first — present only for `?logs=1` (the toolbar's hover-to-see-progress affordance). */
  logs?: string[];
}

export type CancelLabelResponse = CancelLabelResult;

export interface EnqueueLabelResponse {
  jobId: string;
  /** `false` when a labeling run for this repo was already queued or running. */
  enqueued: boolean;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/** The body is optional; `{}` and an absent body both mean "label, don't force". */
const bodySchema = z.object({ force: z.boolean().optional() }).optional();

function errorResponse(error: string, status: number, code?: string): NextResponse {
  return NextResponse.json(code ? { error, code } : { error }, { status });
}

/** Whether the failure looks like "Redis is unreachable" rather than a real application error — see the review route for why the producer connection's bounded retry makes this a 503. */
function isRedisUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|max retries per request|Connection is closed|Stream isn't writeable|Redis/i.test(
    message
  );
}

/** The active saved provider must have all three fields present for a labeling run to be possible (base URL + key + model are one unit). */
async function isAiConfigured(): Promise<boolean> {
  const provider = await getActiveAiProvider();
  return Boolean(provider?.baseUrl && provider?.apiKeyEncrypted && provider?.model);
}

// ---------------------------------------------------------------------------
// POST — enqueue
// ---------------------------------------------------------------------------

export async function POST(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) {
  const { repoId } = await params;

  // An empty body is legitimate here (the common case is "just label it"),
  // so a JSON parse failure only matters when something was actually sent.
  const rawBody = await request.json().catch(() => undefined);
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse("Body must be {} or { force: boolean }.", 400);
  }
  const force = parsed.data?.force === true;

  try {
    const repo = await getRepoById(repoId);
    if (!repo) return errorResponse("Repo not found.", 404);

    // Checked before enqueueing on purpose: a job that can only ever fail on
    // its first line is worse than a straight 400, because with `attempts: 1`
    // it also burns the repo's job id until retention evicts it.
    if (!(await isAiConfigured())) {
      return errorResponse(
        "AI provider is not configured — set the base URL, API key and model in Settings.",
        400,
        "ai_not_configured"
      );
    }

    const result = await enqueueLabel(repoId, { force });
    const body: EnqueueLabelResponse = {
      jobId: result.jobId,
      enqueued: result.enqueued,
    };
    return NextResponse.json(body);
  } catch (err) {
    if (isRedisUnavailable(err)) {
      console.error(`POST /api/repos/${repoId}/label — redis unavailable:`, err);
      return errorResponse(
        "The job queue is unavailable — is Redis running?",
        503,
        "queue_unavailable"
      );
    }
    console.error(`POST /api/repos/${repoId}/label failed:`, err);
    return errorResponse(
      err instanceof Error ? err.message : "Failed to enqueue the labeling run.",
      500
    );
  }
}

// ---------------------------------------------------------------------------
// GET — status
// ---------------------------------------------------------------------------

/** Collapses BullMQ's job states onto the five the UI knows about. */
function toLabelState(jobState: string): LabelState {
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

/** `job.progress` is typed `number | object` and is whatever the job last wrote — accept it only when it structurally matches the contract, so a client never sees a half-shaped object. */
function toProgress(raw: unknown): LabelProgress | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<LabelProgress>;
  if (typeof candidate.done !== "number" || typeof candidate.total !== "number") {
    return undefined;
  }
  return {
    phase:
      candidate.phase === "descriptions" || candidate.phase === "saving"
        ? candidate.phase
        : "domains",
    done: candidate.done,
    total: candidate.total,
    calls: candidate.calls ?? 0,
    promptTokens: candidate.promptTokens ?? 0,
    completionTokens: candidate.completionTokens ?? 0,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) {
  const { repoId } = await params;
  const includeLogs = new URL(request.url).searchParams.get("logs") === "1";

  try {
    const repo = await getRepoById(repoId);
    if (!repo) return errorResponse("Repo not found.", 404);

    const [summary, aiConfigured] = await Promise.all([
      getLabelSummary(repoId),
      isAiConfigured(),
    ]);

    let state: LabelState = "none";
    let progress: LabelProgress | undefined;
    let error: string | undefined;
    let cancelRequested = false;
    let finishedAt: string | undefined;
    let warning: string | undefined;

    try {
      const job = await getLabelJob(repoId);
      if (job) {
        state = toLabelState(await job.getState());
        progress = toProgress(job.progress);
        if (state === "failed" && job.failedReason === LABEL_CANCELLED_REASON) {
          state = "cancelled";
        } else if (state === "failed") {
          error = job.failedReason || "The labeling job failed.";
        }
        if (state === "running") cancelRequested = await isLabelCancelRequested(repoId);
        if (job.finishedOn) finishedAt = new Date(job.finishedOn).toISOString();
        if (state === "completed" && job.returnvalue?.keptPreviousDomains) {
          warning =
            summary.domains > 0
              ? "The model's domain grouping couldn't be used, so the existing domains were kept. Try again, or a larger model."
              : "The model's domain grouping couldn't be used. Try again, or a larger model.";
        }
      }
    } catch (queueError) {
      // Redis being down must not hide a domain tier that is already in
      // Neo4j — degrade to "no live job state" and say why, exactly as the
      // review endpoint does.
      if (!isRedisUnavailable(queueError)) throw queueError;
      console.error(`GET /api/repos/${repoId}/label — redis unavailable:`, queueError);
      error = "The job queue is unavailable — live progress could not be read.";
    }

    // A job only lives as long as its retention window, while the domain
    // tier persists indefinitely. Once the job is gone, "this repo has been
    // labeled" is the truthful answer — regressing to `none` would make the
    // UI offer "Generate labels" as if nothing had ever run.
    if (state === "none" && (summary.domains > 0 || summary.describedModules > 0)) {
      state = "completed";
    }

    // Read on demand only (`?logs=1`) — never part of the regular ~1.2s
    // progress poll, since that would spend a Redis round trip on every tick
    // for a hover nobody may ever make. Best-effort: a failure here must not
    // take down a response that otherwise successfully answered the status
    // question.
    let logs: string[] | undefined;
    if (includeLogs) {
      try {
        logs = await getLabelJobLogs(repoId);
      } catch (logError) {
        console.error(`GET /api/repos/${repoId}/label?logs=1 — could not read job logs:`, logError);
        logs = [];
      }
    }

    const body: LabelStatusResponse = {
      state,
      ...(progress ? { progress } : {}),
      ...(error ? { error } : {}),
      ...(cancelRequested ? { cancelRequested } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      ...(warning ? { warning } : {}),
      aiConfigured,
      domains: summary.domains,
      describedModules: summary.describedModules,
      modules: summary.modules,
      ...(logs ? { logs } : {}),
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error(`GET /api/repos/${repoId}/label failed:`, err);
    return errorResponse(
      err instanceof Error ? err.message : "Failed to read the labeling state.",
      500
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE — cancel
// ---------------------------------------------------------------------------

/**
 * Cancels the repo's labeling run. A queued run is removed outright; a
 * running one is stopped by the worker within about a second (its model
 * calls are aborted and nothing is saved), unless it has already reached the
 * short saving phase, which always completes. Nothing to cancel is a 200 with
 * `outcome: "not_running"`, not an error — the run may simply have finished
 * a moment ago.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) {
  const { repoId } = await params;
  try {
    const body: CancelLabelResponse = await cancelLabel(repoId);
    return NextResponse.json(body);
  } catch (err) {
    if (isRedisUnavailable(err)) {
      console.error(`DELETE /api/repos/${repoId}/label — redis unavailable:`, err);
      return errorResponse(
        "The job queue is unavailable — is Redis running?",
        503,
        "queue_unavailable"
      );
    }
    console.error(`DELETE /api/repos/${repoId}/label failed:`, err);
    return errorResponse(
      err instanceof Error ? err.message : "Failed to cancel the labeling run.",
      500
    );
  }
}
