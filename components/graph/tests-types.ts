// What `/api/repos/[repoId]/tests` and `/tests/plan` return (DESIGN.md §6.22).

import type { TestsCatalog } from "@/lib/analysis/tests/types";
import type { StoredTestPlan } from "@/lib/jobs/test-plan";

export type { StoredTestPlan, TestPlanSource } from "@/lib/jobs/test-plan";
export type * from "@/lib/analysis/tests/types";

/** One component's test numbers. A test counts for its own component when that has code, else for the components it imports. */
export interface TestsComponentRow {
  id: string;
  name: string;
  codeFiles: number;
  codeLoc: number;
  reached: number;
  testFiles: number;
  testLoc: number;
  /** Report lines of its code files (0 = no report covers it). */
  reportFound: number;
  reportHit: number;
}

export interface TestsResponseDTO extends TestsCatalog {
  state: "ready" | "none";
  sha?: string;
  computedAt?: string;
  components: TestsComponentRow[];
  /** Owning component of each code and test file. */
  fileComponents: Record<string, string>;
}

export interface TestPlanResponseDTO {
  plan: StoredTestPlan | null;
}
