/**
 * Checks for the test catalog (lib/analysis/tests/) and the test comparison
 * (DESIGN.md §6.22): a repo with Vitest unit tests, a Playwright e2e test,
 * pytest, Go and JUnit tests and a committed lcov report — then a head that
 * produces each of the five findings. Also the lexical readers on their own:
 * markers per language, the four coverage formats, report path matching.
 *
 *   npm test -- tests
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeRepo } from "../graph-builder";
import type { ChangedLines } from "../compare";
import { testKind, testRole } from "./classify";
import { compareTests } from "./compare";
import { parseCoverage, resolveReportPath } from "./coverage";
import { describeTestsChange, describeTestsForFile } from "./describe";
import { scanTestFacts } from "./facts";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function writeTree(root: string, files: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    if (content === null) {
      rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

const lines = (...l: string[]) => `${l.join("\n")}\n`;

const BASE: Record<string, string> = {
  "package.json": `{ "name": "app", "scripts": { "test": "vitest run", "e2e": "playwright test" }, "devDependencies": { "vitest": "2.0.0", "@playwright/test": "1.47.0" } }\n`,
  "vitest.config.ts": lines("export default {};"),
  "src/math.ts": lines("export function add(a: number, b: number) {", "  return a + b;", "}", "export const sub = (a: number, b: number) => a - b;"),
  "src/format.ts": lines('import { add } from "./math";', "export function total(xs: number[]) {", "  return xs.reduce(add, 0).toFixed(2);", "}"),
  "src/untested.ts": lines("export function lonely() {", "  return 1;", "}"),
  "src/math.test.ts": lines(
    'import { describe, it, expect } from "vitest";',
    'import { add } from "./math";',
    'describe("add", () => {',
    '  it("adds", () => expect(add(1, 2)).toBe(3));',
    '  it.skip("later", () => {});',
    "  // it.only is only a comment here",
    "});"
  ),
  "src/format.test.ts": lines('import { it } from "vitest";', 'import { total } from "./format";', 'it("totals", () => { total([1]); });'),
  "src/__mocks__/fetch.ts": lines("export const fetch = () => null;"),
  "e2e/login.spec.ts": lines('import { test } from "@playwright/test";', 'test("logs in", async () => {});', 'test("logs out", async () => {});'),
  "py/pyproject.toml": lines("[tool.pytest.ini_options]", 'testpaths = ["tests"]'),
  "py/app.py": lines("def greet():", '    return "hi"'),
  "py/tests/test_app.py": lines("import pytest", "", "def test_greet():", "    assert True", "", "@pytest.mark.skip(reason='flaky')", "def test_other():", "    pass"),
  "go/go.mod": lines("module example.com/calc", "", "go 1.22"),
  "go/calc.go": lines("package calc", "", "func Add(a, b int) int { return a + b }"),
  "go/calc_test.go": lines("package calc", "", 'import "testing"', "", "func TestAdd(t *testing.T) {", '  t.Skip("todo")', "}"),
  "jvm/pom.xml": lines("<project><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>"),
  "jvm/src/test/java/com/acme/FooTest.java": lines("package com.acme;", "import org.junit.jupiter.api.Test;", "import org.junit.jupiter.api.Disabled;", "class FooTest {", "  @Test void a() {}", "  @Disabled @Test void b() {}", "}"),
  "coverage/lcov.info": lines("TN:", "SF:/home/ci/work/app/src/math.ts", "DA:1,4", "DA:2,0", "DA:4,0", "LF:3", "LH:1", "end_of_record", "SF:src/format.ts", "DA:2,1", "DA:3,1", "end_of_record", "SF:/elsewhere/nothing.ts", "DA:1,1", "end_of_record"),
};

const HEAD: Record<string, string | null> = {
  "src/math.ts": lines("export function add(a: number, b: number) {", "  return a + b + 0;", "}", "export const sub = (a: number, b: number) => a - b;"),
  "src/math.test.ts": lines(
    'import { describe, it, expect } from "vitest";',
    'import { add } from "./math";',
    'describe("add", () => {',
    '  it("adds", () => expect(add(1, 2)).toBe(3));',
    '  it.skip("later", () => {});',
    "  // it.only is only a comment here",
    '  it.only("debug", () => {});',
    '  xit("parked", () => {});',
    "});"
  ),
  "src/untested.ts": lines("export function lonely() {", "  return 2;", "}"),
  "src/fresh.ts": lines("export const fresh = true;"),
  "src/format.test.ts": null,
};

const CHANGED = new Map<string, ChangedLines>([
  ["src/math.ts", { added: new Set([2]), removed: new Set([2]) }],
  ["src/math.test.ts", { added: new Set([7, 8]), removed: new Set() }],
  ["src/untested.ts", { added: new Set([2]), removed: new Set([2]) }],
  ["src/fresh.ts", { added: new Set([1]), removed: new Set() }],
  ["src/format.test.ts", { added: new Set(), removed: new Set([1, 2, 3]) }],
]);

async function main(): Promise<void> {
  console.log("lexical readers");
  {
    const js = scanTestFacts("typescript", BASE["src/math.test.ts"])!;
    check("js: two cases, comment ignored", js.cases === 2, JSON.stringify(js));
    check("js: it.skip is a skip marker on line 5", js.markers.length === 1 && js.markers[0].marker === "it.skip" && js.markers[0].line === 5, JSON.stringify(js.markers));
    const focus = scanTestFacts("javascript", lines('fdescribe("x", () => {', '  test.only("y", () => {});', '  xdescribe("z", () => {});', "});"))!;
    check("js: fdescribe and test.only focus, xdescribe skips", focus.markers.map((m) => `${m.kind}:${m.marker}`).join(",") === "focus:fdescribe,focus:test.only,skip:xdescribe", JSON.stringify(focus.markers));
    // A test of a test scanner holds markers as text: none of these is one.
    const quoted = scanTestFacts(
      "typescript",
      lines(
        "const fixture = lines('  it.only(\"debug\", () => {});', \"  xit('parked', () => {});\");",
        'it("flags `it.skip` and fdescribe(", () => {});',
        "const t = `",
        '  test.only("in a template", () => {});',
        "`;",
        "/* describe.only(",
        "   xdescribe( */",
        "const re = /it\\.only\\s*\\(/g;"
      )
    )!;
    check("js: markers in strings, templates, block comments and regexes ignored", quoted.markers.length === 0 && quoted.cases === 1, JSON.stringify(quoted));
    const pyQuoted = scanTestFacts("python", lines('"""', "@pytest.mark.skip", '"""', "def test_a():", "    s = '@pytest.mark.skip # x'", "    pytest.skip('x')"))!;
    check("python: markers in docstrings and strings ignored", pyQuoted.markers.length === 1 && pyQuoted.markers[0].line === 6 && pyQuoted.cases === 1, JSON.stringify(pyQuoted));
    const py = scanTestFacts("python", BASE["py/tests/test_app.py"])!;
    check("python: two cases, pytest.mark.skip", py.cases === 2 && py.markers[0]?.marker === "@pytest.mark.skip", JSON.stringify(py));
    const java = scanTestFacts("java", BASE["jvm/src/test/java/com/acme/FooTest.java"])!;
    check("java: two @Test cases, @Disabled", java.cases === 2 && java.markers.some((m) => m.marker === "@Disabled"), JSON.stringify(java));
    const go = scanTestFacts("go", BASE["go/calc_test.go"])!;
    check("go: one case, t.Skip", go.cases === 1 && go.markers[0]?.marker === "t.Skip", JSON.stringify(go));
    check("support: __mocks__ and conftest.py are support", testRole("src/__mocks__/fetch.ts", 0) === "support" && testRole("tests/conftest.py", 0) === "support");
    check("a helper in tests/ with cases is a test", testRole("tests/helpers-run.ts", 3) === "test");
    check("kind: e2e by folder, integration by IT suffix", testKind("e2e/a.spec.ts", "vitest") === "e2e" && testKind("src/test/java/FooIT.java", "junit") === "integration" && testKind("src/a.test.ts", "jest") === "unit");

    const cob = parseCoverage("coverage.xml", lines('<?xml version="1.0"?>', '<coverage line-rate="0.5"><sources><source>/src/app</source></sources><packages><package><classes>', '<class name="a" filename="pkg/a.py"><lines><line number="1" hits="2"/><line number="2" hits="0"/></lines></class>', "</classes></package></packages></coverage>"));
    check("cobertura: lines under the source root", cob?.format === "cobertura" && cob.raw.get("/src/app/pkg/a.py")?.get(2) === 0, JSON.stringify([...(cob?.raw.keys() ?? [])]));
    const ist = parseCoverage("coverage-final.json", JSON.stringify({ "/x/src/a.ts": { path: "/x/src/a.ts", statementMap: { 0: { start: { line: 3 } }, 1: { start: { line: 5 } } }, s: { 0: 1, 1: 0 } } }));
    check("istanbul: statement lines", ist?.format === "istanbul" && ist.raw.get("/x/src/a.ts")?.get(5) === 0 && ist.raw.get("/x/src/a.ts")?.get(3) === 1);
    const jac = parseCoverage("jacoco.xml", '<report name="x"><package name="com/acme"><sourcefile name="Foo.java"><line nr="4" mi="0" ci="3"/><line nr="5" mi="2" ci="0"/></sourcefile></package></report>');
    check("jacoco: covered and missed instructions", jac?.format === "jacoco" && jac.raw.get("com/acme/Foo.java")?.get(4) === 3 && jac.raw.get("com/acme/Foo.java")?.get(5) === 0);
    const repo = new Set(["src/a.ts", "lib/a.ts", "jvm/src/main/java/com/acme/Foo.java"]);
    const bySuffix = new Map([["a.ts", ["src/a.ts", "lib/a.ts"]], ["Foo.java", ["jvm/src/main/java/com/acme/Foo.java"]]]);
    check("report paths: unique suffix matches", resolveReportPath("/ci/x/src/a.ts", "", repo, bySuffix) === "src/a.ts");
    check("report paths: an ambiguous bare name doesn't", resolveReportPath("a.ts", "", repo, bySuffix) === undefined);
    check("report paths: a JaCoCo package path matches", resolveReportPath("com/acme/Foo.java", "jvm", repo, bySuffix) === "jvm/src/main/java/com/acme/Foo.java");
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), "gr-tests-"));
  try {
    writeTree(tmp, BASE);
    console.log("catalog");
    const base = await analyzeRepo(tmp);
    const cat = base.tests;
    const fw = new Set(cat.frameworks.map((f) => f.framework));
    for (const f of ["vitest", "playwright", "pytest", "go", "junit"]) check(`framework ${f} detected`, fw.has(f as never), [...fw].join(","));
    const byFile = new Map(cat.tests.map((t) => [t.file, t]));
    check("math.test.ts is a vitest unit test", byFile.get("src/math.test.ts")?.framework === "vitest" && byFile.get("src/math.test.ts")?.kind === "unit");
    check("login.spec.ts is a playwright e2e test", byFile.get("e2e/login.spec.ts")?.framework === "playwright" && byFile.get("e2e/login.spec.ts")?.kind === "e2e" && byFile.get("e2e/login.spec.ts")?.cases === 2);
    check("test_app.py is pytest", byFile.get("py/tests/test_app.py")?.framework === "pytest");
    check("calc_test.go is go", byFile.get("go/calc_test.go")?.framework === "go");
    check("FooTest.java is junit", byFile.get("jvm/src/test/java/com/acme/FooTest.java")?.framework === "junit");
    check("the mock is support, not a test", !byFile.has("src/__mocks__/fetch.ts") && cat.support >= 1);
    const src = new Map(cat.sources.map((s) => [s.file, s]));
    check("math.ts reached directly by two tests", src.get("src/math.ts")?.hops === 1 && src.get("src/math.ts")?.testCount === 2, JSON.stringify(src.get("src/math.ts")));
    check("untested.ts reached by nothing", src.get("src/untested.ts")?.testCount === 0);
    check("vitest.config.ts is not code", !src.has("vitest.config.ts"));
    check("tests aren't sources", !src.has("src/math.test.ts"));
    const report = cat.reports.find((r) => r.file === "coverage/lcov.info");
    check("lcov read from the skipped coverage/ folder", Boolean(report), cat.reports.map((r) => r.file).join(","));
    const math = report?.files.find((f) => f.file === "src/math.ts");
    check("lcov: absolute path matched by suffix, 1 of 3 lines hit", math?.found === 3 && math.hit === 1 && math.missed.join(",") === "2,4", JSON.stringify(math));
    check("lcov: unmatched entries counted", report?.unmatched === 1);
    const described = describeTestsForFile(cat, "src/math.ts")?.join("\n") ?? "";
    check("chat text names the tests and the report", described.includes("src/math.test.ts") && described.includes("coverage/lcov.info"), described);

    console.log("comparison");
    const headDir = mkdtempSync(path.join(os.tmpdir(), "gr-tests-head-"));
    try {
      writeTree(headDir, BASE);
      writeTree(headDir, HEAD);
      const head = await analyzeRepo(headDir);
      const change = compareTests(cat, head.tests, CHANGED);
      const rules = change.findings.map((f) => `${f.rule}:${f.file}${f.line ? `:${f.line}` : ""}`);
      check("focused finding (defect) for it.only on line 7", change.findings.some((f) => f.rule === "focused" && f.assessment === "defect" && f.line === 7), rules.join(" | "));
      check("skipped finding for xit on line 8, not for the old it.skip", change.findings.filter((f) => f.rule === "skipped").map((f) => f.line).join(",") === "8", rules.join(" | "));
      check("deleted-test finding for format.test.ts", change.findings.some((f) => f.rule === "deleted-test" && f.file === "src/format.test.ts"), rules.join(" | "));
      check("untested findings for untested.ts and fresh.ts", ["src/untested.ts", "src/fresh.ts"].every((file) => change.findings.some((f) => f.rule === "untested" && f.file === file)), rules.join(" | "));
      check("uncovered-lines finding for math.ts line 2", change.findings.some((f) => f.rule === "uncovered-lines" && f.file === "src/math.ts" && f.line === 2), rules.join(" | "));
      const math2 = change.changedCode.find((c) => c.file === "src/math.ts");
      check("math.ts: the changed test is listed apart", math2?.changedTests.includes("src/math.test.ts") === true && !math2.tests.includes("src/math.test.ts"), JSON.stringify(math2));
      check("fresh.ts is added", change.changedCode.find((c) => c.file === "src/fresh.ts")?.status === "added");
      check("untested files come first", change.changedCode[0]?.testCount === 0);
      check("counts", change.counts.focused === 1 && change.counts.skipped === 1 && change.counts.deletedTests === 1 && change.counts.untested === 2, JSON.stringify(change.counts));
      check("change described for the plan", describeTestsChange(change).some((l) => l.includes("deleted test src/format.test.ts")));
      const empty = compareTests(undefined, undefined, CHANGED);
      check("no catalogs: no findings", empty.findings.length === 0);
    } finally {
      rmSync(headDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall test-catalog checks passed");
}

void main();
