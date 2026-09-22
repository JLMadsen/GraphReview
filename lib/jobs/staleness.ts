// Staleness check + auto-refresh.
//
// "Opening a repo's Graph tab, or selecting a PR/ref comparison, compares
// `lastAnalyzedSha` against the current HEAD via a cheap check (`git
// ls-remote` for local/URL repos). If they differ, a background re-analysis
// job is enqueued automatically — no manual 'refresh' button to remember."
//
// This module is the shared implementation of that rule, callable from any
// route handler or server component (including the Graph tab's own
// endpoints) so the behaviour is identical wherever it is triggered. It is
// deliberately non-blocking: it never waits for the analysis, it only
// reports whether the stored graph is behind and kicks off the job.

import { getRepoById } from "@/lib/neo4j";
import type { RepoRecord } from "@/lib/neo4j";
import { enqueueAnalysis } from "./queue";
import { readCurrentSha } from "./source";

export interface StalenessResult {
  /** `true` when the stored analysis is behind the source's current HEAD (or there is no analysis yet). */
  stale: boolean;
  /** `true` when *this* call put a job on the queue (`false` if one was already pending). */
  enqueued: boolean;
  /** HEAD SHA observed now, when it could be determined cheaply. */
  currentSha?: string;
  /** SHA the stored graph was built from, when the repo has been analyzed before. */
  lastAnalyzedSha?: string;
  /**
   * `false` when the HEAD probe itself failed (offline, missing PAT, bad
   * local path). Callers should keep showing the last-known graph rather
   * than treating this as staleness — the stale-while-revalidate rule
   * says a reviewer is never blocked just to look at a PR.
   */
  checked: boolean;
}

export interface StalenessOptions {
  /** Set `false` to probe without scheduling any work (e.g. a pure status read). Defaults to `true`. */
  enqueue?: boolean;
  /**
   * A SHA the caller already knows the graph should match — e.g. a PR's head
   * SHA from the GitHub API. When given, no
   * `git ls-remote` is performed at all.
   */
  expectedSha?: string;
}

/**
 * Compares a repo's stored `lastAnalyzedSha` against its current HEAD and
 * enqueues a re-analysis when they differ. Safe to call on every page view:
 * the HEAD probe is one round trip and enqueueing is deduped per repo.
 */
export async function checkAndEnqueueIfStaleForRepo(
  repo: RepoRecord,
  options: StalenessOptions = {}
): Promise<StalenessResult> {
  const shouldEnqueue = options.enqueue ?? true;

  // Never analyzed: unambiguously stale, no probe needed.
  if (!repo.lastAnalyzedSha) {
    const enqueued = shouldEnqueue ? await enqueueSafely(repo.id) : false;
    return { stale: true, enqueued, checked: true };
  }

  const currentSha = options.expectedSha ?? (await readCurrentSha(repo));
  if (!currentSha) {
    return {
      stale: false,
      enqueued: false,
      lastAnalyzedSha: repo.lastAnalyzedSha,
      checked: false,
    };
  }

  const stale = currentSha !== repo.lastAnalyzedSha;
  const enqueued = stale && shouldEnqueue ? await enqueueSafely(repo.id) : false;

  return {
    stale,
    enqueued,
    currentSha,
    lastAnalyzedSha: repo.lastAnalyzedSha,
    checked: true,
  };
}

/**
 * `repoId` overload of {@link checkAndEnqueueIfStaleForRepo} — the entry
 * point other routes (including the Graph tab's) call. Returns
 * `{ stale: false, enqueued: false, checked: false }` for an unknown repo
 * rather than throwing, so a caller can use it as a fire-and-forget refresh
 * hook.
 */
export async function checkAndEnqueueIfStale(
  repoId: string,
  options: StalenessOptions = {}
): Promise<StalenessResult> {
  const repo = await getRepoById(repoId);
  if (!repo) return { stale: false, enqueued: false, checked: false };
  return checkAndEnqueueIfStaleForRepo(repo, options);
}

/**
 * Enqueue without letting a Redis outage break the caller's render — the
 * failure is logged, and the repo simply reports as stale until the queue is
 * reachable again.
 */
async function enqueueSafely(repoId: string): Promise<boolean> {
  try {
    const { enqueued } = await enqueueAnalysis(repoId);
    return enqueued;
  } catch (error) {
    console.error(
      `[staleness] failed to enqueue analysis for repo ${repoId}: ${(error as Error).message}`
    );
    return false;
  }
}
