// Shared DTO shapes for the Graph tab (DESIGN.md §3, §4, §6). These are the
// contract between the two API routes this package owns
// (app/api/repos/[repoId]/graph, app/api/repos/[repoId]/diff-impact) and the
// Cytoscape UI in this directory. Intentionally colocated here rather than
// in types/ — see components/graph/README.md's scope note; promote later if
// another layer needs them.

/** Mirrors `lib/neo4j`'s `ComponentTier`, duplicated here (not imported) so
 * this file stays framework/DB-agnostic and safe to import from client
 * components — `lib/neo4j` is server-only. */
export type GraphNodeTier = "domain" | "module" | "file";

/** One `(:Component)` node, flattened for the graph UI. `parentId` is only
 * present when a `CHILD_OF` edge exists — v1 rarely populates the domain
 * tier (DESIGN.md §6.1/§16), so most nodes have no parent and the UI must
 * render a flat graph in that case rather than assuming a 3-tier hierarchy. */
export interface GraphNodeDTO {
  id: string;
  name: string;
  tier: GraphNodeTier | string;
  parentId?: string;
  fileCount: number;
  description?: string;
}

/** One `(Component)-[:DEPENDS_ON {weight}]->(Component)` edge. */
export interface GraphEdgeDTO {
  source: string;
  target: string;
  weight: number;
}

/** Response shape for `GET /api/repos/[repoId]/graph`. */
export interface GraphResponseDTO {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
}

/** One `(:File)` belonging to a component, as returned by
 * `GET /api/repos/[repoId]/components/[componentId]/files`. A trimmed
 * `FileRecord` — the graph UI only needs identity, path, language and size. */
export interface ComponentFileDTO {
  id: string;
  path: string;
  language: string;
  loc: number;
}

/** Response shape for `GET /api/repos/[repoId]/components/[componentId]/files`. `files` is sorted by `path` ascending. */
export interface ComponentFilesResponseDTO {
  componentId: string;
  componentName: string;
  files: ComponentFileDTO[];
}

/** Request body accepted by `POST /api/repos/[repoId]/diff-impact` — exactly one of the three shapes. */
export type DiffImpactRequestDTO =
  | { prNumber: number }
  | { baseRef: string; headRef: string }
  | { filePaths: string[] };

/** Response shape for `POST /api/repos/[repoId]/diff-impact`. */
export interface DiffImpactResponseDTO {
  /** Changed file paths that matched a stored `(:File)` node. */
  touchedFiles: string[];
  /** Distinct `Component` ids touched via a matched file's `BELONGS_TO` edge. */
  touchedComponentIds: string[];
  /** Changed paths with no matching `(:File)` node (non-code files, or the repo needs re-analysis). */
  unmatchedFiles: string[];
}

/**
 * File status vocabulary shared by GitHub's file-diff APIs and the
 * local-git equivalent — mirrors `PullRequestFileStatus` in lib/github,
 * duplicated here for the same client/server-boundary reason as the rest of
 * this file.
 */
export type FileDiffStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

/**
 * Response shape for `GET /api/repos/[repoId]/diff-impact/file` — the
 * single-file unified diff behind one `FindingDTO`'s `filePath`. Fetched on
 * demand (not carried on the finding itself): a review can touch hundreds of
 * files, but nobody reads more than a handful of diffs in one session.
 */
export interface FileDiffResponseDTO {
  path: string;
  status: FileDiffStatus;
  additions: number;
  deletions: number;
  /** Unified diff hunks (`@@ ... @@`), the same text GitHub/`git diff -U3` produce. Absent for binary files or a diff too large to keep. */
  patch?: string;
}

// ---------------------------------------------------------------------------
// AI review (DESIGN.md §9, §10) — mirrors app/api/repos/[repoId]/review.
// ---------------------------------------------------------------------------
//
// Duplicated here rather than imported from the route module for the same
// reason as everything else in this file: that module pulls in lib/neo4j and
// lib/jobs (Neo4j driver + a Redis connection), which are server-only and
// must never reach a client bundle. These are the wire shapes only.

