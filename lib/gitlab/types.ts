// Public return types for lib/gitlab. Deliberately reuses the same trimmed,
// stable shapes as lib/github/types.ts wherever a concept means the same
// thing regardless of git host (a branch, a "pull request"-shaped review
// target, a changed file, a linked issue) — a GitLab merge request is
// mapped onto these exact shapes in client.ts, so downstream code
// (lib/jobs/review.ts, review-freshness.ts, the API routes) never needs to
// know which host produced them. Only what's genuinely GitLab-specific
// lives here.

export type {
  RateLimitInfo,
  Branch,
  CommitSummary,
  PullRequestListState,
  PullRequestState,
  PullRequestSummary,
  PullRequestDetail,
  PullRequestFileStatus,
  PullRequestFile,
  RefComparison,
  LinkedIssue,
} from "@/lib/github/types";

import type { RateLimitInfo } from "@/lib/github/types";

/**
 * Every REST-backed function returns its data wrapped like this instead of
 * bare, matching `GitHubResult` in lib/github/types.ts — see that type's
 * doc comment for why (surfacing rate-limit info safely under concurrent
 * callers).
 */
export interface GitLabResult<T> {
  data: T;
  rateLimit: RateLimitInfo | null;
}
