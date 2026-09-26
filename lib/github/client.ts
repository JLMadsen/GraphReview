// GitHub API wrapper.
//
// Fully self-contained: every function takes the PAT as an explicit `token`
// parameter. Nothing here reads settings, decrypts credentials, or touches
// Neo4j — that wiring ("read the stored token, decrypt it, pass it in")
// belongs to a caller in a later integration step.
//
// REST calls go through `@octokit/rest`; the one GraphQL-only need (linked
// issues via `closingIssuesReferences`) goes through `@octokit/graphql`.
//
// The API host itself is overridable via `GITHUB_API_URL` (GitHub
// Enterprise Server, or an internal mirror on a closed network) — see
// `GITHUB_API_BASE_URL` below and `docker/.env.example`.

import { Octokit } from "@octokit/rest";
import type { OctokitResponse } from "@octokit/types";
import { graphql } from "@octokit/graphql";
import { GitHubApiError, toGitHubApiError } from "./errors";
import type {
  Branch,
  CiCheck,
  CiState,
  CiStatus,
  CommitSummary,
  GitHubResult,
  LinkedIssue,
  PullRequestDetail,
  PullRequestFile,
  PullRequestListState,
  PullRequestState,
  PullRequestSummary,
  RateLimitInfo,
  RefComparison,
  RepoSummary,
} from "./types";

const DEFAULT_PER_PAGE = 100;

/**
 * REST/GraphQL base URL override, e.g. for a GitHub Enterprise Server
 * instance or an internal mirror on a closed network
 * (`https://github.example.com/api/v3`). Unset means "use Octokit's
 * built-in default" (`https://api.github.com`) — see `docker/.env.example`.
 * Read once at module load rather than per-call since it's a deployment-time
 * constant, not something that changes while the process is running.
 */
const GITHUB_API_BASE_URL = process.env.GITHUB_API_URL || undefined;

function createOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    ...(GITHUB_API_BASE_URL ? { baseUrl: GITHUB_API_BASE_URL } : {}),
  });
}

/** Reads `x-ratelimit-*` response headers. Returns `null` when a response carries none (e.g. GraphQL, or a mocked/proxied response). */
function extractRateLimit(headers: Record<string, unknown> | undefined): RateLimitInfo | null {
  if (!headers) return null;
  const limitRaw = headers["x-ratelimit-limit"];
  const remainingRaw = headers["x-ratelimit-remaining"];
  if (limitRaw === undefined || remainingRaw === undefined) return null;

  const limit = Number(limitRaw);
  const remaining = Number(remainingRaw);
  if (Number.isNaN(limit) || Number.isNaN(remaining)) return null;

  const resetRaw = headers["x-ratelimit-reset"];
  const usedRaw = headers["x-ratelimit-used"];
  const reset = resetRaw !== undefined ? Number(resetRaw) : undefined;
  const used = usedRaw !== undefined ? Number(usedRaw) : undefined;

  return {
    limit,
    remaining,
    reset: reset !== undefined && !Number.isNaN(reset) ? reset : undefined,
    used: used !== undefined && !Number.isNaN(used) ? used : undefined,
  };
}

/** Runs a single (non-paginated) REST call and wraps its result with rate-limit info, or rethrows a {@link GitHubApiError} tagged with `endpoint`. */
async function runRest<T>(
  endpoint: string,
  fn: () => Promise<OctokitResponse<T>>
): Promise<GitHubResult<T>> {
  try {
    const response = await fn();
    return { data: response.data, rateLimit: extractRateLimit(response.headers) };
  } catch (err) {
    throw toGitHubApiError(err, endpoint);
  }
}

