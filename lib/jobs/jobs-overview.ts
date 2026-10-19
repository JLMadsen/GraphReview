// Every background job, across the six queues and all repos (DESIGN.md
// §6.20): what the header indicator, the Jobs drawer and the inline job
// states read. Rows come straight from the `jobs` table (./runner.ts) —
// nothing new is stored except which failures the user has seen (`kv`).
//
// Server-only.

import { all, get } from "@/lib/db/client";
import { listRepos, readKv, writeKv } from "@/lib/db";
import type { RepoRecord } from "@/lib/db";
import { DEFAULT_REVIEW_EFFORT } from "@/lib/ai/effort";
import type { JobDto, JobKind, JobsResponse, JobStateDto } from "@/components/jobs/types";
import { WORKTREE_REF } from "./git-ref";
import { ANALYSIS_QUEUE_NAME, ANALYSIS_VERSION, enqueueAnalysis, isPendingJobState } from "./queue";
import { REVIEW_CANCELLED_REASON, REVIEW_QUEUE_NAME, cancelReview, enqueueReview, reviewTargetKey, type ReviewProgress, type ReviewTarget } from "./review-queue";
import { APP_MAP_CANCELLED_REASON, APP_MAP_QUEUE_NAME, cancelAppMap, enqueueAppMap, type AppMapJobData, type AppMapProgress } from "./app-map-queue";
import { TARGET_GRAPH_QUEUE_NAME, ensureTargetGraph } from "./target-graph-queue";
import { PREVIEW_QUEUE_NAME, PREVIEW_SCAN_QUEUE_NAME, enqueuePreview, ensurePreviewScan, type PreviewJobData } from "./preview-queue";
import { invalidateReviewFreshness } from "./review-freshness";
import type { PreviewProgress } from "@/lib/preview/types";

const KINDS: Record<string, JobKind> = {
  [ANALYSIS_QUEUE_NAME]: "Analysis",
  [TARGET_GRAPH_QUEUE_NAME]: "Compare",
  [REVIEW_QUEUE_NAME]: "Review",
  [APP_MAP_QUEUE_NAME]: "App map",
  [PREVIEW_SCAN_QUEUE_NAME]: "Preview scan",
  [PREVIEW_QUEUE_NAME]: "Preview",
};

export const JOB_QUEUES = Object.keys(KINDS);

export function isJobQueue(queue: string): boolean {
  return queue in KINDS;
}

const CANCELLABLE = new Set([REVIEW_QUEUE_NAME, APP_MAP_QUEUE_NAME]);
const CANCELLED_REASONS = new Set([REVIEW_CANCELLED_REASON, APP_MAP_CANCELLED_REASON]);

/** Seen marks outlive the longest failed-job retention (7 days). */
const SEEN_TTL_SECONDS = 8 * 24 * 3600;
const JOB_LOG_TAIL = 200;

interface Row {
  queue: string;
  id: string;
  data: string;
  state: string;
  progress: string | null;
  returnvalue: string | null;
  failed_reason: string | null;
  seq: number;
  created_at: number;
  processed_on: number | null;
  finished_on: number | null;
}

interface JobData {
  repoId?: string;
  target?: ReviewTarget;
  filePath?: string;
  only?: "failed";
  level?: AppMapJobData["level"];
  mode?: AppMapJobData["mode"];
  card?: string;
  inputs?: unknown;
  mocks?: unknown;
}

