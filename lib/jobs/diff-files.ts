// The diff the viewer shows — every changed file's patch for a review target,
// from a local `git diff` whenever the commits are on disk, and from the
// host's API only when they are not (DESIGN.md §6.24).
//
// Why git first: GitHub's `patch` field drops big files outright and the
// files endpoint stops at 3000 files; GitLab truncates too. A local repo is
// its own checkout, and a hosted one usually has the app-managed clone the
// analysis made — the head and base are fetched into it on demand, the same
// way the before/after preview and the impact check read the head
// (./head-source.ts). Git also gives what the APIs can't: `-w` for the
// ignore-whitespace toggle, rename detection, and each file's head blob id,
// which is what the reader's "viewed" checkbox remembers.
//
// This is the viewer's source only. The review pipeline keeps
// `listLocalFilePatches` (./local-git.ts), whose `--no-renames` choice maps
// onto the component graph better and whose patches are capped for prompts.

import { existsSync } from "node:fs";
import path from "node:path";
import { compareRefs, getPullRequest, listPullRequestFiles } from "@/lib/github";
import type { PullRequestFile, PullRequestFileStatus } from "@/lib/github";
import { compareRefs as compareGitLabRefs, getMergeRequest, listMergeRequestFiles } from "@/lib/gitlab";
import type { RepoRecord } from "@/lib/db";
import { assertSafeGitRef } from "./git-ref";
import { resolveGitHubAccess } from "./github-access";
import { resolveGitLabAccess } from "./gitlab-access";
import type { ReviewTarget } from "./review-queue";
import { ensureCommitsInCache, gitIn, repoCacheDir, resolveLocalRepoPath } from "./source";

/** `safe.directory` as everywhere else; `core.quotePath=false` keeps non-ASCII paths verbatim in the patch headers. */
const GIT_CONFIG = ["safe.directory=*", "core.quotePath=false"];
/** A whole PR's patch in one `git diff` can take a while on a big repo. */
const DIFF_TIMEOUT_MS = 90_000;
/** One file's patch past this is cut — a reader can't use a 5 MB lockfile diff, and the browser shouldn't have to render it. */
const MAX_FILE_PATCH_CHARS = 1_000_000;
/** Every file's patch together past this is cut: the remaining files keep their names and counts. */
const MAX_TOTAL_PATCH_CHARS = 40_000_000;

export type DiffFileStatus = PullRequestFileStatus | "unchanged";

export interface DiffFile {
  path: string;
  /** The path before a rename or copy. */
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  /** Unified diff text (with git's preamble, or just the hunks from an API). Absent for binary files and files the source left out. */
  patch?: string;
  binary?: boolean;
  /** The patch was cut at the size cap. */
  truncated?: boolean;
  /** With whitespace ignored by git: every change in the file was whitespace. */
  whitespaceOnly?: boolean;
  /** What the file is at the head — the head blob id from git — so "viewed" resets exactly when the file changes. Absent from API sources. */
  fingerprint?: string;
}

export interface DiffFilesResult {
  source: "git" | "api";
  /** `git`: git already left whitespace changes out; `client`: the patches are as the host sent them and the viewer filters them; `shown`: not asked for. */
  whitespace: "git" | "client" | "shown";
  headSha?: string;
  files: DiffFile[];
}

/** Where a `git diff` can run: a repo directory and the two ends of the comparison. */
export interface GitDiffSpot {
  dir: string;
  base: string;
  head: string;
  headSha?: string;
}