/**
 * Runs a paginated REST `list*` call to exhaustion via Octokit's built-in
 * pagination (follows the `Link` header), mapping each page's items to `T`.
 * Rate-limit info reflects the *last* page fetched.
 *
 * `request` is intentionally untyped: `octokit.paginate`'s overloads are
 * built to be called with a *concrete* bound REST method (so TS can infer
 * the route from it directly), not passed through a further generic helper
 * like this one — routing it through a type parameter defeats that
 * inference. The public functions below stay fully typed regardless, since
 * `Item`/`T` are pinned by each call site's explicit type arguments and
 * `mapItem`'s signature.
 */
async function runPaginated<Item, T>(
  endpoint: string,
  octokit: Octokit,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: any,
  params: Record<string, unknown>,
  mapItem: (item: Item) => T,
  /** Stop paging once this many items are in (the list is still sorted server-side). */
  maxItems?: number
): Promise<GitHubResult<T[]>> {
  try {
    let rateLimit: RateLimitInfo | null = null;
    let seen = 0;
    const items: Item[] = await octokit.paginate(
      request,
      { per_page: DEFAULT_PER_PAGE, ...params },
      (response: OctokitResponse<Item[]>, done: () => void) => {
        rateLimit = extractRateLimit(response.headers as unknown as Record<string, unknown>) ?? rateLimit;
        seen += response.data.length;
        if (maxItems !== undefined && seen >= maxItems) done();
        return response.data;
      }
    );
    const kept = maxItems !== undefined ? items.slice(0, maxItems) : items;
    return { data: kept.map(mapItem), rateLimit };
  } catch (err) {
    throw toGitHubApiError(err, endpoint);
  }
}

function toPullRequestState(rawState: string, mergedAt: string | null): PullRequestState {
  if (mergedAt) return "merged";
  return rawState === "closed" ? "closed" : "open";
}

// ---------------------------------------------------------------------------
// Repos & branches
// ---------------------------------------------------------------------------

/** Repos the authenticated user has access to — for a repo-picker UI when adding a repo. */
export async function listUserRepos(token: string): Promise<GitHubResult<RepoSummary[]>> {
  const octokit = createOctokit(token);
  return runPaginated<
    Awaited<ReturnType<Octokit["rest"]["repos"]["listForAuthenticatedUser"]>>["data"][number],
    RepoSummary
  >(
    "GET /user/repos",
    octokit,
    octokit.rest.repos.listForAuthenticatedUser,
    { sort: "updated", affiliation: "owner,collaborator,organization_member" },
    (repo) => ({
      id: repo.id,
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch,
      htmlUrl: repo.html_url,
      description: repo.description,
      updatedAt: repo.updated_at ?? null,
    })
  );
}

