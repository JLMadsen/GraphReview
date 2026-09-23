// The AI review endpoint.
//
//   POST /api/repos/[repoId]/review   enqueue a review of a PR or a ref pair
//   GET  /api/repos/[repoId]/review   job state + progress + findings so far
//
// The GET is intentionally poll-shaped rather than a one-shot result: the review
// runs one LLM call per touched component and persists each component's
// findings the moment it completes, so repeatedly reading this endpoint is
// how findings stream into the graph UI while the job is still running.
//
// This route never talks to the AI provider or GitHub itself — all of that
// happens in the worker (`lib/jobs/review.ts`). It only validates, checks
// that a review *could* succeed, enqueues, and reads back.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  checkReviewFreshness,
  enqueueReview,
  getReviewJob,
  getReviewJobLogs,
  invalidateReviewFreshness,
  reviewTargetKey,
  type ReviewFreshness,
  type ReviewProgress,
  type ReviewTarget,
} from "@/lib/jobs";
import { DEFAULT_REVIEW_EFFORT, isReviewEffort } from "@/lib/ai/effort";
import {
  getActiveAiProvider,
  getRepoById,
  listFindingsByTargetKey,
  type FindingIntentMatch,
} from "@/lib/neo4j";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Response contract
// ---------------------------------------------------------------------------

/** One persisted `(:Finding)`, flattened for the graph UI. Deliberately *not* the raw `FindingRecord`: `repoId`/`targetKey`/`prId` are request context the client already has, while `componentName` (joined from the component node) is what a finding list actually renders. */
export interface FindingDto {
  id: string;
  componentId: string;
  componentName: string;
  filePath?: string;
  lineRange?: string;
  summary: string;
  intentMatch: FindingIntentMatch;
  confidence: number;
  rationale: string;
  model: string;
  createdAt: string;
  /** ISO-8601 time a reviewer resolved this finding; absent while open. */
  resolvedAt?: string;
}

/** Lifecycle of a review target, collapsed from BullMQ's finer-grained job states. `"none"` means "never reviewed". */
export type ReviewState = "none" | "queued" | "running" | "completed" | "failed";

export interface ReviewStatusResponse {
  targetKey: string;
  state: ReviewState;
  progress?: ReviewProgress;
  /** The failed job's `failedReason`, when `state === "failed"`. */
  error?: string;
  findings: FindingDto[];
  /**
   * Whether the reviewed code has moved since the review ran (stale-review
   * detection). Purely additive and advisory:
   *   - present only when `state` is `completed` and the persisted findings
   *     carry the shas they were produced from — absent for legacy findings,
   *     for `queued`/`running`/`failed`, and when there are no findings;
   *   - a failed check (branch deleted, GitHub down, no PAT, …) comes back as
   *     `{ stale: false, currentHeadSha: "", checkError }`, never as an error
   *     status on this endpoint.
   */
  freshness?: ReviewFreshness;
  /** Whether all three AI provider settings are present — lets the UI decide whether auto-running a review can work at all (no cost gate, but no point firing into an unconfigured provider either). */
  aiConfigured: boolean;
  /** Recent `job.log()` lines from the worker, oldest first — present only for `?logs=1` (the dock's hover-to-see-progress affordance). */
  logs?: string[];
}

export interface EnqueueReviewResponse {
  jobId: string;
  targetKey: string;
  /** `false` when a review of this exact target was already queued or running — the existing job stands. */
  enqueued: boolean;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

const targetSchema = z.union([
  z.object({ prNumber: z.number().int().positive() }),
  z.object({ baseRef: z.string().min(1), headRef: z.string().min(1) }),
]);

function toTarget(parsed: z.infer<typeof targetSchema>): ReviewTarget {
  return "prNumber" in parsed
    ? { kind: "pr", prNumber: parsed.prNumber }
    : { kind: "refs", baseRef: parsed.baseRef, headRef: parsed.headRef };
}

/** Parses a target out of GET query params (`?prNumber=` or `?baseRef=&headRef=`). Returns `null` when neither shape is present/valid. */
function targetFromSearchParams(params: URLSearchParams): ReviewTarget | null {
  const prNumberRaw = params.get("prNumber");
  if (prNumberRaw !== null) {
    const prNumber = Number(prNumberRaw);
    if (!Number.isInteger(prNumber) || prNumber <= 0) return null;
    return { kind: "pr", prNumber };
  }
  const baseRef = params.get("baseRef")?.trim();
  const headRef = params.get("headRef")?.trim();
  if (baseRef && headRef) return { kind: "refs", baseRef, headRef };
  return null;
}

function errorResponse(
  error: string,
  status: number,
  code?: string
): NextResponse {
  return NextResponse.json(code ? { error, code } : { error }, { status });
}

/**
 * Whether the failure looks like "Redis is unreachable" rather than a real
 * application error.
 *
 * The producer connection is configured with a *bounded* retry
 * (`maxRetriesPerRequest: 3`, see lib/jobs/queue.ts) precisely so a request
 * made while Redis is down rejects in a few seconds instead of hanging a
 * route handler forever — this turns that rejection into a 503 rather than
 * a misleading 500.
 */
function isRedisUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|max retries per request|Connection is closed|Stream isn't writeable|Redis/i.test(
    message
  );
}

