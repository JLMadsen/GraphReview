// A small persistent job queue, stored in the app's SQLite database.
//
// It replaces BullMQ + Redis with the slice of their API this app uses, so
// the queue modules and job bodies kept their shape: `Queue` (add, getJob,
// getJobState, getJobLogs, remove), `Worker` (a processor with a
// concurrency limit and `completed`/`failed` events), `Job` (data,
// progress, logs, return value) and `UnrecoverableError`.
//
// Everything runs in the one GraphReview process: route handlers enqueue,
// and the workers started from instrumentation.ts pick jobs up. Jobs are
// rows, so a queued job survives a restart. A job that was *running* when
// the app stopped is re-queued if it has retries left (analysis), and
// otherwise marked failed as interrupted (AI jobs never retry on their own,
// since that would silently repeat model spend) — see `recoverInterruptedJobs`.
//
// Server-only.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { all, get, run, transaction } from "@/lib/db/client";

export type JobState = "waiting" | "active" | "delayed" | "completed" | "failed";

export interface BackoffOptions {
  type: "exponential" | "fixed";
  /** Milliseconds; doubled per retry for `exponential`. */
  delay: number;
}

/** How long finished jobs are kept: `age` in seconds, `count` newest. */
export interface KeepJobs {
  age?: number;
  count?: number;
}

export interface JobsOptions {
  jobId?: string;
  attempts?: number;
  backoff?: BackoffOptions;
  removeOnComplete?: KeepJobs;
  removeOnFail?: KeepJobs;
}

/** Thrown by a job body to fail at once, skipping any remaining attempts. */
export class UnrecoverableError extends Error {
  override readonly name = "UnrecoverableError";
}

interface JobRow {
  queue: string;
  id: string;
  name: string;
  data: string;
  opts: string;
  state: JobState;
  progress: string | null;
  returnvalue: string | null;
  failed_reason: string | null;
  attempts_made: number;
  created_at: number;
  processed_on: number | null;
  finished_on: number | null;
}

// Route handlers, server components and instrumentation are separate
// bundles in Next.js; the wake-up channel has to be shared across them.
const EMITTER_KEY = Symbol.for("graphreview.jobs.emitter");
function bus(): EventEmitter {
  const g = globalThis as typeof globalThis & { [EMITTER_KEY]?: EventEmitter };
  g[EMITTER_KEY] ??= new EventEmitter().setMaxListeners(100);
  return g[EMITTER_KEY];
}

function parse<T>(value: string | null): T | undefined {
  return value == null ? undefined : (JSON.parse(value) as T);
}

function readRow(queue: string, id: string): JobRow | undefined {
  return get<JobRow>(`SELECT * FROM jobs WHERE queue = ? AND id = ?`, queue, id);
}

/** A snapshot of one job, with the methods a job body uses while it runs. */
export class Job<D = unknown, R = unknown> {
  readonly queueName: string;
  readonly id: string;
  readonly name: string;
  readonly data: D;
  readonly opts: JobsOptions;
  progress: unknown;
  returnvalue: R | undefined;
  failedReason: string | undefined;
  attemptsMade: number;
  readonly timestamp: number;
  processedOn: number | undefined;
  finishedOn: number | undefined;

  constructor(row: JobRow) {
    this.queueName = row.queue;
    this.id = row.id;
    this.name = row.name;
    this.data = JSON.parse(row.data) as D;
    this.opts = JSON.parse(row.opts) as JobsOptions;
    this.progress = parse(row.progress) ?? 0;
    this.returnvalue = parse<R>(row.returnvalue);
    this.failedReason = row.failed_reason ?? undefined;
    this.attemptsMade = Number(row.attempts_made);
    this.timestamp = Number(row.created_at);
    this.processedOn = row.processed_on == null ? undefined : Number(row.processed_on);
    this.finishedOn = row.finished_on == null ? undefined : Number(row.finished_on);
  }

  /** The job's current state, read fresh. */
  async getState(): Promise<JobState | "unknown"> {
    return readRow(this.queueName, this.id)?.state ?? "unknown";
  }

  async updateProgress(progress: unknown): Promise<void> {
    this.progress = progress;
    run(`UPDATE jobs SET progress = ? WHERE queue = ? AND id = ?`, JSON.stringify(progress), this.queueName, this.id);
  }

  /** Appends a line to the job's log; returns the number of lines. */
  async log(line: string): Promise<number> {
    return transaction(() => {
      if (!readRow(this.queueName, this.id)) return 0;
      const last = get<{ seq: number | null }>(
        `SELECT MAX(seq) AS seq FROM job_logs WHERE queue = ? AND job_id = ?`,
        this.queueName,
        this.id
      );
      const seq = Number(last?.seq ?? 0) + 1;
      run(`INSERT INTO job_logs (queue, job_id, seq, line) VALUES (?, ?, ?, ?)`, this.queueName, this.id, seq, line);
      return seq;
    });
  }
}