export interface ApiDiff {
  files: PullRequestFile[];
  headSha?: string;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function toStatus(code: string): PullRequestFileStatus {
  switch (code.charAt(0)) {
    case "A":
      return "added";
    case "D":
      return "removed";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "changed";
  }
}

/** Undoes git's C-style path quoting (`"a\\tb\\303\\251"`) — only reached for paths with control characters, quotes or backslashes, since `core.quotePath=false` leaves other non-ASCII alone. */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[i + 1];
    if (/[0-7]/.test(next ?? "")) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The new-side path a `diff --git` chunk is about. */
function chunkPath(chunk: string): string | null {
  const lines = chunk.split("\n", 12);
  for (const line of lines) {
    if (line.startsWith("rename to ")) return unquoteGitPath(line.slice(10));
    if (line.startsWith("copy to ")) return unquoteGitPath(line.slice(8));
  }
  const plus = lines.find((l) => l.startsWith("+++ "));
  if (plus && plus !== "+++ /dev/null") return unquoteGitPath(plus.slice(4)).replace(/^b\//, "");
  const minus = lines.find((l) => l.startsWith("--- "));
  if (minus && minus !== "--- /dev/null") return unquoteGitPath(minus.slice(4)).replace(/^a\//, "");
  // No ---/+++ (binary, mode-only): `diff --git a/<p> b/<p>`, the same path twice.
  const head = lines[0].slice("diff --git ".length);
  if (head.startsWith('"')) {
    const end = head.indexOf('" ', 1);
    return end > 0 ? unquoteGitPath(head.slice(0, end + 1)).replace(/^a\//, "") : null;
  }
  const len = (head.length - 5) / 2;
  return Number.isInteger(len) && len > 0 ? head.slice(2, 2 + len) : null;
}

/** Splits one combined `git diff` into per-file patches by new-side path. Content lines always start with +, -, space or \, so a line starting `diff --git ` is a file boundary. */
export function splitCombinedDiff(output: string): Map<string, string> {
  const patches = new Map<string, string>();
  const starts: number[] = [];
  if (output.startsWith("diff --git ")) starts.push(0);
  for (let i = output.indexOf("\ndiff --git "); i >= 0; i = output.indexOf("\ndiff --git ", i + 1)) starts.push(i + 1);
  for (let s = 0; s < starts.length; s++) {
    const chunk = output.slice(starts[s], s + 1 < starts.length ? starts[s + 1] : output.length);
    const p = chunkPath(chunk);
    if (p && chunk.includes("\n@@ ")) patches.set(p, chunk);
  }
  return patches;
}

/**
 * Every changed file of `base...head` in `dir`, with renames found
 * (`--find-renames`), counts, head blob ids and the patch text. `path`
 * narrows the patch to that one file (its list entry still comes from the
 * whole diff, so a rename is still known as one).
 */
export async function listGitDiffFiles(
  spot: GitDiffSpot,
  options: { ignoreWhitespace?: boolean; path?: string } = {}
): Promise<DiffFile[]> {
  assertSafeGitRef(spot.base);
  assertSafeGitRef(spot.head);
  const git = gitIn(spot.dir, DIFF_TIMEOUT_MS, GIT_CONFIG);
  const range = `${spot.base}...${spot.head}`;
  const common = ["--find-renames", "--no-color", "--no-ext-diff", "--no-textconv"];

  const [rawOut, numstatOut] = await Promise.all([
    git.raw(["diff", "--raw", "-z", "--abbrev=40", ...common, "--end-of-options", range, "--"]),
    git.raw(["diff", "--numstat", "-z", ...common, "--end-of-options", range, "--"]),
  ]);

  // --raw -z: ":<mode> <mode> <sha> <sha> <status>\0<path>\0[<new path>\0]"
  const files: DiffFile[] = [];
  const fields = rawOut.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const meta = fields[i];
    if (!meta.startsWith(":")) continue;
    const [, , , newSha, code] = meta.slice(1).split(" ");
    const twoPaths = code.startsWith("R") || code.startsWith("C");
    const first = fields[++i];
    const second = twoPaths ? fields[++i] : undefined;
    const file: DiffFile = {
      path: second ?? first,
      status: toStatus(code),
      additions: 0,
      deletions: 0,
    };
    if (second) file.oldPath = first;
    if (newSha && !/^0+$/.test(newSha)) file.fingerprint = newSha;
    files.push(file);
  }

  // --numstat -z: "<adds>\t<dels>\t<path>\0", or "<adds>\t<dels>\t\0<old>\0<new>\0" for a rename; "-" counts on a binary file.
  const byPath = new Map(files.map((f) => [f.path, f]));
  const counts = numstatOut.split("\0");
  for (let i = 0; i < counts.length; i++) {
    const [adds, dels, ...rest] = counts[i].split("\t");
    if (dels === undefined) continue;
    let p = rest.join("\t");
    if (!p) {
      i += 2;
      p = counts[i] ?? "";
    }
    const file = byPath.get(p);
    if (!file) continue;
    file.binary = adds === "-" || dels === "-";
    file.additions = file.binary ? 0 : Number(adds) || 0;
    file.deletions = file.binary ? 0 : Number(dels) || 0;
  }

  const wanted = options.path ? files.filter((f) => f.path === options.path) : files;
  if (wanted.length === 0) return files;
  const pathspec = options.path ? wanted.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])) : [];
  const patchOut = await git.raw([
    "diff",
    "-U3",
    ...common,
    ...(options.ignoreWhitespace ? ["-w"] : []),
    "--end-of-options",
    range,
    "--",
    ...pathspec.map((p) => `:(literal)${p}`),
  ]);
  const patches = splitCombinedDiff(patchOut);
  let total = 0;
  for (const file of wanted) {
    const patch = patches.get(file.path);
    if (!patch) {
      if (options.ignoreWhitespace && !file.binary && file.additions + file.deletions > 0) file.whitespaceOnly = true;
      continue;
    }
    if (total >= MAX_TOTAL_PATCH_CHARS || patch.length > MAX_FILE_PATCH_CHARS) {
      file.truncated = true;
      if (total < MAX_TOTAL_PATCH_CHARS) file.patch = patch.slice(0, patch.lastIndexOf("\n", MAX_FILE_PATCH_CHARS));
    } else {
      file.patch = patch;
    }
    total += file.patch?.length ?? 0;
  }
  return files;
}

