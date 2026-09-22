// BullMQ queue definition for AI-assisted labeling.
//
// Split from `./queue.ts` and `./review-queue.ts` for the same reason those
// two are split from each other: the policies differ. Labeling spends money
// on LLM calls, so like a review it is `attempts: 1` and never retried
// automatically — but unlike a review it is explicitly **on demand**
// (a review's "no confirmation, no cap" follows a diff selection; re-analysis
// is frequent and re-labeling after every one of them would spend tokens
// nobody asked for). Nothing enqueues this except a user pressing "Generate
// labels".
//
// Server-only: opens a Redis connection. Route handlers and `worker/` only.
// The connections themselves are reused from `./queue.ts`.

import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import type { Job, JobState, JobsOptions } from "bullmq";
import { getRedisConnection, isPendingJobState } from "./queue";

/** Queue name — must match on both sides (app enqueues, worker consumes). */
export const LABEL_QUEUE_NAME = "label";

/** Job name inside the label queue. */
export const LABEL_JOB_NAME = "label-repo";

/** Typed payload of a labeling job. Minimal, like every other job here — the repo record, its modules and the AI settings are all looked up fresh by the worker. */
export interface LabelJobData {
  repoId: string;
  /**
   * Overwrite module descriptions that already have text.
   *
   * Off by default: a description is user-editable data, and
   * an automatic pass must never silently replace something a human wrote.
   */
  force?: boolean;
}

/** Which half of the run is in flight (lib/ai/label.ts's two phases). */
export type LabelPhaseName = "domains" | "descriptions";

/**
 * Live progress of a labeling run, reported via `job.updateProgress()` and
 * surfaced verbatim by `GET /api/repos/[repoId]/label`.
 *
 * `calls`/`promptTokens`/`completionTokens` are a running cost counter,
 * the same idea as `ReviewProgress` — visible as it accrues, gating nothing.
 */
export interface LabelProgress {
  phase: LabelPhaseName;
  /** Modules handled so far in the current phase. */
  done: number;
  /** Modules in the current phase in total. */
  total: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

/** What a completed labeling job returns, for `docker logs` visibility and job introspection. */
export interface LabelJobResult {
  repoId: string;
  /** Module-tier components the run considered. */
  modules: number;
  /** Domain-tier components created. */
  domains: number;
  /** Modules whose description was written (skipped ones already had text and `force` was off). */
  describedModules: number;
  /** Domain components removed before the new ones were written — the "replace, don't duplicate" count. */
  replacedDomains: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** At least one model call's output could not be parsed (lib/ai/label.ts). */
  parseFailed: boolean;
  durationMs: number;
}

export type LabelQueue = Queue<LabelJobData, LabelJobResult>;

export type LabelJob = Job<LabelJobData, LabelJobResult>;

/**
 * Retry/retention policy. `attempts: 1` for exactly the reason
 * `review-queue.ts` documents: an automatic retry would silently double a
 * real bill after a transient provider error, and re-running is a deliberate
 * user action. Retention keeps a tail of finished jobs so the GET endpoint
 * can still report a recent `completed`/`failed` and its reason.
 */
const LABEL_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 24 * 60 * 60, count: 50 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 50 },
};

let labelQueueSingleton: LabelQueue | undefined;

export function getLabelQueue(): LabelQueue {
  if (!labelQueueSingleton) {
    labelQueueSingleton = new Queue<LabelJobData, LabelJobResult>(LABEL_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: LABEL_JOB_OPTIONS,
    });
  }
  return labelQueueSingleton;
}

/**
 * Deterministic BullMQ job id — one labeling run per repo at a time.
 *
 * `-` rather than `:` as the separator: BullMQ rejects custom job ids
 * containing `:` ("Custom Id cannot contain :"), which once made every
 * enqueue in this codebase fail silently. Repo ids are
 * UUIDs, but nothing enforces that at the type level, so anything outside
 * `[A-Za-z0-9_-]` is hashed rather than trusted.
 */
export function labelJobId(repoId: string): string {
  const safe = /^[A-Za-z0-9_-]+$/.test(repoId)
    ? repoId
    : createHash("sha1").update(repoId).digest("hex").slice(0, 12);
  return `label-${safe}`;
}

export async function getLabelJob(repoId: string): Promise<LabelJob | undefined> {
  return getLabelQueue().getJob(labelJobId(repoId));
}

export async function getLabelJobState(
  repoId: string
): Promise<JobState | "unknown"> {
  return getLabelQueue().getJobState(labelJobId(repoId));
}

/** How many of the most recent `job.log()` lines to hand back — mirrors `queue.ts`'s analysis equivalent. */
const JOB_LOG_TAIL = 200;

/**
 * The most recent `job.log()` lines the worker wrote for a repo's labeling
 * job, oldest first. Best-effort and read on demand only, backing the "hover
 * the labeling spinner" affordance rather than the regular progress poll.
 */
export async function getLabelJobLogs(repoId: string): Promise<string[]> {
  const { logs } = await getLabelQueue().getJobLogs(
    labelJobId(repoId),
    -JOB_LOG_TAIL,
    -1
  );
  return logs;
}

export interface EnqueueLabelResult {
  /** `false` when a labeling run for this repo was already pending/active — not an error. */
  enqueued: boolean;
  jobId: string;
  /** The job state observed *before* this call. */
  previousState: JobState | "unknown";
}

/**
 * Enqueues a labeling run for a repo, at most once at a time.
 *
 * Same two-step dance as `enqueueAnalysis`/`enqueueReview`: a still-pending
 * job short-circuits (a second run would just duplicate LLM spend), while a
 * *finished* job's id is explicitly removed first — BullMQ would otherwise
 * silently drop the `add()` forever, since a completed job keeps occupying
 * its id until retention evicts it.
 */
export async function enqueueLabel(
  repoId: string,
  options: { force?: boolean } = {}
): Promise<EnqueueLabelResult> {
  const queue = getLabelQueue();
  const jobId = labelJobId(repoId);

  const previousState = await queue.getJobState(jobId);
  if (isPendingJobState(previousState)) {
    return { enqueued: false, jobId, previousState };
  }
  if (previousState !== "unknown") {
    await queue.remove(jobId).catch(() => undefined);
  }

  await queue.add(
    LABEL_JOB_NAME,
    { repoId, ...(options.force ? { force: true } : {}) },
    { jobId }
  );
  return { enqueued: true, jobId, previousState };
}

/**
 * Graceful shutdown for the worker entrypoint and tests. Like
 * `closeReviewQueue`, this must run *before* `closeQueues()`, which tears
 * down the shared Redis connections this queue borrows.
 */
export async function closeLabelQueue(): Promise<void> {
  if (!labelQueueSingleton) return;
  const queue = labelQueueSingleton;
  labelQueueSingleton = undefined;
  await queue.close();
}
