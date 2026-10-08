// Analysing one commit of a repo, with the parse cache in the database and
// the last few results kept in memory.
//
// The repo's own graph is the default branch's tip (./analyze.ts); a review
// target also needs its merge-base and head (./target-graph.ts, and the
// review's impact pass). Each is `analyzeCommit` from lib/analysis: files
// whose blob was parsed before — at any commit — come from the cache, so a
// PR's head costs only the files it changed. The in-memory memo lets the
// target-graph job and a review that runs right after share one result.
//
// Server-only, worker-only in practice (pulls in lib/analysis). Kept out of
// lib/jobs' barrel for that reason.

import path from "node:path";
import { analyzeCommit, DEFAULT_MODULE_DEPTH, type AnalysisResult, type CachedParse, type ParseCache } from "@/lib/analysis";
import { readParseCache, writeParseCache } from "@/lib/db";

export const dbParseCache: ParseCache = {
  async getMany(keys) {
    return readParseCache<CachedParse>(keys);
  },
  async setMany(entries) {
    writeParseCache(entries);
  },
};

/** Analyses kept in memory — each can be large (every declaration of the repo). */
const MEMO_SIZE = 3;
const MEMO_KEY = Symbol.for("graphreview.jobs.commit-analysis");

function memo(): Map<string, Promise<AnalysisResult>> {
  const g = globalThis as typeof globalThis & { [MEMO_KEY]?: Map<string, Promise<AnalysisResult>> };
  g[MEMO_KEY] ??= new Map();
  return g[MEMO_KEY];
}

/** The analysis of commit `sha` of the repository at `repoDir`. */
export function analyzeRepoCommit(
  repoDir: string,
  sha: string,
  onProgress?: (progress: { analyzed: number; total: number; file: string }) => void
): Promise<AnalysisResult> {
  const results = memo();
  const key = `${path.resolve(repoDir)}\u0000${sha}`;
  const existing = results.get(key);
  if (existing) {
    // Most recently used goes last.
    results.delete(key);
    results.set(key, existing);
    return existing;
  }
  const pending = analyzeCommit(repoDir, sha, { moduleDepth: DEFAULT_MODULE_DEPTH, cache: dbParseCache, onProgress });
  results.set(key, pending);
  pending.catch(() => results.delete(key));
  while (results.size > MEMO_SIZE) results.delete(results.keys().next().value!);
  return pending;
}
