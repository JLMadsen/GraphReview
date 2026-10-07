// The analysis job body.
//
// Pipeline: resolve the repo's source on disk → `analyzeRepo()` from
// lib/analysis → persist the resulting graph through lib/db's typed
// repository functions → record `lastAnalyzedAt`/`lastAnalyzedSha`.
//
// Kept out of `worker/index.ts` on purpose: the worker entrypoint is just
// job-runner plumbing, while this is the actual unit of work, importable from a
// script or test without starting a queue consumer.

import { UnrecoverableError } from "./runner";
import { analyzeRepo, DEFAULT_MODULE_DEPTH } from "@/lib/analysis";
import type { AnalysisResult } from "@/lib/analysis";
import {
  clearRepoFileImports,
  deleteFiles,
  getRepoById,
  linkFileImports,
  listFilesByRepoId,
  markRepoAnalyzed,
  upsertFiles,
} from "@/lib/db";
import { writeModuleTier } from "./module-tier";
import type { AnalysisJobResult } from "./queue";
import { LocalPathOutsideRootError, RepoAccessError, prepareRepoSource } from "./source";

export type JobLogger = (message: string) => void;

function fileNodeId(repoId: string, filePath: string): string {
  return `${repoId}:${filePath}`;
}

/**
 * Drops the file-level import edges of a repo's graph before they are
 * rewritten — including edges whose *source* file no longer exists.
 *
 * Note the deliberate trade-off: for the duration of a re-analysis the
 * repo's edges are missing rather than stale. A job takes seconds, so a
 * short edgeless window is preferred over keeping removed edges around
 * until the very end and having to diff them precisely.
 */
async function clearDerivedEdges(repoId: string): Promise<void> {
  await clearRepoFileImports(repoId);
  // DEPENDS_ON is replaced by writeModuleTier (./module-tier.ts).
}

/**
 * Removes stored files that the latest analysis no longer sees (deleted or
 * renamed in the repo). Modules left with no files are pruned by
 * writeModuleTier (./module-tier.ts), which also owns the rule that
 * re-analysis never touches the domain tier beyond removing empty domains.
 */
async function pruneRemovedFiles(
  repoId: string,
  liveFileIds: ReadonlySet<string>,
  log: JobLogger
): Promise<void> {
  const staleFiles = (await listFilesByRepoId(repoId)).filter((file) => !liveFileIds.has(file.id));
  if (staleFiles.length > 0) log(`pruning ${staleFiles.length} removed file(s)`);
  await deleteFiles(staleFiles.map((file) => file.id));
}

interface PersistCounts {
  files: number;
  components: number;
  fileEdges: number;
  componentEdges: number;
}

/** Writes an {@link AnalysisResult} into the database as the component/file graph. */
export async function persistAnalysis(
  repoId: string,
  sha: string,
  result: AnalysisResult,
  log: JobLogger
): Promise<PersistCounts> {
  const liveFileIds = new Set(
    result.files.map((file) => fileNodeId(repoId, file.file))
  );

  await clearDerivedEdges(repoId);

  // --- Files ----------------------------------------------------------
  await upsertFiles(
    result.files.map((file) => ({
      id: fileNodeId(repoId, file.file),
      repoId,
      path: file.file,
      language: file.language,
      loc: file.loc,
      lastSeenCommit: sha,
    }))
  );
  log(`upserted ${result.files.length} file(s)`);

  // --- IMPORTS --------------------------------------------------------
  await linkFileImports(
    result.edges.map((edge) => ({
      fromFileId: fileNodeId(repoId, edge.from),
      toFileId: fileNodeId(repoId, edge.to),
      kind: edge.kind,
    }))
  );
  log(`wrote ${result.edges.length} file import edge(s)`);

  // --- Module tier: folder modules, merged feature modules, BELONGS_TO,
  // DEPENDS_ON and findings (./module-tier.ts). Merge suggestions are not
  // refreshed here while nothing shows them (docs/ideas.md). --------------
  const moduleTier = await writeModuleTier({
    repoId,
    edges: result.edges,
    folderClusters: result.modules,
    log,
  });

  await pruneRemovedFiles(repoId, liveFileIds, log);

  return {
    files: result.files.length,
    fileEdges: result.edges.length,
    ...moduleTier,
  };
}

/**
 * Runs one full analysis for a repo. Throws on failure — the job runner's
 * retry policy owns what happens next; nothing here swallows an error.
 * Failures that retrying cannot possibly fix (repo deleted, path outside the
 * allowed folder, no access to a private repo) are raised as `UnrecoverableError` so they fail fast instead of
 * burning three attempts.
 */
export async function runAnalysisJob(
  repoId: string,
  log: JobLogger = (message) => console.log(`[analysis] ${message}`)
): Promise<AnalysisJobResult> {
  const startedAt = Date.now();

  const repo = await getRepoById(repoId);
  if (!repo) {
    throw new UnrecoverableError(`Repo ${repoId} no longer exists — nothing to analyze.`);
  }
  log(`repo ${repo.name} (${repo.provider}) — resolving source`);

  let dir: string;
  let sha: string;
  try {
    ({ dir, sha } = await prepareRepoSource(repo, log));
  } catch (error) {
    if (error instanceof LocalPathOutsideRootError || error instanceof RepoAccessError) {
      throw new UnrecoverableError(error.message);
    }
    throw error;
  }
  log(`analyzing ${dir} at ${sha.slice(0, 12)}`);

  const result = await analyzeRepo(dir, { moduleDepth: DEFAULT_MODULE_DEPTH });
  log(
    `static analysis done: ${result.files.length} file(s), ${result.edges.length} import edge(s), ` +
      `${result.modules.length} module(s), ${result.externalPackages.length} external package(s)`
  );

  const counts = await persistAnalysis(repo.id, sha, result, log);
  await markRepoAnalyzed(repo.id, sha);

  const durationMs = Date.now() - startedAt;
  log(`persisted graph and marked repo analyzed at ${sha.slice(0, 12)} in ${durationMs}ms`);

  return { repoId: repo.id, sha, durationMs, ...counts };
}
