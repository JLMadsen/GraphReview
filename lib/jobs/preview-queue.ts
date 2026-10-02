// BullMQ queue for the before/after preview (DESIGN.md §6.9).
//
// One job per (repo, review target, file): pressing "Run" again replaces the
// previous run of that file. `attempts: 1` like every other on-demand queue —
// a run spends a model call and container time, and a retry would only
// repeat whatever went wrong. The result lives in the job's return value
// (Redis), not Neo4j: previews are cheap to redo and go stale with every push.
//
// Server-only: opens a Redis connection (reused from ./queue.ts).

import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import type { Job, JobState, JobsOptions } from "bullmq";
import type { PreviewInputs, PreviewProgress, PreviewResult } from "@/lib/preview/types";
import { getRedisConnection, isPendingJobState } from "./queue";
import { reviewTargetKey, type ReviewTarget } from "./review-queue";

export const PREVIEW_QUEUE_NAME = "preview";
export const PREVIEW_JOB_NAME = "preview-file";

export interface PreviewJobData {
  repoId: string;
  target: ReviewTarget;
  filePath: string;
  /** Inputs the user edited; symbols without an entry still get AI inputs. */
  inputs?: PreviewInputs;
}

export type PreviewJobResult = PreviewResult;
export type PreviewJob = Job<PreviewJobData, PreviewJobResult>;
export type { PreviewProgress };

const PREVIEW_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 24 * 60 * 60, count: 200 },
  removeOnFail: { age: 24 * 60 * 60, count: 200 },
};

let queueSingleton: Queue<PreviewJobData, PreviewJobResult> | undefined;

export function getPreviewQueue(): Queue<PreviewJobData, PreviewJobResult> {
  queueSingleton ??= new Queue<PreviewJobData, PreviewJobResult>(PREVIEW_QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: PREVIEW_JOB_OPTIONS,
  });
  return queueSingleton;
}

/** `preview-<hash>` of repo + target + file — `-`, never `:` (BullMQ rejects it in custom ids). */
export function previewJobId(repoId: string, target: ReviewTarget, filePath: string): string {
  const digest = createHash("sha1").update(`${repoId}|${reviewTargetKey(target)}|${filePath}`).digest("hex").slice(0, 16);
  return `preview-${digest}`;
}

export async function getPreviewJob(repoId: string, target: ReviewTarget, filePath: string): Promise<PreviewJob | undefined> {
  return getPreviewQueue().getJob(previewJobId(repoId, target, filePath));
}

export async function getPreviewJobLogs(repoId: string, target: ReviewTarget, filePath: string): Promise<string[]> {
  const { logs } = await getPreviewQueue().getJobLogs(previewJobId(repoId, target, filePath), -100, -1);
  return logs;
}

/** Enqueues a run unless one for the same file is already pending. */
export async function enqueuePreview(
  data: PreviewJobData
): Promise<{ enqueued: boolean; jobId: string; previousState: JobState | "unknown" }> {
  const queue = getPreviewQueue();
  const jobId = previewJobId(data.repoId, data.target, data.filePath);
  const previousState = await queue.getJobState(jobId);
  if (isPendingJobState(previousState)) return { enqueued: false, jobId, previousState };
  if (previousState !== "unknown") await queue.remove(jobId).catch(() => undefined);
  await queue.add(PREVIEW_JOB_NAME, data, { jobId });
  return { enqueued: true, jobId, previousState };
}

/** Must run before `closeQueues()`, which tears down the shared connections. */
export async function closePreviewQueue(): Promise<void> {
  if (!queueSingleton) return;
  const queue = queueSingleton;
  queueSingleton = undefined;
  await queue.close();
}
