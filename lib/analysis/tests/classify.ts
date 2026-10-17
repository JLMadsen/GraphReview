// Which files are tests, from their path alone (DESIGN.md §6.22 §1). The PR
// map's role classifier (lib/jobs/pr-map.ts) uses the same patterns.

import path from "node:path";
import type { TestFramework, TestKind } from "./types";

export const TEST_DIR = /(^|\/)(__tests__|__mocks__|tests?|specs?|testdata|e2e|cypress)\//i;
export const TEST_FILE =
  /(\.(test|spec|e2e|cy)\.[^./]+$)|(_test\.(go|py|rb|exs?)$)|(^test_[^/]+\.py$)|((Test|Tests|Spec|IT)\.(java|kt|kts|cs|scala|swift)$)|(^smoke-tests?([-_.][^/]*)?\.[cm]?[jt]sx?$)/;
/** In a test folder but never a test itself. */
const SUPPORT_DIR = /(^|\/)(__mocks__|testdata|fixtures?|__fixtures__|__snapshots__|mocks?|helpers?|support|utils)\//i;
const SUPPORT_FILE = /^(conftest\.py|setup[-_.]?tests?\.[cm]?[jt]sx?|jest\.setup\.[cm]?[jt]s|vitest\.setup\.[cm]?[jt]s|test[-_]?utils?\.[^/]+|test[-_]?helpers?\.[^/]+)$/i;

/** The file's name says it is a test (`a.test.ts`, `test_a.py`, `ATest.java`). */
export function isTestFileName(filePath: string): boolean {
  return TEST_FILE.test(path.posix.basename(filePath));
}

/** A test, or something that lives with the tests — the PR map's "test" role. */
export function isTestPath(filePath: string): boolean {
  return isTestFileName(filePath) || TEST_DIR.test(filePath);
}

/**
 * A test file proper (a starting point for reach), support (a mock, fixture
 * or helper), or neither. A file in a test folder with test cases is a test
 * whatever its name.
 */
export function testRole(filePath: string, cases: number): "test" | "support" | null {
  if (!isTestPath(filePath)) return null;
  if (isTestFileName(filePath)) return SUPPORT_DIR.test(filePath) && cases === 0 ? "support" : "test";
  const base = path.posix.basename(filePath);
  if (SUPPORT_FILE.test(base) || SUPPORT_DIR.test(filePath)) return cases > 0 && !SUPPORT_FILE.test(base) ? "test" : "support";
  return cases > 0 ? "test" : "support";
}

const E2E_PATH = /(^|\/)(e2e|cypress|playwright)\/|\.(e2e|cy)\.[^./]+$/i;
const INTEGRATION_PATH = /(^|\/)(integration|it|integration[-_]tests?)\/|\.(int|integration)\.[^./]+$|IT\.(java|kt|kts)$/;

export function testKind(filePath: string, framework: TestFramework): TestKind {
  if (framework === "playwright" || framework === "cypress" || E2E_PATH.test(filePath)) return "e2e";
  if (INTEGRATION_PATH.test(filePath)) return "integration";
  return "unit";
}
