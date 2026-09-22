// Worker process entrypoint.
//
// Same image as `app`, different command (`npm run worker`). It has no HTTP
// surface: it consumes the `analysis`, `review` and `label` queues defined
// in lib/jobs/ and writes results through lib/neo4j. Everything it does is
// logged to stdout, since `docker logs graphreview-worker` is the only way
// anyone observes it.
//
// Errors are never swallowed — a throwing job is handed back to BullMQ,
// which applies the retry/backoff policy from lib/jobs/queue.ts.

import { Worker } from "bullmq";
import type { Job } from "bullmq";
import {
  ANALYSIS_QUEUE_NAME,
  LABEL_QUEUE_NAME,
  REVIEW_QUEUE_NAME,
  closeLabelQueue,
  closeQueues,
  closeReviewQueue,
  getBlockingRedisConnection,
  listRepoDtos,
  type AnalysisJobData,
  type AnalysisJobResult,
  type LabelJobData,
  type LabelJobResult,
  type ReviewJobData,
  type ReviewJobResult,
} from "@/lib/jobs";
// Imported from the modules directly rather than the barrel: these are the
// entry points that pull in lib/analysis (tree-sitter + WASM grammars) and
// lib/ai + lib/github respectively, and keeping them out of `lib/jobs`'s
// public surface keeps those dependencies out of the Next.js app bundle.
// See the note in lib/jobs/index.ts.
import { runAnalysisJob } from "@/lib/jobs/analyze";
import { runReviewJob } from "@/lib/jobs/review";
import { runLabelJob } from "@/lib/jobs/label";
import { closeDriver, runMigrations } from "@/lib/neo4j";

/** One job at a time: static analysis is CPU-bound (tree-sitter parsing) and a second concurrent run would just contend for the same core. */
const CONCURRENCY = Number(process.env.ANALYSIS_CONCURRENCY ?? 1);

/**
 * One review job at a time as well. A review is I/O-bound rather than
 * CPU-bound, but it already fans out to several concurrent model calls
 * internally, and running two whole reviews at once would multiply that
 * fan-out against a provider that may be a single local model server — and
 * against Neo4j's serial finding writes.
 */
const REVIEW_CONCURRENCY = Number(process.env.REVIEW_CONCURRENCY ?? 1);

/**
 * One labeling job at a time, for the same reasons as a review — it spends
 * model calls against a provider that may be a single local server, and its
 * domain-tier writes are relationship writes, which Neo4j Community insists
 * on seeing serially.
 */
const LABEL_CONCURRENCY = Number(process.env.LABEL_CONCURRENCY ?? 1);

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
 * Mirrors a job-scoped log line into BullMQ's own per-job log (`job.log()`,
 * stored in Redis under the job's retention window) alongside the stdout
 * write every call site already does. This is what lets the UI's hover-to-
 * see-progress affordance read back what the worker was doing — `docker
 * logs` is the only channel today, and it isn't reachable from the app.
 * Best-effort: a Redis hiccup here must never fail the job over a nice-to-
 * have.
 */
function mirrorToJobLog(job: { log: (row: string) => Promise<number> }, message: string): void {
  void job.log(message).catch(() => undefined);
}

async function main(): Promise<void> {
  log(
    `starting — queue "${ANALYSIS_QUEUE_NAME}" (concurrency ${CONCURRENCY}), ` +
      `queue "${REVIEW_QUEUE_NAME}" (concurrency ${REVIEW_CONCURRENCY}), ` +
      `queue "${LABEL_QUEUE_NAME}" (concurrency ${LABEL_CONCURRENCY})`
  );

  // Constraints are `IF NOT EXISTS`, so this is a no-op on an already
  // migrated database (lib/neo4j/schema.ts).
  try {
    await runMigrations();
    log("neo4j schema constraints ensured");
  } catch (error) {
    // Don't exit: Neo4j may still be starting up alongside us in Compose.
    // The first job will fail loudly and retry if it really is unreachable.
    logError(`could not run neo4j migrations at startup: ${(error as Error).message}`);
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
    { connection: getBlockingRedisConnection(), concurrency: CONCURRENCY }
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

  // Connection-level problems (Redis down, etc.) — surfaced rather than
  // crashing the process, so Compose doesn't restart-loop the container
  // while Redis is still coming up.
  worker.on("error", (error) => {
    logError(`worker error: ${error.message}`);
  });

  // --- review queue -------------------------------------------------------
  const reviewWorker = new Worker<ReviewJobData, ReviewJobResult>(
    REVIEW_QUEUE_NAME,
    async (job: Job<ReviewJobData, ReviewJobResult>) => {
      const { repoId, target } = job.data;
      const describedTarget =
        target.kind === "pr"
          ? `PR #${target.prNumber}`
          : `${target.baseRef}...${target.headRef}`;
      log(`review job ${job.id} started — repo ${repoId}, ${describedTarget}`);

      return runReviewJob(job.data, job, (message) => {
        log(`review job ${job.id} · ${message}`);
        mirrorToJobLog(job, message);
      });
    },
    { connection: getBlockingRedisConnection(), concurrency: REVIEW_CONCURRENCY }
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

      return runLabelJob(job.data, job, (message) => {
        log(`label job ${job.id} · ${message}`);
        mirrorToJobLog(job, message);
      });
    },
    { connection: getBlockingRedisConnection(), concurrency: LABEL_CONCURRENCY }
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

  const sweep = startStalenessSweep();

  const shutdown = async (signal: string): Promise<void> => {
    log(`received ${signal} — shutting down`);
    if (sweep) clearInterval(sweep);
    try {
      await Promise.all([worker.close(), reviewWorker.close(), labelWorker.close()]);
      // The review and label queues borrow ./queue.ts's Redis connections, so
      // they have to be closed before `closeQueues()` tears those down.
      await closeReviewQueue();
      await closeLabelQueue();
      await closeQueues();
      await closeDriver();
    } catch (error) {
      logError(`error during shutdown: ${(error as Error).message}`);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

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
  return setInterval(() => {
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
}

main().catch((error: unknown) => {
  logError(`fatal: ${(error as Error).message}`);
  console.error(error);
  process.exit(1);
});
