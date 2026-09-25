// The per-tab dispatch shared by the Branches and Pull-Requests-or-Merge-
// Requests API routes and server pages: given a `(:Repo)` record, fetch its
// branch/PR(MR) list from whichever source applies — local `.git`, the
// GitHub API, or the GitLab API — and hand back one envelope shape the UI
// already knows how to render regardless of which provider produced it.
//
// Moved out of github-access.ts (which used to own both functions) so each
// provider module (github-access.ts, gitlab-access.ts) stays single-purpose
// and symmetric; this is the one place that fans out across all three.

import { listBranches as listGitHubBranches, listCommits as listGitHubCommits, listPullRequests } from "@/lib/github";
import type { Branch, CommitSummary, PullRequestListState, PullRequestSummary, RateLimitInfo } from "@/lib/github";
import { listBranches as listGitLabBranches, listCommits as listGitLabCommits, listMergeRequests } from "@/lib/gitlab";
import type { RepoRecord } from "@/lib/neo4j";
import { describeGitHubError, resolveGitHubAccess, type GitHubUnavailableReason } from "./github-access";
import { describeGitLabError, resolveGitLabAccess, type GitLabUnavailableReason } from "./gitlab-access";
import { listLocalBranches, listLocalCommits } from "./local-git";

export type RepoAccessUnavailableReason = GitHubUnavailableReason | GitLabUnavailableReason;

/** Shared envelope for the two provider-backed tab endpoints. `linked: false` is the UI's "not linked" state, not an error. */
interface RepoListResponse {
  linked: boolean;
  reason?: RepoAccessUnavailableReason;
  /** Set when the provider itself rejected/failed the call — the data is empty but the repo *is* linked. */
  error?: string;
  rateLimit: RateLimitInfo | null;
}

export interface BranchesResponse extends RepoListResponse {
  branches: Branch[];
}

export interface PullRequestsResponse extends RepoListResponse {
  state: PullRequestListState;
  pullRequests: PullRequestSummary[];
}

export interface CommitsResponse extends RepoListResponse {
  /** The ref that was listed; `""` for the host's default branch. */
  ref: string;
  commits: CommitSummary[];
}

/**
 * The newest commits of one branch (or any ref), newest first — the commit
 * picker behind "compare two commits". Same three-way dispatch and
 * `linked`/`error` envelope as branches.
 *
 * With no `ref`, the *host's* default branch is used (GitHub/GitLab resolve
 * it when the branch is omitted; locally it's `HEAD`) rather than the
 * `defaultBranch` stored on the repo, which can be out of date.
 */
export async function getRepoCommits(
  repo: Pick<RepoRecord, "provider" | "url" | "localPath">,
  ref: string | undefined,
  limit = 50
): Promise<CommitsResponse> {
  const empty = { ref: ref ?? "", commits: [], rateLimit: null };
  if (repo.provider === "local") {
    if (!repo.localPath) return { linked: false, reason: "not_linked", ...empty };
    try {
      return {
        linked: true,
        ref: ref ?? "HEAD",
        commits: await listLocalCommits(repo.localPath, ref ?? "HEAD", limit),
        rateLimit: null,
      };
    } catch (err) {
      return { linked: true, error: err instanceof Error ? err.message : String(err), ...empty };
    }
  }

  if (repo.provider === "gitlab") {
    const access = await resolveGitLabAccess(repo);
    if (!access.ok) return { linked: false, reason: access.reason, ...empty };
    try {
      const { data, rateLimit } = await listGitLabCommits(access.token, access.ref.path, ref, limit);
      return { linked: true, ref: ref ?? "", commits: data, rateLimit };
    } catch (err) {
      return { linked: true, error: describeGitLabError(err), ...empty };
    }
  }

  const access = await resolveGitHubAccess(repo);
  if (!access.ok) return { linked: false, reason: access.reason, ...empty };
  try {
    const { data, rateLimit } = await listGitHubCommits(access.token, access.ref.owner, access.ref.repo, ref, limit);
    return { linked: true, ref: ref ?? "", commits: data, rateLimit };
  } catch (err) {
    return { linked: true, error: describeGitHubError(err), ...empty };
  }
}

/**
 * Local branches don't go through either provider's access resolver at all —
 * a `provider: "local"` repo's branches live in its own `.git` directory, so
 * no API call (and no PAT) is involved. A local repo with no `localPath` on
 * file (shouldn't happen, but data can be hand-edited) falls back to the
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

  if (repo.provider === "gitlab") {
    const access = await resolveGitLabAccess(repo);
    if (!access.ok) {
      return { linked: false, reason: access.reason, branches: [], rateLimit: null };
    }
    try {
      const { data, rateLimit } = await listGitLabBranches(access.token, access.ref.path);
      return { linked: true, branches: data, rateLimit };
    } catch (err) {
      return { linked: true, error: describeGitLabError(err), branches: [], rateLimit: null };
    }
  }

  const access = await resolveGitHubAccess(repo);
  if (!access.ok) {
    return { linked: false, reason: access.reason, branches: [], rateLimit: null };
  }
  try {
    const { data, rateLimit } = await listGitHubBranches(access.token, access.ref.owner, access.ref.repo);
    return { linked: true, branches: data, rateLimit };
  } catch (err) {
    return { linked: true, error: describeGitHubError(err), branches: [], rateLimit: null };
  }
}

/** Pull/merge requests are a GitHub-or-GitLab-only concept — a local repo always gets the "not linked" empty state. */
export async function getRepoPullRequests(
  repo: Pick<RepoRecord, "provider" | "url">,
  state: PullRequestListState = "open",
  /** Most recently updated first; omit for the whole list. */
  limit?: number
): Promise<PullRequestsResponse> {
  if (repo.provider === "gitlab") {
    const access = await resolveGitLabAccess(repo);
    if (!access.ok) {
      return { linked: false, reason: access.reason, state, pullRequests: [], rateLimit: null };
    }
    try {
      const { data, rateLimit } = await listMergeRequests(access.token, access.ref.path, state, limit);
      return { linked: true, state, pullRequests: data, rateLimit };
    } catch (err) {
      return { linked: true, error: describeGitLabError(err), state, pullRequests: [], rateLimit: null };
    }
  }

  const access = await resolveGitHubAccess(repo);
  if (!access.ok) {
    return { linked: false, reason: access.reason, state, pullRequests: [], rateLimit: null };
  }
  try {
    const { data, rateLimit } = await listPullRequests(access.token, access.ref.owner, access.ref.repo, state, limit);
    return { linked: true, state, pullRequests: data, rateLimit };
  } catch (err) {
    return { linked: true, error: describeGitHubError(err), state, pullRequests: [], rateLimit: null };
  }
}
