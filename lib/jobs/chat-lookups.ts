// The chat's lookups that need the code's structure or its history
// (DESIGN.md §6.7): callers and callees from the call edges, a file's
// imports both ways, and `git log` / `git blame`.
//
// Calls and imports come from the commit analysis (lib/analysis) of the
// commit the chat is about — the PR's head, or the repo's analysed commit —
// through ./commit-analysis.ts, so the parse cache makes it cheap and a
// review that just ran has it in memory already. History comes from the repo
// on disk: the local checkout, or the app's full clone with the commit
// fetched into it.
//
// Server-only, kept out of lib/jobs' barrel (pulls in lib/analysis).

import type { AnalysisResult, SymbolCall, SymbolDecl } from "@/lib/analysis";
import { readDbSource, type RepoRecord } from "@/lib/db";
import { analyzeRepoCommit } from "./commit-analysis";
import { sourceDir } from "./review-context";
import type { ReviewTarget } from "./review-queue";
import { ensureCommitsInCache, gitIn } from "./source";

/** The repo on disk with `sha` in it, or null when there is none. */
export async function repoDirWithCommit(repo: RepoRecord, sha: string, target: ReviewTarget | null): Promise<string | null> {
  if (repo.provider === "local") return sourceDir(repo);
  const refspecs = !target
    ? []
    : target.kind === "refs"
      ? [target.baseRef, target.headRef]
      : repo.provider === "gitlab"
        ? [`merge-requests/${target.prNumber}/head`]
        : [`pull/${target.prNumber}/head`];
  return ensureCommitsInCache(repo, [sha], refspecs);
}

