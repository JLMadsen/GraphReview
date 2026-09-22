// GitHub API wrapper — §8 of docs/DESIGN.md.
//
// Fully self-contained: every function takes the PAT as an explicit `token`
// parameter. Nothing here reads settings, decrypts credentials, or touches
// Neo4j — that wiring ("read the stored token, decrypt it, pass it in")
// belongs to a caller in a later integration step.
//
// REST calls go through `@octokit/rest`; the one GraphQL-only need (linked
// issues via `closingIssuesReferences`) goes through `@octokit/graphql`.

import { Octokit } from "@octokit/rest";
import type { OctokitResponse } from "@octokit/types";
import { graphql } from "@octokit/graphql";
import { GitHubApiError, toGitHubApiError } from "./errors";
import type {
  Branch,
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

function createOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

/** Reads `x-ratelimit-*` response headers (§8). Returns `null` when a response carries none (e.g. GraphQL, or a mocked/proxied response). */
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
  mapItem: (item: Item) => T
): Promise<GitHubResult<T[]>> {
  try {
    let rateLimit: RateLimitInfo | null = null;
    const items: Item[] = await octokit.paginate(
      request,
      { per_page: DEFAULT_PER_PAGE, ...params },
      (response: OctokitResponse<Item[]>) => {
        rateLimit = extractRateLimit(response.headers as unknown as Record<string, unknown>) ?? rateLimit;
        return response.data;
      }
    );
    return { data: items.map(mapItem), rateLimit };
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

/** Repos the authenticated user has access to — for a repo-picker UI when adding a repo (§4, §8). */
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
  state: PullRequestListState = "open"
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
    })
  );
}

/** Title, body, base/head SHA, author, state, url (§8) for a single PR. */
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

/** Per-file unified diffs for a PR, via `GET /repos/{owner}/{repo}/pulls/{pull_number}/files` — `patch` text comes straight from GitHub, no separate diffing step (§8). */
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
 * `GET /repos/{owner}/{repo}/compare/{base}...{head}` (§8, decision #4).
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
 * `closingIssuesReferences` — reliably available only via GraphQL (§8).
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
