// Committed coverage reports: lcov, Istanbul JSON, Cobertura and JaCoCo XML,
// read into line coverage per repo file (DESIGN.md §6.22 §1). Nothing is run.

import path from "node:path";
import type { CoverageFile, CoverageReport } from "./types";

type ReadText = (relPath: string) => Promise<string | null>;

/** Report paths probed under the repo root and each package root (the analysis skips `coverage/`, so it isn't listed). */
const PROBES = [
  "coverage/lcov.info",
  "lcov.info",
  "coverage/coverage-final.json",
  "coverage/cobertura-coverage.xml",
  "cobertura/coverage.xml",
  "coverage.xml",
  "target/site/jacoco/jacoco.xml",
  "build/reports/jacoco/test/jacocoTestReport.xml",
];
const REPORT_NAMES = /^(lcov\.info|coverage-final\.json|cobertura-coverage\.xml|coverage\.xml|jacoco\.xml|jacocoTestReport\.xml)$/;
const PACKAGE_ROOT = /^(package\.json|pyproject\.toml|setup\.py|go\.mod|pom\.xml|build\.gradle(\.kts)?)$/;

/** Raw line hits per path as the report writes it. */
type RawCoverage = Map<string, Map<number, number>>;

/** Every committed coverage report in the tree, matched to repo files. */
export async function readCoverageReports(files: readonly string[], readText: ReadText): Promise<CoverageReport[]> {
  const roots = new Set<string>([""]);
  for (const f of files) {
    if (PACKAGE_ROOT.test(path.posix.basename(f)) && !f.split("/").includes("node_modules")) {
      const dir = path.posix.dirname(f);
      roots.add(dir === "." ? "" : dir);
    }
  }
  const candidates = new Set<string>();
  for (const root of roots) for (const probe of PROBES) candidates.add(root ? `${root}/${probe}` : probe);
  for (const f of files) if (REPORT_NAMES.test(path.posix.basename(f))) candidates.add(f);

  const repoFiles = new Set(files);
  const reports: CoverageReport[] = [];
  for (const file of [...candidates].sort()) {
    const text = await readText(file);
    if (!text) continue;
    const parsed = parseCoverage(file, text);
    if (!parsed) continue;
    reports.push(matchReport(file, parsed.format, parsed.raw, repoFiles));
  }
  return reports;
}

/** One report's text; `null` when it isn't a report this reads. */
export function parseCoverage(file: string, text: string): { format: CoverageReport["format"]; raw: RawCoverage } | null {
  const trimmed = text.trimStart();
  if (/(^|\n)SF:/.test(text)) return { format: "lcov", raw: parseLcov(text) };
  if (trimmed.startsWith("{")) {
    const raw = parseIstanbul(text);
    return raw ? { format: "istanbul", raw } : null;
  }
  if (trimmed.startsWith("<")) {
    if (/<report\b/.test(text) && /<sourcefile\b/.test(text)) return { format: "jacoco", raw: parseJacoco(text) };
    if (/<coverage\b/.test(text) && /<class\b/.test(text)) return { format: "cobertura", raw: parseCobertura(text) };
  }
  void file;
  return null;
}

function hitsFor(raw: RawCoverage, file: string): Map<number, number> {
  let hits = raw.get(file);
  if (!hits) raw.set(file, (hits = new Map()));
  return hits;
}

function parseLcov(text: string): RawCoverage {
  const raw: RawCoverage = new Map();
  let current: Map<number, number> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) current = hitsFor(raw, line.slice(3).trim());
    else if (line === "end_of_record") current = null;
    else if (current && line.startsWith("DA:")) {
      const [ln, count] = line.slice(3).split(",");
      const n = Number(ln);
      if (n > 0) current.set(n, Math.max(current.get(n) ?? 0, Number(count) || 0));
    }
  }
  return raw;
}