export async function listBranches(
  token: string,
  owner: string,
  repo: string
): Promise<GitHubResult<Branch[]>> {
  const octokit = createOctokit(token);
  return runPaginated<
    Awaited<ReturnType<Octokit["rest"]["repos"]["listBranches"]>>["data"][number],
    Branch
  >(
    `GET /repos/${owner}/${repo}/branches`,
    octokit,
    octokit.rest.repos.listBranches,
    { owner, repo },
    (branch) => ({
      name: branch.name,
      commitSha: branch.commit.sha,
      protected: branch.protected,
    })
  );
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export async function listPullRequests(
  token: string,
  owner: string,
  repo: string,
  state: PullRequestListState = "open",
  /** Most recently updated first; omit for every PR. */
  limit?: number
): Promise<GitHubResult<PullRequestSummary[]>> {
  const octokit = createOctokit(token);
  return runPaginated<
    Awaited<ReturnType<Octokit["rest"]["pulls"]["list"]>>["data"][number],
    PullRequestSummary
  >(
    `GET /repos/${owner}/${repo}/pulls`,
    octokit,
    octokit.rest.pulls.list,
    { owner, repo, state, sort: "updated", direction: "desc" },
    (pr) => ({
      number: pr.number,
      title: pr.title,
      state: toPullRequestState(pr.state, pr.merged_at ?? null),
      draft: pr.draft ?? false,
      author: pr.user?.login ?? null,
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      url: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
    }),
    limit
  );
}

/** The newest `limit` commits reachable from `ref` (a branch name or sha; omitted = the repo's default branch as GitHub knows it), newest first. One page — `limit` is capped at 100. */
export async function listCommits(
  token: string,
  owner: string,
  repo: string,
  ref: string | undefined,
  limit = 50
): Promise<GitHubResult<CommitSummary[]>> {
  const octokit = createOctokit(token);
  const endpoint = `GET /repos/${owner}/${repo}/commits${ref ? `?sha=${ref}` : ""}`;
  const { data, rateLimit } = await runRest(endpoint, () =>
    octokit.rest.repos.listCommits({
      owner,
      repo,
      ...(ref ? { sha: ref } : {}),
      per_page: Math.min(100, Math.max(1, limit)),
    })
  );
  return {
    data: data.map((commit) => ({
      sha: commit.sha,
      subject: (commit.commit.message ?? "").split("\n")[0].trim(),
      author: commit.author?.login ?? commit.commit.author?.name ?? null,
      date: commit.commit.author?.date ?? commit.commit.committer?.date ?? "",
      parents: commit.parents.map((parent) => parent.sha),
    })),
    rateLimit,
  };
}

/** Title, body, base/head SHA, author, state, url for a single PR. */
export async function getPullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number
): Promise<GitHubResult<PullRequestDetail>> {
  const octokit = createOctokit(token);
  const endpoint = `GET /repos/${owner}/${repo}/pulls/${number}`;
  const { data: pr, rateLimit } = await runRest(endpoint, () =>
    octokit.rest.pulls.get({ owner, repo, pull_number: number })
  );

  return {
    data: {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: toPullRequestState(pr.state, pr.merged_at ?? null),
      draft: pr.draft ?? false,
      author: pr.user?.login ?? null,
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      url: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
    },
    rateLimit,
  };
}

/** Per-file unified diffs for a PR, via `GET /repos/{owner}/{repo}/pulls/{pull_number}/files` — `patch` text comes straight from GitHub, no separate diffing step. */
export async function listPullRequestFiles(
  token: string,
  owner: string,
  repo: string,
  number: number
): Promise<GitHubResult<PullRequestFile[]>> {
  const octokit = createOctokit(token);
  return runPaginated<
    Awaited<ReturnType<Octokit["rest"]["pulls"]["listFiles"]>>["data"][number],
    PullRequestFile
  >(
    `GET /repos/${owner}/${repo}/pulls/${number}/files`,
    octokit,
    octokit.rest.pulls.listFiles,
    { owner, repo, pull_number: number },
    (file) => ({
      filename: file.filename,
      previousFilename: file.previous_filename,
      status: file.status as PullRequestFile["status"],
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: file.patch,
    })
  );
}

// ---------------------------------------------------------------------------
// Ad-hoc ref comparison
// ---------------------------------------------------------------------------

/**
 * Ad-hoc ref-to-ref comparison (not tied to a PR), via
 * `GET /repos/{owner}/{repo}/compare/{base}...{head}`.
 *
 * The compare API's response has a `base_commit` but no dedicated "head
 * commit" field (its `commits` array only lists commits ahead of `base`,
 * which is empty when `head` is behind or identical to `base`) — so
 * `headSha` is resolved with one extra, reliable call to
 * `GET /repos/{owner}/{repo}/commits/{head}` rather than guessed from that
 * array.
 */
