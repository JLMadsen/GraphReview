// The Stats page (DESIGN.md §6.19): numbers about the repo itself, with no
// PR or diff involved. Lines of code per language at the last analysed
// commit, who wrote the history, and a day-by-day timeline of commits and
// lines of code — all read from git in the app's clone (a local repo: the
// repo itself), so it works offline. CI runs for the timeline come from
// the host separately (`loadCiRuns`), since they need the network.
//
// Kept out of lib/jobs' barrel like ./repo-tree: only the `/stats` routes
// need it.

import type { RepoRecord } from "@/lib/db";
import { gitOutput } from "@/lib/analysis/source-tree";
import { listWorkflowRuns } from "@/lib/github";
import type { CiRun } from "@/lib/github";
import { listPipelines } from "@/lib/gitlab";
import { resolveGitHubAccess } from "./github-access";
import { resolveGitLabAccess } from "./gitlab-access";
import { sourceDir } from "./review-context";

export type { CiRun };

/** GitHub linguist's split: only `programming` counts toward "code". */
export type LanguageKind = "programming" | "markup" | "data" | "prose";

interface LanguageDef {
  name: string;
  kind: LanguageKind;
  /** linguist's colour, so the bar reads like GitHub's. */
  color: string;
}

const L = (name: string, kind: LanguageKind, color: string): LanguageDef => ({ name, kind, color });
const TS = L("TypeScript", "programming", "#3178c6");
const JS = L("JavaScript", "programming", "#f1e05a");
const PY = L("Python", "programming", "#3572A5");
const CSHARP = L("C#", "programming", "#178600");
const CPP = L("C++", "programming", "#f34b7d");
const SHELL = L("Shell", "programming", "#89e051");
const YAML = L("YAML", "data", "#cb171e");
const MD = L("Markdown", "prose", "#083fa1");
const SCSS = L("SCSS", "markup", "#c6538c");

const BY_EXTENSION: Readonly<Record<string, LanguageDef>> = {
  ts: TS, tsx: TS, mts: TS, cts: TS,
  js: JS, jsx: JS, mjs: JS, cjs: JS,
  py: PY, pyi: PY,
  go: L("Go", "programming", "#00ADD8"),
  rs: L("Rust", "programming", "#dea584"),
  java: L("Java", "programming", "#b07219"),
  kt: L("Kotlin", "programming", "#A97BFF"), kts: L("Kotlin", "programming", "#A97BFF"),
  scala: L("Scala", "programming", "#c22d40"),
  groovy: L("Groovy", "programming", "#4298b8"), gradle: L("Groovy", "programming", "#4298b8"),
  cs: CSHARP,
  fs: L("F#", "programming", "#b845fc"),
  c: L("C", "programming", "#555555"), h: L("C", "programming", "#555555"),
  cc: CPP, cpp: CPP, cxx: CPP, hpp: CPP, hh: CPP,
  m: L("Objective-C", "programming", "#438eff"),
  swift: L("Swift", "programming", "#F05138"),
  dart: L("Dart", "programming", "#00B4AB"),
  rb: L("Ruby", "programming", "#701516"),
  php: L("PHP", "programming", "#4F5D95"),
  ex: L("Elixir", "programming", "#6e4a7e"), exs: L("Elixir", "programming", "#6e4a7e"),
  erl: L("Erlang", "programming", "#B83998"),
  clj: L("Clojure", "programming", "#db5855"),
  hs: L("Haskell", "programming", "#5e5086"),
  lua: L("Lua", "programming", "#000080"),
  r: L("R", "programming", "#198CE7"),
  jl: L("Julia", "programming", "#a270ba"),
  zig: L("Zig", "programming", "#ec915c"),
  sh: SHELL, bash: SHELL, zsh: SHELL,
  ps1: L("PowerShell", "programming", "#012456"), psm1: L("PowerShell", "programming", "#012456"),
  sql: L("SQL", "data", "#e38c00"),
  tf: L("HCL", "programming", "#844FBA"), hcl: L("HCL", "programming", "#844FBA"), nomad: L("HCL", "programming", "#844FBA"),
  vue: L("Vue", "programming", "#41b883"),
  svelte: L("Svelte", "programming", "#ff3e00"),
  astro: L("Astro", "markup", "#ff5a03"),
  html: L("HTML", "markup", "#e34c26"), htm: L("HTML", "markup", "#e34c26"),
  css: L("CSS", "markup", "#663399"),
  scss: SCSS, sass: SCSS,
  less: L("Less", "markup", "#1d365d"),
  graphql: L("GraphQL", "data", "#e10098"), gql: L("GraphQL", "data", "#e10098"),
  proto: L("Protocol Buffer", "data", "#cccccc"),
  prisma: L("Prisma", "data", "#0c344b"),
  json: L("JSON", "data", "#292929"), jsonc: L("JSON", "data", "#292929"),
  yml: YAML, yaml: YAML,
  toml: L("TOML", "data", "#9c4221"),
  xml: L("XML", "data", "#0060ac"),
  md: MD, mdx: L("MDX", "prose", "#fcb32c"),
  rst: L("reStructuredText", "prose", "#141414"),
  txt: L("Text", "prose", "#999999"),
};