// ---------------------------------------------------------------------------
// The preference: git when it can, the API when it can't
// ---------------------------------------------------------------------------

function fromApiFile(file: PullRequestFile): DiffFile {
  return {
    path: file.filename,
    ...(file.previousFilename && file.previousFilename !== file.filename ? { oldPath: file.previousFilename } : {}),
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    ...(file.patch ? { patch: file.patch } : {}),
  };
}

/**
 * The target's diff from git when `openGit` finds the commits, else from
 * `fetchApi`. Kept separate from the repo lookups so the preference itself
 * can be tested without a host (lib/jobs/smoke-test-diff-viewer.ts).
 */
export async function preferLocalDiff(sources: {
  openGit: () => Promise<GitDiffSpot | null>;
  fetchApi: () => Promise<ApiDiff>;
  ignoreWhitespace?: boolean;
  path?: string;
  log?: (message: string) => void;
}): Promise<DiffFilesResult> {
  try {
    const spot = await sources.openGit();
    if (spot) {
      const files = await listGitDiffFiles(spot, { ignoreWhitespace: sources.ignoreWhitespace, path: sources.path });
      return { source: "git", whitespace: sources.ignoreWhitespace ? "git" : "shown", headSha: spot.headSha, files };
    }
  } catch (error) {
    sources.log?.(`local git diff unavailable (${(error as Error).message.split("\n")[0]}) — using the host's patches`);
  }
  const api = await sources.fetchApi();
  return {
    source: "api",
    whitespace: sources.ignoreWhitespace ? "client" : "shown",
    headSha: api.headSha,
    files: api.files.map(fromApiFile),
  };
}

/** A target's diff can't be read for a reason the user can fix (no PAT, PR on a local repo …). */
export class DiffFilesError extends Error {}

/** The refs to fetch when a host won't serve a commit by sha. */
function fallbackRefspecs(repo: RepoRecord, target: ReviewTarget): string[] {
  if (target.kind === "refs") return [target.headRef, target.baseRef];
  return repo.provider === "gitlab" ? [`merge-requests/${target.prNumber}/head`] : [`pull/${target.prNumber}/head`];
}

/** The app's clone of a hosted repo, if the analysis already made one — never cloned here, a request is no place for that. */
function hasClone(repo: RepoRecord): boolean {
  return existsSync(path.join(repoCacheDir(repo.id), ".git"));
}

/**
 * The diff of `target` in `repo` for the viewer. A local repo is diffed in
 * its checkout; a hosted one in the app's clone when there is one (the two
 * ends fetched into it if missing), else read from the host's API.
 */
