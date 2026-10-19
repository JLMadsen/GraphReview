// Resolving a stored repo to a directory on disk that can be analyzed.
//
// Three ingestion paths behind one interface:
//   - `provider: "local"` — a repo already cloned somewhere on this machine,
//     read in place and never written to. Optionally confined to
//     `LOCAL_REPOS_ROOT` (see `resolveLocalRepoPath`).
//   - `provider: "github"` / `provider: "gitlab"` — an app-managed clone in
//     the clone cache (`<data folder>/repos/<repoId>`).
//   - `provider: "git"` — any other git server (DESIGN.md §6.29): an
//     app-managed clone whose branches mirror the server's, read in place
//     like a local repo (`inPlacePath`), since there is no API to ask.
//
// SSH URLs clone with the user's own SSH setup (keys, agent, ssh config);
// HTTPS ones with the PAT from Settings, or anonymously.
//
// Server-only (spawns `git`, reads env vars) — never import from a client
// component.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { SimpleGit, SimpleGitOptions } from "simple-git";
import type { RepoProvider, RepoRecord } from "@/lib/db";
import { gitCaBundle } from "@/lib/runtime/ca";
import { memo } from "./memo-cache";
import { getDataDir } from "@/lib/runtime/paths";
import { assertSafeGitRef, isSafeGitRef } from "./git-ref";
import { hostOf, serverFor, tokenFor } from "./git-hosts";
import { gitHubCloneUrl, parseGitHubUrl } from "./github-access";
import { gitLabCloneUrl, parseGitLabUrl } from "./gitlab-access";

/** The providers `source.ts` clones/fetches over git — everything that isn't `"local"`. */
type RemoteProvider = Exclude<RepoProvider, "local">;

// A `git` subprocess that decides to ask for credentials would hang forever
// here — nobody is watching a background job. Fail the command instead, so a
// private (or misspelled) repo without a configured PAT surfaces as a job
// error rather than a stuck process. On a desktop that takes more than
// GIT_TERMINAL_PROMPT: Git for Windows' credential manager and GUI askpass
// (or an editor's, inherited via GIT_ASKPASS) open a login window instead,
// and the clone waits on it. So askpass answers with nothing, and
// credential helpers are switched off for every command (`gitOptions`) —
// over HTTPS GraphReview authenticates with the PAT from Settings only, never
// with the user's own git credentials. SSH is the exception: an SSH URL uses
// the user's keys and agent, in batch mode (`ensureSshCommand`).
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_ASKPASS = "echo";
process.env.SSH_ASKPASS = "echo";
process.env.GCM_INTERACTIVE = "never";

/**
 * Inherited variables simple-git lets through to git. Since v4 it strips
 * every ambient `GIT_*` variable (and `SSH_ASKPASS`) from git's environment
 * unless it is named here — the no-prompt settings above among them, which
 * would leave a private-repo clone waiting on a credential prompt. The TLS
 * trust variables are the user's own and were always honoured before.
 */
const GIT_ENVIRONMENT = [
  "GIT_TERMINAL_PROMPT",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_SSL_NO_VERIFY",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
];

/** Never prompt (a passphrase, a host key) — a background job can't answer; trust a host seen for the first time, refuse one whose key changed. */
const SSH_BATCH_OPTIONS = "-o BatchMode=yes -o StrictHostKeyChecking=accept-new";

let sshCommandSet = false;

/**
 * Sets `GIT_SSH_COMMAND` once, so an SSH clone/fetch never waits on a
 * prompt: the user's own ssh command (their `GIT_SSH_COMMAND`, else
 * `core.sshCommand` from their git config — on Windows often the system
 * OpenSSH, for its agent) plus {@link SSH_BATCH_OPTIONS}. The variable wins
 * over `core.sshCommand`, which is why that is folded in rather than left to
 * git. A `GIT_SSH` (PuTTY's plink) is left alone — it takes no `-o`.
 */
function ensureSshCommand(): void {
  if (sshCommandSet) return;
  sshCommandSet = true;
  if (process.env.GIT_SSH && !process.env.GIT_SSH_COMMAND) return;
  let base = process.env.GIT_SSH_COMMAND?.trim();
  if (!base) {
    try {
      base = execFileSync("git", ["config", "--get", "core.sshCommand"], { cwd: os.homedir(), encoding: "utf8", windowsHide: true }).trim();
    } catch {
      /* not configured */
    }
  }
  process.env.GIT_SSH_COMMAND = `${base || "ssh"} ${SSH_BATCH_OPTIONS}`;
}

