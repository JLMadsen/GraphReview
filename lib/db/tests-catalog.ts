// The test catalog of each repo's analysed commit (lib/analysis/tests/,
// DESIGN.md §6.22). Kept in `kv` rather than a table of its own. A review
// target's test change rides in target_graphs.

import type { TestsCatalog } from "@/lib/analysis/tests/types";
import { readKv, writeKv } from "./kv";

export interface StoredTestsCatalog {
  sha: string;
  computedAt: string;
  catalog: TestsCatalog;
}

const key = (repoId: string) => `tests-catalog:${repoId}`;

export function readTestsCatalog(repoId: string): StoredTestsCatalog | null {
  return readKv<StoredTestsCatalog>(key(repoId)) ?? null;
}

export function writeTestsCatalog(repoId: string, sha: string, catalog: TestsCatalog): void {
  writeKv(key(repoId), { sha, computedAt: new Date().toISOString(), catalog } satisfies StoredTestsCatalog);
}
