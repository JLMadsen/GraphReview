// Queue for comparing a review target's base and head graphs
// (./target-graph.ts): the structure change (new import cycles, new and
// removed dependencies, orphaned files, dependents) and the call graph of
// the functions it touches.
//
// Static analysis only — no model, no Docker — so it runs whenever a target
// is opened, like the preview scan: reading the result (re)starts it when
// there is none, it failed, or it is older than {@link FRESH_MS}. The result
// is stored in `target_graphs` (lib/db) so it outlives the job record.
//
// Server-only.

import { createHash } from "node:crypto";
import type { CallGraph, StructureChange } from "@/lib/analysis";
import { Queue, type Job, type JobsOptions } from "./runner";
import { isPendingJobState } from "./queue";
import { reviewTargetKey, type ReviewTarget } from "./review-queue";

export const TARGET_GRAPH_QUEUE_NAME = "target-graph";
export const TARGET_GRAPH_JOB_NAME = "compare-target";

/** A comparison older than this is redone on the next read, so a pushed PR is picked up. */
const FRESH_MS = 5 * 60_000;

export interface TargetGraphJobData {
  repoId: string;
  target: ReviewTarget;
}

/** A component-level dependency the change adds or removes, with the file imports behind it. */
export interface ComponentDependencyChange {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  files: Array<{ from: string; to: string }>;
}

/** What `target_graphs.data` holds for one target. */
export interface TargetGraphData {
  structure: StructureChange & {
    components: { added: ComponentDependencyChange[]; removed: ComponentDependencyChange[] };
    /** Components with a file that depends on what changed (dependents' owners). */
    dependentComponents: number;
  };
  callGraph: CallGraph;
  /** Owning component of each file the call graph and the edge changes mention. */
  fileComponents: Record<string, { id: string; name: string }>;
  stats: {
    baseFiles: number;
    headFiles: number;
    /** Files whose parse came from the cache, of both sides. */
    cached: number;
    skipped: { binary: number; large: number; failed: number };
    durationMs: number;
  };
}

export interface TargetGraphJobResult {
  baseSha: string;
  headSha: string;
  cycles: number;
  functions: number;
}

export type TargetGraphJob = Job<TargetGraphJobData, TargetGraphJobResult>;

const JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 24 * 3600, count: 200 },
  removeOnFail: { age: 24 * 3600, count: 200 },
};

let queueSingleton: Queue<TargetGraphJobData, TargetGraphJobResult> | undefined;

export function getTargetGraphQueue(): Queue<TargetGraphJobData, TargetGraphJobResult> {
  queueSingleton ??= new Queue<TargetGraphJobData, TargetGraphJobResult>(TARGET_GRAPH_QUEUE_NAME, {
    defaultJobOptions: JOB_OPTIONS,
  });
  return queueSingleton;
}

export function targetGraphJobId(repoId: string, target: ReviewTarget): string {
  const digest = createHash("sha1").update(`${repoId}|${reviewTargetKey(target)}`).digest("hex").slice(0, 16);
  return `target-graph-${digest}`;
}

/** The target's comparison job, (re)started when there is none, it failed, or it went stale. */
export async function ensureTargetGraph(repoId: string, target: ReviewTarget): Promise<TargetGraphJob> {
  const queue = getTargetGraphQueue();
  const jobId = targetGraphJobId(repoId, target);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    const fresh = state === "completed" && Date.now() - (existing.finishedOn ?? 0) < FRESH_MS;
    if (fresh || isPendingJobState(state)) return existing;
    await queue.remove(jobId).catch(() => undefined);
  }
  return queue.add(TARGET_GRAPH_JOB_NAME, { repoId, target }, { jobId });
}

export async function getTargetGraphJob(repoId: string, target: ReviewTarget): Promise<TargetGraphJob | undefined> {
  return getTargetGraphQueue().getJob(targetGraphJobId(repoId, target));
}

export async function closeTargetGraphQueue(): Promise<void> {
  if (!queueSingleton) return;
  const queue = queueSingleton;
  queueSingleton = undefined;
  await queue.close();
}
