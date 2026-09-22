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
import { analyzeRepo, DEFAULT_MODULE_DEPTH, dirOf } from "@/lib/analysis";
import type { AnalysisResult } from "@/lib/analysis";
import {
  deleteEmptyAutoDomainComponents,
  getComponentById,
  getRepoById,
  linkComponentDependency,
  linkComponentToRepo,
  linkFileImport,
  linkFileToComponent,
  listComponentsByRepoId,
  listFilesByRepoId,
  markRepoAnalyzed,
  deleteComponent,
  deleteFile,
  runWrite,
  upsertComponent,
  upsertFile,
} from "@/lib/neo4j";
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

function componentNodeId(repoId: string, moduleName: string): string {
  return `${repoId}:module:${moduleName}`;
}

/**
 * The folder key a module cluster was derived from, recovered from one of
 * its files. `ModuleCluster.name` is the *display* name (a bare folder name,
 * or the qualified path when two folders would collide), so it can't be used
 * directly as a path pattern.
 */
function pathPatternFor(filePath: string, depth: number): string {
  const dir = dirOf(filePath);
  if (dir === "") return "*";
  return `${dir.split("/").slice(0, depth).join("/")}/**`;
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
 * Drops the derived edges of a repo's graph before they are rewritten.
 *
 * Done as two set-based statements rather than per-node `clearFileImports`
 * calls: re-analysis must also remove edges whose *source* file no longer
 * exists, and one statement per repo is both cheaper and atomic per label.
 * These are the only two raw statements in this module — every node write
 * below goes through the typed repository functions.
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
  await runWrite(
    `MATCH (:Component {repoId: $repoId})-[rel:DEPENDS_ON]->(:Component) DELETE rel`,
    { repoId }
  );
}

/**
 * Removes `File`/auto-created module `Component` nodes that the latest
 * analysis no longer sees (deleted or renamed in the repo). User-created
 * components are never touched.
 *
 * Note what this deliberately does **not** touch: the domain tier.
 * Domains come from the AI labeling pass (lib/jobs/label.ts), not from
 * static analysis, and re-analysis is frequent (it re-runs on every
 * staleness check) — so `listComponentsByRepoId(repoId, "module")` is
 * scoped to the module tier precisely so a refresh can never delete a
 * domain box or a module's `CHILD_OF` edge to one. Modules that are new
 * since the last labeling run simply render ungrouped until the next one.
 *
 * The one domain the prune *does* remove is one left with no children at
 * all: an empty dashed box grouping nothing is noise, not information.
 */
async function pruneRemovedNodes(
  repoId: string,
  liveFileIds: ReadonlySet<string>,
  liveComponentIds: ReadonlySet<string>,
  log: JobLogger
): Promise<void> {
  const [existingFiles, existingComponents] = await Promise.all([
    listFilesByRepoId(repoId),
    listComponentsByRepoId(repoId, "module"),
  ]);

  const staleFiles = existingFiles.filter((file) => !liveFileIds.has(file.id));
  const staleComponents = existingComponents.filter(
    (component) => component.createdBy === "auto" && !liveComponentIds.has(component.id)
  );

  if (staleFiles.length || staleComponents.length) {
    log(
      `pruning ${staleFiles.length} removed file(s) and ${staleComponents.length} empty module(s)`
    );
  }
  await mapWithConcurrency(staleFiles, NEO4J_WRITE_CONCURRENCY, (file) =>
    deleteFile(file.id)
  );
  await mapWithConcurrency(staleComponents, NEO4J_WRITE_CONCURRENCY, (component) =>
    deleteComponent(component.id)
  );

  // After the modules are gone, a domain that grouped only those modules has
  // nothing left under it. Runs last, and only ever affects `createdBy:
  // 'auto'` domains.
  const emptyDomains = await deleteEmptyAutoDomainComponents(repoId);
  if (emptyDomains > 0) {
    log(`pruned ${emptyDomains} domain component(s) left with no modules`);
  }
}

interface PersistCounts {
  files: number;
  components: number;
  fileEdges: number;
  componentEdges: number;
}

/** Writes an {@link AnalysisResult} into Neo4j as the component/file graph. */
export async function persistAnalysis(
  repoId: string,
  sha: string,
  result: AnalysisResult,
  moduleDepth: number,
  log: JobLogger
): Promise<PersistCounts> {
  // file path -> the component it belongs to, used both for BELONGS_TO and
  // for aggregating file edges into component edges.
  const componentIdByFile = new Map<string, string>();
  const liveComponentIds = new Set<string>();

  for (const cluster of result.modules) {
    const componentId = componentNodeId(repoId, cluster.name);
    liveComponentIds.add(componentId);
    for (const filePath of cluster.filePaths) {
      componentIdByFile.set(filePath, componentId);
    }
  }

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

  // --- Component nodes (module tier) -----------------------------------
  await mapWithConcurrency(result.modules, NEO4J_WRITE_CONCURRENCY, async (cluster) => {
    const componentId = componentNodeId(repoId, cluster.name);
    // `upsertComponent` fully replaces the node's properties, so anything the
    // user curated (descriptions live only in Neo4j and are
    // edited in-app) has to be read back and carried across, or every
    // re-analysis would silently wipe it. A component the user has taken
    // ownership of also keeps its name; only its path patterns are refreshed.
    const existing = await getComponentById(componentId);
    await upsertComponent({
      id: componentId,
      repoId,
      name: existing?.createdBy === "user" ? existing.name : cluster.name,
      description: existing?.description,
      createdBy: existing?.createdBy ?? "auto",
      pathPatterns: [pathPatternFor(cluster.filePaths[0] ?? "", moduleDepth)],
      tier: "module",
    });
    await linkComponentToRepo(componentId, repoId);
  });
  log(`upserted ${result.modules.length} module component(s)`);

  // --- BELONGS_TO -----------------------------------------------------
  await mapWithConcurrency(
    result.files,
    NEO4J_RELATIONSHIP_WRITE_CONCURRENCY,
    async (file) => {
      const componentId = componentIdByFile.get(file.file);
      if (!componentId) return;
      await linkFileToComponent(fileNodeId(repoId, file.file), componentId);
    }
  );

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

  // --- DEPENDS_ON (aggregated from the file edges) ---------------------
  // weight = number of underlying file-level edges between the two
  // components. Intra-component edges are dropped: a component depending on
  // itself carries no information in the component graph.
  const weights = new Map<string, { from: string; to: string; weight: number }>();
  for (const edge of result.edges) {
    const from = componentIdByFile.get(edge.from);
    const to = componentIdByFile.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from} -> ${to}`;
    const existing = weights.get(key);
    if (existing) existing.weight += 1;
    else weights.set(key, { from, to, weight: 1 });
  }

  const componentEdges = [...weights.values()];
  await mapWithConcurrency(
    componentEdges,
    NEO4J_RELATIONSHIP_WRITE_CONCURRENCY,
    async (edge) => {
      await linkComponentDependency(edge.from, edge.to, { weight: edge.weight });
    }
  );
  log(`wrote ${componentEdges.length} component dependency edge(s)`);

  await pruneRemovedNodes(repoId, liveFileIds, liveComponentIds, log);

  return {
    files: result.files.length,
    components: result.modules.length,
    fileEdges: result.edges.length,
    componentEdges: componentEdges.length,
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
