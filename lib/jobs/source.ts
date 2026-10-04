// Resolving a stored repo to a directory on disk that can be analyzed.
//
// Three ingestion paths behind one interface:
//   - `provider: "local"` — a repo already cloned somewhere on this machine,
//     read in place and never written to. Optionally confined to
//     `LOCAL_REPOS_ROOT` (see `resolveLocalRepoPath`).
//   - `provider: "github"` / `provider: "gitlab"` — an app-managed clone in
//     the clone cache (`<data folder>/repos/<repoId>`).
//
// Server-only (spawns `git`, reads env vars) — never import from a client
// component.

import { existsSync } from "node:fs";
import os from "node:os";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { SimpleGit, SimpleGitOptions } from "simple-git";
import type { RepoProvider, RepoRecord } from "@/lib/db";
import { gitCaBundle } from "@/lib/runtime/ca";
import { getDataDir } from "@/lib/runtime/paths";
import { getStoredGitHubToken, gitHubCloneUrl, parseGitHubUrl } from "./github-access";
import { getStoredGitLabToken, gitLabCloneUrl, parseGitLabUrl } from "./gitlab-access";

/** The two providers `source.ts` clones/fetches over git — everything that isn't `"local"`. */
type RemoteProvider = Exclude<RepoProvider, "local">;

// A `git` subprocess that decides to ask for credentials would hang forever
// here — nobody is watching a background job. Fail the command instead, so a
// private (or misspelled) repo without a configured PAT surfaces as a job
// error rather than a stuck process. On a desktop that takes more than
// GIT_TERMINAL_PROMPT: Git for Windows' credential manager and GUI askpass
// (or an editor's, inherited via GIT_ASKPASS) open a login window instead,
// and the clone waits on it. So askpass answers with nothing, and
// credential helpers are switched off for every command (`gitOptions`) —
// GraphReview authenticates with the PAT from Settings only, never with the
// user's own git credentials.
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_ASKPASS = "echo";
process.env.SSH_ASKPASS = "echo";
process.env.GCM_INTERACTIVE = "never";

/** Idle timeout for a git subprocess that should be quick (`ls-remote`, `rev-parse`). */
const QUICK_GIT_TIMEOUT_MS = 20_000;
/** Idle timeout for a clone/fetch, which can legitimately be quiet for a while on a big repo. */
const SLOW_GIT_TIMEOUT_MS = 10 * 60_000;

function gitCaConfig(): string[] {
  const bundle = gitCaBundle();
  return bundle ? [`http.sslCAInfo=${bundle}`, "http.schannelUseSSLCAInfo=true"] : [];
}

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
    // Empty `credential.helper` clears any configured helper (see the note on
    // GIT_ASKPASS above). simple-git refuses to touch this key unless told to.
    // A company CA file (NODE_EXTRA_CA_CERTS, e.g. from config.env) is
    // trusted too — as one bundle with the public roots and the OS store's
    // extras, since git replaces its own bundle with it (and with
    // schannelUseSSLCAInfo, Git for Windows' schannel backend uses it as well).
    config: ["credential.helper=", ...gitCaConfig(), ...config],
    unsafe: { allowUnsafeCredentialHelper: true },
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
 * this deliberately avoids.
 *
 * The Basic-auth username differs by host convention: GitHub accepts (and
 * its own docs recommend) `x-access-token` as the username for a PAT;
 * GitLab's documented convention for PAT-over-HTTPS is `oauth2`. Either
 * host actually accepts near-arbitrary non-empty usernames as long as the
 * password is a valid token, but matching each host's own convention avoids
 * surprises.
 */
function authConfig(token: string | null, provider: RemoteProvider): string[] {
  if (!token) return [];
  const username = provider === "gitlab" ? "oauth2" : "x-access-token";
  const basic = Buffer.from(`${username}:${token}`).toString("base64");
  return [`http.extraHeader=Authorization: Basic ${basic}`];
}

/** The token + host label for whichever remote provider a repo uses. */
async function resolveRemoteToken(provider: RemoteProvider): Promise<string | null> {
  return provider === "gitlab" ? getStoredGitLabToken() : getStoredGitHubToken();
}

function providerLabel(provider: RemoteProvider): string {
  return provider === "gitlab" ? "GitLab" : "GitHub";
}

