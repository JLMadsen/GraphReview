// The pinned schema source (DESIGN.md §6.13, pinned source): every path of
// the repo's analysed commit, for the Data view's file search, and changing
// the pin — which re-runs the analysis and drops the stored comparisons so
// every review target re-reads the schema from the new source.
//
// Kept out of lib/jobs' barrel: only the db-schema routes need it.

import { clearDbSource, deleteTargetGraphsForRepo, writeDbSource, type DbSourcePin, type RepoRecord } from "@/lib/db";
import { enqueueAnalysis } from "./queue";
import { sourceDir } from "./review-context";
import { gitIn } from "./source";

/** A repo this big is cut off for the search (and says so). */
const MAX_FILES = 100_000;

/** Every file path at the last analysed commit; `null` when there is no checkout to read. */
export async function listAnalysedFiles(repo: RepoRecord): Promise<{ sha: string; files: string[]; truncated: boolean } | null> {
  const dir = await sourceDir(repo);
  if (!dir) return null;
  const git = gitIn(dir, 60_000, ["safe.directory=*"]);
  const sha =
    repo.lastAnalyzedSha && /^[0-9a-f]{7,64}$/.test(repo.lastAnalyzedSha) ? repo.lastAnalyzedSha : (await git.raw(["rev-parse", "HEAD"])).trim();
  const listing = await git.raw(["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha]);
  const files = listing.split("\0").filter(Boolean);
  return { sha, files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}

/** Pins `file` (or clears the pin with `null`), then re-analyses and lets every target recompute. */
export async function setSchemaSource(repo: RepoRecord, file: string | null): Promise<{ pin: DbSourcePin | null; enqueued: boolean }> {
  const pin = file ? writeDbSource(repo.id, file) : (clearDbSource(repo.id), null);
  deleteTargetGraphsForRepo(repo.id);
  const { enqueued } = await enqueueAnalysis(repo.id);
  return { pin, enqueued };
}
