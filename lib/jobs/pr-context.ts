// What the PR checklist and the PR chat know about one review target (a PR
// or a base...head ref comparison): its intent and diff, its CI status, and
// its files at the head commit.
//
// The diff + intent come from the review pipeline's own `resolveTarget`, so
// all three features read a target the same way. It is cached for a short
// while per target: a chat conversation asks several questions in a row and
// each turn may call several tools — refetching a PR's files from GitHub on
// every step would burn rate limit for nothing. The cache is keyed on the
// target, not the head sha, so a push shows up after at most `CACHE_MS`.
//
// Kept out of lib/jobs' barrel: it pulls in ./review (lib/ai, lib/github).

import { getCommitCiStatus as getGitHubCiStatus, getFileAtRef as getGitHubFile } from "@/lib/github";
import type { CiStatus } from "@/lib/github";
import { getCommitCiStatus as getGitLabCiStatus, getFileAtRef as getGitLabFile } from "@/lib/gitlab";
import type { RepoRecord } from "@/lib/neo4j";
import type { JobLogger } from "./analyze";
import { resolveGitHubAccess } from "./github-access";
import { resolveGitLabAccess } from "./gitlab-access";
import { grepLocalAtRef, readLocalFileAtRef } from "./local-git";
import { resolveTarget, type ResolvedTarget } from "./review";
import { reviewTargetKey, type ReviewTarget } from "./review-queue";
import { readRepoFile, sourceDir } from "./review-context";
import { gitIn } from "./source";

const CACHE_MS = 60_000;
const MAX_FILE_CHARS = 400_000;

interface CacheEntry {
  at: number;
  value: Promise<ResolvedTarget>;
}

const cache = new Map<string, CacheEntry>();

/** The target's diff + intent + reviewed shas, cached for {@link CACHE_MS}. */
export async function loadPrContext(
  repo: RepoRecord,
  target: ReviewTarget,
  log: JobLogger = () => undefined,
  options: { fresh?: boolean } = {}
): Promise<ResolvedTarget> {
  const key = `${repo.id}|${reviewTargetKey(target)}`;
  const hit = cache.get(key);
  if (!options.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const value = resolveTarget(repo, target, log);
  cache.set(key, { at: Date.now(), value });
  // A failed load must not be served from the cache.
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

export type CiLookup =
  | { available: true; status: CiStatus }
  | { available: false; reason: string };

/** CI status of the target's head commit, from GitHub or GitLab. Local repos have none. */
export async function loadCiStatus(repo: RepoRecord, headSha: string | undefined): Promise<CiLookup> {
  if (!headSha) return { available: false, reason: "The head commit could not be resolved." };
  if (repo.provider === "local") {
    return { available: false, reason: "Local repos have no CI to read — link the repo to GitHub or GitLab." };
  }
  try {
    if (repo.provider === "gitlab") {
      const access = await resolveGitLabAccess(repo);
      if (!access.ok) return { available: false, reason: `GitLab is not reachable for this repo (${access.reason}).` };
      return { available: true, status: (await getGitLabCiStatus(access.token, access.ref.path, headSha)).data };
    }
    const access = await resolveGitHubAccess(repo);
    if (!access.ok) return { available: false, reason: `GitHub is not reachable for this repo (${access.reason}).` };
    return {
      available: true,
      status: (await getGitHubCiStatus(access.token, access.ref.owner, access.ref.repo, headSha)).data,
    };
  } catch (error) {
    return { available: false, reason: `Could not read CI status: ${(error as Error).message}` };
  }
}

/**
 * A file's text at `sha` (the PR's head or base). Local repos read it with
 * `git show`; GitHub/GitLab through their contents API; if that fails, the
 * app's checkout of the default branch is the last resort (and says so).
 */
export async function readFileAtCommit(
  repo: RepoRecord,
  sha: string | undefined,
  filePath: string
): Promise<{ text: string; source: "commit" | "default-branch" } | null> {
  const clean = filePath.replace(/^\/+/, "");
  if (!clean || clean.includes("..")) return null;

  if (sha) {
    try {
      let text: string | null = null;
      if (repo.provider === "local" && repo.localPath) {
        text = await readLocalFileAtRef(repo.localPath, sha, clean);
      } else if (repo.provider === "gitlab") {
        const access = await resolveGitLabAccess(repo);
        if (access.ok) text = (await getGitLabFile(access.token, access.ref.path, clean, sha)).data;
      } else {
        const access = await resolveGitHubAccess(repo);
        if (access.ok) text = (await getGitHubFile(access.token, access.ref.owner, access.ref.repo, clean, sha)).data;
      }
      if (text !== null) return { text: text.slice(0, MAX_FILE_CHARS), source: "commit" };
    } catch {
      /* fall through to the checkout */
    }
  }

  const dir = await sourceDir(repo);
  const text = dir ? await readRepoFile(dir, clean) : null;
  return text === null ? null : { text, source: "default-branch" };
}

/**
 * Text search. Local repos search the given commit with `git grep`; other
 * repos search the app's checkout of the default branch (there is no cheap
 * code search at an arbitrary commit over the APIs) — the result says which.
 */
export async function searchCode(
  repo: RepoRecord,
  sha: string | undefined,
  query: string
): Promise<{ hits: Array<{ path: string; line: number; text: string }>; source: "commit" | "default-branch" }> {
  if (repo.provider === "local" && repo.localPath && sha) {
    return { hits: await grepLocalAtRef(repo.localPath, sha, query), source: "commit" };
  }
  const dir = await sourceDir(repo);
  if (!dir) return { hits: [], source: "default-branch" };
  // `git grep` in the checkout itself: fast, respects .gitignore, no new dependency.
  let out = "";
  try {
    out = await gitIn(dir, undefined, ["safe.directory=*"]).raw(["grep", "-n", "-I", "-F", "--no-color", "-e", query]);
  } catch {
    return { hits: [], source: "default-branch" };
  }
  const hits = out
    .split("\n")
    .map((row) => /^([^:]+):(\d+):(.*)$/.exec(row))
    .filter((m): m is RegExpExecArray => m !== null)
    .slice(0, 60)
    .map((m) => ({ path: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 200) }));
  return { hits, source: "default-branch" };
}
