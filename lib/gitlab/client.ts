// GitLab API wrapper — the GitLab counterpart to lib/github/client.ts.
//
// Fully self-contained: every function takes the PAT as an explicit `token`
// parameter. Nothing here reads settings, decrypts credentials, or touches
// Neo4j — that wiring belongs to lib/jobs/gitlab-access.ts, matching how
// lib/jobs/github-access.ts wires up lib/github/client.ts.
//
// Uses a plain `fetch` client against GitLab REST API v4 rather than a
// dependency like @gitbeaker/rest — GitLab's REST API is uniform JSON with
// Link-header pagination (same shape as GitHub's), simple enough not to
// need a generated SDK for the handful of endpoints this app uses.
//
// The API host is overridable via `GITLAB_API_URL` (a self-hosted GitLab
// instance, or an internal mirror) — see `GITLAB_API_BASE_URL` below and
// `docker/.env.example`. Defaults to gitlab.com.
//
// GitLab merge requests are mapped onto the exact same PullRequestSummary/
// PullRequestDetail/PullRequestFile/LinkedIssue shapes lib/github uses (see
// lib/gitlab/types.ts), so callers never need host-specific branching past
// this module.

import { GitLabApiError, toGitLabApiError, toGitLabNetworkError } from "./errors";
import type {
  Branch,
  CiCheck,
  CiState,
  CiStatus,
  CommitSummary,
  GitLabResult,
  LinkedIssue,
  PullRequestDetail,
  PullRequestFile,
  PullRequestFileStatus,
  PullRequestListState,
  PullRequestState,
  PullRequestSummary,
  RateLimitInfo,
  RefComparison,
} from "./types";

const DEFAULT_PER_PAGE = 100;

/**
 * REST base URL override for a self-hosted GitLab instance or an internal
 * mirror (`https://gitlab.example.com/api/v4`). Unset means gitlab.com.
 * Read once at module load since it's a deployment-time constant.
 */
const GITLAB_API_BASE_URL = process.env.GITLAB_API_URL || "https://gitlab.com/api/v4";

/** GitLab identifies a project by numeric ID or by its URL-encoded full path — `group/subgroup/project` becomes one path-encoded segment, which is how nested subgroups of arbitrary depth are supported. */
function projectApiBase(projectPath: string): string {
  return `${GITLAB_API_BASE_URL}/projects/${encodeURIComponent(projectPath)}`;
}

interface FetchResult {
  data: unknown;
  headers: Headers;
}

async function gitlabFetch(endpoint: string, url: string, token: string): Promise<FetchResult> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
  } catch (err) {
    throw toGitLabNetworkError(err, endpoint);
  }
  if (!response.ok) {
    throw await toGitLabApiError(response, endpoint);
  }
  try {
    const data = await response.json();
    return { data, headers: response.headers };
  } catch (err) {
    throw toGitLabNetworkError(err, endpoint);
  }
}

/** Reads GitLab's `RateLimit-*` response headers (present on gitlab.com; a self-managed instance may not send them). */
function extractRateLimit(headers: Headers): RateLimitInfo | null {
  const limitRaw = headers.get("ratelimit-limit");
  const remainingRaw = headers.get("ratelimit-remaining");
  if (limitRaw === null || remainingRaw === null) return null;

  const limit = Number(limitRaw);
  const remaining = Number(remainingRaw);
  if (Number.isNaN(limit) || Number.isNaN(remaining)) return null;

  const resetRaw = headers.get("ratelimit-reset");
  const reset = resetRaw !== null ? Number(resetRaw) : undefined;

  return {
    limit,
    remaining,
    reset: reset !== undefined && !Number.isNaN(reset) ? reset : undefined,
    used: Number.isNaN(limit - remaining) ? undefined : limit - remaining,
  };
}

