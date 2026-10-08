// The background job workers.
//
// Started once per process from instrumentation.ts, alongside the web
// server: they consume the `analysis`, `review`, `label`, `app-map` and
// `preview` queues defined in lib/jobs/ (stored in SQLite, see
// lib/jobs/runner.ts) and write results through lib/db. Everything they do
// is logged to stdout, and each job's own lines are mirrored into its job
// log so the UI can show them.
//
// Errors are never swallowed — a throwing job is handed back to the runner,
// which applies the retry/backoff policy from lib/jobs/queue.ts.

import { Worker, purgeExpiredFlags, recoverInterruptedJobs, type Job } from "@/lib/jobs/runner";
import {
  ANALYSIS_QUEUE_NAME,
  APP_MAP_QUEUE_NAME,
  LABEL_QUEUE_NAME,
  PREVIEW_QUEUE_NAME,
  PREVIEW_SCAN_QUEUE_NAME,
  REVIEW_QUEUE_NAME,
  TARGET_GRAPH_QUEUE_NAME,
  clearAppMapCancel,
  clearLabelCancel,
  clearReviewCancel,
  cleanUpIfRepoRemoved,
  isAppMapCancelRequested,
  isLabelCancelRequested,
  isReviewCancelRequested,
  listRepoDtos,
  reviewTargetKey,
  type AppMapJobData,
  type AppMapJobResult,
  type AnalysisJobData,
  type AnalysisJobResult,
  type LabelJobData,
  type LabelJobResult,
  type PreviewJobData,
  type PreviewJobResult,
  type PreviewScanJobData,
  type ReviewJobData,
  type ReviewJobResult,
  type TargetGraphJobData,
  type TargetGraphJobResult,
} from "@/lib/jobs";
// Imported from the modules directly rather than the barrel: these are the
// entry points that pull in lib/analysis (tree-sitter + WASM grammars) and
// lib/ai + lib/github respectively, and keeping them out of `lib/jobs`'s
// public surface keeps those dependencies out of the Next.js app bundle.
// See the note in lib/jobs/index.ts.
import { runAnalysisJob } from "@/lib/jobs/analyze";
import { runReviewJob } from "@/lib/jobs/review";
import { runLabelJob } from "@/lib/jobs/label";
import { runAppMapJob } from "@/lib/jobs/app-map-job";
import { runPreviewJob } from "@/lib/jobs/preview";
import { runPreviewScanJob } from "@/lib/jobs/preview-scan";
import { runTargetGraphJob } from "@/lib/jobs/target-graph";
import type { PreviewScanResult } from "@/lib/preview/types";
import { getDb, purgeExpiredKv, purgeParseCache } from "@/lib/db";

/** One job at a time: static analysis is CPU-bound (tree-sitter parsing) and a second concurrent run would just contend for the same core. */
const CONCURRENCY = Number(process.env.ANALYSIS_CONCURRENCY ?? 1);

/**
 * One review job at a time as well. A review is I/O-bound rather than
 * CPU-bound, but it already fans out to several concurrent model calls
 * internally, and running two whole reviews at once would multiply that
 * fan-out against a provider that may be a single local model server.
 */
const REVIEW_CONCURRENCY = Number(process.env.REVIEW_CONCURRENCY ?? 1);

/** How often an active review, labeling or app-map job checks whether the user cancelled it. */
const LABEL_CANCEL_POLL_MS = 1000;

/**
 * One labeling job at a time, for the same reasons as a review — it spends
 * model calls against a provider that may be a single local server.
 */
const LABEL_CONCURRENCY = Number(process.env.LABEL_CONCURRENCY ?? 1);

/** App-map runs (DESIGN.md §6.5): on demand, model calls — one at a time, like labeling. */
const APP_MAP_CONCURRENCY = Number(process.env.APP_MAP_CONCURRENCY ?? 1);

/** Before/after previews (DESIGN.md §6.9): each runs two sandbox containers already, so one file at a time by default. */
const PREVIEW_CONCURRENCY = Math.max(1, Number(process.env.PREVIEW_CONCURRENCY) || 1);

