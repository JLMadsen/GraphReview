// The static-analysis queue, shared by route handlers (which enqueue) and
// the workers started from instrumentation.ts (which consume). Jobs live in
// the app's SQLite database (./runner.ts).
//
// Server-only: never import from a client component.

import { Queue, isPendingJobState } from "./runner";
import type { JobState, JobsOptions } from "./runner";

export { isPendingJobState };
export type { JobState };

/** Queue name — must match on both sides (app enqueues, worker consumes). */
export const ANALYSIS_QUEUE_NAME = "analysis";

/** Job name inside the analysis queue. One job type for now (v1 has no AI jobs yet). */
export const ANALYSIS_JOB_NAME = "analyze-repo";

/** Typed payload of an analysis job. Deliberately minimal — everything else is looked up from the database by the worker, so a queued job can never carry a stale copy of the repo record. */
export interface AnalysisJobData {
  repoId: string;
}

/** What a completed analysis job returns, for log visibility and job introspection. */
export interface AnalysisJobResult {
  repoId: string;
  sha: string;
  files: number;
  components: number;
  fileEdges: number;
  componentEdges: number;
  /** Open merge suggestions after this run (DESIGN.md §6.3). */
  openSuggestions?: number;
  durationMs: number;
}

export type AnalysisQueue = Queue<AnalysisJobData, AnalysisJobResult>;

/** Default retry/retention policy for analysis jobs (failures retry, they are not swallowed). */
const ANALYSIS_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 15_000 },
  // Keep a short tail of finished jobs so `getAnalysisJobState` can still
  // report a recent failure as the repo's `error` status (the status
  // indicator) rather than losing it immediately.
  removeOnComplete: { age: 24 * 60 * 60, count: 50 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 50 },
};

let analysisQueueSingleton: AnalysisQueue | undefined;

export function getAnalysisQueue(): AnalysisQueue {
  if (!analysisQueueSingleton) {
    analysisQueueSingleton = new Queue<AnalysisJobData, AnalysisJobResult>(
      ANALYSIS_QUEUE_NAME,
      { defaultJobOptions: ANALYSIS_JOB_OPTIONS }
    );
  }
  return analysisQueueSingleton;
}

/**
 * Deterministic job id per repo — this is what makes enqueueing idempotent:
 * `add()` with a job id that already exists is a no-op, so at most one
 * analysis job per repo can ever be pending at a time.
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
 * loads the actual `Job`, whose `failedReason` carries the thrown
 * error's message. Used to surface *why* a repo's status is `error`
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
 * Enqueues a static-analysis job for a repo, at most once at a time.
 *
 * Job-id dedup covers every job still stored; a *finished* job keeps
 * occupying its id until retention evicts it, and a plain
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
  analysisQueueSingleton = undefined;
}
