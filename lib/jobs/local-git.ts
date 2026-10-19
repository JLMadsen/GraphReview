// Local-git branch listing for the diff panel's branch picker.
//
// A `provider: "local"` repo's branches are sitting right there in its
// `.git` directory — no GitHub API call (and no PAT) needed. This mirrors
// the `Branch` shape lib/github's `listBranches` returns so the Branches
// page can render either source through the same list markup.
//
// Reuses source.ts's `gitIn` (same simple-git setup as `readCurrentBranch`)
// and `resolveLocalRepoPath` (the containment check) rather than
// duplicating either.
//
// Every ref a function here takes can come from a request, so each one is
// checked with `assertSafeGitRef` and, where the command's option parser
// knows it (git 2.24+: diff, log, merge-base), placed after
// `--end-of-options`: a ref like `--output=<path>` must never reach git as
// an option.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Branch, CommitSummary, PullRequestFile, PullRequestFileStatus } from "@/lib/github";
import { WORKTREE_REF, assertSafeGitRef, isSafeGitRef } from "./git-ref";
import { memo } from "./memo-cache";
import { gitIn, resolveLocalRepoPath } from "./source";

const execFileAsync = promisify(execFile);

/**
 * Git config applied to every command in this module.
 *
 * Local repos are read in place, and their checkout can be owned by a
 * different account than the one GraphReview runs as (a shared drive, a repo
 * cloned as admin, WSL/Windows ownership mismatches). Git refuses to operate
 * on a repo it considers owned by someone else ("detected dubious ownership in
 * repository"), which would make every local-repo feature fail with a
 * confusing message. `safe.directory=*` waives that check — appropriate
 * here because the mount is read-only and the path was already constrained
 * to the configured local-repos root by `resolveLocalRepoPath`.
 */
const LOCAL_GIT_CONFIG = ["safe.directory=*"];

/** Per-file patch text is capped so one enormous generated file (a lockfile, a bundled asset) can't blow up a job payload or an LLM prompt. The review pipeline truncates further before sending; this is just the outer guard. */
const MAX_PATCH_BYTES = 60_000;

/** How long one snapshot of the working tree answers for it — long enough for the handful of git calls one request makes. */
const WORKTREE_SNAPSHOT_TTL_MS = 3_000;