/** `git@host:path`, `ssh://…` — a URL git fetches over SSH. */
export function isSshUrl(url: string): boolean {
  return /^ssh:\/\//i.test(url) || (!url.includes("://") && /^[\w.-]+@[\w.-]+:/.test(url));
}

/** The host of a clone URL in any form git takes (`https://`, `ssh://`, `git@host:path`, `host/path`), lowercase, or `null`. */
export const urlHost = hostOf;

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
  ensureSshCommand();
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
    // On Windows, paths past 260 characters (a deep data folder plus a long
    // migration name) fail the checkout unless git uses long paths.
    config: ["credential.helper=", ...(process.platform === "win32" ? ["core.longpaths=true"] : []), ...gitCaConfig(), ...config],
    allowEnvironment: GIT_ENVIRONMENT,
    unsafe: { allowUnsafeCredentialHelper: true, allowUnsafeSshCommand: true },
  };
}

/** Exported for `./local-git`, which lists a local checkout's branches with the same simple-git setup. */
export function gitIn(baseDir: string, timeoutMs = QUICK_GIT_TIMEOUT_MS, config: string[] = []): SimpleGit {
  return simpleGit(gitOptions(baseDir, timeoutMs, config));
}

/**
 * Per-invocation credential for a private clone/fetch, passed as an
 * `http.extraHeader` rather than being baked into the remote URL. Keeping
 * the PAT out of the remote means it is never written to `.git/config` inside
 * the persistent `repo_cache` volume — a plaintext-credential-at-rest leak
 * this deliberately avoids. It travels in git's environment
 * (`GIT_CONFIG_COUNT`/`_KEY_0`/`_VALUE_0`, git's env form of `-c`), not as a
 * `-c` argument: a command line is readable by every local user (`ps`,
 * `/proc/<pid>/cmdline`) and ends up in error messages; an environment isn't
 * and doesn't.
 *
 * The token is the one saved for the URL's server (./git-hosts.ts) — never
 * for an SSH URL, which authenticates with the user's key instead. The
 * Basic-auth username follows each server's convention: GitHub recommends
 * `x-access-token`, GitLab documents `oauth2` (both accept near-anything);
 * another git server gets the username saved with its token (Bitbucket
 * needs the real one), else `git`.
 */
