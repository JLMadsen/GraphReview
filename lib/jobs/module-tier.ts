// Writing the module tier (DESIGN.md §6.3).
//
// One function owns module membership: `writeModuleTier`, which the
// analysis job calls with fresh folder clusters. It:
//
//   1. resolves which component owns each file (./ownership.ts — merged
//      feature modules claim files out of folder modules);
//   2. upserts folder modules, and updates/deletes merged modules whose
//      folders disappeared;
//   3. rewrites BELONGS_TO (only the files whose owner changed) and DEPENDS_ON;
//   4. prunes folder modules left with no files;
//   5. lets a module without a domain inherit the domain most of its files
//      were in before;
//   6. moves findings along with their files.
//
// Merged modules are the ones a user accepted from the merge suggestions,
// which were removed with the Repo view (docs/ideas.md); those already
// accepted stay in effect.

import type { ModuleCluster } from "@/lib/analysis/graph-builder";
import {
  deleteComponent,
  deleteEmptyAutoDomainComponents,
  getComponentById,
  getDomainByModule,
  getFileOwnerMap,
  linkComponentChildOf,
  listComponentsByRepoId,
  listMergedModules,
  relinkFindings,
  replaceComponentDependencies,
  setFileOwners,
  upsertComponent,
} from "@/lib/db";
import type { ComponentRecord } from "@/lib/db";
import type { JobLogger } from "./analyze";
import { pathPatternsFor, resolveOwnership } from "./ownership";

export interface ModuleTierInput {
  repoId: string;
  edges: ReadonlyArray<{ from: string; to: string; weight?: number }>;
  folderClusters: readonly ModuleCluster[];
  log: JobLogger;
}

export interface ModuleTierCounts {
  components: number;
  componentEdges: number;
}

export async function writeModuleTier(input: ModuleTierInput): Promise<ModuleTierCounts> {
  const { repoId, edges, folderClusters, log } = input;

  const [mergedModules, previousOwners, domainByModule] = await Promise.all([
    listMergedModules(repoId),
    getFileOwnerMap(repoId),
    getDomainByModule(repoId),
  ]);
  const ownership = resolveOwnership(repoId, folderClusters, mergedModules);

  // --- folder modules --------------------------------------------------
  for (const { id, cluster } of ownership.liveFolderModules) {
    // `upsertComponent` fully replaces the stored record, so anything the
    // user curated (descriptions live only in the database and are edited in-app)
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
      pathPatterns: pathPatternsFor(cluster),
      tier: "module",
      origin: "folder",
    });
  }

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

    const updated: ComponentRecord = { ...merged, pathPatterns: merged.pathPatterns.filter((p) => !dead.includes(p)) };
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
  // weight = how much the files of one use the other: the lines they refer
  // to its names on (lib/analysis/symbols.ts), 1 per file edge for languages
  // without names — summed over the underlying file-level edges between the two
  // components. Intra-component edges are dropped: a component depending on
  // itself carries no information in the component graph.
  const weights = new Map<string, { from: string; to: string; weight: number }>();
  for (const edge of edges) {
    const from = ownership.componentIdByFile.get(edge.from);
    const to = ownership.componentIdByFile.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from} -> ${to}`;
    const existing = weights.get(key);
    const weight = edge.weight ?? 1;
    if (existing) existing.weight += weight;
    else weights.set(key, { from, to, weight });
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
  for (const c of stale) await deleteComponent(c.id);

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
  if (inherited > 0) log(`${inherited} module(s) inherited a domain`);

  // After the modules are gone, a domain that grouped only those modules has
  // nothing left under it. Only ever affects `createdBy: 'auto'` domains.
  const emptyDomains = await deleteEmptyAutoDomainComponents(repoId);
  if (emptyDomains > 0) log(`pruned ${emptyDomains} domain component(s) left with no modules`);

  // --- findings follow their files ----------------------------------------
  const movedFindings = await relinkFindings(repoId);
  if (movedFindings > 0) log(`moved ${movedFindings} finding(s) to the module that now owns their file`);

  return { components: liveIds.size, componentEdges: componentEdges.length };
}

