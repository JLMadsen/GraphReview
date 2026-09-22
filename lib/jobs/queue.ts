// BullMQ queue definitions shared by the `app` (producer) and `worker`
// (consumer) processes — DESIGN.md §3, §12.
//
// Server-only: this reads `REDIS_URL` and opens a Redis connection, so it
// must never be imported from a client component. Route handlers, server
// components and `worker/` are the only intended callers.

import { Queue } from "bullmq";
import type { JobState, JobsOptions } from "bullmq";
import { Redis } from "ioredis";

/** Queue name — must match on both sides (app enqueues, worker consumes). */
export const ANALYSIS_QUEUE_NAME = "analysis";

/** Job name inside the analysis queue. One job type for now (§15: v1 has no AI jobs yet). */
export const ANALYSIS_JOB_NAME = "analyze-repo";

/** Typed payload of an analysis job. Deliberately minimal — everything else is looked up from Neo4j by the worker, so a queued job can never carry a stale copy of the repo record. */
export interface AnalysisJobData {
  repoId: string;
}

/** What a completed analysis job returns, for `docker logs` visibility and job introspection. */
export interface AnalysisJobResult {
  repoId: string;
  sha: string;
  files: number;
  components: number;
  fileEdges: number;
  componentEdges: number;
  durationMs: number;
}

export type AnalysisQueue = Queue<AnalysisJobData, AnalysisJobResult>;

/**
 * Job states in which a job is still going to run (or is running). Used for
 * the idempotent-enqueue check below: re-enqueueing while one of these holds
 * would be pointless duplicate work.
 */
const PENDING_STATES: ReadonlySet<string> = new Set<JobState>([
  "waiting",
  "waiting-children",
  "active",
  "delayed",
  "prioritized",
]);

export function isPendingJobState(state: JobState | "unknown"): boolean {
  return PENDING_STATES.has(state);
}

/** Default retry/retention policy for analysis jobs (§10: failures retry, they are not swallowed). */
const ANALYSIS_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 15_000 },
  // Keep a short tail of finished jobs so `getAnalysisJobState` can still
  // report a recent failure as the repo's `error` status (§4's status
  // indicator) rather than losing it immediately.
  removeOnComplete: { age: 24 * 60 * 60, count: 50 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 50 },
};

function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "Missing required environment variable: REDIS_URL. See docker/.env.example."
    );
  }
  return url;
}

let connectionSingleton: Redis | undefined;
let blockingConnectionSingleton: Redis | undefined;

/**
 * Connection for *producing* — enqueueing and reading job state from route
 * handlers and server components.
 *
 * `maxRetriesPerRequest` is deliberately finite here. BullMQ's own advice
 * (`null`) applies to the worker's blocking commands; on the request path it
 * would mean a command issued while Redis is down never settles, which would
 * hang a page render forever instead of degrading to "status unknown". With
 * a bounded retry the command rejects after a few seconds and the callers in
 * repo-status.ts/staleness.ts fall back gracefully.
 */
export function getRedisConnection(): Redis {
  if (!connectionSingleton) {
    connectionSingleton = new Redis(redisUrl(), {
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      connectTimeout: 5_000,
      retryStrategy: (times) => Math.min(times * 500, 2_000),
    });
    // ioredis emits `error` on every failed reconnect; without a listener
    // Node treats it as an unhandled 'error' event and kills the process.
    connectionSingleton.on("error", (error: Error) => {
      console.error(`[jobs] redis connection error: ${error.message}`);
    });
  }
  return connectionSingleton;
}

/**
 * Connection for the worker's *blocking* commands. BullMQ requires
 * `maxRetriesPerRequest: null` on these (it throws otherwise) — a blocking
 * `BZPOPMIN` that gave up after N retries would silently stop the worker
 * from picking up jobs.
 */
