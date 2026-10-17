"use client";

// The Stats view (DESIGN.md §6.19): totals, lines of code per language, a
// day-by-day timeline (lines of code, commits, CI runs) and — when more
// than one person committed — who did what. Everything but the CI runs
// arrives from StatsGraphView; the runs are fetched here, since they come
// from the host and may be slow or unavailable.

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";
import type { CiRun, CiRunsLookup, RepoStats } from "@/lib/jobs/repo-stats";

const fmt = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export interface StatsViewProps {
  repoId: string;
  stats: RepoStats;
  /** `null` for a local repo, which has no CI to read. */
  ciHost: "GitHub" | "GitLab" | null;
}

export function StatsView({ repoId, stats, ciHost }: StatsViewProps) {
  const [ci, setCi] = useState<CiRunsLookup | null>(null);
  useEffect(() => {
    if (!ciHost) return;
    let live = true;
    fetch(`/api/repos/${repoId}/stats/ci`)
      .then((r) => r.json())
      .then((body: CiRunsLookup | { error?: string }) => {
        if (live) setCi("available" in body ? body : { available: false, reason: (body as { error?: string }).error ?? "Could not read CI runs." });
      })
      .catch((error: Error) => live && setCi({ available: false, reason: error.message }));
    return () => {
      live = false;
    };
  }, [repoId, ciHost]);

  return (
    <div className="space-y-4">
      <Totals stats={stats} />
      <Languages stats={stats} />
      <Timeline stats={stats} ci={ciHost ? ci : { available: false, reason: "Local repos have no CI to read." }} ciHost={ciHost} />
      {stats.contributors.length > 1 ? <Contributors stats={stats} /> : null}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-card p-4 ring-1 ring-border">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ageOf(first: string | null): string {
  if (!first) return "—";
  const days = Math.max(0, Math.round((Date.now() - new Date(first).getTime()) / 86_400_000));
  if (days < 60) return `${days} day${days === 1 ? "" : "s"}`;
  if (days < 730) return `${Math.round(days / 30.4)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}

function Totals({ stats }: { stats: RepoStats }) {
  const tiles: Array<[string, string, string?]> = [
    ["Lines", fmt.format(stats.totals.lines), `${fmt.format(stats.totals.nonBlank)} non-blank`],
    ["Code", fmt.format(stats.totals.codeLines), "programming languages only"],
    ["Files", fmt.format(stats.totals.files), `${stats.languages.length} languages`],
    ["Commits", fmt.format(stats.commits.total) + (stats.commits.truncated ? "+" : ""), `${stats.timeline.length} active days`],
    ["Contributors", fmt.format(stats.contributors.length)],
    ["Age", ageOf(stats.commits.first), stats.commits.first ? `since ${stats.commits.first.slice(0, 10)}` : undefined],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map(([label, value, sub]) => (
        <div key={label} className="rounded-xl bg-card px-3 py-2.5 ring-1 ring-border">
          <div className="text-[11px] text-muted-foreground">{label}</div>
          <div className="font-mono text-lg font-semibold tabular-nums">{value}</div>
          {sub ? <div className="truncate text-[11px] text-muted-foreground">{sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

function Languages({ stats }: { stats: RepoStats }) {
  const [codeOnly, setCodeOnly] = useState(false);
  const rows = codeOnly ? stats.languages.filter((l) => l.kind === "programming") : stats.languages;
  const total = rows.reduce((n, l) => n + l.lines, 0) || 1;
  return (
    <Section
      title="Lines of code by language"
      aside={
        <Toggle
          options={[
            ["all", "All files"],
            ["code", "Code only"],
          ]}
          value={codeOnly ? "code" : "all"}
          onChange={(v) => setCodeOnly(v === "code")}
        />
      }
    >
      <div className="mb-3 flex h-2.5 overflow-hidden rounded-full bg-secondary">
        {rows.map((l) => (
          <span key={l.language} style={{ width: `${(l.lines / total) * 100}%`, background: l.color }} title={`${l.language} ${((l.lines / total) * 100).toFixed(1)}%`} />
        ))}
      </div>
      <table className="w-full text-[12px]">
        <thead className="text-left text-[11px] text-muted-foreground">
          <tr>
            <th className="py-1 font-normal">Language</th>
            <th className="py-1 text-right font-normal">Files</th>
            <th className="py-1 text-right font-normal">Lines</th>
            <th className="hidden py-1 text-right font-normal sm:table-cell">Non-blank</th>
            <th className="w-1/4 py-1 pl-4 font-normal">Share</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((l) => (
            <tr key={l.language}>
              <td className="py-1.5">
                <span className="mr-2 inline-block size-2.5 rounded-full align-middle" style={{ background: l.color }} aria-hidden />
                {l.language}
                <span className="ml-1.5 text-[11px] text-muted-foreground">{l.kind}</span>
              </td>
              <td className="py-1.5 text-right font-mono tabular-nums">{fmt.format(l.files)}</td>
              <td className="py-1.5 text-right font-mono tabular-nums">{fmt.format(l.lines)}</td>
              <td className="hidden py-1.5 text-right font-mono tabular-nums text-muted-foreground sm:table-cell">{fmt.format(l.nonBlank)}</td>
              <td className="py-1.5 pl-4">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full" style={{ width: `${(l.lines / total) * 100}%`, background: l.color }} />
                  </div>
                  <span className="w-10 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{((l.lines / total) * 100).toFixed(1)}%</span>
                </div>
              </td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="py-1.5">Total</td>
            <td className="py-1.5 text-right font-mono tabular-nums">{fmt.format(rows.reduce((n, l) => n + l.files, 0))}</td>
            <td className="py-1.5 text-right font-mono tabular-nums">{fmt.format(rows.reduce((n, l) => n + l.lines, 0))}</td>
            <td className="hidden py-1.5 text-right font-mono tabular-nums text-muted-foreground sm:table-cell">{fmt.format(rows.reduce((n, l) => n + l.nonBlank, 0))}</td>
            <td />
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-muted-foreground">Lockfiles, minified bundles, type declarations and vendored folders aren&apos;t counted.</p>
    </Section>
  );
}

function Toggle<T extends string>({ options, value, onChange }: { options: Array<[T, string]>; value: T; onChange(v: T): void }) {
  return (
    <div className="flex rounded-md bg-secondary p-0.5 text-[11px]">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={cn("rounded px-2 py-0.5 transition-colors", value === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

type Range = "30" | "90" | "365" | "all";

interface Day {
  date: string;
  commits: number;
  lines: number;
  passed: number;
  failed: number;
  failedRuns: CiRun[];
}

/** `YYYY-MM-DD` in the viewer's time zone. */
function localDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function buildDays(stats: RepoStats, runs: CiRun[], range: Range): Day[] {
  const byDate = new Map(stats.timeline.map((d) => [d.date, d]));
  const ciByDate = new Map<string, { passed: number; failed: number; failedRuns: CiRun[] }>();
  for (const run of runs) {
    const day = localDay(run.date);
    let entry = ciByDate.get(day);
    if (!entry) ciByDate.set(day, (entry = { passed: 0, failed: 0, failedRuns: [] }));
    if (run.state === "success") entry.passed++;
    else if (run.state === "failure") {
      entry.failed++;
      entry.failedRuns.push(run);
    }
  }
  const known = [...byDate.keys(), ...ciByDate.keys()].sort();
  if (known.length === 0) return [];
  const today = localDay(new Date().toISOString());
  const end = known[known.length - 1] > today ? known[known.length - 1] : today;
  const start = range === "all" ? known[0] : addDays(end, -Number(range) + 1);

  // Lines carry forward over days without commits; before `start`, take the last known value.
  let lines = 0;
  for (const d of stats.timeline) {
    if (d.date < start) lines = d.lines;
    else break;
  }

  const days: Day[] = [];
  for (let day = start; day <= end && days.length < 20_000; day = addDays(day, 1)) {
    const t = byDate.get(day);
    if (t) lines = t.lines;
    const c = ciByDate.get(day);
    days.push({ date: day, commits: t?.commits ?? 0, lines, passed: c?.passed ?? 0, failed: c?.failed ?? 0, failedRuns: c?.failedRuns ?? [] });
  }
  return days;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const LOC_H = 140;
const COMMITS_H = 48;
const CI_H = 36;
const GAP = 14;
const AXIS_W = 44;

function Timeline({ stats, ci, ciHost }: { stats: RepoStats; ci: CiRunsLookup | null; ciHost: string | null }) {
  const [range, setRange] = useState<Range>(stats.timeline.length > 0 && stats.timeline[0].date > addDays(localDay(new Date().toISOString()), -90) ? "all" : "365");
  const runs = useMemo(() => (ci?.available ? ci.runs : []), [ci]);
  const days = useMemo(() => buildDays(stats, runs, range), [stats, runs, range]);
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const showCi = Boolean(ci?.available && runs.length > 0);
  const plotW = Math.max(0, width - AXIS_W);
  const n = days.length;
  const step = n > 0 ? plotW / n : 0;
  const maxLines = Math.max(1, ...days.map((d) => d.lines));
  const minLines = Math.min(maxLines, ...days.map((d) => d.lines));
  const lo = Math.max(0, minLines - (maxLines - minLines) * 0.1);
  const maxCommits = Math.max(1, ...days.map((d) => d.commits));
  const maxCi = Math.max(1, ...days.map((d) => d.passed + d.failed));
  const totalH = LOC_H + GAP + COMMITS_H + (showCi ? GAP + CI_H : 0) + 16;

  const y = (v: number) => LOC_H - ((v - lo) / (maxLines - lo || 1)) * (LOC_H - 6);
  const x = (i: number) => AXIS_W + i * step + step / 2;
  const linePath = days.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.lines).toFixed(1)}`).join("");
  const areaPath = n ? `${linePath}L${x(n - 1).toFixed(1)},${LOC_H}L${x(0).toFixed(1)},${LOC_H}Z` : "";
  const barW = Math.max(1, step - (step > 4 ? 1 : 0));
  const commitsTop = LOC_H + GAP;
  const ciTop = commitsTop + COMMITS_H + GAP;

  const windowRuns = useMemo(() => {
    if (!n) return { passed: 0, failed: 0 };
    return days.reduce((acc, d) => ({ passed: acc.passed + d.passed, failed: acc.failed + d.failed }), { passed: 0, failed: 0 });
  }, [days, n]);
  const windowCommits = days.reduce((s, d) => s + d.commits, 0);
  const ticks = n ? [0, Math.floor(n / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i) : [];
  const h = hover !== null ? days[hover] : null;

  let ciNote: React.ReactNode;
  if (!ciHost) ciNote = "No CI — a local repo";
  else if (!ci) ciNote = `Loading CI runs from ${ciHost}…`;
  else if (!ci.available) ciNote = <span title={ci.reason}>CI unavailable</span>;
  else if (runs.length === 0) ciNote = "No CI runs on the default branch";
  else
    ciNote = (
      <>
        CI {fmt.format(windowRuns.passed + windowRuns.failed)} runs ·{" "}
        <span className={windowRuns.failed ? "text-destructive" : undefined}>{fmt.format(windowRuns.failed)} failed</span>
      </>
    );

  return (
    <Section
      title="Timeline"
      aside={
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">
            {fmt.format(windowCommits)} commits · {ciNote}
          </span>
          <Toggle<Range>
            options={[
              ["30", "30d"],
              ["90", "90d"],
              ["365", "1y"],
              ["all", "All"],
            ]}
            value={range}
            onChange={setRange}
          />
        </div>
      }
    >
      <div ref={ref} className="relative">
        {width > 0 && n > 0 ? (
          <svg
            width={width}
            height={totalH}
            className="block select-none"
            onMouseLeave={() => setHover(null)}
            onMouseMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const i = Math.floor((e.clientX - box.left - AXIS_W) / (step || 1));
              setHover(i >= 0 && i < n ? i : null);
            }}
          >
            {/* lines of code */}
            <text x={0} y={10} className="fill-muted-foreground text-[10px]">{compact.format(maxLines)}</text>
            <text x={0} y={LOC_H} className="fill-muted-foreground text-[10px]">{compact.format(lo)}</text>
            <line x1={AXIS_W} x2={width} y1={LOC_H} y2={LOC_H} className="stroke-border" />
            <path d={areaPath} className="fill-brand/15" />
            <path d={linePath} fill="none" className="stroke-brand" strokeWidth={1.5} strokeLinejoin="round" />

            {/* commits */}
            <text x={0} y={commitsTop + 10} className="fill-muted-foreground text-[10px]">commits</text>
            {days.map((d, i) =>
              d.commits ? (
                <rect
                  key={d.date}
                  x={AXIS_W + i * step}
                  width={barW}
                  y={commitsTop + COMMITS_H - Math.max(2, (d.commits / maxCommits) * COMMITS_H)}
                  height={Math.max(2, (d.commits / maxCommits) * COMMITS_H)}
                  className="fill-foreground/45"
                  rx={step > 6 ? 1 : 0}
                />
              ) : null
            )}
            <line x1={AXIS_W} x2={width} y1={commitsTop + COMMITS_H} y2={commitsTop + COMMITS_H} className="stroke-border" />

            {/* CI: passed stacked under failed */}
            {showCi ? (
              <>
                <text x={0} y={ciTop + 10} className="fill-muted-foreground text-[10px]">CI</text>
                {days.map((d, i) => {
                  if (!d.passed && !d.failed) return null;
                  const ph = (d.passed / maxCi) * CI_H;
                  const fh = Math.max(d.failed ? 3 : 0, (d.failed / maxCi) * CI_H);
                  return (
                    <g key={d.date}>
                      {d.passed ? <rect x={AXIS_W + i * step} width={barW} y={ciTop + CI_H - ph} height={ph} className="fill-success/60" /> : null}
                      {d.failed ? <rect x={AXIS_W + i * step} width={barW} y={ciTop + CI_H - ph - fh} height={fh} className="fill-destructive" /> : null}
                    </g>
                  );
                })}
                <line x1={AXIS_W} x2={width} y1={ciTop + CI_H} y2={ciTop + CI_H} className="stroke-border" />
              </>
            ) : null}

            {/* date axis */}
            {ticks.map((i) => (
              <text
                key={i}
                x={x(i)}
                y={totalH - 2}
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                className="fill-muted-foreground text-[10px]"
              >
                {days[i].date}
              </text>
            ))}

            {hover !== null ? (
              <>
                <line x1={x(hover)} x2={x(hover)} y1={0} y2={totalH - 14} className="stroke-foreground/30" strokeDasharray="2 2" />
                <circle cx={x(hover)} cy={y(days[hover].lines)} r={3} className="fill-brand" />
              </>
            ) : null}
          </svg>
        ) : (
          <p className="py-6 text-center text-[12px] text-muted-foreground">{n === 0 ? "No commits in this range." : null}</p>
        )}
        {h && hover !== null ? (
          <div
            className="pointer-events-none absolute top-1 z-10 rounded-md bg-popover px-2.5 py-1.5 text-[11px] shadow-md ring-1 ring-border"
            style={x(hover) > width / 2 ? { right: width - x(hover) + 10 } : { left: x(hover) + 10 }}
          >
            <div className="font-mono font-semibold">{h.date}</div>
            <div>{fmt.format(h.lines)} lines</div>
            <div>
              {h.commits} commit{h.commits === 1 ? "" : "s"}
            </div>
            {showCi ? (
              <div>
                CI {h.passed} passed
                {h.failed ? <span className="text-destructive"> · {h.failed} failed</span> : null}
              </div>
            ) : null}
            {h.failedRuns.slice(0, 4).map((run) => (
              <div key={run.id} className="max-w-56 truncate text-destructive">
                ✕ {run.name}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Lines of code follow the default branch&apos;s main line (first parents), counted the same way as the table above.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Contributors
// ---------------------------------------------------------------------------

function Contributors({ stats }: { stats: RepoStats }) {
  const max = Math.max(1, ...stats.contributors.map((c) => c.commits));
  const total = stats.contributors.reduce((n, c) => n + c.commits, 0) || 1;
  return (
    <Section title={`Contributors · ${stats.contributors.length}`}>
      <table className="w-full text-[12px]">
        <thead className="text-left text-[11px] text-muted-foreground">
          <tr>
            <th className="py-1 font-normal">Who</th>
            <th className="w-1/4 py-1 font-normal">Commits</th>
            <th className="py-1 text-right font-normal">Lines + / −</th>
            <th className="hidden py-1 pl-4 text-right font-normal md:table-cell">Active</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {stats.contributors.map((c) => (
            <tr key={`${c.name}:${c.email}`}>
              <td className="max-w-0 py-1.5">
                <div className="truncate">{c.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">{c.email}</div>
              </td>
              <td className="py-1.5">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${(c.commits / max) * 100}%` }} />
                  </div>
                  <span className="w-20 text-right font-mono text-[11px] tabular-nums">
                    {fmt.format(c.commits)} <span className="text-muted-foreground">{Math.round((c.commits / total) * 100)}%</span>
                  </span>
                </div>
              </td>
              <td className="py-1.5 text-right font-mono text-[11px] tabular-nums">
                <span className="text-success">+{compact.format(c.added)}</span> <span className="text-destructive">−{compact.format(c.removed)}</span>
              </td>
              <td className="hidden py-1.5 pl-4 text-right font-mono text-[11px] text-muted-foreground md:table-cell">
                {c.first.slice(0, 10)} → {c.last.slice(0, 10)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
