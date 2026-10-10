// The analysis job body.
//
// Pipeline: resolve the repo's source on disk and its default branch's tip
// commit → analyse that commit (lib/analysis `analyzeCommit`, through
// ./commit-analysis.ts: read from git objects, parses cached by blob) →
// persist the resulting graph through lib/db's typed repository functions →
// record `lastAnalyzedAt`/`lastAnalyzedSha`/`analysisVersion`.
//
// Kept out of `worker/index.ts` on purpose: the worker entrypoint is just
// job-runner plumbing, while this is the actual unit of work, importable from a
// script or test without starting a queue consumer.

import { UnrecoverableError } from "./runner";
import type { AnalysisResult } from "@/lib/analysis";
import { analyzeRepoCommit } from "./commit-analysis";
import {
  clearRepoFileImports,
  deleteFiles,
  getRepoById,
  linkFileImports,
  listFilesByRepoId,
  markRepoAnalyzed,
  setRepoDefaultBranch,
  upsertFiles,
  writeApiCatalog,
  writeInfraCatalog,
  writeDbSchema,
} from "@/lib/db";
import { writeModuleTier } from "./module-tier";
import { ANALYSIS_VERSION, type AnalysisJobResult } from "./queue";
import { LocalPathOutsideRootError, RepoAccessError, prepareRepoSource, readLocalDefaultBranch, validateLocalRepoPath } from "./source";

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
      weight: edge.weight,
      typeOnly: edge.typeOnly,
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

  // Local repos added before graphs followed the default branch stored the
  // branch that happened to be checked out then; detect it properly once.
  if (repo.provider === "local" && repo.analysisVersion === undefined && repo.localPath) {
    try {
      const detected = await readLocalDefaultBranch(await validateLocalRepoPath(repo.localPath));
      if (detected && detected !== repo.defaultBranch) {
        log(`default branch is ${detected}, not ${repo.defaultBranch} — updating`);
        await setRepoDefaultBranch(repo.id, detected);
        repo.defaultBranch = detected;
      }
    } catch {
      /* keep the stored one */
    }
  }

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

  let lastLogged = 0;
  const result = await analyzeRepoCommit(dir, sha, ({ analyzed, total }) => {
    if (analyzed - lastLogged >= 500) {
      lastLogged = analyzed;
      log(`parsed ${analyzed} of ${total} file(s)`);
    }
  });
  const skipped = result.skipped;
  log(
    `static analysis done: ${result.files.length} file(s) (${result.cached} from the cache), ` +
      `${result.edges.length} import edge(s), ${result.symbols.decls.length} declaration(s), ` +
      `${result.symbols.calls.length} resolved call(s), ${result.modules.length} module(s), ` +
      `${result.externalPackages.length} external package(s)` +
      (skipped.binary + skipped.large + skipped.failed > 0
        ? `; skipped ${skipped.binary} binary, ${skipped.large} oversized, ${skipped.failed} unparseable`
        : "")
  );

  const counts = await persistAnalysis(repo.id, sha, result, log);
  writeApiCatalog(repo.id, sha, result.api);
  log(
    `endpoint catalog: ${result.api.endpoints.length} endpoint(s)` +
      (result.api.frameworks.length ? ` (${result.api.frameworks.join(", ")})` : "") +
      (result.api.specs.length ? `, ${result.api.specs.length} OpenAPI document(s)` : "")
  );
  writeInfraCatalog(repo.id, sha, result.infra);
  log(
    `infra catalog: ${result.infra.resources.length} resource(s) in ${result.infra.stacks.length} stack(s)` +
      (result.infra.tools.length ? ` (${result.infra.tools.join(", ")})` : "") +
      (result.infra.links.deploys.length ? `, ${result.infra.links.deploys.filter((d) => d.resolved).length}/${result.infra.links.deploys.length} deploy link(s) resolved` : "")
  );
  writeDbSchema(repo.id, sha, result.db);
  log(
    `schema catalog: ${result.db.databases.reduce((n, d) => n + d.tables.length, 0)} table(s) in ${result.db.databases.length} database(s)` +
      (result.db.databases.length ? ` (${[...new Set(result.db.databases.flatMap((d) => d.tools))].join(", ")})` : "") +
      `, ${result.db.databases.reduce((n, d) => n + d.migrations.length, 0)} migration(s), ${result.db.uses.length} use(s) in code` +
      (result.db.databases.some((d) => d.orderProblems.length) ? `; order problems: ${result.db.databases.flatMap((d) => d.orderProblems).slice(0, 3).join(" | ")}` : "")
  );
  await markRepoAnalyzed(repo.id, sha, ANALYSIS_VERSION);

  const durationMs = Date.now() - startedAt;
  log(`persisted graph and marked repo analyzed at ${sha.slice(0, 12)} in ${durationMs}ms`);

  return { repoId: repo.id, sha, durationMs, ...counts };
}
