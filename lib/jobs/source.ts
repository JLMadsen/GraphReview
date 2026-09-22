// Resolving a `(:Repo)` record to a directory on disk that can be analyzed —
// DESIGN.md §4 (decision #4), §12, §14.
//
// Two ingestion paths behind one interface:
//   - `provider: "local"` — a repo already cloned under the read-only bind
//     mount (`LOCAL_REPOS_PATH` on the host → `/data/local-repos` in the
//     container). Escaping that folder is a security boundary, not a
//     convenience check: the path is user input from the "add repo" dialog
//     and would otherwise let anyone read arbitrary container-visible files
//     into the graph.
//   - `provider: "github"` — an app-managed clone in the `repo_cache` volume
//     at `/data/repos/<repoId>` (§12).
//
// Server-only (spawns `git`, reads env vars) — never import from a client
// component.

import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { SimpleGit, SimpleGitOptions } from "simple-git";
import type { RepoRecord } from "@/lib/neo4j";
import { getStoredGitHubToken, gitHubCloneUrl, parseGitHubUrl } from "./github-access";

// A `git` subprocess that decides to ask for credentials would hang forever
// here — there is no terminal attached to a Next.js route handler or a
// BullMQ worker. Fail the command instead, so a private repo without a
// configured PAT surfaces as a job error rather than a stuck process.
process.env.GIT_TERMINAL_PROMPT = "0";

/** Container-side mount point of the `LOCAL_REPOS_PATH` bind mount (§12). */
export const DOCKER_LOCAL_REPOS_MOUNT = "/data/local-repos";
/** Container-side mount point of the `repo_cache` volume (§12). */
export const DOCKER_REPO_CACHE_DIR = "/data/repos";
/** Fallback clone root when running outside Docker (`npm run dev` + `npm run worker`). */
export const DEV_REPO_CACHE_DIR = ".data/repos";

/** Idle timeout for a git subprocess that should be quick (`ls-remote`, `rev-parse`). */
const QUICK_GIT_TIMEOUT_MS = 20_000;
/** Idle timeout for a clone/fetch, which can legitimately be quiet for a while on a big repo. */
const SLOW_GIT_TIMEOUT_MS = 10 * 60_000;

function gitOptions(
  baseDir: string,
  timeoutMs: number,
  config: string[] = []
): Partial<SimpleGitOptions> {
  return {
    baseDir,
    maxConcurrentProcesses: 1,
    trimmed: true,
    timeout: { block: timeoutMs },
    config,
  };
}

/** Exported for `./local-git`, which lists a local checkout's branches with the same simple-git setup. */
export function gitIn(baseDir: string, timeoutMs = QUICK_GIT_TIMEOUT_MS, config: string[] = []): SimpleGit {
  return simpleGit(gitOptions(baseDir, timeoutMs, config));
}

/**
 * Per-invocation credential for a private clone/fetch, passed as `git -c
 * http.extraHeader=…` rather than being baked into the remote URL. Keeping
 * the PAT out of the remote means it is never written to `.git/config` inside
 * the persistent `repo_cache` volume — a plaintext-credential-at-rest leak
 * that §11 explicitly tries to avoid.
 */
function authConfig(token: string | null): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return [`http.extraHeader=Authorization: Basic ${basic}`];
}

/**
 * Rewrites git's own (cryptic, credential-helper-flavored) failure message
 * into something a user can act on. When a token is missing, wrong, expired,
 * or lacks `repo` scope, GitHub answers the clone/fetch request with a 401 —
 * and rather than reporting that cleanly, git falls back to its interactive
 * credential-prompt flow to try to satisfy the challenge, which then fails
 * with "could not read Username ... terminal prompts disabled" because
 * `GIT_TERMINAL_PROMPT=0` (no terminal is ever attached here). That message
 * is accurate but says nothing about *why*, so it's worth translating.
 */
/**
 * Every phrasing seen in practice for "this clone/fetch failed because of
 * missing or insufficient access", across both git's own credential-prompt
 * failure and GitHub's several different server-side rejection messages:
 *   - "could not read Username" — git's own message when it falls back to
 *     its interactive credential flow and there's no terminal (§17).
 *   - "Authentication failed" / "status code: 401" — an invalid/expired PAT.
 *   - "Write access to repository not granted" / "403" — an authenticated
 *     but insufficiently-scoped PAT, or (with no token at all) how GitHub's
 *     git-http-backend sometimes phrases "you can't read this private repo"
 *     rather than the plain 404 "repository not found" case below.
 *   - "repository not found" — GitHub deliberately can't distinguish
 *     "doesn't exist" from "exists but you can't see it" for a private repo,
 *     so this is just as likely to mean "wrong/missing credentials" as a
 *     typo'd URL.
 */
