// The test catalog of one analysed tree (DESIGN.md §6.22 §2): the test files
// by framework and kind, which code files each one reaches over the import
// and call edges, and the committed coverage reports.

import type { FileAnalysis } from "../ir";
import type { ImportEdge } from "../graph-builder";
import type { SymbolGraph } from "../symbols";
import { testKind, testRole } from "./classify";
import { readCoverageReports } from "./coverage";
import { detectFrameworks, frameworkOf } from "./frameworks";
import { MAX_TESTS_PER_SOURCE, type CoverageFile, type SourceReach, type TestFile, type TestsCatalog } from "./types";

export interface TestsCatalogInput {
  /** The parsed code files (graph files of a programming language), with their test facts. */
  files: FileAnalysis[];
  edges: ImportEdge[];
  symbols: SymbolGraph;
  /** Every file of the tree. */
  allFiles: readonly string[];
  readText: (relPath: string) => Promise<string | null>;
}

/** Code that isn't under test by nature: configs, type declarations, stories. */
const NOT_CODE = /(\.config\.[cm]?[jt]s$)|(\.d\.ts$)|(\.stories\.[^./]+$)|(^|\/)(migrations?)\//;
const E2E_PATH = /(^|\/)(e2e|cypress|playwright)\/|\.(e2e|cy)\.[^./]+$/i;

/** A file that declares only types and interfaces: nothing in it runs, so no test can reach it. */
function typesOnly(f: FileAnalysis): boolean {
  const decls = f.symbols?.decls ?? [];
  return decls.length > 0 && decls.every((d) => d.kind === "type" || d.kind === "interface");
}

export async function buildTestsCatalog(input: TestsCatalogInput): Promise<TestsCatalog> {
  const frameworks = await detectFrameworks(input.allFiles, input.readText);

  const roles = new Map<string, "test" | "support" | "code">();
  const locOf = new Map<string, number>();
  for (const f of input.files) {
    locOf.set(f.file, f.loc);
    const role = testRole(f.file, f.tests?.cases ?? 0);
    if (role) roles.set(f.file, role);
    else if (!NOT_CODE.test(f.file) && !typesOnly(f)) roles.set(f.file, "code");
  }

  // Runtime edges: imports (not type-only) and calls into another file.
  const out = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (from === to || !roles.has(from) || !roles.has(to)) return;
    (out.get(from) ?? out.set(from, new Set()).get(from)!).add(to);
  };
  for (const e of input.edges) if (!e.typeOnly) link(e.from, e.to);
  const declFile = new Map(input.symbols.decls.map((d) => [d.id, d.file]));
  for (const call of input.symbols.calls) {
    const to = declFile.get(call.to);
    if (to) link(call.file, to);
  }

  const tests: TestFile[] = [];
  for (const f of input.files) {
    if (roles.get(f.file) !== "test") continue;
    const imports = f.imports.map((i) => i.raw);
    const framework = frameworkOf(f.file, imports, frameworks, E2E_PATH.test(f.file));
    tests.push({
      file: f.file,
      framework,
      kind: testKind(f.file, framework),
      cases: f.tests?.cases ?? 0,
      loc: f.loc,
      markers: f.tests?.markers ?? [],
      reaches: 0,
      subjects: [...(out.get(f.file) ?? [])].filter((t) => roles.get(t) === "code").sort().slice(0, 10),
    });
  }
  tests.sort((a, b) => a.file.localeCompare(b.file));

  // Breadth-first from each test, through support files, never through another test.
  const reached = new Map<string, Array<{ test: number; hops: number }>>();
  tests.forEach((t, index) => {
    const seen = new Set<string>([t.file]);
    let frontier = [t.file];
    let hops = 0;
    let count = 0;
    while (frontier.length > 0) {
      hops++;
      const next: string[] = [];
      for (const file of frontier) {
        for (const to of out.get(file) ?? []) {
          if (seen.has(to)) continue;
          seen.add(to);
          const role = roles.get(to);
          if (role === "test") continue;
          if (role === "code") {
            (reached.get(to) ?? reached.set(to, []).get(to)!).push({ test: index, hops });
            count++;
          }
          next.push(to);
        }
      }
      frontier = next;
    }
    t.reaches = count;
  });

  const sources: SourceReach[] = [];
  for (const [file, role] of roles) {
    if (role !== "code") continue;
    const by = (reached.get(file) ?? []).sort((a, b) => a.hops - b.hops || tests[a.test].file.localeCompare(tests[b.test].file));
    sources.push({
      file,
      loc: locOf.get(file) ?? 0,
      tests: by.slice(0, MAX_TESTS_PER_SOURCE).map((r) => r.test),
      testCount: by.length,
      ...(by.length ? { hops: by[0].hops } : {}),
    });
  }
  sources.sort((a, b) => a.file.localeCompare(b.file));

  const reports = await readCoverageReports(input.allFiles, input.readText);
  const support = [...roles.values()].filter((r) => r === "support").length;
  return { frameworks, tests, sources, reports, support };
}

/** Line coverage of a file from the first report that covers it. */
export function coverageOf(catalog: TestsCatalog, file: string): (CoverageFile & { report: string }) | undefined {
  for (const r of catalog.reports) {
    const f = r.files.find((x) => x.file === file);
    if (f) return { ...f, report: r.file };
  }
  return undefined;
}
