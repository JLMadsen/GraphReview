/**
 * Louvain community-detection clustering — an opt-in
 * "suggest a different clustering" alternative to the folder-based
 * `clusterByFolderDepth` in graph-builder.ts, not a replacement for it. Same
 * output shape (`ModuleCluster[]`) so it's a drop-in alternative wherever
 * clustering is consumed, but grounded in the file-level import graph's
 * actual connectivity rather than folder structure — useful for flatter
 * `src/` layouts where folders don't reflect logical boundaries.
 *
 * Library-only: nothing here is wired into an API route, job, or UI yet.
 * Triggering it and an accept/reject UI for the suggestion are separate
 * follow-up work.
 */
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { ImportEdge, ModuleCluster } from "./graph-builder";
import { ROOT_MODULE_NAME } from "./graph-builder";
import type { FileAnalysis } from "./ir";
import { dirOf } from "./paths";

/**
 * Name of the single cluster holding files with no import edges at all
 * (neither importing nor imported by anything else in the analyzed set).
 * Louvain has nothing to place these on — left in, each would form its own
 * meaningless one-file "community" — so they're pulled out before running
 * the algorithm and reported together here instead. This is a judgment call
 * (folding them into their folder name instead would also be defensible);
 * "unconnected" was chosen because it's honest about *why* these files are
 * grouped together (structurally isolated), rather than implying a folder
 * heuristic was applied to them when it wasn't.
 */
export const UNCONNECTED_CLUSTER_NAME = "unconnected";

/**
 * Community-detection clustering: builds an undirected
 * `graphology` graph from the file-level import graph and runs the Louvain
 * algorithm to group files by detected community instead of folder location.
 *
 * Edge direction is dropped when building the graph — Louvain's modularity
 * optimization is inherently undirected, and import direction doesn't change
 * which files structurally belong together. Multiple edges between the same
 * pair of files (e.g. both an `import` and a `call` edge) collapse to a
 * single undirected edge; this clustering only cares about connectivity, not
 * edge weight or kind.
 *
 * Naming heuristic (communities have no inherent name the way a folder
 * does — this is a deliberate judgment call): for each detected
 * community, take the most common top-level folder segment (the first path
 * segment, e.g. "src" from "src/auth/index.ts") among its files. If one
 * segment is strictly more common than every other, and it's not "every file
 * in this community sits at the repo root", use it as the cluster's name.
 * Otherwise — a tie, an all-root-files community, or a collision with a name
 * already used by a larger community — the cluster instead gets a
 * deterministic `"cluster-N"` label, numbered by descending cluster size
 * (`cluster-1` is the biggest unnamed community). Folder-derived names here
 * are a best-effort hint about what a community likely represents, not a
 * guarantee — a community can legitimately span multiple folders, since it's
 * defined by import connectivity, not location.
 *
 * Files with zero import edges (isolated nodes — Louvain can't meaningfully
 * place them) are excluded from the algorithm run and collected into one
 * {@link UNCONNECTED_CLUSTER_NAME} cluster instead; see that constant for why.
 */
export function clusterByCommunity(files: FileAnalysis[], edges: ImportEdge[]): ModuleCluster[] {
  const allPaths = files.map((f) => f.file);
  const pathSet = new Set(allPaths);

  const graph = new Graph({ type: "undirected", allowSelfLoops: false });
  for (const filePath of allPaths) graph.addNode(filePath);

  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    // Defensive: edges are expected to only ever reference files also passed
    // in `files` (that's what graph-builder.ts guarantees), but a caller
    // could hand this function a mismatched pair.
    if (!pathSet.has(edge.from) || !pathSet.has(edge.to)) continue;
    if (!graph.hasEdge(edge.from, edge.to)) {
      graph.addEdge(edge.from, edge.to);
    }
  }

  const unconnected: string[] = [];
  for (const filePath of allPaths) {
    if (graph.degree(filePath) === 0) {
      unconnected.push(filePath);
      graph.dropNode(filePath);
    }
  }

  const groups = new Map<number, string[]>();
  if (graph.order > 0) {
    const communities = louvain(graph);
    for (const [filePath, communityId] of Object.entries(communities)) {
      const bucket = groups.get(communityId);
      if (bucket) bucket.push(filePath);
      else groups.set(communityId, [filePath]);
    }
  }

  // Largest community first, so the numbered fallback ("cluster-1",
  // "cluster-2", …) and name-collision resolution below are deterministic
  // regardless of the (arbitrary) community-id numbering Louvain hands back.
  const communityFilePaths = [...groups.values()]
    .map((filePaths) => filePaths.slice().sort())
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));

  const usedNames = new Set<string>();
  const modules: ModuleCluster[] = [];
  let fallbackCount = 0;
  for (const filePaths of communityFilePaths) {
    let name = mostCommonTopLevelFolder(filePaths);
    if (!name || usedNames.has(name)) {
      fallbackCount++;
      name = `cluster-${fallbackCount}`;
    }
    usedNames.add(name);
    modules.push({ name, filePaths });
  }

  if (unconnected.length > 0) {
    modules.push({ name: UNCONNECTED_CLUSTER_NAME, filePaths: unconnected.slice().sort() });
  }

  modules.sort((a, b) => a.name.localeCompare(b.name));
  return modules;
}

/**
 * The most common top-level (first path segment) folder among `filePaths`,
 * or `undefined` when there's a tie for most common, or every file sits at
 * the repo root (no folder at all — see the "no clear common folder" case
 * documented on {@link clusterByCommunity}).
 */
function mostCommonTopLevelFolder(filePaths: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const filePath of filePaths) {
    const dir = dirOf(filePath);
    const segment = dir === "" ? ROOT_MODULE_NAME : dir.split("/")[0];
    counts.set(segment, (counts.get(segment) ?? 0) + 1);
  }

  let best: string | undefined;
  let bestCount = 0;
  let tie = false;
  for (const [segment, count] of counts) {
    if (count > bestCount) {
      best = segment;
      bestCount = count;
      tie = false;
    } else if (count === bestCount) {
      tie = true;
    }
  }
  if (tie || best === ROOT_MODULE_NAME) return undefined;
  return best;
}