export async function compareRefs(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<GitHubResult<RefComparison>> {
  const octokit = createOctokit(token);

  const compareEndpoint = `GET /repos/${owner}/${repo}/compare/${base}...${head}`;
  const { data: comparison, rateLimit: compareRateLimit } = await runRest(compareEndpoint, () =>
    octokit.rest.repos.compareCommits({ owner, repo, base, head })
  );

  const headEndpoint = `GET /repos/${owner}/${repo}/commits/${head}`;
  const { data: headCommit, rateLimit: headRateLimit } = await runRest(headEndpoint, () =>
    octokit.rest.repos.getCommit({ owner, repo, ref: head })
  );

  return {
    data: {
      baseSha: comparison.base_commit.sha,
      headSha: headCommit.sha,
      mergeBaseSha: comparison.merge_base_commit.sha,
      status: comparison.status,
      aheadBy: comparison.ahead_by,
      behindBy: comparison.behind_by,
      totalCommits: comparison.total_commits,
      files: (comparison.files ?? []).map((file) => ({
        filename: file.filename,
        previousFilename: file.previous_filename,
        status: file.status as PullRequestFile["status"],
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: file.patch,
      })),
      htmlUrl: comparison.html_url,
    },
    // Prefer the most recent call's rate-limit snapshot.
    rateLimit: headRateLimit ?? compareRateLimit,
  };
}

/**
 * The commit sha a ref (branch, tag or sha) currently points at — and nothing
 * else — via `GET /repos/{owner}/{repo}/commits/{ref}` with the
 * `application/vnd.github.sha` media type, which makes GitHub answer with the
 * bare 40-hex sha instead of the full commit + file payload. This is what the
 * stale-review check polls (one call per ref), so it must stay light.
 *
 * Throws {@link GitHubApiError}: `status` 404/422 means the ref doesn't exist
 * (GitHub answers 422 "No commit found for SHA" for an unknown branch name).
 */
export async function getRefSha(
  token: string,
  owner: string,
  repo: string,
  ref: string
): Promise<GitHubResult<string>> {
  const octokit = createOctokit(token);
  const endpoint = `GET /repos/${owner}/${repo}/commits/${ref}`;
  const { data, rateLimit } = await runRest<unknown>(endpoint, () =>
    octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner,
      repo,
      ref,
      headers: { accept: "application/vnd.github.sha" },
    }) as Promise<OctokitResponse<unknown>>
  );

  // Depending on the response's Content-Type, Octokit hands the body back as
  // text, as raw bytes, or (if GitHub ever ignores the media type) as the
  // usual commit JSON — accept all three rather than trusting one.
  let sha: string | undefined;
  if (typeof data === "string") {
    sha = data;
  } else if (data instanceof ArrayBuffer) {
    sha = new TextDecoder().decode(data);
  } else if (ArrayBuffer.isView(data)) {
    sha = new TextDecoder().decode(data);
  } else if (data && typeof data === "object" && typeof (data as { sha?: unknown }).sha === "string") {
    sha = (data as { sha: string }).sha;
  }
  sha = sha?.trim();
  if (!sha || !/^[0-9a-f]{40,64}$/i.test(sha)) {
    throw new GitHubApiError(`GitHub returned no commit sha for "${ref}" (${endpoint}).`, {
      status: 0,
      endpoint,
    });
  }
  return { data: sha.toLowerCase(), rateLimit };
}

// ---------------------------------------------------------------------------
// Linked issues (GraphQL-only)
// ---------------------------------------------------------------------------

interface LinkedIssuesQueryResponse {
  repository: {
    pullRequest: {
      closingIssuesReferences: {
        nodes: Array<{
          number: number;
          title: string;
          body: string | null;
          state: string;
          url: string;
        } | null>;
      } | null;
    } | null;
  } | null;
}

const LINKED_ISSUES_QUERY = /* GraphQL */ `
  query LinkedIssues($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 25) {
          nodes {
            number
            title
            body
            state
            url
          }
        }
      }
    }
  }
`;

/**
 * Issues GitHub resolved as "closed by" this PR, via GraphQL
 * `closingIssuesReferences` — reliably available only via GraphQL.
 * `rateLimit` is always `null`: `@octokit/graphql` doesn't surface
 * REST-style rate-limit headers on success.
 */