export async function loadChatAnalysis(repo: RepoRecord, sha: string, target: ReviewTarget | null): Promise<AnalysisResult> {
  const dir = await repoDirWithCommit(repo, sha, target);
  if (!dir) throw new Error("The repo isn't on disk — analyse it first.");
  return analyzeRepoCommit(dir, sha, undefined, readDbSource(repo.id)?.file);
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

const CALLABLE = new Set<SymbolDecl["kind"]>(["function", "method", "class"]);
const MAX_MATCHES = 5;
const MAX_CALLS_PER_MATCH = 40;

export interface LookupResult {
  text: string;
  summary: string;
  files: string[];
}

/** Declarations a name means: exact qualified/name/id first, then case-insensitive; narrowed by a file when given. */
export function findDeclarations(analysis: AnalysisResult, query: string, file?: string): SymbolDecl[] {
  const q = query.trim().replace(/\(\)$/, "").replace(/::/g, ".");
  const inFile = (d: SymbolDecl) => !file || d.file === file || d.file.endsWith(`/${file}`);
  const callable = analysis.symbols.decls.filter((d) => CALLABLE.has(d.kind) && inFile(d));
  const exact = callable.filter((d) => d.id === q || d.qualified === q || d.name === q);
  if (exact.length) return exact;
  const lower = q.toLowerCase();
  return callable.filter((d) => d.qualified.toLowerCase() === lower || d.name.toLowerCase() === lower);
}

/** `MapPage` / `module-level code` for a call's caller id (`<file>#` is module-level). */
function callerLabel(byId: Map<string, SymbolDecl>, id: string): string {
  if (id.endsWith("#")) return "module-level code";
  return byId.get(id)?.qualified ?? id.slice(id.indexOf("#") + 1);
}

function declLabel(d: SymbolDecl): string {
  return `${d.qualified} (${d.kind}, ${d.file}:${d.startLine}-${d.endLine})`;
}

const NO_DECL_NOTE =
  "Calls are known for TypeScript/JavaScript, Python, Java and Kotlin. Try the exact name (`Class.method` for a method), add the file as `path`, or use search_code.";

const UNRESOLVED_NOTE =
  "Calls through instances, callbacks or dynamic dispatch that static analysis couldn't tie to a declaration are not listed — confirm with search_code before saying nothing else calls it.";

/** Who calls `query` (direction `callers`) or what it calls (`callees`), from the analysis's call edges. */
export function describeCalls(
  analysis: AnalysisResult,
  query: string,
  direction: "callers" | "callees",
  file: string | undefined,
  componentOf: (path: string) => string
): LookupResult {
  const matches = findDeclarations(analysis, query, file);
  if (matches.length === 0) {
    return { text: `No function, method or class named "${query}"${file ? ` in ${file}` : ""}. ${NO_DECL_NOTE}`, summary: `no declaration "${query}"`, files: [] };
  }
  const byId = new Map(analysis.symbols.decls.map((d) => [d.id, d]));
  const files = new Set<string>();
  const blocks: string[] = [];
  let total = 0;
  for (const decl of matches.slice(0, MAX_MATCHES)) {
    files.add(decl.file);
    const edges: SymbolCall[] = analysis.symbols.calls.filter((c) => (direction === "callers" ? c.to === decl.id : c.from === decl.id));
    edges.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    total += edges.length;
    const lines = edges.slice(0, MAX_CALLS_PER_MATCH).map((c) => {
      if (direction === "callers") {
        files.add(c.file);
        const where = componentOf(c.file);
        return `- ${c.file}:${c.line} in ${callerLabel(byId, c.from)}${where ? ` [${where}]` : ""}`;
      }
      const callee = byId.get(c.to);
      if (callee) files.add(callee.file);
      const where = callee ? componentOf(callee.file) : "";
      return `- line ${c.line}: ${callee ? declLabel(callee) : c.to}${where ? ` [${where}]` : ""}`;
    });
    if (edges.length > MAX_CALLS_PER_MATCH) lines.push(`- … ${edges.length - MAX_CALLS_PER_MATCH} more`);
    const unresolved = direction === "callees" ? analysis.symbols.unresolved[decl.id] ?? 0 : 0;
    blocks.push(
      [
        `${declLabel(decl)} — ${edges.length} ${direction === "callers" ? `caller site${edges.length === 1 ? "" : "s"}` : `call${edges.length === 1 ? "" : "s"} into the repo`}:`,
        ...(lines.length ? lines : ["- (none found)"]),
        ...(unresolved ? [`- plus ${unresolved} call(s) naming a repo function that couldn't be resolved`] : []),
      ].join("\n")
    );
  }
  if (matches.length > MAX_MATCHES) blocks.push(`… ${matches.length - MAX_MATCHES} more declarations share that name — pass a path to pick one.`);
  blocks.push(UNRESOLVED_NOTE);
  return {
    text: blocks.join("\n\n"),
    summary: `${direction === "callers" ? "found the callers of" : "listed the calls of"} ${matches[0].qualified} (${total})`,
    files: [...files],
  };
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const MAX_IMPORT_ROWS = 60;

/** What a file imports and what imports it, resolved to repo files. */
export function describeImports(analysis: AnalysisResult, query: string, componentOf: (path: string) => string): LookupResult {
  const path = query.replace(/^\/+/, "");
  const known = analysis.files.find((f) => f.file === path) ?? analysis.files.find((f) => f.file.endsWith(`/${path}`));
  if (!known) return { text: `"${path}" isn't a file the analysis knows at this commit.`, summary: `no file ${path}`, files: [] };
  const file = known.file;
  const row = (other: string, typeOnly?: true) => {
    const where = componentOf(other);
    return `- ${other}${where ? ` [${where}]` : ""}${typeOnly ? " (types only)" : ""}`;
  };
  const out = analysis.edges.filter((e) => e.from === file).sort((a, b) => a.to.localeCompare(b.to));
  const into = analysis.edges.filter((e) => e.to === file).sort((a, b) => a.from.localeCompare(b.from));
  const section = (title: string, rows: string[]) => [
    `${title} (${rows.length}):`,
    ...(rows.length ? rows.slice(0, MAX_IMPORT_ROWS) : ["- (none)"]),
    ...(rows.length > MAX_IMPORT_ROWS ? [`- … ${rows.length - MAX_IMPORT_ROWS} more`] : []),
  ];
  const own = componentOf(file);
  return {
    text: [
      `${file}${own ? ` [${own}]` : ""}`,
      ...section("Imports", out.map((e) => row(e.to, e.typeOnly))),
      ...section("Imported by", into.map((e) => row(e.from, e.typeOnly))),
      "Package imports and files the analysis couldn't resolve are left out.",
    ].join("\n"),
    summary: `read the imports of ${file} (${out.length} out, ${into.length} in)`,
    files: [file, ...into.slice(0, 6).map((e) => e.from)],
  };
}

// ---------------------------------------------------------------------------
// Files by path
// ---------------------------------------------------------------------------

const MAX_FILE_ROWS = 60;

/**
 * The words of a path or URL query, lower-cased: `/repo/{repo-id}/pull-requests`
 * → `repo`, `pull-requests`. Parameter segments (`{id}`, `:id`, `[id]`, `<id>`)
 * are dropped — they name a folder like `[repoId]` that the URL never spells.
 */
function pathWords(query: string): string[] {
  return query
    .replace(/[?#].*$/, "")
    .split(/[\\/]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && !/^(\{.*\}|\[.*\]|<.*>|:.+)$/.test(s));
}

/** Files at `sha` whose path holds every word of `query`, in order — so a page URL finds `app/…/page.tsx`. */
export async function findFiles(dir: string, sha: string, query: string): Promise<LookupResult> {
  const words = pathWords(query);
  if (!words.length) return { text: `"${query}" has no path words to look for.`, summary: "file search skipped", files: [] };
  const out = await gitIn(dir, undefined, ["safe.directory=*"]).raw(["ls-tree", "-r", "--name-only", "--end-of-options", sha]);
  const matches = out.split(/\r?\n/).filter((file) => {
    const lower = file.toLowerCase();
    let from = 0;
    for (const word of words) {
      const at = lower.indexOf(word, from);
      if (at < 0) return false;
      from = at + word.length;
    }
    return true;
  });
  // Shorter paths first: `app/x/page.tsx` before `app/x/deep/nested/thing.tsx`.
  matches.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const shown = matches.slice(0, MAX_FILE_ROWS);
  const label = words.join(" … ");
  return {
    text: matches.length
      ? [
          `${matches.length} file(s) whose path holds ${label}${matches.length > shown.length ? ` (first ${shown.length})` : ""}:`,
          ...shown.map((f) => `- ${f}`),
        ].join("\n")
      : `No file path holds ${label} at this commit.`,
    summary: `found files matching "${query}" (${matches.length})`,
    files: shown.slice(0, 6),
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const MAX_LOG = 30;
const MAX_BLAME_LINES = 200;

/** A path from the model, safe to hand to git after `--`; null when it isn't. */
function cleanPath(path: string): string | null {
  const clean = path.replace(/^\/+/, "").replace(/:\d+(-\d+)?$/, "");
  return clean && !clean.split("/").includes("..") ? clean : null;
}

/** The last commits up to `sha`, optionally only those touching `path`. */
export async function gitLog(dir: string, sha: string, path: string | undefined, limit: number): Promise<LookupResult> {
  const clean = path ? cleanPath(path) : undefined;
  if (path && !clean) return { text: `"${path}" isn't a usable path.`, summary: "git log skipped", files: [] };
  const n = Math.min(Math.max(1, limit), MAX_LOG);
  const out = await gitIn(dir, undefined, ["safe.directory=*"]).raw([
    "log",
    `-n${n}`,
    "--format=%h%x09%ad%x09%an%x09%s",
    "--date=short",
    "--end-of-options",
    sha,
    ...(clean ? ["--", clean] : []),
  ]);
  const rows = out.split("\n").filter(Boolean).map((line) => {
    const [hash, date, author, subject] = line.split("\t");
    return `- ${hash} ${date} ${author}: ${subject}`;
  });
  return {
    text: rows.length ? `${clean ? `Commits touching ${clean}` : "Commits"}, newest first:\n${rows.join("\n")}` : `No commits${clean ? ` touch ${clean}` : ""} up to this commit.`,
    summary: `read the history${clean ? ` of ${clean}` : ""} (${rows.length} commit${rows.length === 1 ? "" : "s"})`,
    files: clean ? [clean] : [],
  };
}

interface BlameCommit {
  author: string;
  date: string;
  summary: string;
  lines: number[];
}

/** Who last changed each line of `path` in `start..end` at `sha`, grouped by commit. */
export async function gitBlame(dir: string, sha: string, path: string, start: number, end: number): Promise<LookupResult> {
  const clean = cleanPath(path);
  if (!clean) return { text: `"${path}" isn't a usable path.`, summary: "blame skipped", files: [] };
  const from = Math.max(1, start);
  const to = Math.max(from, Math.min(end, from + MAX_BLAME_LINES - 1));
  let out: string;
  try {
    out = await gitIn(dir, undefined, ["safe.directory=*"]).raw(["blame", "--porcelain", "-L", `${from},${to}`, sha, "--", clean]);
  } catch (error) {
    const message = (error as Error).message.split("\n")[0];
    return { text: `git blame failed: ${message}`, summary: `could not blame ${clean}`, files: [] };
  }
  const commits = new Map<string, BlameCommit>();
  let current: BlameCommit | undefined;
  for (const line of out.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (header) {
      const hash = header[1];
      current = commits.get(hash) ?? { author: "", date: "", summary: "", lines: [] };
      commits.set(hash, current);
      current.lines.push(Number(header[2]));
    } else if (current && line.startsWith("author ")) current.author = line.slice(7);
    else if (current && line.startsWith("author-time ")) current.date = new Date(Number(line.slice(12)) * 1000).toISOString().slice(0, 10);
    else if (current && line.startsWith("summary ")) current.summary = line.slice(8);
  }
  const ranges = (lines: number[]) => {
    const sorted = [...new Set(lines)].sort((a, b) => a - b);
    const parts: string[] = [];
    for (let i = 0; i < sorted.length; i++) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
      parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
      i = j;
    }
    return parts.join(", ");
  };
  const rows = [...commits]
    .sort((a, b) => b[1].date.localeCompare(a[1].date))
    .map(([hash, c]) => `- ${hash.slice(0, 7)} ${c.date} ${c.author}: ${c.summary} — lines ${ranges(c.lines)}`);
  return {
    text: rows.length ? `Who last changed ${clean}:${from}-${to}, newest first:\n${rows.join("\n")}` : `No blame for ${clean}:${from}-${to}.`,
    summary: `blamed ${clean}:${from}-${to} (${commits.size} commit${commits.size === 1 ? "" : "s"})`,
    files: [clean],
  };
}
