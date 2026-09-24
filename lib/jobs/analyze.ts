// The analysis job body.
//
// Pipeline: resolve the repo's source on disk → `analyzeRepo()` from
// lib/analysis → persist the resulting graph through lib/neo4j's typed
// repository functions → record `lastAnalyzedAt`/`lastAnalyzedSha`.
//
// Kept out of `worker/index.ts` on purpose: the worker entrypoint is just
// BullMQ plumbing, while this is the actual unit of work, importable from a
// script or test without starting a queue consumer.

import { UnrecoverableError } from "bullmq";
import { analyzeRepo, DEFAULT_MODULE_DEPTH } from "@/lib/analysis";
import type { AnalysisResult } from "@/lib/analysis";
import {
  getRepoById,
  linkFileImport,
  listFilesByRepoId,
  markRepoAnalyzed,
  deleteFile,
  runWrite,
  upsertFile,
} from "@/lib/neo4j";
import { writeModuleTier } from "./module-tier";
import type { AnalysisJobResult } from "./queue";
import { LocalPathOutsideRootError, prepareRepoSource } from "./source";

export type JobLogger = (message: string) => void;

/** How many Neo4j writes to keep in flight. The repository layer runs one statement per call, so persistence is round-trip bound; a small fixed fan-out keeps a big repo from taking minutes without flooding the driver's pool. Safe for node upserts (each targets its own `id`, so parallel MERGEs don't contend). */
const NEO4J_WRITE_CONCURRENCY = 16;

/**
 * Concurrency for writes that create a *relationship* (`BELONGS_TO`,
 * `IMPORTS`, `DEPENDS_ON`) rather than just a node. These MERGE two
 * existing nodes together, and it's common for many edges to share an
 * endpoint (a widely-imported file, a heavily-depended-on component) — run
 * more than one of those in parallel under Neo4j Community's pessimistic
 * (Forseti) locking and you get real deadlocks, not just contention, once a
 * repo has more than a couple hundred edges. Serial is the only fully safe
 * option without moving to batched `UNWIND` writes.
 */
const NEO4J_RELATIONSHIP_WRITE_CONCURRENCY = 1;

function fileNodeId(repoId: string, filePath: string): string {
  return `${repoId}:${filePath}`;
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}

/**
 * Drops the file-level import edges of a repo's graph before they are rewritten.
 *
 * Done as one set-based statement rather than per-node `clearFileImports`
 * calls: re-analysis must also remove edges whose *source* file no longer
 * exists, and one statement per repo is both cheaper and atomic. This is the
 * only raw statement in this module — every node write below goes through
 * the typed repository functions.
 *
 * Note the deliberate trade-off: for the duration of a re-analysis the
 * repo's edges are missing rather than stale. The stale-while-revalidate
 * promise is about *not blocking* the reviewer, and a job takes seconds, so
 * a short edgeless window is preferred over the alternative (keeping removed
 * edges around until the very end and having to diff them precisely).
 */
async function clearDerivedEdges(repoId: string): Promise<void> {
  await runWrite(
    `MATCH (:File {repoId: $repoId})-[rel:IMPORTS]->(:File) DELETE rel`,
    { repoId }
  );
  // DEPENDS_ON is replaced by writeModuleTier (./module-tier.ts).
}

/**
 * Removes `File` nodes that the latest analysis no longer sees (deleted or
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
  await mapWithConcurrency(staleFiles, NEO4J_WRITE_CONCURRENCY, (file) => deleteFile(file.id));
}

interface PersistCounts {
  files: number;
  components: number;
  fileEdges: number;
  componentEdges: number;
  openSuggestions: number;
}

/** Writes an {@link AnalysisResult} into Neo4j as the component/file graph. */
export async function persistAnalysis(
  repoId: string,
  sha: string,
  result: AnalysisResult,
  moduleDepth: number,
  log: JobLogger
): Promise<PersistCounts> {
  const liveFileIds = new Set(
    result.files.map((file) => fileNodeId(repoId, file.file))
  );

  await clearDerivedEdges(repoId);

  // --- File nodes -----------------------------------------------------
  await mapWithConcurrency(result.files, NEO4J_WRITE_CONCURRENCY, async (file) => {
    await upsertFile({
      id: fileNodeId(repoId, file.file),
      repoId,
      path: file.file,
      language: file.language,
      loc: file.loc,
      lastSeenCommit: sha,
    });
  });
  log(`upserted ${result.files.length} file node(s)`);

  // --- IMPORTS --------------------------------------------------------
  await mapWithConcurrency(
    result.edges,
    NEO4J_RELATIONSHIP_WRITE_CONCURRENCY,
    async (edge) => {
      await linkFileImport(
        fileNodeId(repoId, edge.from),
        fileNodeId(repoId, edge.to),
        { kind: edge.kind }
      );
    }
  );
  log(`wrote ${result.edges.length} file import edge(s)`);

  // --- Module tier: folder modules, merged feature modules, BELONGS_TO,
  // DEPENDS_ON, findings and merge suggestions (./module-tier.ts) --------
  const moduleTier = await writeModuleTier({
    repoId,
    filePaths: result.files.map((file) => file.file),
    edges: result.edges,
    folderClusters: result.modules,
    moduleDepth,
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
 * Runs one full analysis for a repo. Throws on failure — BullMQ's retry
 * policy owns what happens next; nothing here swallows an error.
 * Failures that retrying cannot possibly fix (repo deleted, path outside the
 * bind mount) are raised as `UnrecoverableError` so they fail fast instead of
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
    if (error instanceof LocalPathOutsideRootError) {
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

  const counts = await persistAnalysis(repo.id, sha, result, DEFAULT_MODULE_DEPTH, log);
  await markRepoAnalyzed(repo.id, sha);

  const durationMs = Date.now() - startedAt;
  log(`persisted graph and marked repo analyzed at ${sha.slice(0, 12)} in ${durationMs}ms`);

  return { repoId: repo.id, sha, durationMs, ...counts };
}
