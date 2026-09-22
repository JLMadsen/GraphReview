// Public return types for lib/github. These are deliberately trimmed,
// stable shapes rather than raw Octokit response types — see §8/§7 of
// docs/DESIGN.md. Downstream code (lib/neo4j repository functions, route
// handlers) should depend on these, not on `@octokit/*` types directly.

/** REST rate-limit info read from `x-ratelimit-*` response headers (§8: "REST rate-limit headers are surfaced in the UI"). */
export interface RateLimitInfo {
  /** Max requests allowed in the current window (`x-ratelimit-limit`). */
  limit: number;
  /** Requests left in the current window (`x-ratelimit-remaining`). */
  remaining: number;
  /** Unix timestamp (seconds) when the window resets (`x-ratelimit-reset`), when present. */
  reset?: number;
  /** Requests used in the current window (`x-ratelimit-used`), when present. */
  used?: number;
}

/**
 * Every REST-backed function returns its data wrapped like this instead of
 * bare, so a caller can surface rate-limit info without a separate
 * out-of-band "last call" accessor (which would be unsafe under concurrent
 * calls from BullMQ workers using different tokens/repos at once — see §3,
 * §12). GraphQL calls set `rateLimit: null`: `@octokit/graphql` does not
 * expose REST-style rate-limit headers on success responses.
 */
export interface GitHubResult<T> {
  data: T;
  rateLimit: RateLimitInfo | null;
}

/** A repo the authenticated user has access to — for a repo-picker UI when adding a repo (§4). */
export interface RepoSummary {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  description: string | null;
  updatedAt: string | null;
}

export interface Branch {
  name: string;
  commitSha: string;
  protected: boolean;
}

/** `state` filter accepted by GitHub's `GET /repos/{owner}/{repo}/pulls`. */
export type PullRequestListState = "open" | "closed" | "all";

/**
 * A pull request's actual state, as GraphReview models it — note this is
 * `"open" | "closed" | "merged"`, not GitHub REST's raw two-value `state`
 * field, matching the open/closed/merged filter described in §4 and the
 * `PullRequest.state` property in §7. Derived from GitHub's `state` +
 * `merged_at`.
 */
export type PullRequestState = "open" | "closed" | "merged";

export interface PullRequestSummary {
  number: number;
  title: string;
  state: PullRequestState;
  draft: boolean;
  author: string | null;
  baseRef: string;
  headRef: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

/** Full PR detail: title, body, base/head SHA, author, state, url (§8). */
export interface PullRequestDetail extends PullRequestSummary {
  body: string | null;
  baseSha: string;
  headSha: string;
}

export type PullRequestFileStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

/**
 * One changed file, including the unified-diff `patch` text GitHub computes
 * for us directly (§8/§9 — "no separate diff-parsing step needed"). `patch`
 * is absent for files GitHub doesn't generate a text diff for (binary files,
 * or diffs too large — GitHub omits the field in those cases).
 */
export interface PullRequestFile {
  filename: string;
  previousFilename?: string;
  status: PullRequestFileStatus;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

/**
 * Result of an ad-hoc `base...head` ref comparison (§8), not tied to a PR.
 * Shared with `lib/gitlab` (re-exported from there), since a ref comparison
 * means the same thing regardless of git host.
 */
export interface RefComparison {
  baseSha: string;
  headSha: string;
  /**
   * Absent when the host doesn't cheaply expose the true merge-base of an
   * arbitrary pair of refs (e.g. GitLab's compare endpoint doesn't return
   * one) — always present for GitHub. Not read anywhere downstream today,
   * so this is safe to leave unset.
   */
  mergeBaseSha?: string;
  status: "diverged" | "ahead" | "behind" | "identical";
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  files: PullRequestFile[];
  /** Absent for hosts whose compare API doesn't hand back a web URL directly (e.g. GitLab) — not read anywhere downstream today. */
  htmlUrl?: string;
}

/** An issue GitHub resolved as "closed by" a PR, via GraphQL `closingIssuesReferences` (§8 — GraphQL-only). */
export interface LinkedIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
}
