// GET /api/repos/[repoId]/tests
//
// The Tests view's repo level (DESIGN.md §6.22): the test catalog of the
// repo's analysed commit — test files by framework and kind, which code
// files a test reaches, committed coverage reports — joined with the
// components (looked up now, so a re-clustering shows without a
// re-analysis). A review target's test change rides on the target graph.

import { NextResponse } from "next/server";
import { getFileOwnerMap, getRepoById, listComponentsByRepoId, readTestsCatalog } from "@/lib/db";
import { ownerLookup } from "@/lib/jobs/target-graph";
import { EMPTY_TESTS_CATALOG, type TestsCatalog } from "@/lib/analysis/tests/types";
import type { TestsComponentRow, TestsResponseDTO } from "@/components/graph/tests-types";
import { apiError } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    const stored = readTestsCatalog(repoId);
    const body: TestsResponseDTO = stored
      ? { state: "ready", sha: stored.sha, computedAt: stored.computedAt, ...stored.catalog, ...(await byComponent(repoId, stored.catalog)) }
      : { state: "none", ...EMPTY_TESTS_CATALOG, components: [], fileComponents: {} };
    return NextResponse.json(body);
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/tests failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not read the test catalog.", 500);
  }
}

async function byComponent(repoId: string, catalog: TestsCatalog): Promise<Pick<TestsResponseDTO, "components" | "fileComponents">> {
  const [owners, components] = await Promise.all([getFileOwnerMap(repoId), listComponentsByRepoId(repoId)]);
  const ownerOf = ownerLookup(owners);
  const nameOf = new Map(components.map((c) => [c.id, c.name]));
  const rows = new Map<string, TestsComponentRow>();
  const fileComponents: Record<string, string> = {};
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { id, name: nameOf.get(id) ?? id, codeFiles: 0, codeLoc: 0, reached: 0, testFiles: 0, testLoc: 0, reportFound: 0, reportHit: 0 }));
    return r;
  };
  const coverage = new Map<string, { found: number; hit: number }>();
  for (const report of catalog.reports) for (const f of report.files) if (!coverage.has(f.file)) coverage.set(f.file, f);
  for (const s of catalog.sources) {
    const id = ownerOf(s.file);
    if (!id) continue;
    fileComponents[s.file] = id;
    const r = row(id);
    r.codeFiles++;
    r.codeLoc += s.loc;
    if (s.testCount > 0) r.reached++;
    const cov = coverage.get(s.file);
    if (cov) {
      r.reportFound += cov.found;
      r.reportHit += cov.hit;
    }
  }
  for (const t of catalog.tests) {
    const own = ownerOf(t.file);
    if (own) fileComponents[t.file] = own;
    const targets = own && rows.has(own) ? [own] : [...new Set(t.subjects.map((s) => ownerOf(s)).filter((x): x is string => Boolean(x)))];
    for (const id of targets.length ? targets : own ? [own] : []) {
      const r = row(id);
      r.testFiles++;
      r.testLoc += t.loc;
    }
  }
  return { components: [...rows.values()].sort((a, b) => b.codeLoc - a.codeLoc), fileComponents };
}
