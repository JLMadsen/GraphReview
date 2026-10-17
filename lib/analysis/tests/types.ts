// The test catalog and a change's test signals (DESIGN.md §6.22).

export type TestFramework = "jest" | "vitest" | "playwright" | "cypress" | "mocha" | "node" | "pytest" | "unittest" | "junit" | "go" | "other";
export type TestKind = "unit" | "integration" | "e2e";

/** A skip or focus marker in a test file. */
export interface TestMarker {
  line: number;
  /** As written: `it.skip`, `xit`, `@Disabled`, `t.Skip`, `.only`, … */
  marker: string;
  kind: "skip" | "focus";
}

/** What a test file's text says — the cached unit (beside a parse). */
export interface TestFileFacts {
  cases: number;
  markers: TestMarker[];
}

/** A framework the repo is set up for, and the file that says so. */
export interface TestFrameworkUse {
  framework: TestFramework;
  /** The folder the manifest or config sits in ("" = repo root). */
  root: string;
  /** The manifest or config file that names it. */
  source: string;
}

export interface TestFile {
  file: string;
  framework: TestFramework;
  kind: TestKind;
  cases: number;
  loc: number;
  markers: TestMarker[];
  /** Code files this test reaches over imports and calls. */
  reaches: number;
  /** Code files it imports directly (at most 10). */
  subjects: string[];
}

/** A code file and the tests that reach it. */
export interface SourceReach {
  file: string;
  loc: number;
  /** Indexes into `TestsCatalog.tests`, nearest first, at most {@link MAX_TESTS_PER_SOURCE}. */
  tests: number[];
  /** Every test that reaches it. */
  testCount: number;
  /** Hops from the nearest test (1 = imported directly); absent when none reaches it. */
  hops?: number;
}

export interface CoverageFile {
  file: string;
  /** Instrumented lines. */
  found: number;
  hit: number;
  /** Instrumented lines with no hits. */
  missed: number[];
  /** Instrumented lines with hits. */
  covered: number[];
}

export interface CoverageReport {
  file: string;
  format: "lcov" | "istanbul" | "cobertura" | "jacoco";
  files: CoverageFile[];
  /** Report entries no repo file matched. */
  unmatched: number;
}

export interface TestsCatalog {
  frameworks: TestFrameworkUse[];
  tests: TestFile[];
  sources: SourceReach[];
  reports: CoverageReport[];
  /** Support files (mocks, fixtures, helpers in test folders). */
  support: number;
}

export const MAX_TESTS_PER_SOURCE = 20;

export const EMPTY_TESTS_CATALOG: TestsCatalog = { frameworks: [], tests: [], sources: [], reports: [], support: 0 };

export interface ChangedCodeTests {
  file: string;
  status: "added" | "modified";
  changedLines: number;
  /** Unchanged head tests that reach it, nearest first (at most 10). */
  tests: string[];
  testCount: number;
  /** Tests this change adds or edits that reach it. */
  changedTests: string[];
  hops?: number;
  /** Changed lines the head's coverage report marks missed; absent when no report covers the file. */
  missedLines?: number[];
  /** Changed lines the report instruments. */
  instrumentedLines?: number;
}

export interface DeletedTest {
  file: string;
  framework: TestFramework;
  kind: TestKind;
  cases: number;
  /** Files it imported directly that the head still has. */
  subjects: string[];
}

export interface PatchMarker extends TestMarker {
  file: string;
}

export type TestsFindingRule = "focused" | "skipped" | "deleted-test" | "untested" | "uncovered-lines";

export interface TestsFinding {
  /** Stable: rule and where. */
  key: string;
  rule: TestsFindingRule;
  assessment: "defect" | "concern";
  file: string;
  line?: number;
  summary: string;
  rationale: string;
}

export interface TestsChange {
  changedCode: ChangedCodeTests[];
  deletedTests: DeletedTest[];
  addedTests: Array<Pick<TestFile, "file" | "framework" | "kind" | "cases">>;
  modifiedTests: string[];
  markers: PatchMarker[];
  /** The head report the missed lines came from. */
  report?: string;
  findings: TestsFinding[];
  counts: { changedCode: number; untested: number; deletedTests: number; addedTests: number; skipped: number; focused: number; missedLines: number };
}