/** The active saved provider must have all three fields present for a review to be possible (base URL + key + model are one unit). */
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

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse("Invalid JSON body.", 400);
  }

  const parsed = targetSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse("Body must be { prNumber } or { baseRef, headRef }.", 400);
  }
  const target = toTarget(parsed.data);

  // Optional; anything other than a known level is a client bug worth a 400
  // rather than silently reviewing at a different cost than was asked for.
  const rawEffort = (rawBody as { effort?: unknown }).effort;
  if (rawEffort !== undefined && !isReviewEffort(rawEffort)) {
    return errorResponse("effort must be one of low, medium, high, max.", 400);
  }
  const effort = rawEffort ?? DEFAULT_REVIEW_EFFORT;

  try {
    const repo = await getRepoById(repoId);
    if (!repo) return errorResponse("Repo not found.", 404);

    // Checked before enqueueing on purpose: a job that can only ever fail
    // on its first line is worse than a straight 400, because with
    // `attempts: 1` it also burns the target's job id until it's evicted.
    if (!(await isAiConfigured())) {
      return errorResponse(
        "AI provider is not configured — set the base URL, API key and model in Settings.",
        400,
        "ai_not_configured"
      );
    }

    // A PR/MR only exists on the GitHub or GitLab side; a local-only repo
    // has no PRs to review, however valid the number looks.
    if (target.kind === "pr" && ((repo.provider !== "github" && repo.provider !== "gitlab") || !repo.url)) {
      return errorResponse(
        "This repo is not linked to a supported git host, so it has no pull/merge requests to review — compare two refs instead.",
        400,
        "not_linked"
      );
    }

    const result = await enqueueReview(repoId, target, effort);
    // A new run is about to stamp new shas on the findings; whatever "where
    // does the branch point" answer is cached must not be compared to them.
    invalidateReviewFreshness(repoId, result.targetKey);
    const body: EnqueueReviewResponse = {
      jobId: result.jobId,
      targetKey: result.targetKey,
      enqueued: result.enqueued,
    };
    return NextResponse.json(body);
  } catch (err) {
    if (isRedisUnavailable(err)) {
      console.error(`POST /api/repos/${repoId}/review — redis unavailable:`, err);
      return errorResponse(
        "The job queue is unavailable — is Redis running?",
        503,
        "queue_unavailable"
      );
    }
    console.error(`POST /api/repos/${repoId}/review failed:`, err);
    return errorResponse(
      err instanceof Error ? err.message : "Failed to enqueue the review.",
      500
    );
  }
}

// ---------------------------------------------------------------------------
// GET — status + findings
// ---------------------------------------------------------------------------

/** Collapses BullMQ's job states onto the five the UI knows about. */
function toReviewState(jobState: string): ReviewState {
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

/** BullMQ's `job.progress` is typed as `number | object` and is whatever the job last wrote. Accept it only when it structurally matches the progress contract, so a client never sees a half-shaped object. */
function toProgress(raw: unknown): ReviewProgress | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<ReviewProgress>;
  if (
    typeof candidate.total !== "number" ||
    typeof candidate.completed !== "number" ||
    typeof candidate.failed !== "number"
  ) {
    return undefined;
  }
  return {
    total: candidate.total,
    completed: candidate.completed,
    failed: candidate.failed,
    calls: candidate.calls ?? 0,
    promptTokens: candidate.promptTokens ?? 0,
    completionTokens: candidate.completionTokens ?? 0,
    running: Array.isArray(candidate.running) ? candidate.running : [],
    unmatchedFiles: candidate.unmatchedFiles ?? 0,
  };
}

/**
 * The revision the persisted findings were produced from: the most recent
 * stamped run. Legacy findings (no `reviewedHeadSha`) are ignored, so a target
 * with only legacy findings yields `undefined` and gets no `freshness` at all.
 * Mixed shas can only exist after a run that failed part-way; the newest
 * stamp wins, since that is the run whose findings are on screen.
 */
