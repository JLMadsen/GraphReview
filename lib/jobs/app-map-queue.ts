// BullMQ queue for the app map's AI runs (DESIGN.md §6.5).
//
// Same policy as the label queue (./label-queue.ts), for the same reasons:
// a run spends model calls, so it is `attempts: 1` and never retried, and it
// is strictly on demand — nothing enqueues it except someone pressing
// "Explain with AI" on the App map. One run per repo at a time (whatever the
// level), cancellable cooperatively through a Redis flag the worker polls.
//
// Server-only: opens a Redis connection. The connections are reused from
// ./queue.ts.

import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import type { Job, JobState, JobsOptions } from "bullmq";
import type { AppMapLevel, AppMapPhaseDTO } from "@/components/graph/app-map-types";
import { getRedisConnection, isPendingJobState } from "./queue";

export const APP_MAP_QUEUE_NAME = "app-map";
export const APP_MAP_JOB_NAME = "app-map-repo";
export const APP_MAP_CANCELLED_REASON = "Cancelled by user.";

export interface AppMapJobData {
  repoId: string;
  level: AppMapLevel;
}

export interface AppMapProgress {
  level: AppMapLevel;
  phase: AppMapPhaseDTO;
  done: number;
  total: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface AppMapJobResult {
  repoId: string;
  level: AppMapLevel;
  cards: number;
  explained: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  parseFailed: boolean;
  durationMs: number;
}

export type AppMapJob = Job<AppMapJobData, AppMapJobResult>;
type AppMapQueue = Queue<AppMapJobData, AppMapJobResult>;

const APP_MAP_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 24 * 60 * 60, count: 50 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 50 },
};

let queueSingleton: AppMapQueue | undefined;

export function getAppMapQueue(): AppMapQueue {
  queueSingleton ??= new Queue<AppMapJobData, AppMapJobResult>(APP_MAP_QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: APP_MAP_JOB_OPTIONS,
  });
  return queueSingleton;
}

/** `appmap-<repoId>` — `-`, never `:` (BullMQ rejects it in custom ids). */
export function appMapJobId(repoId: string): string {
  const safe = /^[A-Za-z0-9_-]+$/.test(repoId)
    ? repoId
    : createHash("sha1").update(repoId).digest("hex").slice(0, 12);
  return `appmap-${safe}`;
}

export async function getAppMapJob(repoId: string): Promise<AppMapJob | undefined> {
  return getAppMapQueue().getJob(appMapJobId(repoId));
}

export async function getAppMapJobLogs(repoId: string): Promise<string[]> {
  const { logs } = await getAppMapQueue().getJobLogs(appMapJobId(repoId), -200, -1);
  return logs;
}

function cancelKey(repoId: string): string {
  return `graphreview:${appMapJobId(repoId)}:cancel`;
}

export async function cancelAppMap(
  repoId: string
): Promise<{ outcome: "removed" | "requested" | "not_running" }> {
  const queue = getAppMapQueue();
  const jobId = appMapJobId(repoId);
  const state = await queue.getJobState(jobId);
  const flag = () => getRedisConnection().set(cancelKey(repoId), "1", "EX", 60 * 60);
  if (state === "active") {
    await flag();
    return { outcome: "requested" };
  }
  if (isPendingJobState(state)) {
    try {
      await queue.remove(jobId);
      return { outcome: "removed" };
    } catch {
      await flag();
      return { outcome: "requested" };
    }
  }
  return { outcome: "not_running" };
}

export async function isAppMapCancelRequested(repoId: string): Promise<boolean> {
  return (await getRedisConnection().exists(cancelKey(repoId))) === 1;
}

export async function clearAppMapCancel(repoId: string): Promise<void> {
  await getRedisConnection().del(cancelKey(repoId));
}

/** Enqueues a run unless one is already pending (then `enqueued: false`). See `enqueueLabel` for the remove-first dance. */
export async function enqueueAppMap(
  repoId: string,
  level: AppMapLevel
): Promise<{ enqueued: boolean; jobId: string; previousState: JobState | "unknown" }> {
  const queue = getAppMapQueue();
  const jobId = appMapJobId(repoId);
  const previousState = await queue.getJobState(jobId);
  if (isPendingJobState(previousState)) return { enqueued: false, jobId, previousState };
  if (previousState !== "unknown") await queue.remove(jobId).catch(() => undefined);
  await clearAppMapCancel(repoId);
  await queue.add(APP_MAP_JOB_NAME, { repoId, level }, { jobId });
  return { enqueued: true, jobId, previousState };
}

/** Must run before `closeQueues()`, which tears down the shared connections. */
export async function closeAppMapQueue(): Promise<void> {
  if (!queueSingleton) return;
  const queue = queueSingleton;
  queueSingleton = undefined;
  await queue.close();
}
