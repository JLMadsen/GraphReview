// The repo status indicator of DESIGN.md §4 ("analyzing… / up to date as of
// <sha> / stale, refreshing…") and the API DTO both the repo list and the
// Graph tab read.
//
// Status is derived, never stored: it combines the analysis queue's view of
// the repo (is a job pending / did the last one fail?) with the §10
// staleness comparison. Deriving it means it can't drift out of sync with
// reality the way a persisted `status` column would after a crashed worker.

import type { JobState } from "bullmq";
import { listRepos } from "@/lib/neo4j";
import type { RepoProvider, RepoRecord } from "@/lib/neo4j";
import {
  enqueueAnalysis,
  getAnalysisJobFailure,
  getAnalysisJobState,
  isPendingJobState,
} from "./queue";
import { checkAndEnqueueIfStaleForRepo } from "./staleness";

export type RepoStatus = "analyzing" | "up_to_date" | "stale" | "error";

/**
 * Wire shape of a repo. This is the exact response body of
 * `GET /api/repos/[repoId]`, and each element of `GET /api/repos`.
 * Optional fields are omitted (not `null`) when absent.
 */
export interface RepoDto {
  id: string;
  name: string;
  provider: RepoProvider;
  url?: string;
  localPath?: string;
  defaultBranch?: string;
  lastAnalyzedAt?: string;
  lastAnalyzedSha?: string;
  status: RepoStatus;
  /** Set when `status === "error"`: the BullMQ job's `failedReason` for the most recent failed analysis. */
  lastError?: string;
}

export interface RepoStatusOptions {
  /**
   * Whether a detected staleness should also *schedule* the refresh (§10's
   * auto-refresh-on-view). `true` for the detail endpoint and the repo list;
   * `false` for any read that must not cause side effects.
   */
  autoEnqueue?: boolean;
  /** Skip the network HEAD probe and treat the stored analysis as current. */
  skipRemoteCheck?: boolean;
}

/**
 * Derives a repo's §4 status indicator.
 *
 * The mapping, spelled out:
 * - a pending/active job with no previous analysis → `analyzing` ("analyzing…")
 * - a pending/active job over an existing graph    → `stale` ("stale, refreshing…")
 * - the most recent job failed                     → `error`
 * - never analyzed, nothing queued                 → enqueue, `analyzing`
 * - HEAD differs from `lastAnalyzedSha`            → enqueue, `stale`
 * - otherwise                                      → `up_to_date`
 */
export async function computeRepoStatus(
  repo: RepoRecord,
  options: RepoStatusOptions = {}
): Promise<RepoStatus> {
  const autoEnqueue = options.autoEnqueue ?? true;
  const analyzedBefore = Boolean(repo.lastAnalyzedSha);

  let jobState: JobState | "unknown" | undefined;
  try {
    jobState = await getAnalysisJobState(repo.id);
  } catch (error) {
    // Redis unreachable — report on what we do know rather than failing the
    // whole render (the settings page takes the same degrade-don't-crash line).
    console.error(
      `[repo-status] could not read job state for repo ${repo.id}: ${(error as Error).message}`
    );
    return analyzedBefore ? "up_to_date" : "error";
  }

  if (isPendingJobState(jobState)) {
    return analyzedBefore ? "stale" : "analyzing";
  }
  if (jobState === "failed") {
    // Surfaced until someone retries via POST /api/repos/[repoId]/refresh —
    // deliberately *not* auto-re-enqueued, which would hot-loop a repo that
    // fails deterministically (bad path, private repo with no PAT).
    return "error";
  }

  if (!analyzedBefore) {
    if (!autoEnqueue) return "analyzing";
    try {
      await enqueueAnalysis(repo.id);
      return "analyzing";
    } catch {
      return "error";
    }
  }

  if (options.skipRemoteCheck) return "up_to_date";

  const { stale, checked } = await checkAndEnqueueIfStaleForRepo(repo, {
    enqueue: autoEnqueue,
  });
  // A failed probe means "we couldn't tell" — keep showing the last-known
  // graph as current (§10 stale-while-revalidate), don't cry wolf.
  if (!checked) return "up_to_date";
  return stale ? "stale" : "up_to_date";
}

export function toRepoDto(
  repo: RepoRecord,
  status: RepoStatus,
  lastError?: string
): RepoDto {
  return {
    id: repo.id,
    name: repo.name,
    provider: repo.provider,
    url: repo.url || undefined,
    localPath: repo.localPath || undefined,
    defaultBranch: repo.defaultBranch || undefined,
    lastAnalyzedAt: repo.lastAnalyzedAt || undefined,
    lastAnalyzedSha: repo.lastAnalyzedSha || undefined,
    status,
    lastError: status === "error" ? lastError : undefined,
  };
}

export async function getRepoDto(
  repo: RepoRecord,
  options: RepoStatusOptions = {}
): Promise<RepoDto> {
  const status = await computeRepoStatus(repo, options);
  let lastError: string | undefined;
  if (status === "error") {
    try {
      lastError = await getAnalysisJobFailure(repo.id);
    } catch (error) {
      // Best-effort — the status badge itself still renders without a reason.
      console.error(
        `[repo-status] could not read failure reason for repo ${repo.id}: ${(error as Error).message}`
      );
    }
  }
  return toRepoDto(repo, status, lastError);
}

/** How many repos to probe concurrently when rendering the repo list. */
const LIST_STATUS_CONCURRENCY = 4;

/**
 * Every tracked repo with its status, for the landing page (§4).
 * Status probes run with bounded concurrency so a list of repos doesn't fan
 * out an unbounded number of `git ls-remote` subprocesses at once.
 */
export async function listRepoDtos(
  options: RepoStatusOptions = {}
): Promise<RepoDto[]> {
  const repos = await listRepos();
  const dtos: RepoDto[] = [];
  for (let i = 0; i < repos.length; i += LIST_STATUS_CONCURRENCY) {
    const batch = repos.slice(i, i + LIST_STATUS_CONCURRENCY);
    dtos.push(...(await Promise.all(batch.map((repo) => getRepoDto(repo, options)))));
  }
  return dtos;
}