/** Verdict of one finding. Mirrors `FindingIntentMatch` in lib/neo4j. */
export type IntentMatch = "match" | "partial" | "mismatch" | "unknown";

/**
 * What a review is about — exactly one of the two shapes, matching the
 * review endpoint's POST body (and its `?prNumber=` / `?baseRef=&headRef=`
 * query form). The "paste paths" diff mode has no reviewable target: there
 * is no diff text behind it, only a list of file names (§9 needs hunks).
 */
export type ReviewTargetDTO =
  | { prNumber: number }
  | { baseRef: string; headRef: string };

/** Lifecycle of a review target. `"none"` means "never reviewed". */
export type ReviewStateDTO =
  | "none"
  | "queued"
  | "running"
  | "completed"
  | "failed";

/** Live progress of a running review — §10's "running counter", verbatim from the job. */
export interface ReviewProgressDTO {
  total: number;
  completed: number;
  failed: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Display names of the components currently in flight. */
  running: string[];
  unmatchedFiles: number;
}

/** One persisted `(:Finding)`, flattened for the graph UI. `componentId` is a graph node id. */
export interface FindingDTO {
  id: string;
  componentId: string;
  componentName: string;
  filePath?: string;
  lineRange?: string;
  summary: string;
  intentMatch: IntentMatch;
  confidence: number;
  rationale: string;
  model: string;
  createdAt: string;
}

/**
 * Whether the reviewed code has moved since the review ran — mirrors
 * `ReviewFreshness` in lib/jobs/review-freshness.ts. Advisory only.
 * `checkError` means "couldn't tell" (branch deleted, GitHub down, …), in
 * which case `stale` is `false` and `currentHeadSha` is `""`.
 */
export interface ReviewFreshnessDTO {
  stale: boolean;
  reviewedHeadSha: string;
  currentHeadSha: string;
  reviewedBaseSha?: string;
  currentBaseSha?: string;
  reviewedAt?: string;
  checkError?: string;
}

/** Response shape for `GET /api/repos/[repoId]/review`. */
export interface ReviewStatusResponseDTO {
  targetKey: string;
  state: ReviewStateDTO;
  progress?: ReviewProgressDTO;
  /** The failed job's reason, or a degraded-read note (e.g. Redis down). */
  error?: string;
  findings: FindingDTO[];
  /** Present only for a completed review whose findings carry the shas they were made from. */
  freshness?: ReviewFreshnessDTO;
  aiConfigured: boolean;
}

/** Response shape for `POST /api/repos/[repoId]/review`. */
export interface EnqueueReviewResponseDTO {
  jobId: string;
  targetKey: string;
  /** `false` when a review of this exact target was already queued or running. */
  enqueued: boolean;
}

/** Error envelope both review verbs share. `code` is `ai_not_configured` | `not_linked` | `queue_unavailable`. */
export interface ReviewErrorDTO {
  error: string;
  code?: string;
}

/**
 * Stable client-side identity of a review target — the same `pr:<n>` /
 * `refs:<base>...<head>` shape the server uses as `targetKey`. Used as an
 * effect dependency so "the target changed" is one primitive comparison
 * rather than a new object identity on every render.
 */
export function reviewTargetKeyOf(target: ReviewTargetDTO): string {
  return "prNumber" in target
    ? `pr:${target.prNumber}`
    : `refs:${target.baseRef}...${target.headRef}`;
}

/** The query string that addresses a target on `GET /api/repos/[repoId]/review`. */
export function reviewTargetQuery(target: ReviewTargetDTO): string {
  const params = new URLSearchParams();
  if ("prNumber" in target) {
    params.set("prNumber", String(target.prNumber));
  } else {
    params.set("baseRef", target.baseRef);
    params.set("headRef", target.headRef);
  }
  return params.toString();
}

/** Human label for a target, for panel headers ("PR #12" / "base…head"). */
export function reviewTargetLabel(target: ReviewTargetDTO): string {
  return "prNumber" in target
    ? `PR #${target.prNumber}`
    : `${target.baseRef} → ${target.headRef}`;
}