function parseIstanbul(text: string): RawCoverage | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const raw: RawCoverage = new Map();
  for (const [key, entry] of Object.entries(data as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { path?: string; statementMap?: Record<string, { start?: { line?: number } }>; s?: Record<string, number> };
    if (!e.statementMap || !e.s) continue;
    const hits = hitsFor(raw, e.path ?? key);
    for (const [id, loc] of Object.entries(e.statementMap)) {
      const n = loc.start?.line;
      if (!n) continue;
      hits.set(n, Math.max(hits.get(n) ?? 0, e.s[id] ?? 0));
    }
  }
  return raw.size > 0 ? raw : null;
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

function parseCobertura(text: string): RawCoverage {
  const raw: RawCoverage = new Map();
  const sources = [...text.matchAll(/<source>([^<]*)<\/source>/g)].map((m) => m[1].trim());
  // Each <class filename="…"> holds its <lines>; a class may repeat a file.
  for (const m of text.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
    const filename = attr(m[1], "filename");
    if (!filename) continue;
    const name = sources.length === 1 && !filename.startsWith("/") ? `${sources[0].replace(/\/+$/, "")}/${filename}` : filename;
    const hits = hitsFor(raw, name);
    for (const l of m[2].matchAll(/<line\b([^>]*)\/?>/g)) {
      const n = Number(attr(l[1], "number"));
      if (n > 0) hits.set(n, Math.max(hits.get(n) ?? 0, Number(attr(l[1], "hits")) || 0));
    }
  }
  return raw;
}

function parseJacoco(text: string): RawCoverage {
  const raw: RawCoverage = new Map();
  for (const pkg of text.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/g)) {
    const pkgName = attr(pkg[1], "name") ?? "";
    for (const sf of pkg[2].matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/g)) {
      const name = attr(sf[1], "name");
      if (!name) continue;
      const hits = hitsFor(raw, pkgName ? `${pkgName}/${name}` : name);
      for (const l of sf[2].matchAll(/<line\b([^>]*)\/?>/g)) {
        const n = Number(attr(l[1], "nr"));
        const ci = Number(attr(l[1], "ci")) || 0;
        const mi = Number(attr(l[1], "mi")) || 0;
        if (n > 0 && ci + mi > 0) hits.set(n, Math.max(hits.get(n) ?? 0, ci));
      }
    }
  }
  return raw;
}

/** Match a report's paths to repo files: as written, under the report's package root, then by unique suffix. */
function matchReport(reportFile: string, format: CoverageReport["format"], raw: RawCoverage, repoFiles: Set<string>): CoverageReport {
  // `pkg/coverage/lcov.info` → `pkg`; `pkg/target/site/jacoco/jacoco.xml` → `pkg`.
  const dir = path.posix.dirname(reportFile);
  const root = (dir === "." ? "" : dir).replace(/(^|\/)(coverage|cobertura|target\/site\/jacoco|build\/reports\/jacoco\/test)$/, "");
  const bySuffix = suffixIndex(repoFiles);
  const out = new Map<string, CoverageFile>();
  let unmatched = 0;
  for (const [written, hits] of raw) {
    const file = resolveReportPath(written, root, repoFiles, bySuffix);
    if (!file) {
      unmatched++;
      continue;
    }
    const lines = new Map<number, number>();
    const prev = out.get(file);
    // A file listed twice: a line is hit if either entry hit it.
    if (prev) {
      for (const n of prev.missed) lines.set(n, 0);
      for (const n of prev.covered) lines.set(n, 1);
    }
    for (const [n, h] of hits) lines.set(n, Math.max(lines.get(n) ?? 0, h));
    const sorted = [...lines].sort((a, b) => a[0] - b[0]);
    const missed = sorted.filter(([, h]) => h === 0).map(([n]) => n);
    const covered = sorted.filter(([, h]) => h > 0).map(([n]) => n);
    out.set(file, { file, found: lines.size, hit: covered.length, missed, covered });
  }
  return { file: reportFile, format, files: [...out.values()].sort((a, b) => a.file.localeCompare(b.file)), unmatched };
}

function suffixIndex(repoFiles: Set<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const f of repoFiles) {
    const base = path.posix.basename(f);
    (index.get(base) ?? index.set(base, []).get(base)!).push(f);
  }
  return index;
}

export function resolveReportPath(written: string, root: string, repoFiles: Set<string>, bySuffix: Map<string, string[]>): string | undefined {
  const norm = written.replace(/\\/g, "/").replace(/^\.\//, "");
  if (repoFiles.has(norm)) return norm;
  if (root && repoFiles.has(`${root}/${norm}`)) return `${root}/${norm}`;
  // Absolute or CI paths: the repo file whose path is the longest suffix, if only one.
  const parts = norm.split("/").filter(Boolean);
  const candidates = bySuffix.get(parts[parts.length - 1] ?? "") ?? [];
  let best: string | undefined;
  let bestLen = 0;
  let tie = false;
  for (const c of candidates) {
    const cParts = c.split("/");
    let n = 0;
    while (n < cParts.length && n < parts.length && cParts[cParts.length - 1 - n] === parts[parts.length - 1 - n]) n++;
    if (n > bestLen) {
      best = c;
      bestLen = n;
      tie = false;
    } else if (n === bestLen) tie = true;
  }
  // A bare file name matching several repo files is a guess, not a match.
  return best && !tie && (bestLen >= 2 || candidates.length === 1) ? best : undefined;
}