/**
 * Rewrites git's own (cryptic, credential-helper-flavored) failure message
 * into something a user can act on. When a token is missing, wrong, expired,
 * or lacks the right scope, the host answers the clone/fetch request with a
 * 401 — and rather than reporting that cleanly, git falls back to its
 * interactive credential-prompt flow to try to satisfy the challenge, which
 * then fails with "could not read Username ... terminal prompts disabled"
 * because `GIT_TERMINAL_PROMPT=0` (no terminal is ever attached here). That
 * message is accurate but says nothing about *why*, so it's worth
 * translating.
 *
 * Every phrasing seen in practice for "this clone/fetch failed because of
 * missing or insufficient access", across both git's own credential-prompt
 * failure and GitHub's/GitLab's several different server-side rejection
 * messages:
 *   - "could not read Username" — git's own message when it falls back to
 *     its interactive credential flow and there's no terminal attached.
 *   - "Authentication failed" / "status code: 401" — an invalid/expired PAT.
 *   - "Write access to repository not granted" / "403" — an authenticated
 *     but insufficiently-scoped PAT, or (with no token at all) how a host's
 *     git-http-backend sometimes phrases "you can't read this private repo"
 *     rather than the plain 404 "repository not found" case below.
 *   - "repository not found" — neither GitHub nor GitLab distinguishes
 *     "doesn't exist" from "exists but you can't see it" for a private
 *     repo, so this is just as likely to mean "wrong/missing credentials"
 *     as a typo'd URL.
 */
const AUTH_FAILURE_PATTERN =
  /could not read username|authentication failed|write access to repository not granted|status code: ?40[13]\b|remote: .*forbidden|repository not found/i;

/** A clone/fetch the host refused for lack of (valid) credentials. Retrying can't fix it; a PAT in Settings can. */
export class RepoAccessError extends Error {
  override readonly name = "RepoAccessError";
}

function withFriendlyAuthError<T>(promise: Promise<T>, provider: RemoteProvider, hadToken: boolean): Promise<T> {
  return promise.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (AUTH_FAILURE_PATTERN.test(message)) {
      const host = providerLabel(provider);
      throw new RepoAccessError(
        hadToken
          ? `${host} rejected the request (likely an invalid, expired, or insufficiently-scoped PAT — it needs repo read access for a private repository). Re-enter it in Settings.`
          : `This repository could not be reached without credentials — it's likely private. Add a ${host} PAT in Settings.`
      );
    }
    throw error;
  });
}

/**
 * The folder local repos are confined to, when one is configured
 * (`LOCAL_REPOS_ROOT`). Unset by default: GraphReview runs on your own
 * machine as you, so any folder you can read is fair game.
 */
export function getLocalReposRoot(): string | undefined {
  const explicit = process.env.LOCAL_REPOS_ROOT;
  return explicit ? path.resolve(explicit) : undefined;
}

/** Root of the app-managed clone cache: `REPO_CACHE_DIR`, or `repos/` in the data folder. */
export function getRepoCacheRoot(): string {
  const explicit = process.env.REPO_CACHE_DIR;
  if (explicit) return path.resolve(explicit);
  return path.join(getDataDir(), "repos");
}

export function repoCacheDir(repoId: string): string {
  return path.join(getRepoCacheRoot(), repoId);
}

export class LocalPathOutsideRootError extends Error {
  override readonly name = "LocalPathOutsideRootError";
  constructor(requested: string, root: string) {
    super(
      `Local repo path "${requested}" is outside the allowed local-repos folder ("${root}"). ` +
        "Only repos under that folder can be used as a local source."
    );
  }
}

/**
 * Resolves a user-supplied local path to an absolute path.
 *
 * Without `LOCAL_REPOS_ROOT` the path must be absolute (`~/` is expanded).
 * With it, a relative path is taken relative to that folder, and anything
 * that escapes it is refused: containment is checked lexically after
 * `path.resolve`, which collapses `..` segments. Symlinks are deliberately
 * *not* resolved away — symlinking a repo into the folder is a supported
 * workflow.
 */
