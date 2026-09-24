// Writing the module tier (DESIGN.md §6.3).
//
// One function owns module membership: `writeModuleTier`. The analysis job
// calls it with fresh folder clusters; `regroupRepo` calls it with clusters
// rebuilt from the graph already stored in Neo4j, after the user accepted a
// merge or unmerged one. Either way it:
//
//   1. resolves which component owns each file (./ownership.ts — merged
//      feature modules claim files out of folder modules);
//   2. upserts folder modules, and updates/deletes merged modules whose
//      folders disappeared (remembering them for rename detection);
//   3. rewrites BELONGS_TO (only the files whose owner changed) and DEPENDS_ON;
//   4. prunes folder modules left with no files;
//   5. lets a module without a domain inherit the domain most of its files
//      were in before, and flags the domain tier as stale when that happens;
//   6. moves findings along with their files;
//   7. refreshes the free merge suggestions.
//
// Deliberately free of lib/analysis's parser: `regroupRepo` runs inside an
// API route, and only `clusterByFolderDepth` (pure) is needed from there.

import { clusterByFolderDepth, DEFAULT_MODULE_DEPTH } from "@/lib/analysis/graph-builder";
import type { ModuleCluster } from "@/lib/analysis/graph-builder";
import { dirOf } from "@/lib/analysis/paths";
import {
  deleteComponent,
  deleteEmptyAutoDomainComponents,
  getComponentById,
  getDomainByModule,
  getFileOwnerMap,
  getStoredImportGraph,
  linkComponentChildOf,
  linkComponentToRepo,
  listComponentsByRepoId,
  listMergedModules,
  relinkFindings,
  replaceComponentDependencies,
  setFileOwners,
  setRepoDomainsStale,
  syncMergeSuggestions,
  upsertComponent,
} from "@/lib/neo4j";
import type { ComponentRecord, LostFolder } from "@/lib/neo4j";
import type { JobLogger } from "./analyze";
import { computeMergeSuggestions, type HeuristicModule } from "./merge-heuristics";
import { folderOfPattern, isUnderFolder, resolveOwnership } from "./ownership";

/** Node upserts can run in parallel (each targets its own id); see analyze.ts. */
const NEO4J_WRITE_CONCURRENCY = 16;
/** How many lost folders a merged module remembers for rename detection. */
const MAX_LOST_FOLDERS = 10;

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
 * The folder pattern a module cluster was derived from, recovered from one
 * of its files. `ModuleCluster.name` is the *display* name (a bare folder
 * name, or the qualified path when two folders would collide), so it can't
 * be used directly as a path pattern.
 */
export function pathPatternFor(filePath: string, depth: number): string {
  const dir = dirOf(filePath);
  if (dir === "") return "*";
  return `${dir.split("/").slice(0, depth).join("/")}/**`;
}

export function parseLostFolders(raw: string | undefined): LostFolder[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as LostFolder[]) : [];
  } catch {
    return [];
  }
}

function baseName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

export interface ModuleTierInput {
  repoId: string;
  filePaths: readonly string[];
  edges: ReadonlyArray<{ from: string; to: string }>;
  folderClusters: readonly ModuleCluster[];
  moduleDepth: number;
  log: JobLogger;
}

export interface ModuleTierCounts {
  components: number;
  componentEdges: number;
  openSuggestions: number;
}

