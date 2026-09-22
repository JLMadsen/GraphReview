// Bridge between a stored `(:Repo)` record and lib/gitlab — the GitLab
// counterpart to github-access.ts (see that module's header comment for the
// general shape this mirrors: lib/gitlab is credential-free, this module
// joins it to the decrypted PAT and the repo's stored URL).
//
// getRepoBranches/getRepoPullRequests (the actual per-tab dispatch) live in
// ./repo-access.ts, not here — this module only exports the GitLab-specific
// pieces that repo-access.ts (and the diff-impact routes) call into.

import { decrypt } from "@/lib/crypto";
import { GitLabApiError } from "@/lib/gitlab";
import { getSettings } from "@/lib/neo4j";
import type { RepoRecord } from "@/lib/neo4j";

export interface GitLabProjectRef {
  /**
   * Full namespace path, e.g. `"group/subgroup/project"` — GitLab supports
   * arbitrarily nested subgroups, unlike GitHub's fixed owner/repo split, so
   * this is kept as one path rather than split into parts. Used both as the
   * GitLab API "project id" (URL-encoded, see lib/gitlab/client.ts) and to
   * build clone/web URLs.
   */
  path: string;
}

/**
 * Parses a GitLab project path out of a stored URL. Accepts the shapes a
 * user realistically pastes: `https://gitlab.com/group/project`,
 * `.../group/subgroup/project`, a trailing slash, `.git` suffix, a deep
 * link (`.../group/project/-/tree/main` — GitLab separates a project's own
 * path from any sub-page with `/-/`), and the SSH form
 * `git@gitlab.com:group/project.git`.
 */
export function parseGitLabUrl(url: string): GitLabProjectRef | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // SSH form: git@host:group/project(.git)
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

  // Anything from "/-/" onward is a sub-page (tree, merge_requests, etc.),
  // not part of the project's own path.
  const projectPathname = pathname.split("/-/")[0];

  const segments = projectPathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 2) return null;

  const last = segments[segments.length - 1].replace(/\.git$/i, "");
  if (!last) return null;

  const path = [...segments.slice(0, -1), last].join("/");
  return { path };
}

/**
 * The GitLab *web* host — used for the clone URL and the repo URL stored/
 * displayed in the UI. Distinct from `GITLAB_API_URL` (lib/gitlab/client.ts)
 * because a self-hosted instance's web host and API host can diverge.
 * Defaults to `https://gitlab.com`; override via `GITLAB_WEB_URL` — see
 * `docker/.env.example`.
 */
const GITLAB_WEB_URL = (process.env.GITLAB_WEB_URL || "https://gitlab.com").replace(/\/+$/, "");

/** Canonical `<GITLAB_WEB_URL>/<path>.git` remote for cloning. */
export function gitLabCloneUrl(ref: GitLabProjectRef): string {
  return `${GITLAB_WEB_URL}/${ref.path}.git`;
}

/** Canonical `<GITLAB_WEB_URL>/<path>` page URL — what gets stored on `(:Repo).url` and shown in the UI. */
export function gitLabRepoWebUrl(ref: GitLabProjectRef): string {
  return `${GITLAB_WEB_URL}/${ref.path}`;
}

/**
 * The decrypted GitLab PAT from the Settings singleton, or `null` when none
 * is configured (or when it can't be decrypted — e.g. `SESSION_SECRET`
 * changed since it was saved). Never logged, never returned to a client.
 */
export async function getStoredGitLabToken(): Promise<string | null> {
  const settings = await getSettings();
  const encrypted = settings?.gitlabPatEncrypted;
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch {
    console.warn(
      "[gitlab-access] stored GitLab PAT could not be decrypted — has SESSION_SECRET changed? Re-enter it in Settings."
    );
    return null;
  }
}

/** Why a repo can't be talked to over the GitLab API right now. */
export type GitLabUnavailableReason =
  /** `provider !== "gitlab"` or no GitLab URL on file. */
  | "not_linked"
  /** A URL is stored but a project path couldn't be parsed out of it. */
  | "invalid_url"
  /** No PAT saved in Settings yet. */
  | "no_token";

export type GitLabAccess =
  | { ok: true; ref: GitLabProjectRef; token: string }
  | { ok: false; reason: GitLabUnavailableReason };

/** Resolves everything needed for a GitLab call against this repo: project path + a decrypted PAT. */
export async function resolveGitLabAccess(
  repo: Pick<RepoRecord, "provider" | "url">
): Promise<GitLabAccess> {
  if (repo.provider !== "gitlab" || !repo.url) {
    return { ok: false, reason: "not_linked" };
  }
  const ref = parseGitLabUrl(repo.url);
  if (!ref) return { ok: false, reason: "invalid_url" };

  const token = await getStoredGitLabToken();
  if (!token) return { ok: false, reason: "no_token" };

  return { ok: true, ref, token };
}

/** Turns any error from a `lib/gitlab` call into a short human-readable string — shared by ./repo-access.ts. */
export function describeGitLabError(err: unknown): string {
  if (err instanceof GitLabApiError) {
    return err.status
      ? `GitLab API error ${err.status}: ${err.message}`
      : `GitLab API error: ${err.message}`;
  }
  return err instanceof Error ? err.message : "Unknown GitLab error.";
}
