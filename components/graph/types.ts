// Shared DTO shapes for the Graph tab. These are the
// contract between the API routes it reads (app/api/repos/[repoId]/graph,
// …/diff-impact, …/review) and the UI in this directory. Intentionally
// colocated here rather than in types/ — see components/graph/README.md's
// scope note; promote later if another layer needs them.

/** Mirrors `lib/db`'s `ComponentTier`, duplicated here (not imported) so
 * this file stays framework/DB-agnostic and safe to import from client
 * components — `lib/db` is server-only. */
export type GraphNodeTier = "domain" | "module" | "file";

/** One component, flattened for the graph UI (which reads it for component
 * names). `parentId` is only present when a `CHILD_OF` edge exists — only
 * the AI labeling job writes the domain tier, so most nodes have no parent. */
export interface GraphNodeDTO {
  id: string;
  name: string;
  tier: GraphNodeTier | string;
  parentId?: string;
  fileCount: number;
  description?: string;
  /** `merge` for a merged feature module (DESIGN.md §6.3); absent/`folder` otherwise. */
  origin?: "folder" | "merge";
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

/** Request body accepted by `POST /api/repos/[repoId]/diff-impact` — exactly one of the three shapes. */
export type DiffImpactRequestDTO =
  | { prNumber: number }
  | { baseRef: string; headRef: string }
  | { filePaths: string[] };

/** Response shape for `POST /api/repos/[repoId]/diff-impact`. */
export interface DiffImpactResponseDTO {
  /** Changed file paths that matched a stored stored file. */
  touchedFiles: string[];
  /** Distinct `Component` ids touched via a matched file's `BELONGS_TO` edge. */
  touchedComponentIds: string[];
  /** Changed paths with no matching stored file (non-code files, or the repo needs re-analysis). */
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
  /** The whole file — set only when the path is not part of the diff (an impact finding's caller, or any file clicked in a list). */
  content?: string;
  /** With `content`: the commit or ref it was read at. */
  ref?: string;
  /** The path before a rename or copy. */
  oldPath?: string;
  /** Where the patch came from: a local `git diff` (checkout or the app's clone) or the host's API (DESIGN.md §6.24). */
  source?: "git" | "api";
  /** Asked with `?w=1`: `git` — git left whitespace changes out; `client` — the viewer has to (an API patch). */
  whitespace?: "git" | "client" | "shown";
  /** Git, ignoring whitespace, found nothing else changed. */
  whitespaceOnly?: boolean;
  binary?: boolean;
  /** The patch was cut at the size cap. */
  truncated?: boolean;
  /** The head blob id (git sources) — what the reader's "viewed" checkbox remembers. */
  fingerprint?: string;
}

/** One file of `GET /api/repos/[repoId]/diff-impact/files` — the all-files reader (DESIGN.md §6.24). */
export type DiffFileDTO = Omit<FileDiffResponseDTO, "content" | "ref" | "source" | "whitespace">;

/** Response shape for `GET /api/repos/[repoId]/diff-impact/files`: every changed file's patch at once. */
export interface DiffFilesResponseDTO {
  source: "git" | "api";
  whitespace: "git" | "client" | "shown";
  headSha?: string;
  files: DiffFileDTO[];
}

/**
 * Response shape for the same endpoint with `?view=file`: one file of the
 * diff in full — the "File" tab of the diff modal. Read at the target's head,
 * or at its base for a file the diff deletes.
 */
export interface FileContentResponseDTO {
  path: string;
  /** Which end of the diff the text comes from. */
  side: "head" | "base";
  /** The commit or ref it was read at. */
  ref: string;
  content: string;
  /** The file is longer than the server reads and is cut off. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// AI review — mirrors app/api/repos/[repoId]/review.
// ---------------------------------------------------------------------------
//
// Duplicated here rather than imported from the route module for the same
// reason as everything else in this file: that module pulls in lib/db and
// lib/jobs (the SQLite database and the job runner), which are server-only and
// must never reach a client bundle. These are the wire shapes only.

/** Verdict of one finding — is the change sound on its own terms. Mirrors `FindingAssessment` in lib/db. */
export type Assessment = "defect" | "concern" | "unknown" | "ok";
/** How a change relates to the PR's stated intent. Informational. Mirrors `FindingScope`. */
export type FindingScope = "described" | "supporting" | "unmentioned";
/** Mirrors `FindingKind`. */
export type FindingKind = "fix" | "feature" | "refactor" | "test" | "docs" | "config" | "chore";
/** Which review pass wrote a finding. Mirrors `FindingCategory`. */
export type FindingCategory = "change" | "impact" | "intent" | "structure" | "infra" | "schema" | "env" | "security" | "tests" | "chat";

/**
 * What a review is about — exactly one of the two shapes, matching the
 * review endpoint's POST body (and its `?prNumber=` / `?baseRef=&headRef=`
 * query form). The "paste paths" diff mode has no reviewable target: there
 * is no diff text behind it, only a list of file names (the review needs hunks).
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

/** Live progress of a running review — the "running counter", verbatim from the job. */
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
  /** The effort level the run uses. */
  effort?: ReviewEffort;
  /** Components a re-review after a push kept without a call — their patch didn't change (DESIGN.md §6.21). */
  reused?: number;
}

/** Mirrors `ReviewEffort` in lib/ai/effort.ts. */
export type ReviewEffort = "low" | "medium" | "high" | "max";

/** Dropdown order, labels and the one-line explanation each option shows. Budgets mirror REVIEW_EFFORT_SETTINGS. */
export const REVIEW_EFFORT_OPTIONS: Array<{
  value: ReviewEffort;
  label: string;
  budget: string;
  description: string;
}> = [
  { value: "low", label: "Low", budget: "7k", description: "The diff and neighbour names only. Safe for small local models." },
  { value: "medium", label: "Medium", budget: "16k", description: "Adds what each neighbouring component does." },
  { value: "high", label: "High", budget: "32k", description: "Adds signatures from the files the change imports or is imported by." },
  { value: "max", label: "Max", budget: "128k", description: "Adds the source of related code the diff refers to. Needs a large-context model." },
];

/** Pre-selected in the dropdown — mirrors DEFAULT_REVIEW_EFFORT. */
export const DEFAULT_REVIEW_EFFORT: ReviewEffort = "medium";

/** One persisted finding, flattened for the graph UI. `componentId` is a graph node id. */
export interface FindingDTO {
  id: string;
  componentId: string;
  componentName: string;
  filePath?: string;
  lineRange?: string;
  summary: string;
  assessment: Assessment;
  /** PR reviews only. */
  scope?: FindingScope;
  kind?: FindingKind;
  /**
   * `change`: the per-component review. `impact`: a usage the change left
   * behind — `componentId` is the *caller's* component (often untouched),
   * or "" for the "not everything was checked" note. `intent`: the one
   * PR-level verdict, `componentId` "".
   */
  category: FindingCategory;
  confidence: number;
  /** The head commit the review ran against (absent on legacy findings). */
  reviewedHeadSha?: string;
  rationale: string;
  model: string;
  createdAt: string;
  /** ISO-8601 time a reviewer resolved this finding; absent while open. */
  resolvedAt?: string;
  /** The model call behind it never completed (provider error, timeout) — "Retry failed" re-runs it. */
  callFailed?: boolean;
  /** Replies from coding agents (over MCP), oldest first. */
  responses?: FindingResponseDTO[];
  /** A near-identical finding on this file was dismissed as not a problem on this repo (DESIGN.md §6.21): hidden behind "suppressed N". */
  suppressed?: { id: string; reason?: string; summary: string };
}

/** A reply to a finding. Mirrors `FindingResponse` in lib/db: `answered` resolved it, `fixing` says a fix is under way. */
export interface FindingResponseDTO {
  id: string;
  kind: "answered" | "fixing" | "comment";
  author: string;
  body: string;
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
  /** The failed job's reason — absent for a cancelled one. */
  error?: string;
  /** `failed` only: the user cancelled the run. Findings of the components that finished before it stopped are kept. */
  cancelled?: boolean;
  /** `running` only: a cancel was requested and the worker hasn't stopped yet. */
  cancelRequested?: boolean;
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
    : `${shortRef(target.baseRef)} → ${shortRef(target.headRef)}`;
}

/** Whether a ref looks like a commit sha rather than a branch name. */
export function isShaLike(ref: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(ref);
}

/** A commit sha shortened to 7 characters; branch names unchanged. */
export function shortRef(ref: string): string {
  return isShaLike(ref) ? ref.slice(0, 7) : ref;
}

/** `"just now"`, `"12 min ago"`, `"3 h ago"`, `"2 days ago"` — coarse on purpose; empty for a missing/invalid time. */
export function formatAgo(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 days ago", "last month" — coarse on purpose, for telling commits and files apart; empty for an invalid time. */
export function formatRelativeDate(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((then - Date.now()) / 60_000);
  if (minutes === 0) return "just now";
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return RELATIVE.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return RELATIVE.format(months, "month");
  return RELATIVE.format(Math.round(months / 12), "year");
}
