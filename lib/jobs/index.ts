// Barrel for lib/jobs — the queue/job definitions plus the wiring that turns
// a stored repo into analyzed graph data. See README.md for scope.
//
// Everything here is server-only: it reads env vars, opens the database
// and spawns `git`. Import it from route handlers, server
// components and `worker/` only — never from a client component.

export {
  ANALYSIS_JOB_NAME,
  ANALYSIS_QUEUE_NAME,
  analysisJobId,
  closeQueues,
  enqueueAnalysis,
  getAnalysisJobFailure,
  getAnalysisJobLogs,
  getAnalysisJobState,
  getAnalysisQueue,
  isPendingJobState,
  type AnalysisJobData,
  type AnalysisJobResult,
  type AnalysisQueue,
  type EnqueueAnalysisResult,
} from "./queue";

export { cleanUpIfRepoRemoved, removeRepo } from "./repo-removal";

export {
  checkAndEnqueueIfStale,
  checkAndEnqueueIfStaleForRepo,
  type StalenessOptions,
  type StalenessResult,
} from "./staleness";

export {
  computeRepoStatus,
  getRepoDto,
  listRepoDtos,
  toRepoDto,
  type RepoDto,
  type RepoStatus,
  type RepoStatusOptions,
} from "./repo-status";

export {
  LocalPathOutsideRootError,
  detectDefaultBranch,
  getLocalReposRoot,
  getRepoCacheRoot,
  prepareRepoSource,
  readCurrentBranch,
  readCurrentSha,
  readHeadSha,
  readRemoteHead,
  remoteUrlForRepo,
  repoCacheDir,
  resolveLocalRepoPath,
  validateLocalRepoPath,
  type PreparedSource,
  type RemoteHead,
} from "./source";

export {
  describeGitHubError,
  getStoredGitHubToken,
  gitHubCloneUrl,
  gitHubRepoWebUrl,
  parseGitHubUrl,
  resolveGitHubAccess,
  type GitHubAccess,
  type GitHubRepoRef,
  type GitHubUnavailableReason,
} from "./github-access";

export {
  describeGitLabError,
  getStoredGitLabToken,
  gitLabCloneUrl,
  gitLabRepoWebUrl,
  parseGitLabUrl,
  resolveGitLabAccess,
  type GitLabAccess,
  type GitLabProjectRef,
  type GitLabUnavailableReason,
} from "./gitlab-access";

export {
  getRepoBranches,
  getRepoCommits,
  getRepoPullRequests,
  type BranchesResponse,
  type CommitsResponse,
  type PullRequestsResponse,
  type RepoAccessUnavailableReason,
} from "./repo-access";

export {
  REVIEW_JOB_NAME,
  REVIEW_QUEUE_NAME,
  closeReviewQueue,
  enqueueReview,
  getReviewJob,
  getReviewJobLogs,
  getReviewJobState,
  getReviewQueue,
  reviewJobId,
  reviewTargetKey,
  type EnqueueReviewResult,
  type ReviewJob,
  type ReviewJobData,
  type ReviewJobResult,
  type ReviewProgress,
  type ReviewQueue,
  type ReviewTarget,
} from "./review-queue";

export {
  LABEL_JOB_NAME,
  LABEL_CANCELLED_REASON,
  LABEL_QUEUE_NAME,
  cancelLabel,
  clearLabelCancel,
  closeLabelQueue,
  enqueueLabel,
  getLabelJob,
  getLabelJobLogs,
  getLabelJobState,
  getLabelQueue,
  isLabelCancelRequested,
  labelJobId,
  type CancelLabelResult,
  type EnqueueLabelResult,
  type LabelJob,
  type LabelJobData,
  type LabelJobResult,
  type LabelPhaseName,
  type LabelProgress,
  type LabelQueue,
} from "./label-queue";

export {
  getComponentReviewContexts,
  matchFilesToComponents,
  toDiffImpactResponse,
  type ComponentReviewContext,
  type DiffComponentMatch,
} from "./diff-components";

export { ChangedFilesError, listTargetChangedFiles } from "./changed-files";

export {
  applyPrMapGrouping,
  assemblePrMap,
  buildHeuristicPrMap,
  classifyPath,
  collectPrMapLinks,
  edgeLabelKey,
  heuristicPrMapGroups,
  loadPrMapInput,
  patchHighlights,
  type PrMapAiGrouping,
  type PrMapChangedFile,
  type PrMapGroup,
  type PrMapInput,
  type PrMapLink,
} from "./pr-map";

export {
  assembleAppMap,
  buildAppMap,
  classifyLayer,
  groupsForLevel,
  heuristicFeatureGroups,
  layerResolver,
  loadAppMapInput,
  matchMember,
  toStoredAppMaps,
  type AppMapGroup,
  type AppMapInput,
  type StoredAppMap,
  type StoredAppMapEdge,
  type StoredAppMapGroup,
} from "./app-map";

export {
  APP_MAP_CANCELLED_REASON,
  APP_MAP_JOB_NAME,
  APP_MAP_QUEUE_NAME,
  appMapJobId,
  cancelAppMap,
  clearAppMapCancel,
  closeAppMapQueue,
  enqueueAppMap,
  getAppMapJob,
  getAppMapJobLogs,
  getAppMapQueue,
  isAppMapCancelRequested,
  type AppMapJob,
  type AppMapJobData,
  type AppMapJobResult,
  type AppMapProgress,
} from "./app-map-queue";

export {
  checkReviewFreshness,
  invalidateReviewFreshness,
  latestReviewedRevision,
  type ReviewFreshness,
  type ReviewedRevision,
} from "./review-freshness";

export {
  listLocalBranches,
  listLocalChangedFiles,
  listLocalCommits,
  listLocalFilePatches,
  localMergeBase,
  resolveLocalRefSha,
  toLocalFilePatch,
  type LocalFilePatch,
} from "./local-git";

export {
  PREVIEW_JOB_NAME,
  PREVIEW_QUEUE_NAME,
  PREVIEW_SCAN_QUEUE_NAME,
  closePreviewQueue,
  closePreviewScanQueue,
  enqueuePreview,
  ensurePreviewScan,
  getPreviewJob,
  getPreviewJobLogs,
  getPreviewQueue,
  previewJobId,
  type PreviewJob,
  type PreviewJobData,
  type PreviewJobResult,
  type PreviewScanJob,
  type PreviewScanJobData,
} from "./preview-queue";

// NOTE: `./analyze` is deliberately *not* re-exported here. It pulls in
// lib/analysis (tree-sitter + WASM grammars), which only the worker ever
// executes — re-exporting it would drag the whole parsing engine into the
// Next.js server bundle of every page that imports this barrel. The worker
// imports it directly instead:
//     import { runAnalysisJob } from "@/lib/jobs/analyze";
//
// `./review` is kept out for the same reason: it pulls in lib/ai and
// lib/github, which no route that merely *enqueues* a review needs. The
// worker imports it directly:
//     import { runReviewJob } from "@/lib/jobs/review";
//
// `./label` likewise (lib/ai):
//     import { runLabelJob } from "@/lib/jobs/label";
// and `./app-map-job`:
//     import { runAppMapJob } from "@/lib/jobs/app-map-job";
// and `./preview` (lib/ai, lib/analysis, the Docker sandbox):
//     import { runPreviewJob } from "@/lib/jobs/preview";
export type { JobLogger } from "./analyze";
