// Local-git branch listing for the Branches tab.
//
// A `provider: "local"` repo's branches are sitting right there in its
// `.git` directory — no GitHub API call (and no PAT) needed. This mirrors
// the `Branch` shape lib/github's `listBranches` returns so the Branches
// page can render either source through the same list markup.
//
// Reuses source.ts's `gitIn` (same simple-git setup as `readCurrentBranch`)
// and `resolveLocalRepoPath` (the containment check) rather than
// duplicating either.

import type { Branch, PullRequestFile, PullRequestFileStatus } from "@/lib/github";
import { gitIn, resolveLocalRepoPath } from "./source";

/**
 * Git config applied to every command in this module.
 *
 * Local repos are read into the container through a read-only bind mount,
 * so the checkout is owned by whatever uid the *host* user has
 * while git runs as the container's user. Git refuses to operate on a repo
 * it considers owned by someone else ("detected dubious ownership in
 * repository"), which would make every local-repo feature fail with a
 * confusing message. `safe.directory=*` waives that check — appropriate
 * here because the mount is read-only and the path was already constrained
 * to the configured local-repos root by `resolveLocalRepoPath`.
 */
const LOCAL_GIT_CONFIG = ["safe.directory=*"];

/** Per-file patch text is capped so one enormous generated file (a lockfile, a bundled asset) can't blow up a job payload or an LLM prompt. The review pipeline truncates further before sending; this is just the outer guard. */
const MAX_PATCH_BYTES = 60_000;

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
  baseRef: string,
  headRef: string
): Promise<string[]> {
  const dir = resolveLocalRepoPath(localPath);
  const output = await gitIn(dir, undefined, LOCAL_GIT_CONFIG).raw([
    "diff",
    "--name-only",
    `${baseRef}...${headRef}`,
    "--",
  ]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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
 * a query string and git would otherwise parse it as an option.
 */
export async function resolveLocalRefSha(localPath: string, ref: string): Promise<string> {
  if (!ref || ref.startsWith("-")) {
    throw new Error(`"${ref}" is not a valid git ref.`);
  }
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

/** `git merge-base a b`, or `null` when the two commits share no history (or either is gone). Two commits' merge base is what a three-dot diff is anchored on. */
export async function localMergeBase(
  localPath: string,
  a: string,
  b: string
): Promise<string | null> {
  const dir = resolveLocalRepoPath(localPath);
  try {
    const out = await gitIn(dir, undefined, LOCAL_GIT_CONFIG).raw(["merge-base", a, b]);
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
 */
export async function listLocalFilePatches(
  localPath: string,
  baseRef: string,
  headRef: string
): Promise<LocalFilePatch[]> {
  const dir = resolveLocalRepoPath(localPath);
  const git = gitIn(dir, undefined, LOCAL_GIT_CONFIG);
  const range = `${baseRef}...${headRef}`;

  const [nameStatusRaw, numstatRaw] = await Promise.all([
    git.raw(["diff", "--name-status", "--no-renames", "-z", range, "--"]),
    git.raw(["diff", "--numstat", "--no-renames", "-z", range, "--"]),
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