const BY_NAME: Readonly<Record<string, LanguageDef>> = {
  dockerfile: L("Dockerfile", "programming", "#384d54"),
  makefile: L("Makefile", "programming", "#427819"),
  jenkinsfile: L("Groovy", "programming", "#4298b8"),
};

/** Generated or vendored files that would drown the real code — lockfiles, bundles, snapshots. */
const SKIP_FILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|gradle\.lockfile|packages\.lock\.json)$|\.min\.(js|css)$|\.map$|\.snap$|\.d\.ts$/i;
const SKIP_DIR = /(^|\/)(node_modules|vendor|third_party|dist|build|out|\.next|\.nuxt|coverage|__snapshots__|bower_components)\//;

/** The language a path counts toward, or `null` when it isn't counted (binary, generated, vendored, unknown). */
export function languageOf(filePath: string): LanguageDef | null {
  if (SKIP_DIR.test(filePath) || SKIP_FILE.test(filePath)) return null;
  const base = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  if (base.startsWith("dockerfile.") || base.endsWith(".dockerfile")) return BY_NAME.dockerfile;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? BY_EXTENSION[base.slice(dot + 1)] ?? null : null;
}

export interface LanguageStats {
  language: string;
  kind: LanguageKind;
  color: string;
  files: number;
  /** Every line, blank ones included. */
  lines: number;
  /** Lines with something on them. */
  nonBlank: number;
}

export interface ContributorStats {
  name: string;
  email: string;
  commits: number;
  /** Lines added and removed in counted files (lockfiles and vendored code left out). */
  added: number;
  removed: number;
  first: string;
  last: string;
}

export interface TimelineDay {
  /** `YYYY-MM-DD`, the author's local date for commits. */
  date: string;
  commits: number;
  /** Lines of code (counted files, every line) at the end of that day on the main line. */
  lines: number;
}

export interface RepoStats {
  sha: string;
  languages: LanguageStats[];
  totals: { files: number; lines: number; nonBlank: number; codeLines: number };
  contributors: ContributorStats[];
  commits: { total: number; first: string | null; last: string | null; truncated: boolean };
  /** One entry per day that had a commit, oldest first. */
  timeline: TimelineDay[];
}

/** History past this many commits is cut off (and says so) — enough for years of a busy repo. */
const MAX_COMMITS = 50_000;

const cache = new Map<string, Promise<RepoStats>>();

