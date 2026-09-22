// BullMQ queue definition for the AI review feature — DESIGN.md §9, §10.
//
// Split from `./queue.ts` (which owns the static-analysis queue) rather than
// merged into it: the two have genuinely different policies — analysis is
// cheap, idempotent and retried three times, while a review job spends money
// on LLM calls and must never be retried automatically.
//
// Server-only: opens a Redis connection. Route handlers and `worker/` only.
//
// The connections themselves are reused from `./queue.ts` — one bounded-retry
// producer connection for the request path, one `maxRetriesPerRequest: null`
// blocking connection for the worker (see the long comments there for why
// those two differ).

import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import type { Job, JobState, JobsOptions } from "bullmq";
import { getRedisConnection, isPendingJobState } from "./queue";

/** Queue name — must match on both sides (app enqueues, worker consumes). */
export const REVIEW_QUEUE_NAME = "review";

/** Job name inside the review queue. */
export const REVIEW_JOB_NAME = "review-target";

/** What a review is about: a GitHub pull request, or an ad-hoc two-ref comparison (decision #4). */
export type ReviewTarget =
  | { kind: "pr"; prNumber: number }
  | { kind: "refs"; baseRef: string; headRef: string };

/** Typed payload of a review job. Minimal on purpose, same as `AnalysisJobData` — everything else (repo record, AI settings, the diff itself) is looked up fresh by the worker, so a queued job can never carry a stale copy. */
export interface ReviewJobData {
  repoId: string;
  target: ReviewTarget;
}

/**
 * Live progress of a running review, reported via `job.updateProgress()` and
 * surfaced verbatim by `GET /api/repos/[repoId]/review`.
 *
 * `calls`/`promptTokens`/`completionTokens` are §10's "running counter for
 * the current review session" — cost is made visible as it accrues rather
 * than gated up front.
 */
export interface ReviewProgress {
  /** Touched components to review. Fixed once the diff has been mapped. */
  total: number;
  /** Components whose findings have been persisted successfully. */
  completed: number;
  /** Components whose model call failed (they still get one `unknown` finding explaining the error). */
  failed: number;
  /** Model calls made so far, including retries inside `lib/ai`. */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Display names of the components currently in flight. */
  running: string[];
  /** Changed paths that matched no `(:File)` node — the graph may need re-analysis. */
  unmatchedFiles: number;
}

/** What a completed review job returns, for `docker logs` visibility and job introspection. */
export interface ReviewJobResult {
  repoId: string;
  targetKey: string;
  /** Components reviewed (= `ReviewProgress.total`). */
  components: number;
  /** Components whose model call failed but did not abort the job. */
  failedComponents: number;
  /** Findings persisted in total across all components. */
  findings: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Findings dropped because their component is no longer touched by this target. */
  prunedFindings: number;
  durationMs: number;
  /** The commits this run reviewed (also stored on each finding — this copy ages out with the job). Absent only if the source couldn't report them. */
  reviewedBaseSha?: string;
  reviewedHeadSha?: string;
  reviewedAt?: string;
}

export type ReviewQueue = Queue<ReviewJobData, ReviewJobResult>;

export type ReviewJob = Job<ReviewJobData, ReviewJobResult>;

/**
 * Retry/retention policy for review jobs.
 *
 * `attempts: 1` is the important one and is deliberate: every attempt issues
 * one LLM call per touched component, so an automatic retry would silently
 * double a real bill after a transient provider error. §10 makes review runs
 * explicit user actions — a re-run is a deliberate POST, never a retry.
 * (Individual *component* failures are already absorbed inside the job
 * itself, so a single bad component never costs the whole run.)
 *
 * Retention mirrors the analysis queue: keep a tail of finished jobs so the
 * GET endpoint can still report a recent `completed`/`failed` state and its
 * `failedReason` instead of falling back to "never reviewed".
 */
const REVIEW_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 24 * 60 * 60, count: 50 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 50 },
};

let reviewQueueSingleton: ReviewQueue | undefined;

export function getReviewQueue(): ReviewQueue {
  if (!reviewQueueSingleton) {
    reviewQueueSingleton = new Queue<ReviewJobData, ReviewJobResult>(
      REVIEW_QUEUE_NAME,
      { connection: getRedisConnection(), defaultJobOptions: REVIEW_JOB_OPTIONS }
    );
  }
  return reviewQueueSingleton;
}

