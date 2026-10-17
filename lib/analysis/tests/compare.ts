// What a change does to its tests (DESIGN.md §6.22 §3–4): the changed code
// files and the tests that reach them, deleted tests, skip/focus markers on
// added lines, and the deterministic findings among those.

import type { ChangedLines } from "../compare";
import { coverageOf } from "./catalog";
import { EMPTY_TESTS_CATALOG, type ChangedCodeTests, type DeletedTest, type PatchMarker, type TestsCatalog, type TestsChange, type TestsFinding } from "./types";

const MAX_TESTS_LISTED = 10;

function folderOf(file: string): string {
  const i = file.lastIndexOf("/");
  return i < 0 ? "" : file.slice(0, i);
}

/** Folder and extension: `components/graph/*.tsx` — files like this one, beside it. */
function neighbourhood(file: string): string {
  const dot = file.lastIndexOf(".");
  return `${folderOf(file)}/*${dot > file.lastIndexOf("/") ? file.slice(dot) : ""}`;
}

function ranges(lines: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    out.push(i === j ? `${lines[i]}` : `${lines[i]}–${lines[j]}`);
    i = j;
  }
  return out.join(", ");
}

export function compareTests(baseIn: TestsCatalog | undefined, headIn: TestsCatalog | undefined, changed: Map<string, ChangedLines>): TestsChange {
  const base = baseIn ?? EMPTY_TESTS_CATALOG;
  const head = headIn ?? EMPTY_TESTS_CATALOG;
  const headTests = new Map(head.tests.map((t) => [t.file, t]));
  const baseTests = new Map(base.tests.map((t) => [t.file, t]));
  const baseSources = new Set(base.sources.map((s) => s.file));
  const headSourceFiles = new Set(head.sources.map((s) => s.file));
  const headFiles = new Set([...headSourceFiles, ...head.tests.map((t) => t.file)]);
  const changedTestFiles = new Set([...changed.keys()].filter((f) => headTests.has(f)));
  // Where some test reaches a code file of the same type in the same folder, the code beside it is expected to be tested too.
  const testedFolders = new Set(head.sources.filter((s) => s.testCount > 0).map((s) => neighbourhood(s.file)));

  const findings: TestsFinding[] = [];
  const changedCode: ChangedCodeTests[] = [];
  for (const source of head.sources) {
    const lines = changed.get(source.file);
    if (!lines || lines.added.size === 0) continue;
    const names = source.tests.map((i) => head.tests[i].file);
    const entry: ChangedCodeTests = {
      file: source.file,
      status: baseSources.has(source.file) ? "modified" : "added",
      changedLines: lines.added.size,
      tests: names.filter((n) => !changedTestFiles.has(n)).slice(0, MAX_TESTS_LISTED),
      testCount: source.testCount,
      changedTests: names.filter((n) => changedTestFiles.has(n)),
      ...(source.hops ? { hops: source.hops } : {}),
    };
    const cov = coverageOf(head, source.file);
    if (cov) {
      const missed = new Set(cov.missed);
      const covered = new Set(cov.covered);
      // Only lines the report instruments count: a line it never saw is neither.
      const instrumented = [...lines.added].filter((n) => missed.has(n) || covered.has(n));
      const missedLines = instrumented.filter((n) => missed.has(n)).sort((a, b) => a - b);
      entry.missedLines = missedLines;
      entry.instrumentedLines = instrumented.length;
      if (missedLines.length > 0 && missedLines.length === instrumented.length) {
        findings.push({
          key: `uncovered-lines|${source.file}`,
          rule: "uncovered-lines",
          assessment: "concern",
          file: source.file,
          line: missedLines[0],
          summary: `The coverage report misses every changed line of ${source.file}`,
          rationale: `${cov.report} marks line${missedLines.length === 1 ? "" : "s"} ${ranges(missedLines)} as never run, and those are all the instrumented lines this change adds there. Tests load the file but don't exercise the changed code — or the report is older than the change.`,
        });
      }
    }
    changedCode.push(entry);
    if (source.testCount === 0 && testedFolders.has(neighbourhood(source.file))) {
      const first = Math.min(...lines.added);
      findings.push({
        key: `untested|${source.file}`,
        rule: "untested",
        assessment: "concern",
        file: source.file,
        line: first,
        summary: `No test reaches ${entry.status === "added" ? "the new file " : ""}${source.file}`,
        rationale: `No test file imports or calls into ${source.file}, directly or through other code, so nothing in the test suite runs the ${lines.added.size} line(s) this change ${entry.status === "added" ? "adds" : "changes"} there. Other files like it in ${folderOf(source.file) || "the repo root"} are tested.`,
      });
    }
  }
  changedCode.sort((a, b) => Number(a.testCount > 0) - Number(b.testCount > 0) || a.file.localeCompare(b.file));

  const deletedTests: DeletedTest[] = [];
  for (const t of base.tests) {
    if (headTests.has(t.file) || !changed.has(t.file)) continue;
    const subjects = t.subjects.filter((s) => headFiles.has(s));
    deletedTests.push({ file: t.file, framework: t.framework, kind: t.kind, cases: t.cases, subjects });
    if (subjects.length > 0) {
      findings.push({
        key: `deleted-test|${t.file}`,
        rule: "deleted-test",
        assessment: "concern",
        file: t.file,
        summary: `Test file ${t.file} deleted while the code it tested stays`,
        rationale: `${t.file} (${t.cases} test case(s), ${t.framework}) is removed, but ${subjects.slice(0, 3).join(", ")}${subjects.length > 3 ? ` and ${subjects.length - 3} more` : ""} — which it imported directly — still exist${subjects.length === 1 ? "s" : ""}. Those tests didn't move anywhere this change shows.`,
      });
    }
  }

  const markers: PatchMarker[] = [];
  for (const file of changedTestFiles) {
    const t = headTests.get(file)!;
    const added = changed.get(file)!.added;
    for (const m of t.markers) {
      if (!added.has(m.line)) continue;
      markers.push({ ...m, file });
      findings.push(
        m.kind === "focus"
          ? {
              key: `focused|${file}:${m.line}`,
              rule: "focused",
              assessment: "defect",
              file,
              line: m.line,
              summary: `Focused test \`${m.marker}\` left in ${file}`,
              rationale: `\`${m.marker}\` on line ${m.line} makes the runner run only this test (or block) and silently skip every other one in the file — or the whole suite. It's a debugging leftover.`,
            }
          : {
              key: `skipped|${file}:${m.line}`,
              rule: "skipped",
              assessment: "concern",
              file,
              line: m.line,
              summary: `Test skipped with \`${m.marker}\` in ${file}`,
              rationale: `This change adds \`${m.marker}\` on line ${m.line}: the test no longer runs, so whatever it checked is unchecked from now on. Say why, or fix and re-enable it.`,
            }
      );
    }
  }
  markers.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const addedTests = head.tests.filter((t) => changed.has(t.file) && !baseTests.has(t.file)).map(({ file, framework, kind, cases }) => ({ file, framework, kind, cases }));
  const modifiedTests = [...changedTestFiles].filter((f) => baseTests.has(f)).sort();
  const report = changedCode.some((c) => c.missedLines) ? head.reports.find((r) => changedCode.some((c) => c.missedLines && r.files.some((f) => f.file === c.file)))?.file : undefined;
  const order = { focused: 0, "deleted-test": 1, skipped: 2, untested: 3, "uncovered-lines": 4 } as const;
  findings.sort((a, b) => order[a.rule] - order[b.rule] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));

  return {
    changedCode,
    deletedTests,
    addedTests,
    modifiedTests,
    markers,
    ...(report ? { report } : {}),
    findings,
    counts: {
      changedCode: changedCode.length,
      untested: changedCode.filter((c) => c.testCount === 0).length,
      deletedTests: deletedTests.length,
      addedTests: addedTests.length,
      skipped: markers.filter((m) => m.kind === "skip").length,
      focused: markers.filter((m) => m.kind === "focus").length,
      missedLines: changedCode.reduce((n, c) => n + (c.missedLines?.length ?? 0), 0),
    },
  };
}