export async function loadTargetDiff(
  repo: RepoRecord,
  target: ReviewTarget,
  options: { ignoreWhitespace?: boolean; path?: string } = {}
): Promise<DiffFilesResult> {
  const log = (message: string) => console.warn(`[diff ${repo.id}] ${message}`);

  if (repo.provider === "local") {
    if (target.kind === "pr") {
      throw new DiffFilesError("A pull/merge request cannot be diffed on a repo with no git-host link — compare two refs instead.");
    }
    if (!repo.localPath) throw new DiffFilesError("This local repo has no path on record.");
    const dir = resolveLocalRepoPath(repo.localPath);
    const files = await listGitDiffFiles({ dir, base: target.baseRef, head: target.headRef }, options);
    const headSha = (await gitIn(dir, undefined, GIT_CONFIG).raw(["rev-parse", "--verify", "--end-of-options", `${target.headRef}^{commit}`]).catch(() => "")).trim();
    return { source: "git", whitespace: options.ignoreWhitespace ? "git" : "shown", headSha: headSha || undefined, files };
  }

  // The host is asked for the two ends first (one call for a PR); a ref
  // comparison's answer already carries its files, kept for the fallback.
  let ends: { base: string; head: string } | null = null;
  let apiFiles: PullRequestFile[] | null = null;
  const fetchApi = async (): Promise<ApiDiff> => {
    if (repo.provider === "gitlab") {
      const access = await resolveGitLabAccess(repo);
      if (!access.ok) throw new DiffFilesError(access.reason === "no_token" ? "No GitLab PAT configured in Settings." : "This repo is not linked to GitLab.");
      if (target.kind === "pr") {
        if (!ends) {
          const { data: mr } = await getMergeRequest(access.token, access.ref.path, target.prNumber);
          ends = { base: mr.baseSha, head: mr.headSha };
        }
        if (!apiFiles) apiFiles = (await listMergeRequestFiles(access.token, access.ref.path, target.prNumber)).data;
      } else if (!apiFiles) {
        const { data } = await compareGitLabRefs(access.token, access.ref.path, target.baseRef, target.headRef);
        ends = { base: data.baseSha, head: data.headSha };
        apiFiles = data.files;
      }
      return { files: apiFiles!, headSha: ends?.head };
    }
    const access = await resolveGitHubAccess(repo);
    if (!access.ok) throw new DiffFilesError(access.reason === "no_token" ? "No GitHub PAT configured in Settings." : "This repo is not linked to GitHub.");
    const { owner, repo: name } = access.ref;
    if (target.kind === "pr") {
      if (!ends) {
        const { data: pr } = await getPullRequest(access.token, owner, name, target.prNumber);
        ends = { base: pr.baseSha, head: pr.headSha };
      }
      if (!apiFiles) apiFiles = (await listPullRequestFiles(access.token, owner, name, target.prNumber)).data;
    } else if (!apiFiles) {
      const { data } = await compareRefs(access.token, owner, name, target.baseRef, target.headRef);
      ends = { base: data.mergeBaseSha ?? data.baseSha, head: data.headSha };
      apiFiles = data.files;
    }
    return { files: apiFiles!, headSha: ends?.head };
  };

  const openGit = async (): Promise<GitDiffSpot | null> => {
    if (!hasClone(repo)) return null;
    if (!ends) {
      if (target.kind === "pr") {
        if (repo.provider === "gitlab") {
          const access = await resolveGitLabAccess(repo);
          if (!access.ok) return null;
          const { data: mr } = await getMergeRequest(access.token, access.ref.path, target.prNumber);
          ends = { base: mr.baseSha, head: mr.headSha };
        } else {
          const access = await resolveGitHubAccess(repo);
          if (!access.ok) return null;
          const { data: pr } = await getPullRequest(access.token, access.ref.owner, access.ref.repo, target.prNumber);
          ends = { base: pr.baseSha, head: pr.headSha };
        }
      } else {
        await fetchApi(); // the comparison names both ends (and is the fallback)
      }
    }
    if (!ends) return null;
    const { base, head } = ends;
    const dir = await ensureCommitsInCache(repo, [base, head], fallbackRefspecs(repo, target), log);
    return { dir, base, head, headSha: head };
  };

  return preferLocalDiff({ openGit, fetchApi, ignoreWhitespace: options.ignoreWhitespace, path: options.path, log });
}