const PENDING: ReadonlySet<string> = new Set<JobState>(["waiting", "active", "delayed"]);

export class Queue<D = unknown, R = unknown> {
  readonly name: string;
  private readonly defaults: JobsOptions;

  constructor(name: string, options: { defaultJobOptions?: JobsOptions } = {}) {
    this.name = name;
    this.defaults = options.defaultJobOptions ?? {};
  }

  /**
   * Queues a job. A job id that already exists returns that job unchanged
   * (callers remove a finished job first to re-run it).
   */
  async add(name: string, data: D, opts: JobsOptions = {}): Promise<Job<D, R>> {
    const merged: JobsOptions = { ...this.defaults, ...opts };
    const id = opts.jobId ?? randomUUID();
    const now = Date.now();
    const row = transaction(() => {
      const existing = readRow(this.name, id);
      if (existing) return existing;
      const seq = Number(get<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM jobs`)?.seq ?? 0) + 1;
      run(
        `INSERT INTO jobs (queue, id, name, data, opts, state, seq, run_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?)`,
        this.name,
        id,
        name,
        JSON.stringify(data),
        JSON.stringify(merged),
        seq,
        now,
        now
      );
      return readRow(this.name, id)!;
    });
    bus().emit(this.name);
    return new Job<D, R>(row);
  }

  async getJob(id: string): Promise<Job<D, R> | undefined> {
    const row = readRow(this.name, id);
    return row ? new Job<D, R>(row) : undefined;
  }

  async getJobState(id: string): Promise<JobState | "unknown"> {
    return readRow(this.name, id)?.state ?? "unknown";
  }

  /**
   * A job's log lines between `start` and `end` inclusive; negative indexes
   * count from the end (`-1` is the last line), as Redis' LRANGE does.
   */
  async getJobLogs(id: string, start = 0, end = -1): Promise<{ logs: string[]; count: number }> {
    const lines = all<{ line: string }>(
      `SELECT line FROM job_logs WHERE queue = ? AND job_id = ? ORDER BY seq`,
      this.name,
      id
    ).map((row) => row.line);
    const count = lines.length;
    const from = start < 0 ? Math.max(0, count + start) : start;
    const to = end < 0 ? count + end : Math.min(end, count - 1);
    return { logs: to < from ? [] : lines.slice(from, to + 1), count };
  }

  /** Deletes a job and its logs. Refuses while it is running. */
  async remove(id: string): Promise<void> {
    const row = readRow(this.name, id);
    if (!row) return;
    if (row.state === "active") throw new Error(`Job ${id} is running and cannot be removed.`);
    run(`DELETE FROM jobs WHERE queue = ? AND id = ? AND state <> 'active'`, this.name, id);
  }

  async close(): Promise<void> {}
}

export function isPendingJobState(state: JobState | "unknown"): boolean {
  return PENDING.has(state);
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

type Processor<D, R> = (job: Job<D, R>) => Promise<R>;

interface WorkerEvents<D, R> {
  completed: [job: Job<D, R>, result: R];
  failed: [job: Job<D, R> | undefined, error: Error];
  error: [error: Error];
}

/** How often an idle worker looks for due jobs (retries come due without an `add`). */
const POLL_MS = 1000;

function backoffDelay(opts: JobsOptions, attemptsMade: number): number {
  const backoff = opts.backoff;
  if (!backoff) return 0;
  return backoff.type === "exponential" ? backoff.delay * 2 ** Math.max(0, attemptsMade - 1) : backoff.delay;
}

function applyRetention(queue: string, state: "completed" | "failed", keep: KeepJobs | undefined): void {
  if (!keep) return;
  if (keep.age !== undefined) {
    run(
      `DELETE FROM jobs WHERE queue = ? AND state = ? AND finished_on < ?`,
      queue,
      state,
      Date.now() - keep.age * 1000
    );
  }
  if (keep.count !== undefined) {
    run(
      `DELETE FROM jobs WHERE queue = ? AND state = ? AND id NOT IN (
         SELECT id FROM jobs WHERE queue = ? AND state = ? ORDER BY finished_on DESC LIMIT ?)`,
      queue,
      state,
      queue,
      state,
      keep.count
    );
  }
}

export class Worker<D = unknown, R = unknown> {
  readonly name: string;
  private readonly processor: Processor<D, R>;
  private readonly concurrency: number;
  private readonly events = new EventEmitter();
  private running = 0;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly wake = () => this.fill();

  constructor(name: string, processor: Processor<D, R>, options: { concurrency?: number } = {}) {
    this.name = name;
    this.processor = processor;
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    bus().on(name, this.wake);
    this.timer = setInterval(this.wake, POLL_MS);
    this.timer.unref?.();
    queueMicrotask(this.wake);
  }

  on<E extends keyof WorkerEvents<D, R>>(event: E, listener: (...args: WorkerEvents<D, R>[E]) => void): this {
    this.events.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /** Stops picking up jobs. Jobs already running finish on their own. */
  async close(): Promise<void> {
    this.closed = true;
    bus().off(this.name, this.wake);
    if (this.timer) clearInterval(this.timer);
  }

  private claim(): JobRow | undefined {
    return transaction(() => {
      const row = get<JobRow>(
        `SELECT * FROM jobs WHERE queue = ? AND state IN ('waiting', 'delayed') AND run_at <= ?
         ORDER BY seq LIMIT 1`,
        this.name,
        Date.now()
      );
      if (!row) return undefined;
      run(
        `UPDATE jobs SET state = 'active', processed_on = ?, failed_reason = NULL WHERE queue = ? AND id = ?`,
        Date.now(),
        this.name,
        row.id
      );
      return readRow(this.name, row.id);
    });
  }

  private fill(): void {
    try {
      while (!this.closed && this.running < this.concurrency) {
        const row = this.claim();
        if (!row) return;
        this.running++;
        void this.process(new Job<D, R>(row)).finally(() => {
          this.running--;
          this.fill();
        });
      }
    } catch (error) {
      this.events.emit("error", error as Error);
    }
  }

  private async process(job: Job<D, R>): Promise<void> {
    try {
      const result = await this.processor(job);
      run(
        `UPDATE jobs SET state = 'completed', returnvalue = ?, finished_on = ?, attempts_made = attempts_made + 1
         WHERE queue = ? AND id = ?`,
        result === undefined ? null : JSON.stringify(result),
        Date.now(),
        this.name,
        job.id
      );
      job.returnvalue = result;
      applyRetention(this.name, "completed", job.opts.removeOnComplete);
      this.events.emit("completed", job, result);
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      const attemptsMade = job.attemptsMade + 1;
      const retry = !(error instanceof UnrecoverableError) && attemptsMade < (job.opts.attempts ?? 1);
      if (retry) {
        run(
          `UPDATE jobs SET state = 'delayed', attempts_made = ?, failed_reason = ?, run_at = ? WHERE queue = ? AND id = ?`,
          attemptsMade,
          error.message,
          Date.now() + backoffDelay(job.opts, attemptsMade),
          this.name,
          job.id
        );
      } else {
        run(
          `UPDATE jobs SET state = 'failed', attempts_made = ?, failed_reason = ?, finished_on = ? WHERE queue = ? AND id = ?`,
          attemptsMade,
          error.message,
          Date.now(),
          this.name,
          job.id
        );
        applyRetention(this.name, "failed", job.opts.removeOnFail);
      }
      job.attemptsMade = attemptsMade;
      job.failedReason = error.message;
      this.events.emit("failed", job, error);
    }
  }
}

/** The failure reason recorded on a job that was running when the app stopped. */
export const INTERRUPTED_REASON = "Interrupted — GraphReview stopped while this was running. Run it again.";

/**
 * Settles jobs left `active` by a previous run of the app (it was stopped
 * or crashed mid-job). Jobs with attempts left go back to waiting; the rest
 * fail with {@link INTERRUPTED_REASON}. Call once, before starting workers.
 */
export function recoverInterruptedJobs(): { requeued: number; failed: number } {
  return transaction(() => {
    let requeued = 0;
    let failed = 0;
    for (const row of all<JobRow>(`SELECT * FROM jobs WHERE state = 'active'`)) {
      const opts = JSON.parse(row.opts) as JobsOptions;
      const attemptsMade = Number(row.attempts_made) + 1;
      if (attemptsMade < (opts.attempts ?? 1)) {
        run(
          `UPDATE jobs SET state = 'waiting', attempts_made = ?, run_at = ? WHERE queue = ? AND id = ?`,
          attemptsMade,
          Date.now(),
          row.queue,
          row.id
        );
        requeued++;
      } else {
        run(
          `UPDATE jobs SET state = 'failed', attempts_made = ?, failed_reason = ?, finished_on = ? WHERE queue = ? AND id = ?`,
          attemptsMade,
          INTERRUPTED_REASON,
          Date.now(),
          row.queue,
          row.id
        );
        failed++;
      }
    }
    return { requeued, failed };
  });
}

// ---------------------------------------------------------------------------
// Flags — short-lived markers (e.g. "cancel requested") a running job polls.
// ---------------------------------------------------------------------------

/** Sets `key` for `ttlSeconds`. */
export async function setFlag(key: string, ttlSeconds: number): Promise<void> {
  run(
    `INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    `flag:${key}`,
    String(Date.now() + ttlSeconds * 1000)
  );
}

export async function hasFlag(key: string): Promise<boolean> {
  const row = get<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, `flag:${key}`);
  return row !== undefined && Number(row.value) > Date.now();
}

/** Deletes expired flags. Called once at startup. */
export function purgeExpiredFlags(): number {
  return run(`DELETE FROM kv WHERE key LIKE 'flag:%' AND CAST(value AS INTEGER) <= ?`, Date.now());
}

export async function clearFlag(key: string): Promise<void> {
  run(`DELETE FROM kv WHERE key = ?`, `flag:${key}`);
}