export async function getLinkedIssues(
  token: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<GitHubResult<LinkedIssue[]>> {
  const endpoint = `GraphQL closingIssuesReferences(${owner}/${repo}#${prNumber})`;
  try {
    const response = await graphql<LinkedIssuesQueryResponse>(LINKED_ISSUES_QUERY, {
      owner,
      repo,
      number: prNumber,
      headers: { authorization: `token ${token}` },
      // Same override as `createOctokit` above — `@octokit/graphql` detects
      // a GHES-style `/api/v3` suffix on `baseUrl` and rewrites it to
      // `/api/graphql` itself, so one env var covers both REST and GraphQL.
      ...(GITHUB_API_BASE_URL ? { baseUrl: GITHUB_API_BASE_URL } : {}),
    });

    const nodes = response.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
    const issues: LinkedIssue[] = nodes
      .filter((node): node is NonNullable<typeof node> => node !== null)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        url: issue.url,
      }));

    return { data: issues, rateLimit: null };
  } catch (err) {
    throw toGitHubApiError(err, endpoint);
  }
}

// ---------------------------------------------------------------------------
// CI status + file contents (PR checklist, PR chat)
// ---------------------------------------------------------------------------

function checkRunState(status: string, conclusion: string | null): CiState {
  if (status !== "completed") return "pending";
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") return "success";
  return "failure";
}

function commitStatusState(state: string): CiState {
  if (state === "success") return "success";
  if (state === "pending") return "pending";
  return "failure";
}

/** Folds many checks into one state: any failure fails, else any pending is pending, else success; nothing at all is `none`. */
export function combineCiStates(checks: readonly CiCheck[]): CiState {
  if (checks.length === 0) return "none";
  if (checks.some((c) => c.state === "failure")) return "failure";
  if (checks.some((c) => c.state === "pending")) return "pending";
  return "success";
}

/**
 * Every CI signal GitHub has for a commit: check runs (GitHub Actions and
 * other Checks-API apps) plus legacy commit statuses (older CI services).
 * The two APIs are independent, so both are read and merged.
 */
export async function getCommitCiStatus(
  token: string,
  owner: string,
  repo: string,
  sha: string
): Promise<GitHubResult<CiStatus>> {
  const octokit = createOctokit(token);
  const [runs, statuses] = await Promise.all([
    runRest(`GET /repos/${owner}/${repo}/commits/${sha}/check-runs`, () =>
      octokit.rest.checks.listForRef({ owner, repo, ref: sha, per_page: 100 })
    ),
    runRest(`GET /repos/${owner}/${repo}/commits/${sha}/status`, () =>
      octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha, per_page: 100 })
    ),
  ]);
  const checks: CiCheck[] = [
    ...runs.data.check_runs.map((run) => ({
      name: run.name,
      state: checkRunState(run.status, run.conclusion),
      url: run.html_url ?? undefined,
    })),
    ...statuses.data.statuses.map((status) => ({
      name: status.context,
      state: commitStatusState(status.state),
      url: status.target_url ?? undefined,
    })),
  ];
  return { data: { state: combineCiStates(checks), checks }, rateLimit: statuses.rateLimit ?? runs.rateLimit };
}

/** A file's text at a ref, or `null` when it doesn't exist there (or is a directory/binary). */
export async function getFileAtRef(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<GitHubResult<string | null>> {
  const octokit = createOctokit(token);
  const endpoint = `GET /repos/${owner}/${repo}/contents/{path}`;
  try {
    const response = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    const data = response.data as { type?: string; encoding?: string; content?: string };
    const text =
      !Array.isArray(response.data) && data.type === "file" && data.encoding === "base64" && data.content
        ? Buffer.from(data.content, "base64").toString("utf8")
        : null;
    return { data: text, rateLimit: extractRateLimit(response.headers as Record<string, unknown>) };
  } catch (err) {
    const error = toGitHubApiError(err, endpoint);
    if (error.status === 404) return { data: null, rateLimit: null };
    throw error;
  }
}