/**
 * Optional periodic staleness sweep. The normal refresh trigger is "on
 * view", so
 * this is off unless `STALENESS_SWEEP_INTERVAL_MS` is set — it exists for
 * setups that want repos kept warm without anyone opening the UI.
 */
const SWEEP_INTERVAL_MS = Number(process.env.STALENESS_SWEEP_INTERVAL_MS ?? 0);

function log(message: string): void {
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

function logError(message: string): void {
  console.error(`[worker] ${new Date().toISOString()} ${message}`);
}

/**
 * Mirrors a job-scoped log line into the job's own log (`job.log()`, kept
 * for the job's retention window) alongside the stdout write every call
 * site already does. This is what lets the UI's hover-to-see-progress
 * affordance read back what the worker was doing. Best-effort: a hiccup
 * here must never fail the job over a nice-to-have.
 */
function mirrorToJobLog(job: { log: (row: string) => Promise<number> }, message: string): void {
  void job.log(message).catch(() => undefined);
}

/**
 * The review queue's job body. Exported so lib/ai/smoke-test-review.ts can
 * run it on a worker of its own.
 */
export async function processReviewJob(job: Job<ReviewJobData, ReviewJobResult>): Promise<ReviewJobResult> {
  const { repoId, target } = job.data;
  const describedTarget =
    target.kind === "pr"
      ? `PR #${target.prNumber}`
      : `${target.baseRef}...${target.headRef}`;
  log(`review job ${job.id} started — repo ${repoId}, ${describedTarget}`);

  // Cooperative cancellation, exactly like the label queue: the request
  // sets a flag (lib/jobs/review-queue.ts), this polls it and aborts the
  // run's model calls.
  const targetKey = reviewTargetKey(target);
  const abort = new AbortController();
  const poll = setInterval(() => {
    isReviewCancelRequested(repoId, targetKey)
      .then((requested) => {
        if (requested && !abort.signal.aborted) {
          log(`review job ${job.id} · cancel requested`);
          abort.abort();
        }
      })
      .catch(() => undefined);
  }, LABEL_CANCEL_POLL_MS);

  try {
    return await runReviewJob(
      job.data,
      job,
      (message) => {
        log(`review job ${job.id} · ${message}`);
        mirrorToJobLog(job, message);
      },
      abort.signal
    );
  } finally {
    clearInterval(poll);
    await clearReviewCancel(repoId, targetKey).catch(() => undefined);
  }
}

const STARTED_KEY = Symbol.for("graphreview.worker.started");

/**
 * Starts every queue's worker. Safe to call more than once per process —
 * Next.js may evaluate instrumentation in more than one bundle — only the
 * first call does anything.
 */
export async function startWorker(): Promise<void> {
  const g = globalThis as typeof globalThis & { [STARTED_KEY]?: boolean };
  if (g[STARTED_KEY]) return;
  g[STARTED_KEY] = true;

  log(
    `starting — queue "${ANALYSIS_QUEUE_NAME}" (concurrency ${CONCURRENCY}), ` +
      `queue "${REVIEW_QUEUE_NAME}" (concurrency ${REVIEW_CONCURRENCY}), ` +
      `queue "${LABEL_QUEUE_NAME}" (concurrency ${LABEL_CONCURRENCY}), ` +
      `queue "${APP_MAP_QUEUE_NAME}" (concurrency ${APP_MAP_CONCURRENCY}), ` +
      `queue "${PREVIEW_QUEUE_NAME}" (concurrency ${PREVIEW_CONCURRENCY}), queue "${TARGET_GRAPH_QUEUE_NAME}" (concurrency 1)`
  );

  // Opening the database applies any pending schema migrations.
  getDb();
  // Expired cancel flags and caches are only ignored on read; drop them here.
  purgeExpiredFlags();
  purgeExpiredKv();
  purgeParseCache();

  // Jobs left running by a previous run of the app (stopped or crashed
  // mid-job): analysis is retried, AI jobs are marked interrupted.
  const recovered = recoverInterruptedJobs();
  if (recovered.requeued || recovered.failed) {
    log(`recovered interrupted jobs: ${recovered.requeued} re-queued, ${recovered.failed} marked failed`);
  }

  const worker = new Worker<AnalysisJobData, AnalysisJobResult>(
    ANALYSIS_QUEUE_NAME,
    async (job: Job<AnalysisJobData, AnalysisJobResult>) => {
      const { repoId } = job.data;
      const attempt = `attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1}`;
      log(`job ${job.id} started — repo ${repoId} (${attempt})`);

      return runAnalysisJob(repoId, (message) => {
        log(`job ${job.id} · ${message}`);
        mirrorToJobLog(job, message);
      });
    },
    { concurrency: CONCURRENCY }
  );

  worker.on("completed", (job, result) => {
    log(
      `job ${job.id} completed — repo ${result.repoId} @ ${result.sha.slice(0, 12)}: ` +
        `${result.files} file(s), ${result.components} component(s), ` +
        `${result.fileEdges} import edge(s), ${result.componentEdges} dependency edge(s) ` +
        `in ${result.durationMs}ms`
    );
  });

  worker.on("failed", (job, error) => {
    logError(
      `job ${job?.id ?? "?"} failed — repo ${job?.data?.repoId ?? "?"}: ${error.message}`
    );
    if (error.stack) console.error(error.stack);
  });

  // Problems claiming jobs (e.g. a locked database) — surfaced rather than
  // crashing the app.
  worker.on("error", (error) => {
    logError(`worker error: ${error.message}`);
  });

  // --- review queue -------------------------------------------------------
  const reviewWorker = new Worker<ReviewJobData, ReviewJobResult>(
    REVIEW_QUEUE_NAME,
    processReviewJob,
    { concurrency: REVIEW_CONCURRENCY }
  );

  reviewWorker.on("completed", (job, result) => {
    log(
      `review job ${job.id} completed — repo ${result.repoId} @ ${result.targetKey}: ` +
        `${result.components} component(s) (${result.failedComponents} failed), ` +
        `${result.findings} finding(s), ${result.calls} model call(s), ` +
        `${result.promptTokens}+${result.completionTokens} token(s) in ${result.durationMs}ms`
    );
  });

  reviewWorker.on("failed", (job, error) => {
    logError(
      `review job ${job?.id ?? "?"} failed — repo ${job?.data?.repoId ?? "?"}: ${error.message}`
    );
    if (error.stack) console.error(error.stack);
  });

  reviewWorker.on("error", (error) => {
    logError(`review worker error: ${error.message}`);
  });

  // --- label queue ---------------------------------------------------------
  const labelWorker = new Worker<LabelJobData, LabelJobResult>(
    LABEL_QUEUE_NAME,
    async (job: Job<LabelJobData, LabelJobResult>) => {
      const { repoId, force } = job.data;
      log(`label job ${job.id} started — repo ${repoId}${force ? " (force)" : ""}`);

      // Cooperative cancellation (see lib/jobs/label-queue.ts): the request
      // sets a flag, this polls it and aborts the run's model calls.
      const abort = new AbortController();
      const poll = setInterval(() => {
        isLabelCancelRequested(repoId)
          .then((requested) => {
            if (requested && !abort.signal.aborted) {
              log(`label job ${job.id} · cancel requested`);
              abort.abort();
            }
          })
          .catch(() => undefined);
      }, LABEL_CANCEL_POLL_MS);

      try {
        return await runLabelJob(
          job.data,
          job,
          (message) => {
            log(`label job ${job.id} · ${message}`);
            mirrorToJobLog(job, message);
          },
          abort.signal
        );
      } finally {
        clearInterval(poll);
        await clearLabelCancel(repoId).catch(() => undefined);
      }
    },
    { concurrency: LABEL_CONCURRENCY }
  );

  labelWorker.on("completed", (job, result) => {
    log(
      `label job ${job.id} completed — repo ${result.repoId}: ` +
        `${result.domains} domain(s) over ${result.modules} module(s) ` +
        `(replaced ${result.replacedDomains}), ${result.describedModules} description(s), ` +
        `${result.calls} model call(s), ${result.promptTokens}+${result.completionTokens} token(s) ` +
        `in ${result.durationMs}ms${result.parseFailed ? " (some output unparseable)" : ""}`
    );
  });

  labelWorker.on("failed", (job, error) => {
    logError(
      `label job ${job?.id ?? "?"} failed — repo ${job?.data?.repoId ?? "?"}: ${error.message}`
    );
    if (error.stack) console.error(error.stack);
  });

  labelWorker.on("error", (error) => {
    logError(`label worker error: ${error.message}`);
  });

  // --- app-map queue -------------------------------------------------------
  const appMapWorker = new Worker<AppMapJobData, AppMapJobResult>(
    APP_MAP_QUEUE_NAME,
    async (job: Job<AppMapJobData, AppMapJobResult>) => {
      const { repoId, level, mode } = job.data;
      log(`app-map job ${job.id} started — repo ${repoId}, level ${level}${mode === "place" ? ", placing leftover files" : ""}`);
      // Cooperative cancellation, exactly like the label queue above.
      const abort = new AbortController();
      const poll = setInterval(() => {
        isAppMapCancelRequested(repoId)
          .then((requested) => {
            if (requested && !abort.signal.aborted) {
              log(`app-map job ${job.id} · cancel requested`);
              abort.abort();
            }
          })
          .catch(() => undefined);
      }, LABEL_CANCEL_POLL_MS);
      try {
        return await runAppMapJob(
          job.data,
          job,
          (message) => {
            log(`app-map job ${job.id} · ${message}`);
            mirrorToJobLog(job, message);
          },
          abort.signal
        );
      } finally {
        clearInterval(poll);
        await clearAppMapCancel(repoId).catch(() => undefined);
      }
    },
    { concurrency: APP_MAP_CONCURRENCY }
  );

  appMapWorker.on("completed", (job, result) => {
    log(
      `app-map job ${job.id} completed — repo ${result.repoId} (${result.level}): ${result.cards} card(s), ` +
        `${result.explained} explained, ${result.calls} model call(s), ` +
        `${result.promptTokens}+${result.completionTokens} token(s) in ${result.durationMs}ms` +
        (result.parseFailed ? " (some output unparseable)" : "")
    );
  });
  appMapWorker.on("failed", (job, error) => {
    logError(`app-map job ${job?.id ?? "?"} failed — repo ${job?.data?.repoId ?? "?"}: ${error.message}`);
    if (error.stack) console.error(error.stack);
  });
  appMapWorker.on("error", (error) => {
    logError(`app-map worker error: ${error.message}`);
  });

  // --- preview queue -------------------------------------------------------
  const previewWorker = new Worker<PreviewJobData, PreviewJobResult>(
    PREVIEW_QUEUE_NAME,
    async (job: Job<PreviewJobData, PreviewJobResult>) => {
      log(`preview job ${job.id} started — repo ${job.data.repoId}, ${job.data.filePath}`);
      return runPreviewJob(
        job.data,
        { updateProgress: (progress) => job.updateProgress(progress) },
        (message) => {
          log(`preview job ${job.id} · ${message}`);
          mirrorToJobLog(job, message);
        }
      );
    },
    { concurrency: PREVIEW_CONCURRENCY }
  );
  previewWorker.on("completed", (job, result) => {
    const cases = result.symbols.reduce((n, s) => n + s.cases.length, 0);
    const differing = result.symbols.reduce((n, s) => n + s.cases.filter((c) => c.differs).length, 0);
    log(
      `preview job ${job.id} completed — ${result.filePath}: ${result.symbols.length} symbol(s), ` +
        `${cases} case(s), ${differing} differ, in ${result.durationMs}ms`
    );
  });
  previewWorker.on("failed", (job, error) => {
    logError(`preview job ${job?.id ?? "?"} failed — ${job?.data?.filePath ?? "?"}: ${error.message}`);
  });
  previewWorker.on("error", (error) => {
    logError(`preview worker error: ${error.message}`);
  });

  // --- preview-scan queue --------------------------------------------------
  // Parsing only (no Docker, no model), triggered by the Graph tab loading a
  // target — a couple at once is fine.
  const previewScanWorker = new Worker<PreviewScanJobData, PreviewScanResult>(
    PREVIEW_SCAN_QUEUE_NAME,
    async (job: Job<PreviewScanJobData, PreviewScanResult>) =>
      runPreviewScanJob(job.data, (message) => {
        log(`preview-scan job ${job.id} · ${message}`);
        mirrorToJobLog(job, message);
      }),
    { concurrency: 2 }
  );
  previewScanWorker.on("failed", (job, error) => {
    logError(`preview-scan job ${job?.id ?? "?"} failed: ${error.message}`);
  });
  previewScanWorker.on("error", (error) => {
    logError(`preview-scan worker error: ${error.message}`);
  });

  // --- target-graph queue ---------------------------------------------------
  // Base vs head of a review target (lib/jobs/target-graph.ts): static
  // analysis only, triggered by the Graph tab loading a target. CPU-bound
  // parsing runs in the parse worker thread, so one at a time is plenty.
  const targetGraphWorker = new Worker<TargetGraphJobData, TargetGraphJobResult>(
    TARGET_GRAPH_QUEUE_NAME,
    async (job: Job<TargetGraphJobData, TargetGraphJobResult>) =>
      runTargetGraphJob(job.data, (message) => {
        log(`target-graph job ${job.id} · ${message}`);
        mirrorToJobLog(job, message);
      }),
    { concurrency: 1 }
  );
  targetGraphWorker.on("failed", (job, error) => {
    logError(`target-graph job ${job?.id ?? "?"} failed: ${error.message}`);
  });
  targetGraphWorker.on("error", (error) => {
    logError(`target-graph worker error: ${error.message}`);
  });

  // A repo removed while one of its jobs ran gets that job's leftovers
  // (files, findings, a fresh clone) removed too (lib/jobs/repo-removal.ts).
  const cleanUp = (job: { data?: { repoId?: string } } | undefined) => {
    void cleanUpIfRepoRemoved(job?.data?.repoId).catch((error: unknown) =>
      logError(`cleanup after a removed repo failed: ${(error as Error).message}`)
    );
  };
  for (const w of [worker, reviewWorker, labelWorker, appMapWorker, previewWorker, previewScanWorker, targetGraphWorker]) {
    (w as Worker<{ repoId: string }, unknown>).on("completed", cleanUp).on("failed", cleanUp);
  }

  startStalenessSweep();

  log("ready — waiting for jobs");
}

/**
 * Periodically re-runs the staleness check for every repo, enqueueing
 * work for any that have moved on. Disabled unless configured.
 */
function startStalenessSweep(): NodeJS.Timeout | undefined {
  if (!Number.isFinite(SWEEP_INTERVAL_MS) || SWEEP_INTERVAL_MS <= 0) {
    return undefined;
  }
  log(`staleness sweep enabled — every ${SWEEP_INTERVAL_MS}ms`);
  const timer = setInterval(() => {
    // `listRepoDtos` computes each repo's status, which itself performs the
    // staleness check and enqueues when needed (lib/jobs/repo-status.ts).
    listRepoDtos({ autoEnqueue: true })
      .then((repos) => {
        const refreshing = repos.filter((repo) => repo.status === "stale");
        log(
          `staleness sweep: ${repos.length} repo(s) checked, ${refreshing.length} stale`
        );
      })
      .catch((error: unknown) => {
        logError(`staleness sweep failed: ${(error as Error).message}`);
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