function parse<T>(value: string | null): T | undefined {
  if (value == null) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

function targetLabel(target: ReviewTarget | undefined): string | undefined {
  if (!target) return undefined;
  if (target.kind === "pr") return `PR #${target.prNumber}`;
  return target.headRef === WORKTREE_REF ? "Changes on disk" : `${target.baseRef} → ${target.headRef}`;
}

function graphHref(repoId: string, target?: ReviewTarget): string {
  const base = `/repo/${encodeURIComponent(repoId)}/graph`;
  if (!target) return base;
  return target.kind === "pr"
    ? `${base}?pr=${target.prNumber}`
    : `${base}?base=${encodeURIComponent(target.baseRef)}&head=${encodeURIComponent(target.headRef)}`;
}

function toState(row: Row): JobStateDto {
  if (row.state === "active") return "running";
  if (isPendingJobState(row.state as never)) return "queued";
  if (row.state === "completed") return "done";
  return CANCELLED_REASONS.has(row.failed_reason ?? "") ? "cancelled" : "failed";
}

/** A failure retrying can't fix: points at the setting instead (§6.20 §2). */
function configIssue(reason: string): JobDto["configIssue"] {
  if (/AI provider is not (fully )?configured|no AI provider/i.test(reason)) return { label: "Set up an AI provider", href: "/settings" };
  if (/docker/i.test(reason) && /not running|not installed|can't be reached|cannot connect|not found/i.test(reason)) {
    return { label: "Docker isn't available — see Settings", href: "/settings" };
  }
  if (/(timed out|timeout)/i.test(reason) && /(provider|model|chat\/completions|AI)/i.test(reason)) {
    return { label: "Provider timed out — check its settings", href: "/settings" };
  }
  return undefined;
}

/** "Triggered by", from the queue and the job data (§3). `undefined` when the data can't tell. */
function trigger(
  queue: string,
  data: JobData,
  state: JobStateDto,
  repo: RepoRecord | undefined,
  analysingSha: string | undefined
): string | undefined {
  switch (queue) {
    case REVIEW_QUEUE_NAME:
      return data.only === "failed" ? "Re-review failed components" : "Review";
    case APP_MAP_QUEUE_NAME:
      if (data.mode === "split" && data.card) return `Split card ${data.card}`;
      if (data.mode === "place") return "Re-place map";
      return data.level ? `Explain the ${data.level} level` : undefined;
    case PREVIEW_QUEUE_NAME:
      return data.inputs || data.mocks ? "Preview with edited inputs" : "Preview";
    case ANALYSIS_QUEUE_NAME:
      // Told apart by the previous analysed sha, so only while the run is
      // in flight: once it finishes, the repo's analysed sha is its own.
      if (!repo) return undefined;
      if (!repo.lastAnalyzedSha) return "Repo added";
      if (state !== "running" && state !== "queued") return undefined;
      if (repo.analysisVersion !== ANALYSIS_VERSION) return "GraphReview update (re-analysis)";
      if (!analysingSha) return undefined;
      return repo.lastAnalyzedSha.startsWith(analysingSha) ? "Refresh" : "New commit on default branch";
    case TARGET_GRAPH_QUEUE_NAME:
    case PREVIEW_SCAN_QUEUE_NAME:
      return "Opened the change";
  }
  return undefined;
}

function progressText(queue: string, raw: unknown, lastLine: string | undefined): string | undefined {
  if (queue === REVIEW_QUEUE_NAME) {
    const p = raw as Partial<ReviewProgress> | undefined;
    if (p && typeof p.total === "number" && p.total > 0) return `${p.completed ?? 0} of ${p.total} components`;
  }
  if (queue === APP_MAP_QUEUE_NAME) {
    const p = raw as Partial<AppMapProgress> | undefined;
    if (p && typeof p.total === "number" && p.total > 0) return `${p.done ?? 0} of ${p.total} cards`;
  }
  if (queue === PREVIEW_QUEUE_NAME) {
    const p = raw as Partial<PreviewProgress> | undefined;
    if (p?.message) return p.message;
  }
  // Analysis and the comparisons report no structured progress; their
  // newest log line is the phase they are in.
  return lastLine;
}

function resultText(row: Row, defects: number | undefined): string | undefined {
  const r = parse<Record<string, unknown>>(row.returnvalue);
  if (!r) return undefined;
  const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : undefined);
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  switch (row.queue) {
    case ANALYSIS_QUEUE_NAME:
      return n("files") !== undefined ? plural(n("files")!, "file") : undefined;
    case REVIEW_QUEUE_NAME: {
      const findings = n("findings");
      if (findings === undefined) return undefined;
      return defects ? `${plural(findings, "finding")} · ${plural(defects, "defect")}` : plural(findings, "finding");
    }
    case APP_MAP_QUEUE_NAME:
      return n("cards") !== undefined ? `${plural(n("cards")!, "card")} · ${n("explained") ?? 0} explained` : undefined;
    case TARGET_GRAPH_QUEUE_NAME:
      return n("cycles") ? plural(n("cycles")!, "new cycle") : "No new cycles";
    case PREVIEW_SCAN_QUEUE_NAME:
      return Array.isArray(r.files) ? plural(r.files.length, "file") + " to preview" : undefined;
    case PREVIEW_QUEUE_NAME:
      return Array.isArray(r.symbols) ? plural(r.symbols.length, "symbol") : undefined;
  }
  return undefined;
}