export function resolveLocalRepoPath(localPath: string): string {
  const expanded = localPath.startsWith("~/") || localPath.startsWith("~\\")
    ? path.join(os.homedir(), localPath.slice(2))
    : localPath === "~"
      ? os.homedir()
      : localPath;

  const root = getLocalReposRoot();
  if (!root) {
    if (!path.isAbsolute(expanded)) {
      throw new Error(`Local repo path "${localPath}" must be absolute (e.g. ${path.join(os.homedir(), "code", "my-app")}).`);
    }
    return path.resolve(expanded);
  }

  const candidate = path.resolve(root, expanded);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new LocalPathOutsideRootError(localPath, root);
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
 * Cheap remote HEAD probe via `git ls-remote --symref <url> HEAD` —
 * one network round trip, no clone, and it yields the default branch name in
 * the same call.
 */
export async function readRemoteHead(
  url: string,
  token: string | null,
  provider: RemoteProvider
): Promise<RemoteHead> {
  const output = await gitIn(process.cwd(), QUICK_GIT_TIMEOUT_MS, authConfig(token, provider)).listRemote([
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

/** The clone URL for a github- or gitlab-provider repo, normalized to `https://<host>/<owner>/<repo>.git`. */
export function remoteUrlForRepo(repo: Pick<RepoRecord, "provider" | "url">): string {
  if (repo.provider === "gitlab") {
    if (!repo.url) throw new Error("remoteUrlForRepo: repo has no GitLab URL.");
    const ref = parseGitLabUrl(repo.url);
    if (!ref) throw new Error(`Could not parse a project path out of "${repo.url}".`);
    return gitLabCloneUrl(ref);
  }
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
 * analyze plus its exact commit SHA (recorded as `Repo.lastAnalyzedSha`).
 *
 * Local repos are treated as read-only — they are never
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

  const remoteProvider = repo.provider as RemoteProvider;
  const remote = remoteUrlForRepo(repo);
  const dir = repoCacheDir(repo.id);
  const token = await resolveRemoteToken(remoteProvider);
  const config = authConfig(token, remoteProvider);

  if (!existsSync(path.join(dir, ".git"))) {
    // A leftover directory without a .git (interrupted earlier clone) would
    // make `git clone` fail on a non-empty target — start clean.
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.dirname(dir), { recursive: true });
    log(`cloning ${remote} into ${dir}`);
    await withFriendlyAuthError(
      simpleGit(gitOptions(getRepoCacheRoot(), SLOW_GIT_TIMEOUT_MS, config)).clone(remote, dir),
      remoteProvider,
      Boolean(token)
    );
    return { dir, sha: await readHeadSha(dir), cloned: true };
  }

  log(`fetching ${remote} into existing clone at ${dir}`);
  const git = gitIn(dir, SLOW_GIT_TIMEOUT_MS, config);
  await git.remote(["set-url", "origin", remote]);
  await withFriendlyAuthError(git.fetch(["--prune", "origin"]), remoteProvider, Boolean(token));

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
 * Makes sure the given commits exist in a GitHub/GitLab repo's app-managed
 * clone, fetching them (and `refspecs`, e.g. a PR's head ref, as a fallback
 * for hosts that refuse fetch-by-sha) when they don't. Clones first if the
 * repo was never analyzed. Returns the clone's directory. Used by the
 * before/after preview, which needs whole trees at a PR's base and head, not
 * just the diff.
 */
export async function ensureCommitsInCache(
  repo: RepoRecord,
  shas: readonly string[],
  refspecs: readonly string[],
  log: Logger = () => {}
): Promise<string> {
  const remoteProvider = repo.provider as RemoteProvider;
  const dir = repoCacheDir(repo.id);
  if (!existsSync(path.join(dir, ".git"))) await prepareRepoSource(repo, log);

  const token = await resolveRemoteToken(remoteProvider);
  const git = gitIn(dir, SLOW_GIT_TIMEOUT_MS, authConfig(token, remoteProvider));
  const missing = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const sha of shas) {
      try {
        await git.raw(["cat-file", "-e", `${sha}^{commit}`]);
      } catch {
        out.push(sha);
      }
    }
    return out;
  };

  let absent = await missing();
  if (absent.length === 0) return dir;
  log(`fetching ${absent.map((s) => s.slice(0, 7)).join(", ")} into the app's clone`);
  try {
    await withFriendlyAuthError(git.fetch(["origin", ...absent]), remoteProvider, Boolean(token));
  } catch (error) {
    log(`fetch by sha failed (${(error as Error).message.split("\n")[0]}) — fetching refs instead`);
  }
  absent = await missing();
  if (absent.length > 0 && refspecs.length > 0) {
    await withFriendlyAuthError(git.fetch(["origin", ...refspecs]), remoteProvider, Boolean(token));
    absent = await missing();
  }
  if (absent.length > 0) {
    throw new Error(`Could not fetch commit(s) ${absent.map((s) => s.slice(0, 7)).join(", ")} from ${providerLabel(remoteProvider)}.`);
  }
  return dir;
}

/**
 * The repo's *current* HEAD SHA without doing any expensive work — the cheap
 * staleness probe. Returns `null` when it can't be determined (offline,
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
    const remoteProvider = repo.provider as RemoteProvider;
    const token = await resolveRemoteToken(remoteProvider);
    const { sha } = await readRemoteHead(remoteUrlForRepo(repo), token, remoteProvider);
    return sha ?? null;
  } catch {
    return null;
  }
}

/** Best-effort default-branch detection when adding a repo, falling back to `"main"`. */
export async function detectDefaultBranch(
  source: { provider: "local"; dir: string } | { provider: RemoteProvider; url: string }
): Promise<string> {
  try {
    if (source.provider === "local") {
      return (await readCurrentBranch(source.dir)) ?? "main";
    }
    const token = await resolveRemoteToken(source.provider);
    const { defaultBranch } = await readRemoteHead(source.url, token, source.provider);
    return defaultBranch ?? "main";
  } catch {
    return "main";
  }
}
