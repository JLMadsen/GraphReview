// Barrel for lib/gitlab. See README.md.
export {
  listBranches,
  listMergeRequests,
  getMergeRequest,
  listMergeRequestFiles,
  compareRefs,
  getRefSha,
  getLinkedIssues,
} from "./client";

export { GitLabApiError } from "./errors";

export type {
  RateLimitInfo,
  GitLabResult,
  Branch,
  PullRequestListState,
  PullRequestState,
  PullRequestSummary,
  PullRequestDetail,
  PullRequestFileStatus,
  PullRequestFile,
  RefComparison,
  LinkedIssue,
} from "./types";
