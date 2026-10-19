// Bridge between a stored repo record and lib/github.
//
// lib/github is deliberately credential-free (every function takes an
// explicit `auth`), and lib/db only stores *encrypted* tokens. This module
// is the one place that joins the two: parse the server and owner/repo out
// of the stored GitHub URL and fetch that server's token (./git-hosts.ts,
// DESIGN.md §6.30) — github.com and each GitHub Enterprise server have
// their own.
//
// getRepoBranches/getRepoPullRequests (the actual per-tab dispatch across
// local/GitHub/GitLab) live in ./repo-access.ts, not here — this module only
// exports the GitHub-specific pieces that repo-access.ts (and the
// diff-impact routes) call into, mirroring gitlab-access.ts's shape.

import { GitHubApiError } from "@/lib/github";
import type { GitHostAuth } from "@/lib/github";
import type { RepoRecord } from "@/lib/db";
import { originOf, tokenFor } from "./git-hosts";

export interface GitHubRepoRef {
  /** The server's web origin (`https://github.com`, a GitHub Enterprise host). */
  origin: string;
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
  const origin = originOf(trimmed);
  if (!owner || !repo || !origin) return null;
  return { origin, owner, repo };
}

/** `<origin>/<owner>/<repo>.git` — the HTTPS remote for cloning. */
export function gitHubCloneUrl(ref: GitHubRepoRef): string {
  return `${ref.origin}/${ref.owner}/${ref.repo}.git`;
}

/** `<origin>/<owner>/<repo>` page URL — what gets stored on `Repo.url` and shown in the UI. */
export function gitHubRepoWebUrl(ref: GitHubRepoRef): string {
  return `${ref.origin}/${ref.owner}/${ref.repo}`;
}

/** Why a repo can't be talked to over the GitHub API right now. */
export type GitHubUnavailableReason =
  /** `provider === "local"` and no GitHub URL on file — the "not linked to GitHub" state. */
  | "not_linked"
  /** A URL is stored but owner/repo couldn't be parsed out of it. */
  | "invalid_url"
  /** No token saved in Settings for this repo's server. */
  | "no_token";

export type GitHubAccess =
  | { ok: true; ref: GitHubRepoRef; token: GitHostAuth }
  | { ok: false; reason: GitHubUnavailableReason };

/** Resolves everything needed for a GitHub call against this repo: owner/repo + its server's decrypted token and API. */
export async function resolveGitHubAccess(
  repo: Pick<RepoRecord, "provider" | "url">
): Promise<GitHubAccess> {
  if (repo.provider !== "github" || !repo.url) {
    return { ok: false, reason: "not_linked" };
  }
  const ref = parseGitHubUrl(repo.url);
  if (!ref) return { ok: false, reason: "invalid_url" };

  const saved = await tokenFor(ref.origin);
  if (!saved || saved.kind !== "github") return { ok: false, reason: "no_token" };

  return { ok: true, ref, token: saved.auth };
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
