"use client";

// The Tests view (DESIGN.md §6.22): "Stats for testing". Repo: the test
// inventory by framework and kind, test : code per component, which code a
// test reaches over imports and calls, and line coverage from a committed
// report. Change (with a diff selected): the change's test signals — its
// certain findings first — and the AI test plan. Static only: nothing runs.

import { useEffect, useMemo, useState } from "react";
import { FlaskConical, LoaderCircle, Search, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { Segmented } from "./Segmented";
import { VIEW_TOOLBAR } from "./view-chrome";
import { ASSESSMENT_VISUALS } from "./review-visuals";
import type { StoredTestPlan, TestFramework, TestKind, TestsChange, TestsResponseDTO } from "./tests-types";

const FRAMEWORK_LABEL: Record<TestFramework, string> = {
  jest: "Jest",
  vitest: "Vitest",
  playwright: "Playwright",
  cypress: "Cypress",
  mocha: "Mocha",
  node: "node:test",
  pytest: "pytest",
  unittest: "unittest",
  junit: "JUnit",
  go: "Go testing",
  other: "Other / custom",
};
const KINDS: TestKind[] = ["unit", "integration", "e2e"];
const SOURCE_LABEL: Record<string, string> = {
  finding: "Finding",
  impact: "Impact",
  caller: "Caller",
  api: "API",
  schema: "Schema",
  env: "Env",
  infra: "Infra",
  preview: "UI",
  untested: "Untested",
};

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "—");
const base = (file: string) => file.slice(file.lastIndexOf("/") + 1);

interface TestsViewProps {
  catalog: TestsResponseDTO | null;
  loading: boolean;
  error: string | null;
  change: TestsChange | undefined;
  changePending: boolean;
  plan: StoredTestPlan | null;
  /** The selected diff's head, to mark a plan made for an earlier commit. */
  headSha?: string;
  hasTarget: boolean;
  onOpenFile: (path: string, line?: number) => void;
  className?: string;
}

