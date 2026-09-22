// Bridge between a stored `(:Repo)` record and lib/github.
//
// lib/github is deliberately credential-free (every function takes an
// explicit `token`), and lib/neo4j only stores the *encrypted* PAT. This
// module is the one place that joins the two: read the Settings singleton,
// decrypt the PAT with lib/crypto, parse owner/repo out of the stored GitHub
// URL, and call the matching lib/github function.
//
// getRepoBranches/getRepoPullRequests (the actual per-tab dispatch across
// local/GitHub/GitLab) live in ./repo-access.ts, not here — this module only
// exports the GitHub-specific pieces that repo-access.ts (and the
// diff-impact routes) call into, mirroring gitlab-access.ts's shape.

import { decrypt } from "@/lib/crypto";
import { GitHubApiError } from "@/lib/github";
import { getSettings } from "@/lib/neo4j";
import type { RepoRecord } from "@/lib/neo4j";

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

/**
 * The GitHub *web* host — used for the clone URL and the repo URL stored/
 * displayed in the UI. Distinct from `GITHUB_API_URL` (lib/github/client.ts)
 * because a GitHub Enterprise Server instance's web host and API host differ
 * (`https://host` vs `https://host/api/v3`). Defaults to `https://github.com`;
 * override via `GITHUB_WEB_URL` on a closed network — see
 * `docker/.env.example`. Trailing slashes are stripped so the templates
 * below don't end up with a doubled `//`.
 */
const GITHUB_WEB_URL = (process.env.GITHUB_WEB_URL || "https://github.com").replace(/\/+$/, "");

/** Canonical `<GITHUB_WEB_URL>/<owner>/<repo>.git` remote for cloning. */
export function gitHubCloneUrl(ref: GitHubRepoRef): string {
  return `${GITHUB_WEB_URL}/${ref.owner}/${ref.repo}.git`;
}

/** Canonical `<GITHUB_WEB_URL>/<owner>/<repo>` page URL — what gets stored on `(:Repo).url` and shown in the UI. */
export function gitHubRepoWebUrl(ref: GitHubRepoRef): string {
  return `${GITHUB_WEB_URL}/${ref.owner}/${ref.repo}`;
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
  /** `provider === "local"` and no GitHub URL on file — the "not linked to GitHub" state. */
  | "not_linked"
  /** A URL is stored but owner/repo couldn't be parsed out of it. */
  | "invalid_url"
  /** No PAT saved in Settings yet. */
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

/** Turns any error from a `lib/github` call into a short human-readable string — shared by ./repo-access.ts. */
export function describeGitHubError(err: unknown): string {
  if (err instanceof GitHubApiError) {
    return err.status
      ? `GitHub API error ${err.status}: ${err.message}`
      : `GitHub API error: ${err.message}`;
  }
  return err instanceof Error ? err.message : "Unknown GitHub error.";
}