/** `git` in `dir` with extra environment — simple-git won't pass `GIT_INDEX_FILE` or the identity variables through. */
async function rawGit(dir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "safe.directory=*", ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

/**
 * The working tree of a local checkout as a commit: everything tracked plus
 * untracked files `.gitignore` doesn't exclude, on top of HEAD — what
 * "Changes on disk" reviews (DESIGN.md §6.29).
 *
 * Built in a throwaway index (a copy of the real one, so `git add` only
 * re-hashes what changed), then `write-tree` + `commit-tree`. The user's
 * branches, HEAD, index and files are never touched; the only trace is
 * loose objects in `.git/objects` that nothing references and `git gc`
 * removes. The commit's identity and date are fixed (HEAD's date), so the
 * same files always give the same sha — a review of them stays current until
 * something on disk changes. With nothing changed it is HEAD itself.
 */
export function snapshotWorktree(localPath: string): Promise<string> {
  const dir = resolveLocalRepoPath(localPath);
  return memo("worktree-snapshot", dir, { ttlMs: WORKTREE_SNAPSHOT_TTL_MS, maxEntries: 20 }, async () => {
    const top = (await rawGit(dir, ["rev-parse", "--show-toplevel"])).trim();
    const realIndex = path.resolve(top, (await rawGit(top, ["rev-parse", "--git-path", "index"])).trim());
    const head = (await rawGit(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).catch(() => "")).trim();
    const scratch = await mkdtemp(path.join(os.tmpdir(), "graphreview-index-"));
    try {
      const index = { GIT_INDEX_FILE: path.join(scratch, "index") };
      if (existsSync(realIndex)) await copyFile(realIndex, index.GIT_INDEX_FILE);
      await rawGit(top, ["add", "--all", "--", "."], index);
      const tree = (await rawGit(top, ["write-tree"], index)).trim();
      if (head && tree === (await rawGit(top, ["rev-parse", `${head}^{tree}`])).trim()) return head;
      const date = head ? `${(await rawGit(top, ["show", "-s", "--format=%ct", head])).trim()} +0000` : "0 +0000";
      const identity = {
        GIT_AUTHOR_NAME: "GraphReview",
        GIT_AUTHOR_EMAIL: "graphreview@localhost",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: "GraphReview",
        GIT_COMMITTER_EMAIL: "graphreview@localhost",
        GIT_COMMITTER_DATE: date,
      };
      const args = ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "Changes on disk"];
      return (await rawGit(top, args, identity)).trim();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

/** `ref` as git can take it: {@link WORKTREE_REF} becomes the working tree's snapshot commit, anything else passes through. */
export async function localRev(localPath: string, ref: string): Promise<string> {
  return ref === WORKTREE_REF ? snapshotWorktree(localPath) : ref;
}

/**
 * Local branches (`refs/heads/*`) of a checkout on disk, via a single
 * `git for-each-ref` call — one process spawn instead of `git branch -a`
 * plus a `rev-parse` per branch. `localPath` is resolved (and containment-
 * checked) the same way `prepareRepoSource`/`readCurrentSha` do.
 *
 * `protected` is a GitHub branch-protection-rules concept with no local-git
 * equivalent, so it is always `false` here.
 */
export async function listLocalBranches(localPath: string): Promise<Branch[]> {
  const dir = resolveLocalRepoPath(localPath);
  const output = await gitIn(dir, undefined, LOCAL_GIT_CONFIG).raw([
    "for-each-ref",
    "--format=%(refname:short)%09%(objectname)",
    "refs/heads/",
  ]);

  const branches: Branch[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, commitSha] = trimmed.split("\t");
    if (!name || !commitSha) continue;
    branches.push({ name, commitSha, protected: false });
  }
  return branches;
}

/**
 * Changed file paths between two refs of a local checkout, via
 * `git diff --name-only base...head` (the same "merge-base to head" diff
 * GitHub's compare API and `POST /pulls/{n}/files` use — not a plain
 * `base..head` two-dot diff, which would also include base-side-only
 * commits unrelated to head's actual changes).
 *
 * This is the local-repo counterpart to `lib/github`'s `compareRefs`, used
 * by the diff-impact endpoint so "compare two refs" works for a
 * `provider: "local"` repo without a GitHub URL or PAT at all.
 */
export async function listLocalChangedFiles(
  localPath: string,
  base: string,
  head: string
): Promise<string[]> {
  const baseRef = await localRev(localPath, base);
  const headRef = await localRev(localPath, head);
  assertSafeGitRef(baseRef);
  assertSafeGitRef(headRef);
  const dir = resolveLocalRepoPath(localPath);
  const output = await gitIn(dir, undefined, LOCAL_GIT_CONFIG).raw([
    "diff",
    "--name-only",
    "--end-of-options",
    `${baseRef}...${headRef}`,
    "--",
  ]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The newest `limit` commits reachable from `ref`, newest first — the local
 * counterpart to the GitHub/GitLab commit lists behind the commit picker.
 * Fields are NUL/record-separated so any subject text arrives verbatim.
 */
export async function listLocalCommits(
  localPath: string,
  rev: string,
  limit = 50
): Promise<CommitSummary[]> {
  const ref = await localRev(localPath, rev);
  assertSafeGitRef(ref);
  const dir = resolveLocalRepoPath(localPath);
  const output = await gitIn(dir, undefined, LOCAL_GIT_CONFIG).raw([
    "log",
    `--max-count=${Math.min(500, Math.max(1, limit))}`,
    "--format=%H%x00%P%x00%an%x00%aI%x00%s%x1e",
    "--end-of-options",
    ref,
    "--",
  ]);
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, parents, author, date, subject] = record.split("\0");
      return {
        sha,
        subject: subject ?? "",
        author: author || null,
        date: date ?? "",
        parents: parents ? parents.split(" ").filter(Boolean) : [],
      };
    });
}

/**
 * The commit a ref currently points at, via `git rev-parse --verify
 * <ref>^{commit}` — the full 40-hex sha, with tags peeled to their commit.
 *
 * Used to pin a review to the exact commits it ran against (stale-review
 * detection, `./review-freshness.ts`). Throws when the ref doesn't exist —
 * callers decide whether that is fatal (the review job) or merely "can't
 * tell" (the freshness check on a since-deleted branch).
 *
 * A leading `-` is refused rather than passed through: the ref arrives from
 * a query string and git would otherwise parse it as an option. (rev-parse
 * only learned `--end-of-options` in git 2.30, so the check is all there is.)
 */
export async function resolveLocalRefSha(localPath: string, rev: string): Promise<string> {
  const ref = await localRev(localPath, rev);
  assertSafeGitRef(ref);
  const dir = resolveLocalRepoPath(localPath);
  let out: string;
  try {
    out = await gitIn(dir, undefined, LOCAL_GIT_CONFIG).raw([
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
  } catch {
    // `--quiet` makes a missing ref a silent non-zero exit; simple-git
    // surfaces that as an empty-message rejection, so say what happened.
    throw new Error(`Ref "${ref}" does not exist in this repository.`);
  }
  const sha = out.trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`Ref "${ref}" does not exist in this repository.`);
  }
  return sha;
}

/** How long the code views trust a branch name's commit — a commit to it shows this much later at most. */
const VIEWER_REF_TTL_MS = 5_000;

/**
 * `resolveLocalRefSha` for the code views, which ask it on every file they
 * open: a commit id answers itself, a branch name is kept for a few seconds
 * (memo-cache.ts). The review's own pinning keeps the uncached one.
 */
export function viewerRefSha(localPath: string, ref: string): Promise<string> {
  if (/^[0-9a-f]{40}$/.test(ref)) return Promise.resolve(ref);
  return memo("local-ref", `${localPath}\u0000${ref}`, { ttlMs: VIEWER_REF_TTL_MS, maxEntries: 50 }, () => resolveLocalRefSha(localPath, ref));
}

/** `git merge-base a b`, or `null` when the two commits share no history (or either is gone). Two commits' merge base is what a three-dot diff is anchored on. */
export async function localMergeBase(
  localPath: string,
  revA: string,
  revB: string
): Promise<string | null> {
  if (!isSafeGitRef(revA) || !isSafeGitRef(revB)) return null;
  const dir = resolveLocalRepoPath(localPath);
  try {
    const [a, b] = [await localRev(localPath, revA), await localRev(localPath, revB)];
    const out = await gitIn(dir, undefined, LOCAL_GIT_CONFIG).raw(["merge-base", "--end-of-options", a, b]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** One changed file of a local ref comparison. Structurally a `PullRequestFile` minus GitHub-only fields, so the review pipeline can treat local and GitHub diffs identically (it only ever reads `path`/`status`/counts/`patch`). */
export interface LocalFilePatch {
  path: string;
  status: PullRequestFileStatus;
  additions: number;
  deletions: number;
  /** Unified diff (`-U3`). Absent for binary files, and for files whose diff exceeded {@link MAX_PATCH_BYTES}. */
  patch?: string;
}

/** Maps git's single-letter `--name-status` code onto the same vocabulary GitHub's files API uses, so both diff sources produce one `status` type. */
function toFileStatus(code: string): PullRequestFileStatus {
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
      // T (type change), U (unmerged), X (unknown) — all "something changed".
      return "changed";
  }
}

/** Splits a NUL-delimited git output into its fields, dropping the trailing empty element. */
function splitNul(output: string): string[] {
  return output.split("\0").filter((field) => field.length > 0);
}

/**
 * The local-repo counterpart to GitHub's
 * `GET /repos/{owner}/{repo}/pulls/{n}/files` — per-file status, line counts
 * and unified-diff text for a `base...head` comparison of a checkout on
 * disk, so the AI review pipeline works on a `provider: "local"` repo
 * with no GitHub URL and no PAT.
 *
 * Notes on the git invocation:
 *  - Three-dot (`base...head`) to match GitHub's "changes head introduced
 *    since the merge base" semantics, not a two-dot diff.
 *  - `-z` on the summary passes, so paths containing spaces or non-ASCII
 *    characters arrive verbatim instead of git-quoted (`"a\tb"`).
 *  - `--no-renames` deliberately: it keeps `--name-status` and `--numstat`
 *    one-path-per-entry (a detected rename makes both emit *two* paths in a
 *    format that differs between the two commands), and a rename reported as
 *    an add plus a delete maps onto the component graph more faithfully
 *    anyway — both the old and new location are genuinely touched.
 *  - The patch is fetched per file rather than parsed out of one combined
 *    diff: it keeps the cap below a simple per-file decision and means a
 *    single pathological file can't corrupt the parse of every other one.
 *  - Both refs come straight from requests (the diff-impact and PR map
 *    endpoints, the MCP tools), so they are checked and the range always
 *    follows `--end-of-options` — `--output=<path>` as a base ref would
 *    otherwise make git write the diff to that file.
 */
export async function listLocalFilePatches(
  localPath: string,
  base: string,
  head: string
): Promise<LocalFilePatch[]> {
  const baseRef = await localRev(localPath, base);
  const headRef = await localRev(localPath, head);
  assertSafeGitRef(baseRef);
  assertSafeGitRef(headRef);
  const dir = resolveLocalRepoPath(localPath);
  const git = gitIn(dir, undefined, LOCAL_GIT_CONFIG);
  const range = `${baseRef}...${headRef}`;

  const [nameStatusRaw, numstatRaw] = await Promise.all([
    git.raw(["diff", "--name-status", "--no-renames", "-z", "--end-of-options", range, "--"]),
    git.raw(["diff", "--numstat", "--no-renames", "-z", "--end-of-options", range, "--"]),
  ]);

  // `--name-status -z` emits: status \0 path \0 status \0 path \0 …
  const statusByPath = new Map<string, PullRequestFileStatus>();
  const order: string[] = [];
  const nameStatusFields = splitNul(nameStatusRaw);
  for (let i = 0; i + 1 < nameStatusFields.length; i += 2) {
    const path = nameStatusFields[i + 1];
    if (statusByPath.has(path)) continue;
    statusByPath.set(path, toFileStatus(nameStatusFields[i]));
    order.push(path);
  }

  // `--numstat -z` emits: "<adds>\t<dels>\t<path>" \0 … — with "-" for both
  // counts on a binary file.
  const countsByPath = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const entry of splitNul(numstatRaw)) {
    const [addsRaw, delsRaw, ...rest] = entry.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    const binary = addsRaw === "-" || delsRaw === "-";
    countsByPath.set(path, {
      additions: binary ? 0 : Number(addsRaw) || 0,
      deletions: binary ? 0 : Number(delsRaw) || 0,
      binary,
    });
    if (!statusByPath.has(path)) {
      // Shouldn't happen (both commands see the same diff), but never drop a
      // changed file just because the two summaries disagreed.
      statusByPath.set(path, "changed");
      order.push(path);
    }
  }

  const files: LocalFilePatch[] = [];
  for (const path of order) {
    const counts = countsByPath.get(path);
    const file: LocalFilePatch = {
      path,
      status: statusByPath.get(path) ?? "changed",
      additions: counts?.additions ?? 0,
      deletions: counts?.deletions ?? 0,
    };

    // Binary files have no text diff to send — GitHub omits `patch` for them
    // too, so the review prompt sees the same "changed, no hunk" shape.
    if (!counts?.binary) {
      const patch = await git.raw([
        "diff",
        "-U3",
        "--no-renames",
        "--end-of-options",
        range,
        "--",
        path,
      ]);
      if (patch.length > MAX_PATCH_BYTES) {
        file.patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n… [diff truncated at ${MAX_PATCH_BYTES} characters]`;
      } else if (patch.length > 0) {
        file.patch = patch;
      }
    }

    files.push(file);
  }

  return files;
}

/** Narrows a GitHub `PullRequestFile` to the same shape `listLocalFilePatches` returns, so both diff sources feed one code path. */
export function toLocalFilePatch(file: PullRequestFile): LocalFilePatch {
  return {
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  };
}

/** Files bigger than this are not returned by `readLocalFileAtRef` — generated bundles, fixtures. */
const MAX_FILE_BYTES = 400_000;

/** A file's text at a commit of a local repo (`git show <sha>:<path>`), or `null` when it isn't there or is too big. */
export async function readLocalFileAtRef(
  localPath: string,
  sha: string,
  filePath: string
): Promise<string | null> {
  if (!/^[0-9a-f]{7,64}$/.test(sha) || filePath.startsWith("-") || filePath.includes("..")) return null;
  const dir = resolveLocalRepoPath(localPath);
  try {
    const out = await gitIn(dir, undefined, LOCAL_GIT_CONFIG).raw(["show", `${sha}:${filePath}`]);
    return out.length > MAX_FILE_BYTES ? null : out;
  } catch {
    return null;
  }
}

/** `git grep` at a commit: `path:line:text` hits for a fixed string, capped; `total` counts them all. */
export async function grepLocalAtRef(
  localPath: string,
  sha: string,
  query: string,
  maxHits = 60
): Promise<{ hits: Array<{ path: string; line: number; text: string }>; total: number }> {
  if (!/^[0-9a-f]{7,64}$/.test(sha) || !query.trim()) return { hits: [], total: 0 };
  const dir = resolveLocalRepoPath(localPath);
  let out = "";
  try {
    out = await gitIn(dir, undefined, LOCAL_GIT_CONFIG).raw([
      "grep", "-n", "-I", "-F", "--no-color", "-e", query, sha,
    ]);
  } catch {
    return { hits: [], total: 0 }; // git grep exits non-zero when nothing matches
  }
  const hits: Array<{ path: string; line: number; text: string }> = [];
  let total = 0;
  // Files committed with CRLF keep their \r in the output; `.` stops at it.
  for (const row of out.split(/\r?\n/)) {
    // <sha>:<path>:<line>:<text>
    const match = /^[0-9a-f]+:([^:]+):(\d+):(.*)$/.exec(row);
    if (!match) continue;
    total++;
    if (hits.length < maxHits) hits.push({ path: match[1], line: Number(match[2]), text: match[3].trim().slice(0, 200) });
  }
  return { hits, total };
}
