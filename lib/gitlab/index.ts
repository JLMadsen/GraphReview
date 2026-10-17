// Barrel for lib/gitlab. See README.md.
export {
  listBranches,
  listMergeRequests,
  listCommits,
  getMergeRequest,
  listMergeRequestFiles,
  compareRefs,
  getRefSha,
  getLinkedIssues,
  getCommitCiStatus,
  listPipelines,
  getFileAtRef,
  getTokenScopes,
  getMergeRequestDiffRefs,
  createMergeRequestDiscussion,
  createMergeRequestNote,
  approveMergeRequest,
  unapproveMergeRequest,
} from "./client";
export type { MergeRequestDiffRefs, MergeRequestDiffPosition, PostedNote } from "./client";

export { GitLabApiError } from "./errors";

export type {
  RateLimitInfo,
  GitLabResult,
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
  CiState,
  CiCheck,
  CiStatus,
  CiRun,
} from "./types";