export function TestsView({ catalog, loading, error, change, changePending, plan, headSha, hasTarget, onOpenFile, className }: TestsViewProps) {
  const [mode, setMode] = useState<"change" | "repo">(hasTarget ? "change" : "repo");
  const [query, setQuery] = useState("");
  useEffect(() => setMode(hasTarget ? "change" : "repo"), [hasTarget]);
  const showChange = hasTarget && mode === "change";
  const q = query.trim().toLowerCase();

  return (
    <div className={className}>
      <div className={VIEW_TOOLBAR}>
        {hasTarget && (
          <Segmented
            label="Show"
            size="xs"
            value={mode}
            onChange={setMode}
            options={[
              { value: "change" as const, label: <>Change {change ? <span className="font-mono text-muted-foreground">{change.findings.length}</span> : null}</>, title: "What this diff does to its tests, and the AI test plan" },
              { value: "repo" as const, label: <>Repo <span className="font-mono text-muted-foreground">{catalog?.tests.length ?? 0}</span></>, title: "Every test file of the analysed commit and what it reaches" },
            ]}
          />
        )}
        {showChange && changePending && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" aria-hidden /> Comparing tests…
          </span>
        )}
        <span className="flex items-center text-[11px] text-muted-foreground">Static: reach over imports and calls; coverage only from a committed report. Nothing is run.</span>
        <div className="ml-auto flex items-center gap-2">
          {loading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          <label className="flex h-7 w-44 items-center gap-1.5 self-center rounded-md border border-border bg-background px-2 text-xs focus-within:border-foreground/30">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter files" aria-label="Filter files" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" />
            {query && (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear" className="text-muted-foreground hover:text-foreground">
                <X className="size-3" />
              </button>
            )}
          </label>
        </div>
      </div>
      <div className="relative min-h-[220px] flex-1 overflow-auto bg-background">
        {error ? (
          <p className="flex items-start gap-2 px-6 py-8 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
          </p>
        ) : showChange ? (
          <ChangePanel change={change} pending={changePending} plan={plan} headSha={headSha} q={q} onOpenFile={onOpenFile} />
        ) : !catalog ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading tests…
          </div>
        ) : catalog.state === "none" ? (
          <p className="px-6 py-12 text-center text-sm text-muted-foreground">The test inventory is built during analysis — it appears once this repo&apos;s next analysis finishes.</p>
        ) : (
          <RepoPanel catalog={catalog} q={q} onOpenFile={onOpenFile} />
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-32 rounded-md border border-border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-mono text-lg leading-tight text-foreground">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-3">
      <h3 className="mb-2 text-xs font-semibold text-foreground">
        {title} {count !== undefined && <span className="font-mono font-normal text-muted-foreground">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function FileLink({ file, line, onOpenFile, title }: { file: string; line?: number; onOpenFile: (path: string, line?: number) => void; title?: string }) {
  return (
    <button type="button" onClick={() => onOpenFile(file, line)} title={title ?? file} className="max-w-full truncate text-left font-mono text-[11px] text-foreground hover:underline">
      {file}
      {line ? <span className="text-muted-foreground">:{line}</span> : null}
    </button>
  );
}

const TH = "border-b border-border px-2 py-1 text-left font-normal text-[11px] text-muted-foreground";
const TD = "border-b border-border/60 px-2 py-1 align-top";

function RepoPanel({ catalog, q, onOpenFile }: { catalog: TestsResponseDTO; q: string; onOpenFile: (path: string, line?: number) => void }) {
  const stats = useMemo(() => {
    const byKind = new Map<TestKind, number>();
    for (const t of catalog.tests) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
    const inventory = new Map<string, { framework: TestFramework; kind: TestKind; files: number; cases: number }>();
    for (const t of catalog.tests) {
      const key = `${t.framework}|${t.kind}`;
      const row = inventory.get(key) ?? { framework: t.framework, kind: t.kind, files: 0, cases: 0 };
      row.files++;
      row.cases += t.cases;
      inventory.set(key, row);
    }
    let found = 0;
    let hit = 0;
    const seen = new Set<string>();
    for (const r of catalog.reports) for (const f of r.files) if (!seen.has(f.file)) {
      seen.add(f.file);
      found += f.found;
      hit += f.hit;
    }
    return {
      byKind,
      inventory: [...inventory.values()].sort((a, b) => b.files - a.files),
      cases: catalog.tests.reduce((n, t) => n + t.cases, 0),
      reached: catalog.sources.filter((s) => s.testCount > 0).length,
      found,
      hit,
      markers: catalog.tests.flatMap((t) => t.markers.map((m) => ({ ...m, file: t.file }))),
    };
  }, [catalog]);
  const untested = catalog.sources.filter((s) => s.testCount === 0 && (!q || s.file.toLowerCase().includes(q))).sort((a, b) => b.loc - a.loc);
  const components = catalog.components.filter((c) => !q || c.name.toLowerCase().includes(q));
  const tests = catalog.tests.filter((t) => !q || t.file.toLowerCase().includes(q));
  const frameworks = [...new Set(catalog.frameworks.map((f) => f.framework))];

  if (catalog.tests.length === 0 && catalog.reports.length === 0) {
    return (
      <div className="mx-auto max-w-lg px-6 py-12 text-sm text-muted-foreground">
        <p className="flex items-center gap-2 text-foreground">
          <FlaskConical className="size-4" aria-hidden /> No test files found.
        </p>
        <p className="mt-2 leading-relaxed">
          Tests are files like <code>*.test.ts</code>, <code>*.spec.js</code>, <code>*.cy.ts</code>, <code>test_*.py</code>, <code>*_test.go</code> or <code>*Test.java</code>, or files with test cases in a <code>tests/</code>, <code>__tests__/</code> or <code>e2e/</code> folder.
          {catalog.sources.length > 0 && ` None of the ${catalog.sources.length} code files is reached by a test.`}
        </p>
        {frameworks.length > 0 && <p className="mt-2">Configured anyway: {frameworks.map((f) => FRAMEWORK_LABEL[f]).join(", ")}.</p>}
      </div>
    );
  }

  return (
    <div className="pb-6">
      <div className="flex flex-wrap gap-2 border-b border-border px-4 py-3">
        <Tile label="Test files" value={String(catalog.tests.length)} sub={catalog.support ? `+ ${catalog.support} support file(s)` : undefined} />
        <Tile label="Test cases" value={String(stats.cases)} />
        <Tile label="Unit · integration · e2e" value={KINDS.map((k) => stats.byKind.get(k) ?? 0).join(" · ")} />
        <Tile label="Frameworks" value={String(frameworks.length || "—")} sub={frameworks.map((f) => FRAMEWORK_LABEL[f]).join(", ") || "none configured"} />
        <Tile label="Code files a test reaches" value={pct(stats.reached, catalog.sources.length)} sub={`${stats.reached} of ${catalog.sources.length}`} />
        <Tile label="Report line coverage" value={catalog.reports.length ? pct(stats.hit, stats.found) : "—"} sub={catalog.reports.length ? catalog.reports.map((r) => r.file).join(", ") : "no committed report"} />
      </div>

      <Section title="Inventory" count={stats.inventory.length}>
        <table className="w-full max-w-3xl border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th className={TH}>Framework</th>
              <th className={TH}>Kind</th>
              <th className={cn(TH, "text-right")}>Files</th>
              <th className={cn(TH, "text-right")}>Cases</th>
              <th className={TH}>Configured in</th>
            </tr>
          </thead>
          <tbody>
            {stats.inventory.map((r) => (
              <tr key={`${r.framework}|${r.kind}`}>
                <td className={TD}>{FRAMEWORK_LABEL[r.framework]}</td>
                <td className={TD}>{r.kind}</td>
                <td className={cn(TD, "text-right font-mono")}>{r.files}</td>
                <td className={cn(TD, "text-right font-mono")}>{r.cases}</td>
                <td className={cn(TD, "text-[11px] text-muted-foreground")}>
                  {catalog.frameworks.filter((f) => f.framework === r.framework).map((f) => f.source).join(", ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="By component" count={components.length}>
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className={TH}>Component</th>
                <th className={cn(TH, "text-right")}>Code files</th>
                <th className={cn(TH, "text-right")}>Code lines</th>
                <th className={cn(TH, "text-right")}>Test files</th>
                <th className={cn(TH, "text-right")}>Test lines</th>
                <th className={cn(TH, "text-right")} title="Test lines per code line">Test : code</th>
                <th className={cn(TH, "text-right")} title="Code files some test reaches over imports and calls">Reached</th>
                <th className={cn(TH, "text-right")} title="Line coverage from the committed report">Report</th>
              </tr>
            </thead>
            <tbody>
              {components.map((c) => (
                <tr key={c.id}>
                  <td className={cn(TD, "font-medium")}>{c.name}</td>
                  <td className={cn(TD, "text-right font-mono")}>{c.codeFiles}</td>
                  <td className={cn(TD, "text-right font-mono")}>{c.codeLoc}</td>
                  <td className={cn(TD, "text-right font-mono")}>{c.testFiles}</td>
                  <td className={cn(TD, "text-right font-mono")}>{c.testLoc}</td>
                  <td className={cn(TD, "text-right font-mono", c.codeLoc > 0 && c.testLoc === 0 && "text-muted-foreground")}>{c.codeLoc ? (c.testLoc / c.codeLoc).toFixed(2) : "—"}</td>
                  <td className={cn(TD, "text-right font-mono")}>{pct(c.reached, c.codeFiles)}</td>
                  <td className={cn(TD, "text-right font-mono")}>{c.reportFound ? pct(c.reportHit, c.reportFound) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Code no test reaches (largest first)" count={untested.length}>
        <ul className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
          {untested.slice(0, 40).map((s) => (
            <li key={s.file} className="flex min-w-0 items-baseline gap-2">
              <FileLink file={s.file} onOpenFile={onOpenFile} />
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{s.loc} lines</span>
            </li>
          ))}
        </ul>
        {untested.length > 40 && <p className="mt-1 text-[11px] text-muted-foreground">… {untested.length - 40} more — filter to find one.</p>}
      </Section>

      {stats.markers.length > 0 && (
        <Section title="Skipped and focused tests" count={stats.markers.length}>
          <ul className="space-y-0.5">
            {stats.markers.map((m) => (
              <li key={`${m.file}:${m.line}`} className="flex items-baseline gap-2">
                <MarkerTag kind={m.kind} marker={m.marker} />
                <FileLink file={m.file} line={m.line} onOpenFile={onOpenFile} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Test files" count={tests.length}>
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th className={TH}>File</th>
              <th className={TH}>Framework</th>
              <th className={TH}>Kind</th>
              <th className={cn(TH, "text-right")}>Cases</th>
              <th className={cn(TH, "text-right")} title="Code files it reaches over imports and calls">Reaches</th>
            </tr>
          </thead>
          <tbody>
            {tests.slice(0, 300).map((t) => (
              <tr key={t.file}>
                <td className={cn(TD, "max-w-0 w-1/2")}>
                  <FileLink file={t.file} onOpenFile={onOpenFile} />
                </td>
                <td className={TD}>{FRAMEWORK_LABEL[t.framework]}</td>
                <td className={TD}>{t.kind}</td>
                <td className={cn(TD, "text-right font-mono")}>{t.cases}</td>
                <td className={cn(TD, "text-right font-mono")}>{t.reaches}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {tests.length > 300 && <p className="mt-1 text-[11px] text-muted-foreground">… {tests.length - 300} more — filter to find one.</p>}
      </Section>
    </div>
  );
}

function MarkerTag({ kind, marker }: { kind: "skip" | "focus"; marker: string }) {
  const visual = ASSESSMENT_VISUALS[kind === "focus" ? "defect" : "concern"];
  return (
    <span className="shrink-0 rounded px-1 font-mono text-[10px]" style={{ color: visual.text, background: `${visual.color}22` }}>
      {marker}
    </span>
  );
}

function ChangePanel({ change, pending, plan, headSha, q, onOpenFile }: { change: TestsChange | undefined; pending: boolean; plan: StoredTestPlan | null; headSha?: string; q: string; onOpenFile: (path: string, line?: number) => void }) {
  if (!change) {
    return (
      <p className="px-6 py-12 text-center text-sm text-muted-foreground">
        {pending ? "Comparing the change's tests…" : "The base/head comparison hasn't run for this diff yet."}
      </p>
    );
  }
  const match = (file: string) => !q || file.toLowerCase().includes(q);
  const changed = change.changedCode.filter((c) => match(c.file));
  return (
    <div className="pb-6">
      <div className="flex flex-wrap gap-2 border-b border-border px-4 py-3">
        <Tile label="Changed code files" value={String(change.counts.changedCode)} sub={`${change.counts.untested} no test reaches`} />
        <Tile label="Tests added · deleted" value={`${change.counts.addedTests} · ${change.counts.deletedTests}`} sub={`${change.modifiedTests.length} modified`} />
        <Tile label="Skipped · focused" value={`${change.counts.skipped} · ${change.counts.focused}`} sub="added in this diff" />
        <Tile label="Changed lines the report misses" value={change.report ? String(change.counts.missedLines) : "—"} sub={change.report ?? "no committed report covers them"} />
      </div>

      {change.findings.length > 0 && (
        <Section title="Findings" count={change.findings.length}>
          <ul className="space-y-1.5">
            {change.findings.map((f) => {
              const visual = ASSESSMENT_VISUALS[f.assessment];
              return (
                <li key={f.key} className="border-l-2 pl-2" style={{ borderColor: visual.color }}>
                  <div className="flex flex-wrap items-baseline gap-2 text-xs">
                    <span className="text-[10px] font-medium" style={{ color: visual.text }}>
                      {visual.label}
                    </span>
                    <span className="text-foreground">{f.summary}</span>
                    <FileLink file={f.file} line={f.line} onOpenFile={onOpenFile} />
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{f.rationale}</p>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <Section title="Changed code and the tests that reach it" count={changed.length}>
        {changed.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">This change touches no code file.</p>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className={TH}>File</th>
                <th className={cn(TH, "text-right")}>Changed lines</th>
                <th className={TH}>Tests that reach it (nearest first)</th>
                <th className={TH}>Report</th>
              </tr>
            </thead>
            <tbody>
              {changed.map((c) => (
                <tr key={c.file}>
                  <td className={cn(TD, "max-w-0 w-2/5")}>
                    <FileLink file={c.file} onOpenFile={onOpenFile} />
                    <span className="ml-1 text-[10px] text-muted-foreground">{c.status}</span>
                  </td>
                  <td className={cn(TD, "text-right font-mono")}>{c.changedLines}</td>
                  <td className={TD}>
                    {c.testCount === 0 ? (
                      <span className="text-[11px]" style={{ color: ASSESSMENT_VISUALS.concern.text }}>
                        none
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                        {c.changedTests.map((t) => (
                          <button key={t} type="button" onClick={() => onOpenFile(t)} title={`${t} — this change edits it`} className="font-mono text-[11px] text-brand hover:underline">
                            {base(t)}*
                          </button>
                        ))}
                        {c.tests.slice(0, 4).map((t) => (
                          <button key={t} type="button" onClick={() => onOpenFile(t)} title={t} className="font-mono text-[11px] text-foreground hover:underline">
                            {base(t)}
                          </button>
                        ))}
                        {c.testCount > c.changedTests.length + Math.min(4, c.tests.length) && (
                          <span className="text-[11px] text-muted-foreground">+{c.testCount - c.changedTests.length - Math.min(4, c.tests.length)}</span>
                        )}
                        {c.hops && c.hops > 1 && <span className="text-[10px] text-muted-foreground">({c.hops} hops)</span>}
                      </div>
                    )}
                  </td>
                  <td className={cn(TD, "font-mono text-[11px]")}>
                    {c.missedLines === undefined ? (
                      <span className="text-muted-foreground">—</span>
                    ) : c.missedLines.length === 0 ? (
                      <span className="text-muted-foreground">{c.instrumentedLines ? "all run" : "not instrumented"}</span>
                    ) : (
                      <button type="button" onClick={() => onOpenFile(c.file, c.missedLines![0])} className="hover:underline" style={{ color: ASSESSMENT_VISUALS.concern.text }}>
                        {c.missedLines.length}/{c.instrumentedLines} missed
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-1 text-[10px] text-muted-foreground">* a test this change edits. Reached means a test loads the file, not that it runs the changed lines.</p>
      </Section>

      {change.markers.length > 0 && (
        <Section title="Skipped or focused in this diff" count={change.markers.length}>
          <ul className="space-y-0.5">
            {change.markers.map((m) => (
              <li key={`${m.file}:${m.line}`} className="flex items-baseline gap-2">
                <MarkerTag kind={m.kind} marker={m.marker} />
                <FileLink file={m.file} line={m.line} onOpenFile={onOpenFile} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(change.deletedTests.length > 0 || change.addedTests.length > 0 || change.modifiedTests.length > 0) && (
        <Section title="Test files in this diff" count={change.deletedTests.length + change.addedTests.length + change.modifiedTests.length}>
          <ul className="space-y-0.5 text-xs">
            {change.deletedTests.map((d) => (
              <li key={d.file} className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-[10px] text-destructive">−</span>
                <span className="font-mono text-[11px] text-muted-foreground line-through">{d.file}</span>
                <span className="text-[11px] text-muted-foreground">
                  {d.cases} case(s){d.subjects.length ? ` · tested ${d.subjects.map(base).join(", ")} (still there)` : ""}
                </span>
              </li>
            ))}
            {change.addedTests.map((t) => (
              <li key={t.file} className="flex items-baseline gap-2">
                <span className="font-mono text-[10px] text-emerald-500">+</span>
                <FileLink file={t.file} onOpenFile={onOpenFile} />
                <span className="text-[11px] text-muted-foreground">
                  {FRAMEWORK_LABEL[t.framework]} · {t.kind} · {t.cases} case(s)
                </span>
              </li>
            ))}
            {change.modifiedTests.map((t) => (
              <li key={t} className="flex items-baseline gap-2">
                <span className="font-mono text-[10px] text-amber-500">~</span>
                <FileLink file={t} onOpenFile={onOpenFile} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <TestPlanSection plan={plan} headSha={headSha} onOpenFile={onOpenFile} />
    </div>
  );
}

function TestPlanSection({ plan, headSha, onOpenFile }: { plan: StoredTestPlan | null; headSha?: string; onOpenFile: (path: string, line?: number) => void }) {
  if (!plan) {
    return (
      <Section title="Test plan">
        <p className="text-[11px] text-muted-foreground">The AI test plan is made at the end of a review — run ▶ Review to get one.</p>
      </Section>
    );
  }
  const stale = Boolean(headSha && plan.headSha && plan.headSha !== headSha);
  return (
    <Section title="Test plan" count={plan.items.length}>
      {stale && <p className="mb-2 text-[11px] text-muted-foreground">Made for an earlier commit ({plan.headSha!.slice(0, 7)}) — review again for the current one.</p>}
      {plan.error && <p className="mb-2 text-[11px] text-destructive">The test plan call failed: {plan.error}</p>}
      {plan.parseFailed && <p className="mb-2 text-[11px] text-muted-foreground">The model&apos;s answer could not be read.</p>}
      {!plan.error && !plan.parseFailed && plan.items.length === 0 && <p className="text-[11px] text-muted-foreground">Nothing to plan: the review found nothing the plan could build on.</p>}
      <div className={cn("grid gap-4 lg:grid-cols-2", stale && "opacity-60")}>
        {(["regression", "new-behaviour"] as const).map((type) => {
          const items = plan.items.filter((i) => i.type === type);
          if (items.length === 0) return null;
          return (
            <div key={type}>
              <h4 className="mb-1 text-[11px] font-semibold text-muted-foreground">{type === "regression" ? "Regression" : "New behaviour"}</h4>
              <ol className="space-y-2">
                {items.map((item, i) => {
                  const source = plan.sources[item.source.ref];
                  return (
                    <li key={`${type}-${i}`} className="rounded-md border border-border bg-card px-2.5 py-1.5">
                      <div className="text-xs text-foreground">{item.title}</div>
                      {item.steps.length > 0 && (
                        <ul className="mt-1 list-disc pl-4 text-[11px] text-muted-foreground">
                          {item.steps.map((s, j) => (
                            <li key={j}>{s}</li>
                          ))}
                        </ul>
                      )}
                      <div className="mt-1 flex min-w-0 items-baseline gap-1.5 text-[10px] text-muted-foreground">
                        <span className="shrink-0 rounded bg-secondary px-1">{SOURCE_LABEL[item.source.kind] ?? item.source.kind}</span>
                        {source?.file ? (
                          <button type="button" onClick={() => onOpenFile(source.file!, source.line)} title={source.text} className="truncate font-mono hover:underline">
                            {source.file}
                            {source.line ? `:${source.line}` : ""}
                          </button>
                        ) : (
                          source && <span className="truncate" title={source.text}>{source.text}</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
