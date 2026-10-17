// The test catalog and change as text, for the chat (DESIGN.md §6.22 §6) and
// the AI test plan's inputs.

import { coverageOf } from "./catalog";
import type { TestsCatalog, TestsChange } from "./types";

const pct = (hit: number, found: number) => (found ? `${Math.round((hit / found) * 100)}%` : "—");

/** The tests that reach one file, nearest first, and its report coverage. `null` when the catalog doesn't know the file. */
export function describeTestsForFile(catalog: TestsCatalog, file: string, changedFiles?: ReadonlySet<string>): string[] | null {
  const test = catalog.tests.find((t) => t.file === file);
  if (test) {
    return [
      `${file} is a test (${test.framework}, ${test.kind}, ${test.cases} case(s)) that reaches ${test.reaches} code file(s).`,
      ...(test.subjects.length ? [`Imports directly: ${test.subjects.join(", ")}`] : []),
      ...test.markers.map((m) => `- line ${m.line}: ${m.marker} (${m.kind === "focus" ? "focused" : "skipped"})`),
    ];
  }
  const source = catalog.sources.find((s) => s.file === file);
  if (!source) return null;
  const lines: string[] = [];
  if (source.testCount === 0) lines.push(`No test reaches ${file} over imports or calls.`);
  else {
    lines.push(`${file} is reached by ${source.testCount} test file(s); the nearest ${source.hops === 1 ? "imports it directly" : `is ${source.hops} hops away`}:`);
    for (const i of source.tests) {
      const t = catalog.tests[i];
      lines.push(`- ${t.file} (${t.framework}, ${t.kind}, ${t.cases} case(s))${changedFiles?.has(t.file) ? " — this change edits it" : ""}`);
    }
    if (source.testCount > source.tests.length) lines.push(`… ${source.testCount - source.tests.length} more, further away`);
  }
  const cov = coverageOf(catalog, file);
  if (cov) lines.push(`Coverage report ${cov.report}: ${pct(cov.hit, cov.found)} of ${cov.found} line(s) run${cov.missed.length ? `; never run: ${cov.missed.slice(0, 30).join(", ")}${cov.missed.length > 30 ? " …" : ""}` : ""}.`);
  else if (catalog.reports.length === 0) lines.push("(No committed coverage report — reach over imports only says a test loads the file, not that it runs these lines.)");
  return lines;
}

/** Many files at once (a component): reached / not, and the tests that reach the most of them. */
export function describeTestsForFiles(catalog: TestsCatalog, label: string, files: readonly string[]): string[] {
  const sources = catalog.sources.filter((s) => files.includes(s.file));
  const tests = catalog.tests.filter((t) => files.includes(t.file));
  if (sources.length === 0 && tests.length === 0) return [`${label} has no code files the test catalog knows.`];
  const reached = sources.filter((s) => s.testCount > 0);
  const hits = new Map<number, number>();
  for (const s of sources) for (const i of s.tests) hits.set(i, (hits.get(i) ?? 0) + 1);
  const lines = [`${label}: ${reached.length} of ${sources.length} code file(s) reached by a test; ${tests.length} test file(s) inside it.`];
  const top = [...hits].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) lines.push("Tests that reach it:", ...top.map(([i, n]) => `- ${catalog.tests[i].file} (${catalog.tests[i].framework}, ${catalog.tests[i].kind}) reaches ${n} of its file(s)`));
  const untested = sources.filter((s) => s.testCount === 0).sort((a, b) => b.loc - a.loc);
  if (untested.length) lines.push("Not reached by any test (largest first):", ...untested.slice(0, 15).map((s) => `- ${s.file} (${s.loc} lines)`));
  return lines;
}

/** One line per signal of a change, for the test plan's prompt and the chat. */
export function describeTestsChange(change: TestsChange, max = 30): string[] {
  const lines: string[] = [];
  for (const c of change.changedCode.slice(0, max)) {
    const tested = c.testCount ? `reached by ${c.testCount} test(s): ${[...c.changedTests, ...c.tests].slice(0, 3).join(", ")}` : "no test reaches it";
    const missed = c.missedLines?.length ? `; coverage report misses changed line(s) ${c.missedLines.slice(0, 10).join(", ")}` : "";
    lines.push(`${c.file} (${c.status}, ${c.changedLines} line(s)): ${tested}${missed}`);
  }
  for (const d of change.deletedTests) lines.push(`deleted test ${d.file} (${d.cases} case(s))${d.subjects.length ? `; it tested ${d.subjects.join(", ")}, still there` : ""}`);
  for (const m of change.markers) lines.push(`${m.file}:${m.line} adds ${m.marker} (${m.kind === "focus" ? "focused" : "skipped"})`);
  for (const t of change.addedTests) lines.push(`new test ${t.file} (${t.framework}, ${t.kind}, ${t.cases} case(s))`);
  return lines;
}
