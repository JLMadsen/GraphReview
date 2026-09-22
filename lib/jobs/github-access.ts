// Bridge between a stored `(:Repo)` record and lib/github — DESIGN.md §7, §8, §11.
//
// lib/github is deliberately credential-free (every function takes an
// explicit `token`), and lib/neo4j only stores the *encrypted* PAT. This
// module is the one place that joins the two: read the Settings singleton,
// decrypt the PAT with lib/crypto, parse owner/repo out of the stored GitHub
// URL, and call the matching lib/github function.
//
// Shared by the API route handlers and the server components that render the
// Branches / Pull Requests tabs, so those pages don't have to HTTP-fetch
// their own API (which would need an absolute URL and a second round trip).

import { decrypt } from "@/lib/crypto";
import { GitHubApiError, listBranches, listPullRequests } from "@/lib/github";
import type {
  Branch,
  PullRequestListState,
  PullRequestSummary,
  RateLimitInfo,
} from "@/lib/github";
import { getSettings } from "@/lib/neo4j";
import type { RepoRecord } from "@/lib/neo4j";
import { listLocalBranches } from "./local-git";

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/**
 * Parses `owner`/`repo` out of a stored GitHub URL. Accepts the shapes a user
 * realistically pastes into the "add repo" dialog:
 * `https://github.com/o/r`, `.../o/r.git`, a trailing slash, a deep link
 * (`.../o/r/tree/main`), and the SSH form `git@github.com:o/r.git`.
 */
export function parseGitHubUrl(url: string): GitHubRepoRef | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // SSH form: git@host:owner/repo(.git)
  const sshMatch = /^[\w.-]+@[\w.-]+:(.+)$/.exec(trimmed);
  const pathname = sshMatch
    ? sshMatch[1]
    : (() => {
        try {
          return new URL(
            trimmed.includes("://") ? trimmed : `https://${trimmed}`
          ).pathname;
        } catch {
          return null;
        }
      })();

  if (!pathname) return null;

  const segments = pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** Canonical `https://github.com/<owner>/<repo>.git` remote for cloning. */
export function gitHubCloneUrl(ref: GitHubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}.git`;
}

/**
 * The decrypted GitHub PAT from the Settings singleton, or `null` when none
 * is configured (or when it can't be decrypted — e.g. `SESSION_SECRET`
 * changed since it was saved). Never logged, never returned to a client.
 */
export async function getStoredGitHubToken(): Promise<string | null> {
  const settings = await getSettings();
  const encrypted = settings?.githubPatEncrypted;
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch {
    console.warn(
      "[github-access] stored GitHub PAT could not be decrypted — has SESSION_SECRET changed? Re-enter it in Settings."
    );
    return null;
  }
}

/** Why a repo can't be talked to over the GitHub API right now. */
export type GitHubUnavailableReason =
  /** `provider === "local"` and no GitHub URL on file — §4's "not linked to GitHub" state. */
  | "not_linked"
  /** A URL is stored but owner/repo couldn't be parsed out of it. */
  | "invalid_url"
  /** No PAT saved in Settings yet (decision #7). */
  | "no_token";

export type GitHubAccess =
  | { ok: true; ref: GitHubRepoRef; token: string }
  | { ok: false; reason: GitHubUnavailableReason };

/** Resolves everything needed for a GitHub call against this repo: owner/repo + a decrypted PAT. */
export async function resolveGitHubAccess(
  repo: Pick<RepoRecord, "provider" | "url">
): Promise<GitHubAccess> {
  if (repo.provider !== "github" || !repo.url) {
    return { ok: false, reason: "not_linked" };
  }
  const ref = parseGitHubUrl(repo.url);
  if (!ref) return { ok: false, reason: "invalid_url" };

  const token = await getStoredGitHubToken();
  if (!token) return { ok: false, reason: "no_token" };

  return { ok: true, ref, token };
}

/** Shared envelope for the two GitHub-backed tab endpoints. `linked: false` is the UI's "not linked to GitHub" state, not an error. */
interface GitHubListResponse {
  linked: boolean;
  reason?: GitHubUnavailableReason;
  /** Set when GitHub itself rejected/failed the call — the data is empty but the repo *is* linked. */
  error?: string;
  rateLimit: RateLimitInfo | null;
}

export interface BranchesResponse extends GitHubListResponse {
  branches: Branch[];
}

export interface PullRequestsResponse extends GitHubListResponse {
  state: PullRequestListState;
  pullRequests: PullRequestSummary[];
}

function describeGitHubError(err: unknown): string {
  if (err instanceof GitHubApiError) {
    return err.status
      ? `GitHub API error ${err.status}: ${err.message}`
      : `GitHub API error: ${err.message}`;
  }
  return err instanceof Error ? err.message : "Unknown GitHub error.";
}

/**
 * Local branches don't go through `resolveGitHubAccess` at all — a
 * `provider: "local"` repo's branches live in its own `.git` directory, so
 * no GitHub call (and no PAT) is involved. A local repo with no `localPath`
 * on file (shouldn't happen, but data can be hand-edited) falls back to the
 * same "not linked" empty state the UI already knows how to render.
 */
export async function getRepoBranches(
  repo: Pick<RepoRecord, "provider" | "url" | "localPath">
): Promise<BranchesResponse> {
  if (repo.provider === "local") {
    if (!repo.localPath) {
      return { linked: false, reason: "not_linked", branches: [], rateLimit: null };
    }
    try {
      const branches = await listLocalBranches(repo.localPath);
      return { linked: true, branches, rateLimit: null };
    } catch (err) {
      return {
        linked: true,
        error: err instanceof Error ? err.message : String(err),
        branches: [],
        rateLimit: null,
      };
    }
  }

  const access = await resolveGitHubAccess(repo);
  if (!access.ok) {
    return { linked: false, reason: access.reason, branches: [], rateLimit: null };
  }
  try {
    const { data, rateLimit } = await listBranches(
      access.token,
      access.ref.owner,
      access.ref.repo
    );
    return { linked: true, branches: data, rateLimit };
  } catch (err) {
    return {
      linked: true,
      error: describeGitHubError(err),
      branches: [],
      rateLimit: null,
    };
  }
}

export async function getRepoPullRequests(
  repo: Pick<RepoRecord, "provider" | "url">,
  state: PullRequestListState = "open"
): Promise<PullRequestsResponse> {
  const access = await resolveGitHubAccess(repo);
  if (!access.ok) {
    return {
      linked: false,
      reason: access.reason,
      state,
      pullRequests: [],
      rateLimit: null,
    };
  }
  try {
    const { data, rateLimit } = await listPullRequests(
      access.token,
      access.ref.owner,
      access.ref.repo,
      state
    );
    return { linked: true, state, pullRequests: data, rateLimit };
  } catch (err) {
    return {
      linked: true,
      error: describeGitHubError(err),
      state,
      pullRequests: [],
      rateLimit: null,
    };
  }
}
