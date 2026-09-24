// Which module-tier component owns each file (DESIGN.md §6.3).
//
// Static analysis clusters files into folder modules. Feature modules the
// user accepted from a merge suggestion then claim files out of those
// folders, by pattern. The rule is "most specific wins":
//
//   1. an exact file path listed on a merged module;
//   2. otherwise the longest `<dir>/**` folder pattern of any merged module;
//   3. otherwise the folder module the file was clustered into.
//
// Pure — no Neo4j, no disk. Both the analysis job and a regroup (after an
// accept/unmerge) feed it and write what it returns, so there is exactly
// one place that decides membership.

import type { ModuleCluster } from "@/lib/analysis/graph-builder";

/** Suffix of a folder pattern. Anything without it is an exact file path. */
const FOLDER_SUFFIX = "/**";

export function folderPattern(dir: string): string {
  return `${dir}${FOLDER_SUFFIX}`;
}

export function isFolderPattern(pattern: string): boolean {
  return pattern.endsWith(FOLDER_SUFFIX);
}

/** `app/map/**` → `app/map`. Returns `null` for an exact file path. */
export function folderOfPattern(pattern: string): string | null {
  return isFolderPattern(pattern) ? pattern.slice(0, -FOLDER_SUFFIX.length) : null;
}

/** Whether `filePath` lies under the folder `dir` (at any depth). */
export function isUnderFolder(filePath: string, dir: string): boolean {
  return dir === "" || filePath.startsWith(`${dir}/`);
}

export function folderModuleId(repoId: string, moduleName: string): string {
  return `${repoId}:module:${moduleName}`;
}

/** The part of a merged module that ownership resolution needs. */
export interface MergedModuleInput {
  id: string;
  pathPatterns: readonly string[];
}

export interface OwnershipResult {
  /** File path → owning component id. Every input file has exactly one owner. */
  componentIdByFile: Map<string, string>;
  /** Folder clusters that still own at least one file, with their component ids. */
  liveFolderModules: Array<{ id: string; cluster: ModuleCluster }>;
  /** Merged module id → the files it owns. Merged modules owning nothing are absent. */
  filesByMergedId: Map<string, string[]>;
  /** Merged module id → its patterns that matched no file (deleted/renamed folders or files). */
  deadPatternsByMergedId: Map<string, string[]>;
}

interface Claim {
  mergedId: string;
  /** Exact file claims beat any folder claim; among folders, the longest wins. */
  rank: number;
}

export function resolveOwnership(
  repoId: string,
  folderClusters: readonly ModuleCluster[],
  mergedModules: readonly MergedModuleInput[]
): OwnershipResult {
  const exactClaims = new Map<string, string>();
  const folderClaims: Array<{ dir: string; mergedId: string }> = [];
  for (const merged of mergedModules) {
    for (const pattern of merged.pathPatterns) {
      const dir = folderOfPattern(pattern);
      if (dir === null) exactClaims.set(pattern, merged.id);
      else folderClaims.push({ dir, mergedId: merged.id });
    }
  }

  const claimFor = (filePath: string): Claim | null => {
    const exact = exactClaims.get(filePath);
    if (exact) return { mergedId: exact, rank: Number.MAX_SAFE_INTEGER };
    let best: Claim | null = null;
    for (const { dir, mergedId } of folderClaims) {
      if (!isUnderFolder(filePath, dir)) continue;
      if (!best || dir.length > best.rank) best = { mergedId, rank: dir.length };
    }
    return best;
  };

  const componentIdByFile = new Map<string, string>();
  const filesByMergedId = new Map<string, string[]>();
  const liveFolderModules: OwnershipResult["liveFolderModules"] = [];

  for (const cluster of folderClusters) {
    const folderId = folderModuleId(repoId, cluster.name);
    const kept: string[] = [];
    for (const filePath of cluster.filePaths) {
      const claim = claimFor(filePath);
      if (!claim) {
        kept.push(filePath);
        componentIdByFile.set(filePath, folderId);
        continue;
      }
      componentIdByFile.set(filePath, claim.mergedId);
      const owned = filesByMergedId.get(claim.mergedId);
      if (owned) owned.push(filePath);
      else filesByMergedId.set(claim.mergedId, [filePath]);
    }
    if (kept.length > 0) {
      liveFolderModules.push({ id: folderId, cluster: { name: cluster.name, filePaths: kept } });
    }
  }

  // A pattern is alive when at least one file matches it — whether or not
  // it won that file (a more specific merge may have).
  const allFiles = folderClusters.flatMap((cluster) => cluster.filePaths);
  const fileSet = new Set(allFiles);
  const deadPatternsByMergedId = new Map<string, string[]>();
  for (const merged of mergedModules) {
    const dead = merged.pathPatterns.filter((pattern) => {
      const dir = folderOfPattern(pattern);
      return dir === null ? !fileSet.has(pattern) : !allFiles.some((f) => isUnderFolder(f, dir));
    });
    if (dead.length > 0) deadPatternsByMergedId.set(merged.id, dead);
  }

  for (const files of filesByMergedId.values()) files.sort();
  return { componentIdByFile, liveFolderModules, filesByMergedId, deadPatternsByMergedId };
}