export function getBlockingRedisConnection(): Redis {
  if (!blockingConnectionSingleton) {
    blockingConnectionSingleton = new Redis(redisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    blockingConnectionSingleton.on("error", (error: Error) => {
      console.error(`[jobs] redis (blocking) connection error: ${error.message}`);
    });
  }
  return blockingConnectionSingleton;
}

let analysisQueueSingleton: AnalysisQueue | undefined;

export function getAnalysisQueue(): AnalysisQueue {
  if (!analysisQueueSingleton) {
    analysisQueueSingleton = new Queue<AnalysisJobData, AnalysisJobResult>(
      ANALYSIS_QUEUE_NAME,
      { connection: getRedisConnection(), defaultJobOptions: ANALYSIS_JOB_OPTIONS }
    );
  }
  return analysisQueueSingleton;
}

/**
 * Deterministic job id per repo — this is what makes enqueueing idempotent:
 * BullMQ silently ignores an `add()` for a job id that already exists, so at
 * most one analysis job per repo can ever be pending at a time.
 *
 * Uses `-` rather than `:` as the separator: BullMQ uses `:` internally as
 * a Redis key delimiter and rejects custom job ids that contain one
 * ("Custom Id cannot contain :"), which previously made every enqueue fail.
 */
export function analysisJobId(repoId: string): string {
  return `analysis-${repoId}`;
}

export async function getAnalysisJobState(
  repoId: string
): Promise<JobState | "unknown"> {
  return getAnalysisQueue().getJobState(analysisJobId(repoId));
}

/**
 * The reason the most recent analysis job for a repo failed, if any.
 *
 * `getAnalysisJobState` only returns a bare state string — this instead
 * loads the actual BullMQ `Job`, whose `failedReason` carries the thrown
 * error's message. Used to surface *why* a repo's status is `error` (§4)
 * instead of just that it is.
 */
export async function getAnalysisJobFailure(
  repoId: string
): Promise<string | undefined> {
  const job = await getAnalysisQueue().getJob(analysisJobId(repoId));
  return job?.failedReason;
}

/** How many of the most recent `job.log()` lines to hand back — enough to show a run's shape without an unbounded fetch. */
const JOB_LOG_TAIL = 200;

/**
 * The most recent `job.log()` lines the worker wrote for a repo's analysis
 * job, oldest first. Best-effort and read on demand only (never part of the
 * regular status poll) — it backs the "hover the analyzing spinner to see
 * what's happening" affordance, not anything that gates behaviour. Empty
 * when there is no job, or once its retention window has evicted it.
 */
export async function getAnalysisJobLogs(repoId: string): Promise<string[]> {
  const { logs } = await getAnalysisQueue().getJobLogs(
    analysisJobId(repoId),
    -JOB_LOG_TAIL,
    -1
  );
  return logs;
}

export interface EnqueueAnalysisResult {
  /** `false` when a job for this repo was already pending/active — not an error. */
  enqueued: boolean;
  jobId: string;
  /** The job state observed *before* this call. */
  previousState: JobState | "unknown";
}

/**
 * Enqueues a static-analysis job for a repo, at most once at a time (§10).
 *
 * BullMQ's job-id dedup only covers jobs that still exist in Redis; a
 * *finished* job keeps occupying its id until it is evicted, and a plain
 * `add()` with that id would be silently dropped forever. So a finished job
 * with our deterministic id is explicitly removed first, while a job that is
 * still pending/active short-circuits with `enqueued: false`.
 */
export async function enqueueAnalysis(
  repoId: string
): Promise<EnqueueAnalysisResult> {
  const queue = getAnalysisQueue();
  const jobId = analysisJobId(repoId);

  const previousState = await queue.getJobState(jobId);
  if (isPendingJobState(previousState)) {
    return { enqueued: false, jobId, previousState };
  }
  if (previousState !== "unknown") {
    // Completed or failed: free the id so the re-run can reuse it. A benign
    // race with another caller doing the same ends with one `add()` winning
    // and the other being deduped — which is exactly the desired outcome.
    await queue.remove(jobId).catch(() => undefined);
  }

  await queue.add(ANALYSIS_JOB_NAME, { repoId }, { jobId });
  return { enqueued: true, jobId, previousState };
}

/** Graceful shutdown for the worker entrypoint and tests. */
export async function closeQueues(): Promise<void> {
  if (analysisQueueSingleton) {
    const queue = analysisQueueSingleton;
    analysisQueueSingleton = undefined;
    await queue.close();
  }
  for (const connection of [connectionSingleton, blockingConnectionSingleton]) {
    if (!connection) continue;
    await connection.quit().catch(() => connection.disconnect());
  }
  connectionSingleton = undefined;
  blockingConnectionSingleton = undefined;
}