/** Extracts the `rel="next"` URL from a `Link` response header, GitHub/GitLab share the same RFC 5988 format. */
function nextLinkFrom(headers: Headers): string | null {
  const link = headers.get("link");
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/** Runs a paginated GitLab `list*` call to exhaustion by following `Link: rel="next"`, mapping each page's items to `T`. Rate-limit info reflects the *last* page fetched. */
async function runPaginated<Item, T>(
  endpoint: string,
  initialUrl: string,
  token: string,
  mapItem: (item: Item) => T,
  /** Stop paging once this many items are in. */
  maxItems?: number
): Promise<GitLabResult<T[]>> {
  const items: T[] = [];
  let rateLimit: RateLimitInfo | null = null;
  let url: string | null = initialUrl;
  while (url) {
    const { data, headers } = await gitlabFetch(endpoint, url, token);
    rateLimit = extractRateLimit(headers) ?? rateLimit;
    for (const item of data as Item[]) items.push(mapItem(item));
    url = maxItems !== undefined && items.length >= maxItems ? null : nextLinkFrom(headers);
  }
  return { data: maxItems !== undefined ? items.slice(0, maxItems) : items, rateLimit };
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

interface GitLabBranch {
  name: string;
  commit: { id: string };
  protected: boolean;
}

export async function listBranches(token: string, projectPath: string): Promise<GitLabResult<Branch[]>> {
  const endpoint = "GET /projects/{id}/repository/branches";
  const url = `${projectApiBase(projectPath)}/repository/branches?per_page=${DEFAULT_PER_PAGE}`;
  return runPaginated<GitLabBranch, Branch>(endpoint, url, token, (branch) => ({
    name: branch.name,
    commitSha: branch.commit.id,
    protected: branch.protected,
  }));
}

// ---------------------------------------------------------------------------
// Merge requests
// ---------------------------------------------------------------------------

interface GitLabMergeRequestListItem {
  iid: number;
  title: string;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  author: { username: string } | null;
  source_branch: string;
  target_branch: string;
  web_url: string;
  created_at: string;
  updated_at: string;
}

function toPullRequestState(state: string): PullRequestState {
  if (state === "merged") return "merged";
  if (state === "opened") return "open";
  return "closed"; // "closed" or "locked"
}

function mapMrSummary(mr: GitLabMergeRequestListItem): PullRequestSummary {
  return {
    number: mr.iid,
    title: mr.title,
    state: toPullRequestState(mr.state),
    draft: Boolean(mr.draft ?? mr.work_in_progress),
    author: mr.author?.username ?? null,
    baseRef: mr.target_branch,
    headRef: mr.source_branch,
    url: mr.web_url,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
  };
}

async function listMergeRequestsByState(
  token: string,
  projectPath: string,
  glState: string,
  limit?: number
): Promise<GitLabResult<PullRequestSummary[]>> {
  const endpoint = "GET /projects/{id}/merge_requests";
  const params = new URLSearchParams({
    per_page: String(DEFAULT_PER_PAGE),
    state: glState,
    order_by: "updated_at",
    sort: "desc",
  });
  const url = `${projectApiBase(projectPath)}/merge_requests?${params}`;
  return runPaginated<GitLabMergeRequestListItem, PullRequestSummary>(endpoint, url, token, mapMrSummary, limit);
}

export async function listMergeRequests(
  token: string,
  projectPath: string,
  state: PullRequestListState = "open",
  /** Most recently updated first; omit for every MR. */
  limit?: number
): Promise<GitLabResult<PullRequestSummary[]>> {
  if (state === "open") return listMergeRequestsByState(token, projectPath, "opened", limit);
  if (state === "all") return listMergeRequestsByState(token, projectPath, "all", limit);

  // GitLab's `state=closed` excludes merged MRs — unlike GitHub, where a
  // "closed" PR list includes merged ones — so fetch both and merge to give
  // the app's "Closed" tab the same meaning it has for a GitHub repo.
  const [closed, merged] = await Promise.all([
    listMergeRequestsByState(token, projectPath, "closed", limit),
    listMergeRequestsByState(token, projectPath, "merged", limit),
  ]);
  const combined = [...closed.data, ...merged.data]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
  return { data: combined, rateLimit: closed.rateLimit ?? merged.rateLimit };
}

interface GitLabMergeRequestDetail extends GitLabMergeRequestListItem {
  description: string | null;
  diff_refs: { base_sha: string; head_sha: string; start_sha: string } | null;
}

export async function getMergeRequest(
  token: string,
  projectPath: string,
  iid: number
): Promise<GitLabResult<PullRequestDetail>> {
  const endpoint = "GET /projects/{id}/merge_requests/{iid}";
  const url = `${projectApiBase(projectPath)}/merge_requests/${iid}`;
  const { data, headers } = await gitlabFetch(endpoint, url, token);
  const mr = data as GitLabMergeRequestDetail;
  if (!mr.diff_refs) {
    throw new GitLabApiError(
      `GitLab merge request !${iid} has no diff_refs yet (not diffable — likely still being processed).`,
      { status: 0, endpoint }
    );
  }
  return {
    data: {
      ...mapMrSummary(mr),
      body: mr.description,
      baseSha: mr.diff_refs.base_sha,
      headSha: mr.diff_refs.head_sha,
    },
    rateLimit: extractRateLimit(headers),
  };
}

// ---------------------------------------------------------------------------
// Diffs (merge request changes + ad-hoc compare)
// ---------------------------------------------------------------------------

interface GitLabChange {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
}

function toFileStatus(change: Pick<GitLabChange, "new_file" | "deleted_file" | "renamed_file">): PullRequestFileStatus {
  if (change.new_file) return "added";
  if (change.deleted_file) return "removed";
  if (change.renamed_file) return "renamed";
  return "modified";
}

/** GitLab doesn't return per-file added/removed line counts, unlike GitHub's files API — counted from the unified-diff text instead. */
function countChangedLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function toPullRequestFile(change: GitLabChange): PullRequestFile {
  const { additions, deletions } = countChangedLines(change.diff ?? "");
  return {
    filename: change.new_path,
    previousFilename: change.renamed_file ? change.old_path : undefined,
    status: toFileStatus(change),
    additions,
    deletions,
    changes: additions + deletions,
    patch: change.diff || undefined,
  };
}

interface GitLabChangesResponse {
  changes: GitLabChange[];
}

/** Per-file unified diffs for a merge request, via `GET /projects/{id}/merge_requests/{iid}/changes` — GitLab's counterpart to GitHub's files-with-`patch` endpoint. */
export async function listMergeRequestFiles(
  token: string,
  projectPath: string,
  iid: number
): Promise<GitLabResult<PullRequestFile[]>> {
  const endpoint = "GET /projects/{id}/merge_requests/{iid}/changes";
  const url = `${projectApiBase(projectPath)}/merge_requests/${iid}/changes`;
  const { data, headers } = await gitlabFetch(endpoint, url, token);
  const body = data as GitLabChangesResponse;
  return { data: (body.changes ?? []).map(toPullRequestFile), rateLimit: extractRateLimit(headers) };
}

interface GitLabCompareResponse {
  commits: Array<{ id: string }>;
  diffs: GitLabChange[];
  compare_same_ref?: boolean;
}

/** Ad-hoc `from...to` ref comparison, via `GET /projects/{id}/repository/compare` (not tied to a merge request). `base`/`head` resolved to exact SHAs via {@link getRefSha} rather than trusted as already-SHAs, since callers may pass branch names. */
export async function compareRefs(
  token: string,
  projectPath: string,
  base: string,
  head: string
): Promise<GitLabResult<RefComparison>> {
  const endpoint = "GET /projects/{id}/repository/compare";
  const url = `${projectApiBase(projectPath)}/repository/compare?${new URLSearchParams({ from: base, to: head })}`;

  const [compareResult, baseShaResult, headShaResult] = await Promise.all([
    gitlabFetch(endpoint, url, token),
    getRefSha(token, projectPath, base),
    getRefSha(token, projectPath, head),
  ]);

  const body = compareResult.data as GitLabCompareResponse;
  const commits = body.commits ?? [];
  const identical = Boolean(body.compare_same_ref) || baseShaResult.data === headShaResult.data;

  return {
    data: {
      baseSha: baseShaResult.data,
      headSha: headShaResult.data,
      status: identical ? "identical" : "diverged",
      aheadBy: commits.length,
      // GitLab's compare endpoint doesn't report how far behind `to` is from `from`.
      behindBy: 0,
      totalCommits: commits.length,
      files: (body.diffs ?? []).map(toPullRequestFile),
    },
    rateLimit: extractRateLimit(compareResult.headers) ?? baseShaResult.rateLimit ?? headShaResult.rateLimit,
  };
}

// ---------------------------------------------------------------------------
// Ref SHA resolution
// ---------------------------------------------------------------------------

interface GitLabCommit {
  id: string;
  title: string;
  author_name: string | null;
  authored_date: string;
  parent_ids: string[];
}

/** The newest `limit` commits reachable from `ref` (omitted = the project's default branch), newest first, via `GET /projects/{id}/repository/commits`. One page — capped at 100. */
export async function listCommits(
  token: string,
  projectPath: string,
  ref: string | undefined,
  limit = 50
): Promise<GitLabResult<CommitSummary[]>> {
  const endpoint = "GET /projects/{id}/repository/commits";
  const params = new URLSearchParams({ per_page: String(Math.min(100, Math.max(1, limit))) });
  if (ref) params.set("ref_name", ref);
  const url = `${projectApiBase(projectPath)}/repository/commits?${params}`;
  const { data, headers } = await gitlabFetch(endpoint, url, token);
  return {
    data: (data as GitLabCommit[]).map((commit) => ({
      sha: commit.id,
      subject: (commit.title ?? "").trim(),
      author: commit.author_name ?? null,
      date: commit.authored_date,
      parents: commit.parent_ids ?? [],
    })),
    rateLimit: extractRateLimit(headers),
  };
}

/** The commit sha a ref (branch, tag or sha) currently points at, via `GET /projects/{id}/repository/commits/{ref}`. This is what the stale-review check polls, so it stays a single lightweight call. */
export async function getRefSha(token: string, projectPath: string, ref: string): Promise<GitLabResult<string>> {
  const endpoint = "GET /projects/{id}/repository/commits/{ref}";
  const url = `${projectApiBase(projectPath)}/repository/commits/${encodeURIComponent(ref)}`;
  const { data, headers } = await gitlabFetch(endpoint, url, token);
  const commit = data as { id?: unknown };
  if (typeof commit.id !== "string" || !commit.id) {
    throw new GitLabApiError(`GitLab returned no commit id for "${ref}" (${endpoint}).`, { status: 0, endpoint });
  }
  return { data: commit.id, rateLimit: extractRateLimit(headers) };
}

// ---------------------------------------------------------------------------
// Linked issues
// ---------------------------------------------------------------------------

interface GitLabClosesIssue {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
}

/** Issues GitLab resolves as "closed by" this merge request, via `GET /projects/{id}/merge_requests/{iid}/closes_issues` — a plain REST endpoint, unlike GitHub's GraphQL-only `closingIssuesReferences`. */
export async function getLinkedIssues(
  token: string,
  projectPath: string,
  mrIid: number
): Promise<GitLabResult<LinkedIssue[]>> {
  const endpoint = "GET /projects/{id}/merge_requests/{iid}/closes_issues";
  const url = `${projectApiBase(projectPath)}/merge_requests/${mrIid}/closes_issues`;
  const { data, headers } = await gitlabFetch(endpoint, url, token);
  const issues = data as GitLabClosesIssue[];
  return {
    data: issues
      .filter((issue) => typeof issue.iid === "number")
      .map((issue) => ({
        number: issue.iid,
        title: issue.title,
        body: issue.description,
        state: issue.state,
        url: issue.web_url,
      })),
    rateLimit: extractRateLimit(headers),
  };
}

// ---------------------------------------------------------------------------
// CI status + file contents (PR checklist, PR chat)
// ---------------------------------------------------------------------------

function pipelineState(status: string): CiState {
  if (status === "success" || status === "skipped" || status === "manual") return "success";
  if (["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled"].includes(status)) {
    return "pending";
  }
  return "failure";
}

interface GitLabPipeline {
  id: number;
  status: string;
  web_url?: string;
}

interface GitLabJob {
  name: string;
  status: string;
  web_url?: string;
}

/**
 * The latest pipeline for a commit, with its jobs as the individual checks.
 * GitLab's counterpart to GitHub's check runs + statuses.
 */
export async function getCommitCiStatus(
  token: string,
  projectPath: string,
  sha: string
): Promise<GitLabResult<CiStatus>> {
  const endpoint = "GET /projects/{id}/pipelines";
  const url = `${projectApiBase(projectPath)}/pipelines?sha=${encodeURIComponent(sha)}&per_page=1&order_by=id&sort=desc`;
  const { data, headers } = await gitlabFetch(endpoint, url, token);
  const pipeline = (data as GitLabPipeline[])[0];
  if (!pipeline) return { data: { state: "none", checks: [] }, rateLimit: extractRateLimit(headers) };

  const jobsEndpoint = "GET /projects/{id}/pipelines/{pipeline_id}/jobs";
  const jobsUrl = `${projectApiBase(projectPath)}/pipelines/${pipeline.id}/jobs?per_page=100`;
  let checks: CiCheck[] = [];
  try {
    const jobs = await gitlabFetch(jobsEndpoint, jobsUrl, token);
    checks = (jobs.data as GitLabJob[]).map((job) => ({
      name: job.name,
      state: pipelineState(job.status),
      url: job.web_url,
    }));
  } catch {
    // The pipeline's own status is still the answer; job names are detail.
  }
  return {
    data: { state: pipelineState(pipeline.status), checks },
    rateLimit: extractRateLimit(headers),
  };
}

/** A file's text at a ref, or `null` when it doesn't exist there. */
export async function getFileAtRef(
  token: string,
  projectPath: string,
  path: string,
  ref: string
): Promise<GitLabResult<string | null>> {
  const endpoint = "GET /projects/{id}/repository/files/{path}/raw";
  const url = `${projectApiBase(projectPath)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
  } catch (err) {
    throw toGitLabNetworkError(err, endpoint);
  }
  if (response.status === 404) return { data: null, rateLimit: extractRateLimit(response.headers) };
  if (!response.ok) throw await toGitLabApiError(response, endpoint);
  return { data: await response.text(), rateLimit: extractRateLimit(response.headers) };
}