function seenKey(queue: string, id: string): string {
  return `job-seen:${queue}:${id}`;
}

/** Every job still in the table, optionally of one repo, sorted for the drawer. */
export async function listJobs(options: { repoId?: string } = {}): Promise<JobsResponse> {
  const placeholders = JOB_QUEUES.map(() => "?").join(", ");
  const rows = all<Row>(
    `SELECT queue, id, data, state, progress, returnvalue, failed_reason, seq, created_at, processed_on, finished_on
       FROM jobs WHERE queue IN (${placeholders})`,
    ...JOB_QUEUES
  );
  const repos = new Map((await listRepos()).map((repo) => [repo.id, repo]));

  // Waiting rows run in `seq` order per queue (runner.ts `claim`).
  const waiting = new Map<string, Row[]>();
  for (const row of rows) {
    if (row.state === "waiting" || row.state === "delayed") {
      const list = waiting.get(row.queue) ?? [];
      list.push(row);
      waiting.set(row.queue, list);
    }
  }
  const position = new Map<string, number>();
  for (const list of waiting.values()) {
    list.sort((a, b) => Number(a.seq) - Number(b.seq)).forEach((row, i) => position.set(`${row.queue}\0${row.id}`, i + 1));
  }

  const jobs: JobDto[] = [];
  for (const row of rows) {
    const data = parse<JobData>(row.data) ?? {};
    if (options.repoId && data.repoId !== options.repoId) continue;
    const repo = data.repoId ? repos.get(data.repoId) : undefined;
    const state = toState(row);
    const targetKey = data.target ? reviewTargetKey(data.target) : undefined;

    let lastLine: string | undefined;
    if (state === "running") {
      lastLine = get<{ line: string }>(
        `SELECT line FROM job_logs WHERE queue = ? AND job_id = ? ORDER BY seq DESC LIMIT 1`,
        row.queue,
        row.id
      )?.line;
    }
    // The worker logs "analyzing <dir> at <sha>" once the source is resolved.
    let analysingSha: string | undefined;
    if (state === "running" && row.queue === ANALYSIS_QUEUE_NAME) {
      const line = get<{ line: string }>(
        `SELECT line FROM job_logs WHERE queue = ? AND job_id = ? AND line LIKE 'analyzing % at %' ORDER BY seq DESC LIMIT 1`,
        row.queue,
        row.id
      )?.line;
      analysingSha = line ? /at ([0-9a-f]{7,40})$/.exec(line)?.[1] : undefined;
    }
    const triggeredBy = trigger(row.queue, data, state, repo, analysingSha);
    let defects: number | undefined;
    if (state === "done" && row.queue === REVIEW_QUEUE_NAME && data.repoId && targetKey) {
      defects = Number(
        get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM findings WHERE repo_id = ? AND target_key = ? AND json_extract(data, '$.assessment') = 'defect'`,
          data.repoId,
          targetKey
        )?.n ?? 0
      );
    }

    const reason = row.failed_reason ?? undefined;
    const finishedOn = row.finished_on == null ? undefined : Number(row.finished_on);
    const issue = state === "failed" && reason ? configIssue(reason) : undefined;
    const seen = state === "failed" && finishedOn !== undefined && readKv<number>(seenKey(row.queue, row.id)) === finishedOn;
    const label = row.queue === PREVIEW_QUEUE_NAME && data.filePath
      ? `${data.filePath} · ${targetLabel(data.target)}`
      : row.queue === APP_MAP_QUEUE_NAME
        ? [data.level, data.card].filter(Boolean).join(" · ") || "map"
        : row.queue === ANALYSIS_QUEUE_NAME
          ? repo
            ? `${repo.defaultBranch}${repo.lastAnalyzedSha && state !== "queued" && state !== "running" ? ` @ ${repo.lastAnalyzedSha.slice(0, 7)}` : ""}`
            : "default branch"
          : (targetLabel(data.target) ?? "");

    const pos = position.get(`${row.queue}\0${row.id}`);
    jobs.push({
      queue: row.queue,
      id: row.id,
      kind: KINDS[row.queue],
      state,
      ...(data.repoId ? { repoId: data.repoId } : {}),
      ...(repo ? { repoName: repo.name } : {}),
      target: label,
      ...(targetKey ? { targetKey } : {}),
      ...(data.filePath ? { filePath: data.filePath } : {}),
      ...(pos ? { position: pos, positionText: `${ordinal(pos)} in the ${KINDS[row.queue].toLowerCase()} queue` } : {}),
      ...(state === "running" ? { progress: progressText(row.queue, parse(row.progress), lastLine) } : {}),
      ...(state === "done" ? { result: resultText(row, defects) } : {}),
      ...(reason && state === "failed" ? { failedReason: reason } : {}),
      ...(row.state === "delayed" && reason ? { retrying: reason } : {}),
      ...(issue ? { configIssue: issue } : {}),
      ...(triggeredBy ? { trigger: triggeredBy } : {}),
      createdAt: Number(row.created_at),
      ...(row.processed_on != null ? { startedAt: Number(row.processed_on) } : {}),
      ...(finishedOn !== undefined ? { finishedAt: finishedOn } : {}),
      ...(data.repoId
        ? { href: row.queue === ANALYSIS_QUEUE_NAME ? `/repo/${encodeURIComponent(data.repoId)}` : graphHref(data.repoId, data.target) }
        : {}),
      cancellable: CANCELLABLE.has(row.queue) && (state === "running" || state === "queued"),
      retryable: (state === "failed" || state === "cancelled") && !issue && Boolean(data.repoId),
      ...(state === "failed" ? { unseen: !seen } : {}),
    });
  }

  const rank: Record<JobStateDto, number> = { running: 0, queued: 1, failed: 2, done: 3, cancelled: 4 };
  jobs.sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    if (a.state === "queued") return a.kind === b.kind ? (a.position ?? 0) - (b.position ?? 0) : a.createdAt - b.createdAt;
    return (b.finishedAt ?? b.startedAt ?? b.createdAt) - (a.finishedAt ?? a.startedAt ?? a.createdAt);
  });

  return {
    jobs,
    running: jobs.filter((j) => j.state === "running").length,
    queued: jobs.filter((j) => j.state === "queued").length,
    unseenFailed: jobs.filter((j) => j.unseen).length,
  };
}

function readRow(queue: string, id: string): Row | undefined {
  return get<Row>(
    `SELECT queue, id, data, state, progress, returnvalue, failed_reason, seq, created_at, processed_on, finished_on
       FROM jobs WHERE queue = ? AND id = ?`,
    queue,
    id
  );
}

/** The newest {@link JOB_LOG_TAIL} lines of a job's log, oldest first; `null` for an unknown job. */
export function readJobLogs(queue: string, id: string): string[] | null {
  if (!readRow(queue, id)) return null;
  return all<{ line: string }>(
    `SELECT line FROM (SELECT seq, line FROM job_logs WHERE queue = ? AND job_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
    queue,
    id,
    JOB_LOG_TAIL
  ).map((r) => r.line);
}

export type JobActionResult =
  | { ok: true; outcome: string }
  | { ok: false; status: number; error: string };

/** Delegates to the queue's own cancellation (review, app map); 409 elsewhere. */
export async function cancelJob(queue: string, id: string): Promise<JobActionResult> {
  const row = readRow(queue, id);
  if (!row) return { ok: false, status: 404, error: "No such job." };
  if (!CANCELLABLE.has(queue)) return { ok: false, status: 409, error: `${KINDS[queue] ?? queue} jobs can't be cancelled.` };
  const data = parse<JobData>(row.data) ?? {};
  if (!data.repoId) return { ok: false, status: 409, error: "The job has no repo." };
  if (queue === REVIEW_QUEUE_NAME && data.target) {
    return { ok: true, outcome: (await cancelReview(data.repoId, reviewTargetKey(data.target))).outcome };
  }
  return { ok: true, outcome: (await cancelAppMap(data.repoId)).outcome };
}

/** Re-enqueues a finished job with the same data, through the queue's own `enqueue*`. */
export async function retryJob(queue: string, id: string): Promise<JobActionResult> {
  const row = readRow(queue, id);
  if (!row) return { ok: false, status: 404, error: "No such job." };
  if (row.state !== "failed" && row.state !== "completed") return { ok: false, status: 409, error: "The job hasn't finished." };
  const data = parse<JobData & { effort?: Parameters<typeof enqueueReview>[2] }>(row.data) ?? {};
  const repoId = data.repoId;
  if (!repoId) return { ok: false, status: 409, error: "The job has no repo." };
  switch (queue) {
    case ANALYSIS_QUEUE_NAME:
      await enqueueAnalysis(repoId);
      break;
    case REVIEW_QUEUE_NAME: {
      if (!data.target) return { ok: false, status: 409, error: "The job has no target." };
      const result = await enqueueReview(repoId, data.target, data.effort ?? DEFAULT_REVIEW_EFFORT, data.only ? { only: data.only } : {});
      invalidateReviewFreshness(repoId, result.targetKey);
      break;
    }
    case APP_MAP_QUEUE_NAME:
      if (!data.level) return { ok: false, status: 409, error: "The job has no level." };
      await enqueueAppMap(repoId, data.level, data.mode ?? "full", data.card);
      break;
    case TARGET_GRAPH_QUEUE_NAME:
      if (!data.target) return { ok: false, status: 409, error: "The job has no target." };
      await ensureTargetGraph(repoId, data.target);
      break;
    case PREVIEW_SCAN_QUEUE_NAME:
      if (!data.target) return { ok: false, status: 409, error: "The job has no target." };
      await ensurePreviewScan(repoId, data.target);
      break;
    case PREVIEW_QUEUE_NAME:
      await enqueuePreview(parse<PreviewJobData>(row.data)!);
      break;
    default:
      return { ok: false, status: 409, error: "Unknown queue." };
  }
  return { ok: true, outcome: "enqueued" };
}

/** Marks failures seen — per job id + `finished_on`, so a job that fails again counts again. */
export function markJobsSeen(jobs: Array<{ queue: string; id: string }>): number {
  let marked = 0;
  for (const { queue, id } of jobs) {
    const row = readRow(queue, id);
    if (!row || row.state !== "failed" || row.finished_on == null) continue;
    writeKv(seenKey(queue, id), Number(row.finished_on), SEEN_TTL_SECONDS);
    marked++;
  }
  return marked;
}