/**
 * The stable identity of "what is being reviewed" — `pr:<number>` or
 * `refs:<baseRef>...<headRef>`. Stored on every `Finding` as `targetKey`
 * (lib/neo4j/types.ts) and used as the lookup key by the GET endpoint, so
 * findings and job state always agree on which review they belong to.
 */
export function reviewTargetKey(target: ReviewTarget): string {
  return target.kind === "pr"
    ? `pr:${target.prNumber}`
    : `refs:${target.baseRef}...${target.headRef}`;
}

/**
 * Deterministic BullMQ job id for a review target — what makes enqueueing
 * idempotent, exactly as `analysisJobId` does for analysis.
 *
 * The target key cannot be embedded literally: BullMQ rejects custom job ids
 * containing `:` (it uses that as a Redis key delimiter), and a ref name can
 * additionally contain `/` and other characters. Hashing sidesteps every one
 * of those — 12 hex characters of SHA-1 is ample given the id is already
 * namespaced by `repoId`, and collisions are only ever *within* one repo's
 * review targets.
 */
export function reviewJobId(repoId: string, targetKey: string): string {
  const digest = createHash("sha1").update(targetKey).digest("hex").slice(0, 12);
  return `review-${repoId}-${digest}`;
}

export async function getReviewJob(
  repoId: string,
  targetKey: string
): Promise<ReviewJob | undefined> {
  return getReviewQueue().getJob(reviewJobId(repoId, targetKey));
}

export async function getReviewJobState(
  repoId: string,
  targetKey: string
): Promise<JobState | "unknown"> {
  return getReviewQueue().getJobState(reviewJobId(repoId, targetKey));
}

/** How many of the most recent `job.log()` lines to hand back — mirrors `queue.ts`'s analysis equivalent. */
const JOB_LOG_TAIL = 200;

/**
 * The most recent `job.log()` lines the worker wrote for a review target,
 * oldest first. Best-effort and read on demand only, backing the "hover the
 * reviewing spinner" affordance rather than the regular progress poll.
 */
export async function getReviewJobLogs(
  repoId: string,
  targetKey: string
): Promise<string[]> {
  const { logs } = await getReviewQueue().getJobLogs(
    reviewJobId(repoId, targetKey),
    -JOB_LOG_TAIL,
    -1
  );
  return logs;
}

export interface EnqueueReviewResult {
  /** `false` when a job for this exact target was already pending/active — not an error. */
  enqueued: boolean;
  jobId: string;
  targetKey: string;
  /** The job state observed *before* this call. */
  previousState: JobState | "unknown";
}

/**
 * Enqueues a review of one target, at most once at a time.
 *
 * Same two-step dance as `enqueueAnalysis`: a still-pending job short-
 * circuits (re-running while the first run is in flight would just duplicate
 * LLM spend), while a *finished* job's id is explicitly removed first —
 * BullMQ would otherwise silently drop the `add()` forever, since a completed
 * job keeps occupying its id until retention evicts it. Removing it is also
 * what makes a re-run a real re-run: §10's overwrite-only findings are
 * rewritten by the job itself, not by anything here.
 */
export async function enqueueReview(
  repoId: string,
  target: ReviewTarget
): Promise<EnqueueReviewResult> {
  const queue = getReviewQueue();
  const targetKey = reviewTargetKey(target);
  const jobId = reviewJobId(repoId, targetKey);

  const previousState = await queue.getJobState(jobId);
  if (isPendingJobState(previousState)) {
    return { enqueued: false, jobId, targetKey, previousState };
  }
  if (previousState !== "unknown") {
    await queue.remove(jobId).catch(() => undefined);
  }

  await queue.add(REVIEW_JOB_NAME, { repoId, target }, { jobId });
  return { enqueued: true, jobId, targetKey, previousState };
}

/**
 * Graceful shutdown for the worker entrypoint and tests.
 *
 * Kept separate from `closeQueues()` in ./queue.ts, which also tears down
 * the shared Redis connections this queue borrows — so callers must close
 * this queue *first*. `worker/index.ts` does exactly that.
 */
export async function closeReviewQueue(): Promise<void> {
  if (!reviewQueueSingleton) return;
  const queue = reviewQueueSingleton;
  reviewQueueSingleton = undefined;
  await queue.close();
}
