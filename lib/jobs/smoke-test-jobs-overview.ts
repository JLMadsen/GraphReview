/**
 * Smoke test for the jobs overview behind the header indicator and the Jobs
 * drawer (DESIGN.md §6.20).
 *
 *   npm test -- jobs-overview
 *
 * No workers run, so queued jobs stay queued; finished states are written
 * straight into the `jobs` table. Covers queue positions, the inferred
 * trigger, cancelled vs failed, config failures, unseen-failure marks (and
 * that a job failing again counts again), cancel's 409 and retry.
 */
import { run } from "@/lib/db/client";
import { upsertRepo } from "@/lib/db";
import { enqueueAnalysis } from "./queue";
import { REVIEW_CANCELLED_REASON, enqueueReview } from "./review-queue";
import { enqueueAppMap } from "./app-map-queue";
import { cancelJob, listJobs, markJobsSeen, retryJob } from "./jobs-overview";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function finish(queue: string, id: string, state: "failed" | "completed", reason: string | null, finishedOn: number): void {
  run(
    `UPDATE jobs SET state = ?, failed_reason = ?, processed_on = ?, finished_on = ? WHERE queue = ? AND id = ?`,
    state,
    reason,
    finishedOn - 5000,
    finishedOn,
    queue,
    id
  );
}

async function main(): Promise<void> {
  await upsertRepo({ id: "jobs-repo", name: "jobs-repo", provider: "local", localPath: "/tmp/none", defaultBranch: "main" });

  const first = await enqueueReview("jobs-repo", { kind: "pr", prNumber: 1 });
  const second = await enqueueReview("jobs-repo", { kind: "refs", baseRef: "main", headRef: "feature" });
  const analysis = await enqueueAnalysis("jobs-repo");
  const appMap = await enqueueAppMap("jobs-repo", "features", "split", "auth");

  let jobs = await listJobs();
  const byId = (id: string) => jobs.jobs.find((j) => j.id === id);
  check("lists all four jobs", jobs.jobs.length === 4, String(jobs.jobs.length));
  check("counts them queued", jobs.queued === 4 && jobs.running === 0);
  check("first review is 1st in its queue", byId(first.jobId)?.positionText === "1st in the review queue", byId(first.jobId)?.positionText);
  check("second review is 2nd", byId(second.jobId)?.position === 2);
  check("analysis of a never-analysed repo: Repo added", byId(analysis.jobId)?.trigger === "Repo added", byId(analysis.jobId)?.trigger);
  check("app-map split: Split card", byId(appMap.jobId)?.trigger === "Split card auth", byId(appMap.jobId)?.trigger);
  check("review carries its target key", byId(second.jobId)?.targetKey === "refs:main...feature");
  check("only review and app map cancellable", byId(first.jobId)?.cancellable === true && byId(analysis.jobId)?.cancellable === false);
  check("repo filter", (await listJobs({ repoId: "other" })).jobs.length === 0);

  const refused = await cancelJob("analysis", analysis.jobId);
  check("cancel analysis → 409", !refused.ok && refused.status === 409);
  const cancelled = await cancelJob("review", second.jobId);
  check("cancel a queued review removes it", cancelled.ok && cancelled.outcome === "removed");
  jobs = await listJobs();
  check("first review is still 1st", byId(first.jobId)?.position === 1);

  const t0 = Date.now() - 60_000;
  finish("review", first.jobId, "failed", "Model said no.", t0);
  finish("app-map", appMap.jobId, "failed", REVIEW_CANCELLED_REASON, t0);
  jobs = await listJobs();
  check("failed review is unseen", byId(first.jobId)?.state === "failed" && byId(first.jobId)?.unseen === true);
  check("cancelled app map is cancelled, not failed", byId(appMap.jobId)?.state === "cancelled" && !byId(appMap.jobId)?.unseen);
  check("one unseen failure", jobs.unseenFailed === 1, String(jobs.unseenFailed));
  check("failed review can run again", byId(first.jobId)?.retryable === true);
  check("recent sorts failed before cancelled", jobs.jobs.findIndex((j) => j.id === first.jobId) < jobs.jobs.findIndex((j) => j.id === appMap.jobId));

  check("mark seen", markJobsSeen([{ queue: "review", id: first.jobId }]) === 1);
  jobs = await listJobs();
  check("seen failure no longer counts", jobs.unseenFailed === 0 && byId(first.jobId)?.unseen === false);
  finish("review", first.jobId, "failed", "Model said no again.", t0 + 1000);
  jobs = await listJobs();
  check("failing again counts again", jobs.unseenFailed === 1);

  finish("review", first.jobId, "failed", "AI provider is not fully configured — set the base URL, API key and model in Settings.", t0 + 2000);
  jobs = await listJobs();
  check("config failure links to settings", byId(first.jobId)?.configIssue?.href === "/settings" && byId(first.jobId)?.retryable === false);

  const retried = await retryJob("review", first.jobId);
  check("retry re-enqueues", retried.ok);
  jobs = await listJobs();
  check("retried review is queued again", byId(first.jobId)?.state === "queued");
  const notFinished = await retryJob("review", first.jobId);
  check("retry of a queued job → 409", !notFinished.ok && notFinished.status === 409);

  finish("analysis", analysis.jobId, "completed", null, Date.now());
  run(`UPDATE jobs SET returnvalue = ? WHERE queue = 'analysis' AND id = ?`, JSON.stringify({ files: 412 }), analysis.jobId);
  jobs = await listJobs();
  check("done analysis says its files", byId(analysis.jobId)?.result === "412 files", byId(analysis.jobId)?.result);
}

main()
  .catch((err) => {
    failures++;
    console.error(err);
  })
  .finally(() => {
    console.log(failures === 0 ? "\njobs overview smoke test passed" : `\n${failures} check(s) failed`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