const AUTH_FAILURE_PATTERN =
  /could not read username|authentication failed|write access to repository not granted|status code: ?40[13]\b|remote: .*forbidden|repository not found/i;

function withFriendlyAuthError<T>(promise: Promise<T>, hadToken: boolean): Promise<T> {
  return promise.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (AUTH_FAILURE_PATTERN.test(message)) {
      throw new Error(
        hadToken
          ? "GitHub rejected the request (likely an invalid, expired, or insufficiently-scoped PAT — it needs `repo` scope for a private repository). Re-enter it in Settings."
          : "This repository could not be reached without credentials — it's likely private. Add a GitHub PAT with `repo` scope in Settings."
      );
    }
    throw error;
  });
}

/**
 * Root the "local path" ingestion path is confined to.
 *
 * Under Docker the host folder is bind-mounted at a fixed container path, so
 * that is preferred when it exists; outside Docker (plain `npm run dev`)
 * `LOCAL_REPOS_PATH` is itself a real host path and is used directly.
 * `LOCAL_REPOS_ROOT` overrides both for anyone with a different layout.
 */
export function getLocalReposRoot(): string {
  const explicit = process.env.LOCAL_REPOS_ROOT;
  if (explicit) return path.resolve(explicit);
  if (existsSync(DOCKER_LOCAL_REPOS_MOUNT)) return DOCKER_LOCAL_REPOS_MOUNT;

  const hostPath = process.env.LOCAL_REPOS_PATH;
  if (hostPath) return path.resolve(hostPath);

  throw new Error(
    "No local-repos root configured: set LOCAL_REPOS_PATH (see docker/.env.example) " +
      "or LOCAL_REPOS_ROOT to the folder your local repos live under (DESIGN.md §14)."
  );
}

/** Root of the app-managed clone cache (§12's `repo_cache` volume), overridable via `REPO_CACHE_DIR`. */
export function getRepoCacheRoot(): string {
  const explicit = process.env.REPO_CACHE_DIR;
  if (explicit) return path.resolve(explicit);
  if (existsSync(DOCKER_REPO_CACHE_DIR)) return DOCKER_REPO_CACHE_DIR;
  return path.resolve(process.cwd(), DEV_REPO_CACHE_DIR);
}

export function repoCacheDir(repoId: string): string {
  return path.join(getRepoCacheRoot(), repoId);
}

export class LocalPathOutsideRootError extends Error {
  override readonly name = "LocalPathOutsideRootError";
  constructor(requested: string, root: string) {
    super(
      `Local repo path "${requested}" is outside the allowed local-repos folder ("${root}"). ` +
        "Only repos under that folder can be used as a local source (DESIGN.md §14)."
    );
  }
}

/**
 * Resolves a user-supplied local path (absolute, or relative to the root) to
 * an absolute path, refusing anything that escapes the local-repos root.
 *
 * Containment is checked lexically after `path.resolve`, which collapses
 * `..` segments — so `../../etc` and an absolute `/etc/passwd` are both
 * rejected. Symlinks are deliberately *not* resolved away: §14 names
 * symlinking a repo into the folder as a supported workflow, so following a
 * symlink out of the root is an explicit admin choice on the host side, not
 * an injection through this API.
 */
export function resolveLocalRepoPath(localPath: string): string {
  const root = getLocalReposRoot();
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, localPath);

  const relative = path.relative(resolvedRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new LocalPathOutsideRootError(localPath, resolvedRoot);
  }
  return candidate;
}

/** Validates a local path *and* that it actually is a directory containing a git repo. */
export async function validateLocalRepoPath(localPath: string): Promise<string> {
  const resolved = resolveLocalRepoPath(localPath);
  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error(`Local repo path "${localPath}" is not a directory.`);
  }
  return resolved;
}

/** Current commit SHA of a checkout on disk. */
export async function readHeadSha(dir: string): Promise<string> {
  return (await gitIn(dir).revparse(["HEAD"])).trim();
}