export async function writeModuleTier(input: ModuleTierInput): Promise<ModuleTierCounts> {
  const { repoId, edges, folderClusters, moduleDepth, log } = input;

  const [mergedModules, previousOwners, domainByModule] = await Promise.all([
    listMergedModules(repoId),
    getFileOwnerMap(repoId),
    getDomainByModule(repoId),
  ]);
  const ownership = resolveOwnership(repoId, folderClusters, mergedModules);

  // --- folder modules --------------------------------------------------
  await mapWithConcurrency(ownership.liveFolderModules, NEO4J_WRITE_CONCURRENCY, async ({ id, cluster }) => {
    // `upsertComponent` fully replaces the node's properties, so anything the
    // user curated (descriptions live only in Neo4j and are edited in-app)
    // has to be read back and carried across, or every re-analysis would
    // silently wipe it. A component the user has taken ownership of also
    // keeps its name; only its path patterns are refreshed.
    const existing = await getComponentById(id);
    await upsertComponent({
      id,
      repoId,
      name: existing?.createdBy === "user" ? existing.name : cluster.name,
      description: existing?.description,
      createdBy: existing?.createdBy ?? "auto",
      pathPatterns: [pathPatternFor(cluster.filePaths[0] ?? "", moduleDepth)],
      tier: "module",
      origin: "folder",
    });
    await linkComponentToRepo(id, repoId);
  });

  // --- merged modules --------------------------------------------------
  const liveMerged: ComponentRecord[] = [];
  for (const merged of mergedModules) {
    const owned = ownership.filesByMergedId.get(merged.id) ?? [];
    if (owned.length === 0) {
      log(`merged module "${merged.name}" matches no files any more — removing it`);
      await deleteComponent(merged.id);
      continue;
    }
    const dead = ownership.deadPatternsByMergedId.get(merged.id) ?? [];
    if (dead.length === 0) {
      liveMerged.push(merged);
      continue;
    }

    // Remember vanished folders (with their file names) so a rename can be
    // suggested back; exact file paths that vanished are simply dropped.
    const now = new Date().toISOString();
    const lost: LostFolder[] = dead.flatMap((pattern) => {
      const dir = folderOfPattern(pattern);
      if (dir === null) return [];
      const fileNames = [...previousOwners]
        .filter(([path, owner]) => owner === merged.id && isUnderFolder(path, dir))
        .map(([path]) => baseName(path));
      return [{ pattern, fileNames, lostAt: now }];
    });
    const lostFolders = [...parseLostFolders(merged.lostFolders), ...lost].slice(-MAX_LOST_FOLDERS);
    const updated: ComponentRecord = {
      ...merged,
      pathPatterns: merged.pathPatterns.filter((p) => !dead.includes(p)),
      lostFolders: JSON.stringify(lostFolders),
    };
    log(`merged module "${merged.name}": dropped ${dead.length} vanished pattern(s)`);
    await upsertComponent(updated);
    liveMerged.push(updated);
  }

  // --- BELONGS_TO (only what changed) ------------------------------------
  const changedOwners: Array<{ path: string; componentId: string }> = [];
  for (const [path, componentId] of ownership.componentIdByFile) {
    if (previousOwners.get(path) !== componentId) changedOwners.push({ path, componentId });
  }
  await setFileOwners(repoId, changedOwners);
  if (changedOwners.length > 0) log(`assigned ${changedOwners.length} file(s) to a new module`);

  // --- DEPENDS_ON (aggregated from the file edges) -----------------------
  // weight = number of underlying file-level edges between the two
  // components. Intra-component edges are dropped: a component depending on
  // itself carries no information in the component graph.
  const weights = new Map<string, { from: string; to: string; weight: number }>();
  for (const edge of edges) {
    const from = ownership.componentIdByFile.get(edge.from);
    const to = ownership.componentIdByFile.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from} -> ${to}`;
    const existing = weights.get(key);
    if (existing) existing.weight += 1;
    else weights.set(key, { from, to, weight: 1 });
  }
  const componentEdges = [...weights.values()];
  await replaceComponentDependencies(repoId, componentEdges);
  log(`wrote ${componentEdges.length} component dependency edge(s)`);

  // --- prune folder modules left with no files ----------------------------
  // Only auto folder modules: merged modules were handled above, and a
  // user-owned folder module is never deleted automatically.
  const liveIds = new Set([
    ...ownership.liveFolderModules.map((m) => m.id),
    ...liveMerged.map((m) => m.id),
  ]);
  const stale = (await listComponentsByRepoId(repoId, "module")).filter(
    (c) => c.createdBy === "auto" && c.origin !== "merge" && !liveIds.has(c.id)
  );
  if (stale.length > 0) log(`pruning ${stale.length} module(s) with no files left`);
  await mapWithConcurrency(stale, NEO4J_WRITE_CONCURRENCY, (c) => deleteComponent(c.id));

  // --- domain inheritance -----------------------------------------------
  // A module without a domain whose files used to sit in modules that had
  // one (a fresh merge, or folder modules back after an Unmerge) joins the
  // domain most of those files were in. Serial: relationship writes.
  let inherited = 0;
  const filesByOwner = new Map<string, string[]>();
  for (const [path, owner] of ownership.componentIdByFile) {
    const list = filesByOwner.get(owner);
    if (list) list.push(path);
    else filesByOwner.set(owner, [path]);
  }
  for (const id of liveIds) {
    if (domainByModule.has(id)) continue;
    const votes = new Map<string, number>();
    for (const path of filesByOwner.get(id) ?? []) {
      const previous = previousOwners.get(path);
      const domain = previous ? domainByModule.get(previous) : undefined;
      if (domain) votes.set(domain, (votes.get(domain) ?? 0) + 1);
    }
    const winner = [...votes].sort((a, b) => b[1] - a[1])[0];
    if (!winner) continue;
    await linkComponentChildOf(id, winner[0]);
    inherited++;
  }
  if (inherited > 0) {
    await setRepoDomainsStale(repoId, true);
    log(`${inherited} module(s) inherited a domain — domain grouping marked for regrouping`);
  }

  // After the modules are gone, a domain that grouped only those modules has
  // nothing left under it. Only ever affects `createdBy: 'auto'` domains.
  const emptyDomains = await deleteEmptyAutoDomainComponents(repoId);
  if (emptyDomains > 0) log(`pruned ${emptyDomains} domain component(s) left with no modules`);

  // --- findings follow their files ----------------------------------------
  const movedFindings = await relinkFindings(repoId);
  if (movedFindings > 0) log(`moved ${movedFindings} finding(s) to the module that now owns their file`);

  // --- suggestions (free heuristics; never fails the caller) ---------------
  let openSuggestions = 0;
  try {
    const modules: HeuristicModule[] = [
      ...ownership.liveFolderModules.map(({ id, cluster }) => ({
        id,
        name: cluster.name,
        origin: "folder" as const,
        pathPatterns: [pathPatternFor(cluster.filePaths[0] ?? "", moduleDepth)],
      })),
      ...liveMerged.map((m) => ({
        id: m.id,
        name: m.name,
        origin: "merge" as const,
        pathPatterns: m.pathPatterns,
        lostFolders: parseLostFolders(m.lostFolders),
      })),
    ];
    const suggestions = computeMergeSuggestions({
      filePaths: input.filePaths,
      edges,
      ownerByFile: ownership.componentIdByFile,
      modules,
      moduleDepth,
    });
    openSuggestions = await syncMergeSuggestions(repoId, suggestions);
    log(`${openSuggestions} open merge suggestion(s)`);
  } catch (error) {
    log(`merge suggestions skipped: ${(error as Error).message}`);
  }

  return { components: liveIds.size, componentEdges: componentEdges.length, openSuggestions };
}

/**
 * Re-applies module membership from the graph already stored in Neo4j — no
 * checkout, no parsing. Runs after the user accepts a merge suggestion or
 * unmerges a module, so the change shows up immediately.
 */
export async function regroupRepo(repoId: string, log: JobLogger): Promise<ModuleTierCounts> {
  const { filePaths, edges } = await getStoredImportGraph(repoId);
  return writeModuleTier({
    repoId,
    filePaths,
    edges,
    folderClusters: clusterByFolderDepth(filePaths, DEFAULT_MODULE_DEPTH),
    moduleDepth: DEFAULT_MODULE_DEPTH,
    log,
  });
}