async function authEnv(url: string): Promise<Record<string, string> | null> {
  if (isSshUrl(url)) return null;
  const saved = await tokenFor(url);
  if (!saved) return null;
  const username = saved.kind === "gitlab" ? "oauth2" : saved.kind === "github" ? "x-access-token" : saved.username || "git";
  const basic = Buffer.from(`${username}:${saved.auth.token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** Names simple-git guards besides `GIT_*` (its environment guard and `unsafe` checks). */
const GUARDED_ENV = new Set(["editor", "pager", "prefix", "visual", "ssh_askpass"]);
const ALLOWED_ENV = new Set(GIT_ENVIRONMENT.map((name) => name.toLowerCase()));

/**
 * A simple-git instance whose git sees `auth` in its environment. An explicit
 * environment replaces the inherited one, and simple-git rejects (rather
 * than strips) a guarded variable passed that way, so the ambient guarded
 * ones are dropped here just as simple-git drops them from the inherited
 * environment.
 */
function remoteGit(baseDir: string, timeoutMs: number, auth: Record<string, string> | null): SimpleGit {
  if (!auth) return simpleGit(gitOptions(baseDir, timeoutMs));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    const key = name.toLowerCase();
    if (value === undefined) continue;
    if ((key.startsWith("git_") || GUARDED_ENV.has(key)) && !ALLOWED_ENV.has(key)) continue;
    env[name] = value;
  }
  return simpleGit({
    ...gitOptions(baseDir, timeoutMs),
    allowEnvironment: [...GIT_ENVIRONMENT, ...Object.keys(auth)],
    // The explicit environment carries the no-prompt GIT_ASKPASS/SSH_ASKPASS
    // (`echo`, set at the top of this file), which simple-git checks only when
    // they are passed this way rather than inherited.
    unsafe: { allowUnsafeCredentialHelper: true, allowUnsafeConfigEnvCount: true, allowUnsafeAskPass: true, allowUnsafeSshCommand: true },
  }).env({ ...env, ...auth });
}

function providerLabel(provider: RemoteProvider): string {
  return provider === "gitlab" ? "GitLab" : provider === "git" ? "the git server" : "GitHub";
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

/** SSH's own refusals: no key the server accepts, or a passphrase with no agent to supply it. */
const SSH_KEY_REFUSED_PATTERN = /permission denied \(publickey|incorrect passphrase/i;
/** A host key that no longer matches known_hosts. (A new host is accepted — `accept-new`.) */
const SSH_HOST_KEY_PATTERN = /host key verification failed|remote host identification has changed/i;

function withFriendlyAuthError<T>(promise: Promise<T>, provider: RemoteProvider, hadToken: boolean, url = ""): Promise<T> {
  return promise.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isSshUrl(url) && SSH_HOST_KEY_PATTERN.test(message)) {
      throw new RepoAccessError(
        `The SSH host key of ${urlHost(url) ?? "the server"} doesn't match the one in your known_hosts — it changed, or something is in between. Check it, then remove the old entry with ssh-keygen -R <host>.`
      );
    }
    if (isSshUrl(url) && SSH_KEY_REFUSED_PATTERN.test(message)) {
      throw new RepoAccessError(
        `${urlHost(url) ?? "The server"} refused your SSH key. GraphReview uses your own SSH setup without prompting: a key in ~/.ssh (or your ssh config) with access to this repository, and a key with a passphrase loaded into ssh-agent.`
      );
    }
    if (provider === "git" && AUTH_FAILURE_PATTERN.test(message)) {
      throw new RepoAccessError(
        hadToken
          ? `${urlHost(url) ?? "The server"} rejected the token saved for it — re-enter it in Settings → Git servers, with your username if the server needs one.`
          : "This repository could not be reached without credentials. Save a token for its server in Settings → Git servers, or add it by its SSH URL (git@host:path) to clone with your SSH key."
      );
    }
    if (AUTH_FAILURE_PATTERN.test(message)) {
      const host = providerLabel(provider);
      throw new RepoAccessError(
        hadToken
          ? `${host} rejected the request (likely an invalid, expired, or insufficiently-scoped PAT — it needs repo read access for a private repository). Re-enter it in Settings → Git servers.`
          : `This repository could not be reached without credentials — it's likely private. Save a token for its server in Settings → Git servers.`
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

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
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
  // A plain git repo's clone is read through here too (`inPlacePath`); it is
  // the app's own folder, not one LOCAL_REPOS_ROOT is meant to confine.
  if (root && path.isAbsolute(expanded) && isInside(getRepoCacheRoot(), path.resolve(expanded))) {
    return path.resolve(expanded);
  }
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
  // Graphs are built from commits, so a folder without git history has nothing to analyse.
  if (!existsSync(path.join(resolved, ".git"))) {
    try {
      await gitIn(resolved).raw(["rev-parse", "--git-dir"]);
    } catch {
      throw new Error(`"${localPath}" isn't a git repository. GraphReview analyses commits, so it needs a folder with git history (run "git init" and commit first).`);
    }
  }
  return resolved;
}

/** Current commit SHA of a checkout on disk. */
export async function readHeadSha(dir: string): Promise<string> {
  return (await gitIn(dir).revparse(["HEAD"])).trim();
}

/**
 * The commit a repo's graph is built from: the tip of its default branch —
 * the local branch of that name, else the remote-tracking one, else (a
 * repo without that branch) whatever is checked out. Which branch the
 * checkout happens to be on, and uncommitted edits, never matter.
 */
export async function readDefaultTipSha(dir: string, defaultBranch: string): Promise<string> {
  const git = gitIn(dir);
  if (isSafeGitRef(defaultBranch)) {
    for (const ref of [`refs/heads/${defaultBranch}`, `refs/remotes/origin/${defaultBranch}`]) {
      try {
        const sha = (await git.raw(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])).trim();
        if (/^[0-9a-f]{40,64}$/.test(sha)) return sha;
      } catch {
        /* not there: next candidate */
      }
    }
  }
  return readHeadSha(dir);
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
export async function readRemoteHead(url: string): Promise<RemoteHead> {
  const output = await remoteGit(process.cwd(), QUICK_GIT_TIMEOUT_MS, await authEnv(url)).listRemote([
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

/**
 * The URL a repo is cloned from: a plain git repo's URL as entered, a
 * GitHub/GitLab repo's SSH URL when it was added by one (`cloneUrl`), else
 * `https://<host>/<owner>/<repo>.git`.
 */
export function remoteUrlForRepo(repo: Pick<RepoRecord, "provider" | "url" | "cloneUrl">): string {
  if (repo.provider === "git") {
    if (!repo.url) throw new Error("remoteUrlForRepo: repo has no URL.");
    return repo.url;
  }
  if (repo.cloneUrl) return repo.cloneUrl;
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
    const sha = await readDefaultTipSha(dir, repo.defaultBranch);
    log(`using local source at ${dir}, ${repo.defaultBranch} at ${sha.slice(0, 12)}`);
    return { dir, sha, cloned: false };
  }

  const remoteProvider = repo.provider as RemoteProvider;
  const remote = remoteUrlForRepo(repo);
  const dir = repoCacheDir(repo.id);
  const auth = await authEnv(remote);

  if (!existsSync(path.join(dir, ".git"))) {
    // A leftover directory without a .git (interrupted earlier clone) would
    // make `git clone` fail on a non-empty target — start clean.
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.dirname(dir), { recursive: true });
    log(`cloning ${remote} into ${dir}`);
    await withFriendlyAuthError(
      remoteGit(getRepoCacheRoot(), SLOW_GIT_TIMEOUT_MS, auth).clone(remote, dir),
      remoteProvider,
      Boolean(auth),
      remote
    );
    if (repo.provider === "git") await syncGitMirror(repo, log);
    return { dir, sha: await readHeadSha(dir), cloned: true };
  }

  if (repo.provider === "git") {
    log(`fetching ${remote} into existing clone at ${dir}`);
    await syncGitMirror(repo, log);
    return { dir, sha: await readHeadSha(dir), cloned: false };
  }

  log(`fetching ${remote} into existing clone at ${dir}`);
  const git = remoteGit(dir, SLOW_GIT_TIMEOUT_MS, auth);
  await git.remote(["set-url", "origin", remote]);
  await withFriendlyAuthError(git.fetch(["--prune", "origin"]), remoteProvider, Boolean(auth), remote);

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

/** Where a plain git repo's clone keeps the server's branches: as its own branches, so names resolve and list as in a local repo. */
const MIRROR_BRANCHES = "+refs/heads/*:refs/heads/*";

/**
 * Brings a plain git repo's clone level with the server: every server branch
 * becomes (or moves) the clone's branch of that name, gone ones are pruned,
 * and the checkout sits detached at the default branch. Detached first, so
 * the fetch may move every branch, the default one included.
 */
async function syncGitMirror(repo: RepoRecord, log: Logger): Promise<void> {
  const remote = remoteUrlForRepo(repo);
  const auth = await authEnv(remote);
  const git = remoteGit(repoCacheDir(repo.id), SLOW_GIT_TIMEOUT_MS, auth);
  await git.remote(["set-url", "origin", remote]);
  await git.raw(["checkout", "--force", "--detach"]);
  await git.raw(["config", "remote.origin.fetch", MIRROR_BRANCHES]);
  await withFriendlyAuthError(git.fetch(["--prune", "--tags", "origin"]), "git", Boolean(auth), remote);
  if (!isSafeGitRef(repo.defaultBranch)) return;
  try {
    await git.raw(["checkout", "--force", "--detach", `refs/heads/${repo.defaultBranch}`]);
  } catch (error) {
    log(`could not check out ${repo.defaultBranch} (${(error as Error).message.split("\n")[0]}) — keeping the current commit`);
  }
}

/** How long a plain git repo's branches are trusted before the branch picker fetches again. */
const GIT_MIRROR_TTL_MS = 30_000;

/**
 * Fetches a plain git repo's branches into its clone, at most every
 * {@link GIT_MIRROR_TTL_MS} — what the branch and commit pickers call, so a
 * branch pushed since the last analysis shows up. A repo not cloned yet is
 * left to its analysis.
 */
export function refreshGitMirror(repo: RepoRecord): Promise<void> {
  if (repo.provider !== "git" || !existsSync(path.join(repoCacheDir(repo.id), ".git"))) return Promise.resolve();
  return memo("git-mirror", repo.id, { ttlMs: GIT_MIRROR_TTL_MS, maxEntries: 50 }, () => syncGitMirror(repo, () => {}));
}

/** Repos the git layer (./local-git.ts) reads in place: local folders, and plain git repos' clones. */
export function readsInPlace(repo: Pick<RepoRecord, "provider">): boolean {
  return repo.provider === "local" || repo.provider === "git";
}

/** The folder ./local-git.ts reads `repo` in: a local repo's path, a plain git repo's clone, `undefined` for GitHub/GitLab (or a local repo with no path). */
export function inPlacePath(repo: Pick<RepoRecord, "provider" | "id" | "localPath">): string | undefined {
  if (repo.provider === "local") return repo.localPath;
  if (repo.provider === "git") return repoCacheDir(repo.id);
  return undefined;
}

/**
 * Makes sure the given commits exist in a GitHub/GitLab repo's app-managed
 * clone, fetching them (and `refspecs`, e.g. a PR's head ref, as a fallback
 * for hosts that refuse fetch-by-sha) when they don't. Clones first if the
 * repo was never analyzed. Returns the clone's directory. Used by the
 * before/after preview, which needs whole trees at a PR's base and head, not
 * just the diff.
 *
 * A ref-comparison target's refspecs are the request's own `baseRef` /
 * `headRef`, so every sha and refspec is checked and fetched after
 * `--end-of-options` — `git fetch origin --upload-pack=<cmd>` runs `<cmd>`.
 */
export async function ensureCommitsInCache(
  repo: RepoRecord,
  shas: readonly string[],
  refspecs: readonly string[],
  log: Logger = () => {}
): Promise<string> {
  for (const ref of [...shas, ...refspecs]) assertSafeGitRef(ref);
  const remoteProvider = repo.provider as RemoteProvider;
  const dir = repoCacheDir(repo.id);
  if (!existsSync(path.join(dir, ".git"))) await prepareRepoSource(repo, log);

  const remote = remoteUrlForRepo(repo);
  const auth = await authEnv(remote);
  const git = remoteGit(dir, SLOW_GIT_TIMEOUT_MS, auth);
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
    await withFriendlyAuthError(git.fetch(["--end-of-options", "origin", ...absent]), remoteProvider, Boolean(auth), remote);
  } catch (error) {
    log(`fetch by sha failed (${(error as Error).message.split("\n")[0]}) — fetching refs instead`);
  }
  absent = await missing();
  if (absent.length > 0 && refspecs.length > 0) {
    await withFriendlyAuthError(git.fetch(["--end-of-options", "origin", ...refspecs]), remoteProvider, Boolean(auth), remote);
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
      return await readDefaultTipSha(dir, repo.defaultBranch);
    }
    const { sha } = await readRemoteHead(remoteUrlForRepo(repo));
    return sha ?? null;
  } catch {
    return null;
  }
}

/**
 * A local checkout's default branch: what `origin/HEAD` points at, else a
 * `main` or `master` branch, else the branch that is checked out.
 */
export async function readLocalDefaultBranch(dir: string): Promise<string | undefined> {
  const git = gitIn(dir);
  try {
    const remoteHead = (await git.raw(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim();
    if (remoteHead.startsWith("origin/")) return remoteHead.slice("origin/".length);
  } catch {
    /* no remote HEAD */
  }
  for (const name of ["main", "master", "Master"]) {
    try {
      await git.raw(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
      return name;
    } catch {
      /* next */
    }
  }
  return readCurrentBranch(dir);
}

/** A URL git can clone that isn't a local path or a transport helper: `http(s)://`, `ssh://`, `git://`, or `user@host:path`. */
export function isCloneableUrl(url: string): boolean {
  return /^(?:https?|ssh|git):\/\/[^/\s]+\/\S+$/i.test(url) || (isSshUrl(url) && !/\s/.test(url));
}

/**
 * Which provider a URL belongs to, by its host alone (./git-hosts.ts): a
 * server a token was saved for says what it is; else the configured or
 * public GitHub/GitLab hosts; else a plain git server. The add-repo form
 * takes one URL and asks nothing else (DESIGN.md §6.29, §6.30).
 */
export async function providerForUrl(url: string): Promise<RemoteProvider> {
  return (await serverFor(url))?.kind ?? "git";
}

/** `readRemoteHead` that fails with the same actionable message a clone would (no SSH key access, no credentials). */
export async function probeRemote(url: string, provider: RemoteProvider): Promise<RemoteHead> {
  const auth = await authEnv(url);
  return withFriendlyAuthError(readRemoteHead(url), provider, Boolean(auth), url);
}

/** Best-effort default-branch detection when adding a repo, falling back to `"main"`. */
export async function detectDefaultBranch(
  source: { provider: "local"; dir: string } | { provider: RemoteProvider; url: string }
): Promise<string> {
  try {
    if (source.provider === "local") {
      return (await readLocalDefaultBranch(source.dir)) ?? "main";
    }
    const { defaultBranch } = await readRemoteHead(source.url);
    return defaultBranch ?? "main";
  } catch {
    return "main";
  }
}