/** The repo's stats at its last analysed commit (or HEAD before any analysis). `null` when there is no checkout yet. Cached per commit: a commit's history never changes. */
export async function loadRepoStats(repo: RepoRecord): Promise<RepoStats | null> {
  const dir = await sourceDir(repo);
  if (!dir) return null;
  const sha = repo.lastAnalyzedSha && /^[0-9a-f]{7,64}$/.test(repo.lastAnalyzedSha)
    ? repo.lastAnalyzedSha
    : (await gitOutput(dir, ["rev-parse", "HEAD"])).toString("utf8").trim();
  const key = `${repo.id}:${sha}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = computeStats(dir, sha);
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
    // One commit per repo is enough to keep.
    for (const other of cache.keys()) if (other.startsWith(`${repo.id}:`) && other !== key) cache.delete(other);
  }
  return pending;
}

async function computeStats(dir: string, sha: string): Promise<RepoStats> {
  const [lines, nonBlank, authored, mainLine] = await Promise.all([
    grepCounts(dir, sha, ""),
    grepCounts(dir, sha, "[^[:space:]]"),
    gitOutput(dir, ["log", "--no-merges", "--no-renames", `--max-count=${MAX_COMMITS}`, "--format=%x1e%aN%x1f%aE%x1f%aI", "--numstat", sha, "--"]),
    gitOutput(dir, ["log", "--first-parent", "-m", "--no-renames", `--max-count=${MAX_COMMITS}`, "--format=%x1e%aI", "--numstat", sha, "--"]),
  ]);

  // Languages: `git grep -c` gives every text file's line count without reading blobs here.
  const byLanguage = new Map<string, LanguageStats>();
  for (const [file, count] of lines) {
    const def = languageOf(file);
    if (!def) continue;
    let entry = byLanguage.get(def.name);
    if (!entry) byLanguage.set(def.name, (entry = { language: def.name, kind: def.kind, color: def.color, files: 0, lines: 0, nonBlank: 0 }));
    entry.files++;
    entry.lines += count;
    entry.nonBlank += nonBlank.get(file) ?? 0;
  }
  const languages = [...byLanguage.values()].sort((a, b) => b.lines - a.lines);
  const totals = {
    files: languages.reduce((n, l) => n + l.files, 0),
    lines: languages.reduce((n, l) => n + l.lines, 0),
    nonBlank: languages.reduce((n, l) => n + l.nonBlank, 0),
    codeLines: languages.filter((l) => l.kind === "programming").reduce((n, l) => n + l.lines, 0),
  };

  // Contributors and commits per day: every non-merge commit.
  const people = new Map<string, ContributorStats & { names: Map<string, number> }>();
  const commitsPerDay = new Map<string, number>();
  let total = 0;
  let first: string | null = null;
  let last: string | null = null;
  for (const record of authored.toString("utf8").split("\x1e")) {
    if (!record.trim()) continue;
    const [header, ...rest] = record.split("\n");
    const [name = "", email = "", date = ""] = header.split("\x1f");
    total++;
    last ??= date;
    first = date;
    const day = date.slice(0, 10);
    commitsPerDay.set(day, (commitsPerDay.get(day) ?? 0) + 1);
    const { added, removed } = sumNumstat(rest);
    const key = email.toLowerCase() || name.toLowerCase();
    let person = people.get(key);
    if (!person) people.set(key, (person = { name, email, commits: 0, added: 0, removed: 0, first: date, last: date, names: new Map() }));
    person.commits++;
    person.added += added;
    person.removed += removed;
    person.first = date; // log is newest first
    person.names.set(name, (person.names.get(name) ?? 0) + 1);
  }
  const contributors = mergeSameName([...people.values()]).sort((a, b) => b.commits - a.commits);

  // Lines of code per day along the main line: each day's net change, anchored to today's
  // count and walked backwards, so a cut-off history still ends on the right number.
  const netPerDay = new Map<string, number>();
  for (const record of mainLine.toString("utf8").split("\x1e")) {
    if (!record.trim()) continue;
    const [date, ...rest] = record.split("\n");
    const { added, removed } = sumNumstat(rest);
    const day = date.trim().slice(0, 10);
    netPerDay.set(day, (netPerDay.get(day) ?? 0) + added - removed);
  }
  const days = [...new Set([...commitsPerDay.keys(), ...netPerDay.keys()])].sort();
  const timeline: TimelineDay[] = [];
  let running = totals.lines;
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    timeline.push({ date: day, commits: commitsPerDay.get(day) ?? 0, lines: Math.max(0, running) });
    running -= netPerDay.get(day) ?? 0;
  }
  timeline.reverse();

  return {
    sha,
    languages,
    totals,
    contributors,
    commits: { total, first, last, truncated: total >= MAX_COMMITS },
    timeline,
  };
}

/** Lines matching `pattern` per text file at `sha` (`""` matches every line). */
async function grepCounts(dir: string, sha: string, pattern: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let out: Buffer;
  try {
    // -I skips binaries; -z puts a NUL after the file name, so any path parses.
    out = await gitOutput(dir, ["grep", "-c", "-I", "-z", "-E", "-e", pattern, sha, "--"]);
  } catch {
    return counts; // exit 1: nothing matched (an empty tree)
  }
  const prefix = `${sha}:`;
  for (const row of out.toString("utf8").split("\n")) {
    const nul = row.indexOf("\0");
    if (nul === -1) continue;
    const file = row.startsWith(prefix) ? row.slice(prefix.length, nul) : row.slice(0, nul);
    counts.set(file, Number(row.slice(nul + 1)) || 0);
  }
  return counts;
}

/** Added/removed lines of a commit's `--numstat` rows, counted files only (binaries show `-`). */
function sumNumstat(rows: string[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    const [a, r, file] = row.split("\t");
    if (!file || a === "-" || !languageOf(file)) continue;
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { added, removed };
}

/** One person committing from two emails under the same name is one contributor; each keeps their most-used name. */
function mergeSameName(people: Array<ContributorStats & { names: Map<string, number> }>): ContributorStats[] {
  const byName = new Map<string, ContributorStats>();
  for (const person of people) {
    const name = [...person.names].sort((a, b) => b[1] - a[1])[0]?.[0] ?? person.name;
    const key = name.trim().toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { name, email: person.email, commits: person.commits, added: person.added, removed: person.removed, first: person.first, last: person.last });
      continue;
    }
    existing.commits += person.commits;
    existing.added += person.added;
    existing.removed += person.removed;
    if (person.first < existing.first) existing.first = person.first;
    if (person.last > existing.last) existing.last = person.last;
  }
  return [...byName.values()];
}

export type CiRunsLookup =
  | { available: true; runs: CiRun[] }
  | { available: false; reason: string };

const CI_TTL_MS = 5 * 60_000;
const ciCache = new Map<string, { at: number; value: CiRunsLookup }>();

/** CI runs on the default branch, newest first, from GitHub Actions or GitLab pipelines. Local repos have none. Cached for a few minutes. */
export async function loadCiRuns(repo: RepoRecord): Promise<CiRunsLookup> {
  if (repo.provider === "local") {
    return { available: false, reason: "Local repos have no CI to read — link the repo to GitHub or GitLab." };
  }
  const hit = ciCache.get(repo.id);
  if (hit && Date.now() - hit.at < CI_TTL_MS) return hit.value;
  let value: CiRunsLookup;
  try {
    if (repo.provider === "gitlab") {
      const access = await resolveGitLabAccess(repo);
      value = access.ok
        ? { available: true, runs: (await listPipelines(access.token, access.ref.path, repo.defaultBranch)).data }
        : { available: false, reason: `GitLab is not reachable for this repo (${access.reason}).` };
    } else {
      const access = await resolveGitHubAccess(repo);
      value = access.ok
        ? { available: true, runs: (await listWorkflowRuns(access.token, access.ref.owner, access.ref.repo, repo.defaultBranch)).data }
        : { available: false, reason: `GitHub is not reachable for this repo (${access.reason}).` };
    }
  } catch (error) {
    // Not cached: a network blip shouldn't stick for five minutes.
    return { available: false, reason: `Could not read CI runs: ${(error as Error).message}` };
  }
  ciCache.set(repo.id, { at: Date.now(), value });
  return value;
}