function latestReviewedRevision(
  findings: readonly { reviewedHeadSha?: string; reviewedBaseSha?: string; reviewedAt?: string }[]
): { headSha: string; baseSha?: string; reviewedAt?: string } | undefined {
  let best: (typeof findings)[number] | undefined;
  for (const finding of findings) {
    if (!finding.reviewedHeadSha) continue;
    if (!best || (finding.reviewedAt ?? "") > (best.reviewedAt ?? "")) best = finding;
  }
  if (!best?.reviewedHeadSha) return undefined;
  return {
    headSha: best.reviewedHeadSha,
    ...(best.reviewedBaseSha ? { baseSha: best.reviewedBaseSha } : {}),
    ...(best.reviewedAt ? { reviewedAt: best.reviewedAt } : {}),
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) {
  const { repoId } = await params;
  const searchParams = new URL(request.url).searchParams;
  const target = targetFromSearchParams(searchParams);
  if (!target) {
    return errorResponse(
      "Query must be ?prNumber=N or ?baseRef=X&headRef=Y.",
      400
    );
  }
  const targetKey = reviewTargetKey(target);
  const includeLogs = searchParams.get("logs") === "1";

  try {
    const repo = await getRepoById(repoId);
    if (!repo) return errorResponse("Repo not found.", 404);

    const [findingRecords, aiConfigured] = await Promise.all([
      listFindingsByTargetKey(repoId, targetKey),
      isAiConfigured(),
    ]);

    let state: ReviewState = "none";
    let progress: ReviewProgress | undefined;
    let error: string | undefined;

    try {
      const job = await getReviewJob(repoId, targetKey);
      if (job) {
        state = toReviewState(await job.getState());
        progress = toProgress(job.progress);
        if (state === "failed") error = job.failedReason || "The review job failed.";
      }
    } catch (queueError) {
      // Redis being down must not hide findings that are already in Neo4j —
      // degrade to "no live job state" and say why, rather than 5xx-ing a
      // read that can still answer most of the question.
      if (!isRedisUnavailable(queueError)) throw queueError;
      console.error(`GET /api/repos/${repoId}/review — redis unavailable:`, queueError);
      error = "The job queue is unavailable — live progress could not be read.";
    }

    // A job only lives as long as its retention window (24h for a completed
    // one, lib/jobs/review-queue.ts), while findings persist indefinitely.
    // Once the job is gone, "there are findings" is the truthful answer, so
    // don't regress an old review to `none` — which the UI reads as "never
    // reviewed" and would auto-run again.
    if (state === "none" && findingRecords.length > 0) state = "completed";

    // Stale-review detection. Never while a run is queued/running (the UI
    // polls every ~1.2s then, and the answer would be about to change anyway)
    // and never for a failed one. The check itself cannot throw.
    let freshness: ReviewFreshness | undefined;
    if (state === "queued" || state === "running") {
      invalidateReviewFreshness(repoId, targetKey);
    } else if (state === "completed") {
      const reviewed = latestReviewedRevision(findingRecords);
      if (reviewed) freshness = await checkReviewFreshness(repo, target, targetKey, reviewed);
    }

    // Read on demand only (`?logs=1`) — never part of the regular ~1.2s
    // progress poll. Best-effort: a failure here must not take down a
    // response that otherwise successfully answered the status question.
    let logs: string[] | undefined;
    if (includeLogs) {
      try {
        logs = await getReviewJobLogs(repoId, targetKey);
      } catch (logError) {
        console.error(`GET /api/repos/${repoId}/review?logs=1 — could not read job logs:`, logError);
        logs = [];
      }
    }

    const body: ReviewStatusResponse = {
      targetKey,
      state,
      ...(progress ? { progress } : {}),
      ...(error ? { error } : {}),
      ...(freshness ? { freshness } : {}),
      ...(logs ? { logs } : {}),
      findings: findingRecords.map((finding) => ({
        id: finding.id,
        componentId: finding.componentId,
        componentName: finding.componentName,
        ...(finding.filePath ? { filePath: finding.filePath } : {}),
        ...(finding.lineRange ? { lineRange: finding.lineRange } : {}),
        summary: finding.summary,
        intentMatch: finding.intentMatch,
        confidence: finding.confidence,
        rationale: finding.rationale,
        model: finding.model,
        createdAt: finding.createdAt,
        ...(finding.resolvedAt ? { resolvedAt: finding.resolvedAt } : {}),
      })),
      aiConfigured,
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error(`GET /api/repos/${repoId}/review failed:`, err);
    return errorResponse(
      err instanceof Error ? err.message : "Failed to read the review.",
      500
    );
  }
}