/** Current branch name of a checkout on disk, or `undefined` when detached/unavailable. */
export async function readCurrentBranch(dir: string): Promise<string | undefined> {
  try {
    const branch = (await gitIn(dir).revparse(["--abbrev-ref", "HEAD"])).trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

export interface RemoteHead {
  sha?: string;
  defaultBranch?: string;
}

/**
 * Cheap remote HEAD probe via `git ls-remote --symref <url> HEAD` (§10) —
 * one network round trip, no clone, and it yields the default branch name in
 * the same call.
 */
export async function readRemoteHead(url: string, token: string | null): Promise<RemoteHead> {
  const output = await gitIn(process.cwd(), QUICK_GIT_TIMEOUT_MS, authConfig(token)).listRemote([
    "--symref",
    url,
    "HEAD",
  ]);

  const result: RemoteHead = {};
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(trimmed);
    if (symref) {
      result.defaultBranch = symref[1];
      continue;
    }
    const sha = /^([0-9a-f]{40})\s+HEAD$/i.exec(trimmed);
    if (sha) result.sha = sha[1];
  }
  return result;
}

/** The clone URL for a github-provider repo, normalized to `https://github.com/<owner>/<repo>.git`. */
export function remoteUrlForRepo(repo: Pick<RepoRecord, "provider" | "url">): string {
  if (repo.provider !== "github" || !repo.url) {
    throw new Error("remoteUrlForRepo: repo has no GitHub URL.");
  }
  const ref = parseGitHubUrl(repo.url);
  if (!ref) throw new Error(`Could not parse owner/repo out of "${repo.url}".`);
  return gitHubCloneUrl(ref);
}

export interface PreparedSource {
  /** Absolute directory to hand to `analyzeRepo()`. */
  dir: string;
  /** Commit SHA the directory is currently checked out at. */
  sha: string;
  /** Whether this call cloned the repo for the first time. */
  cloned: boolean;
}

type Logger = (message: string) => void;

/**
 * Brings the repo's source on disk up to date and returns the directory to
 * analyze plus its exact commit SHA (recorded as `Repo.lastAnalyzedSha`, §10).
 *
 * Local repos are read-only (the bind mount is `:ro`, §12) — they are never
 * fetched or mutated, only read at whatever commit the developer has checked
 * out. URL repos are cloned on first use and fast-forwarded to the remote's
 * default branch afterwards.
 */
export async function prepareRepoSource(
  repo: RepoRecord,
  log: Logger = () => {}
): Promise<PreparedSource> {
  if (repo.provider === "local") {
    if (!repo.localPath) {
      throw new Error(`Repo ${repo.id} is a local repo but has no localPath.`);
    }
    const dir = await validateLocalRepoPath(repo.localPath);
    log(`using local source at ${dir}`);
    return { dir, sha: await readHeadSha(dir), cloned: false };
  }

  const remote = remoteUrlForRepo(repo);
  const dir = repoCacheDir(repo.id);
  const token = await getStoredGitHubToken();
  const config = authConfig(token);

  if (!existsSync(path.join(dir, ".git"))) {
    // A leftover directory without a .git (interrupted earlier clone) would
    // make `git clone` fail on a non-empty target — start clean.
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.dirname(dir), { recursive: true });
    log(`cloning ${remote} into ${dir}`);
    await withFriendlyAuthError(
      simpleGit(gitOptions(getRepoCacheRoot(), SLOW_GIT_TIMEOUT_MS, config)).clone(remote, dir),
      Boolean(token)
    );
    return { dir, sha: await readHeadSha(dir), cloned: true };
  }

  log(`fetching ${remote} into existing clone at ${dir}`);
  const git = gitIn(dir, SLOW_GIT_TIMEOUT_MS, config);
  await git.remote(["set-url", "origin", remote]);
  await withFriendlyAuthError(git.fetch(["--prune", "origin"]), Boolean(token));

  // Force the working tree onto the remote's current default-branch head.
  // `-B` resets an existing local branch instead of failing, and `--force`
  // discards anything a previous interrupted run left behind.
  try {
    await git.raw(["checkout", "--force", "-B", repo.defaultBranch, `origin/${repo.defaultBranch}`]);
  } catch (error) {
    log(
      `could not check out origin/${repo.defaultBranch} (${(error as Error).message}) — falling back to origin/HEAD`
    );
    await git.raw(["checkout", "--force", "--detach", "origin/HEAD"]);
  }

  return { dir, sha: await readHeadSha(dir), cloned: false };
}

/**
 * The repo's *current* HEAD SHA without doing any expensive work — the cheap
 * staleness probe of §10. Returns `null` when it can't be determined (offline,
 * bad path, missing credentials); callers treat that as "assume unchanged"
 * rather than failing a page render.
 */
export async function readCurrentSha(repo: RepoRecord): Promise<string | null> {
  try {
    if (repo.provider === "local") {
      if (!repo.localPath) return null;
      const dir = resolveLocalRepoPath(repo.localPath);
      return await readHeadSha(dir);
    }
    const token = await getStoredGitHubToken();
    const { sha } = await readRemoteHead(remoteUrlForRepo(repo), token);
    return sha ?? null;
  } catch {
    return null;
  }
}

/** Best-effort default-branch detection when adding a repo, falling back to `"main"`. */
export async function detectDefaultBranch(
  source: { provider: "local"; dir: string } | { provider: "github"; url: string }
): Promise<string> {
  try {
    if (source.provider === "local") {
      return (await readCurrentBranch(source.dir)) ?? "main";
    }
    const token = await getStoredGitHubToken();
    const { defaultBranch } = await readRemoteHead(source.url, token);
    return defaultBranch ?? "main";
  } catch {
    return "main";
  }
}
