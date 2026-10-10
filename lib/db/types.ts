// Typed shapes for every stored entity and relationship property bag.
//
// Timestamps are stored and returned as ISO-8601 strings to keep the
// storage boundary plain-JSON-friendly for route handlers and job payloads.

export type RepoProvider = "local" | "github" | "gitlab";

export interface RepoRecord {
  id: string;
  name: string;
  /** Present when `provider === "github"` or `provider === "gitlab"`. */
  url?: string;
  /** Present when `provider === "local"`. */
  localPath?: string;
  defaultBranch: string;
  provider: RepoProvider;
  createdAt: string;
  lastAnalyzedAt?: string;
  lastAnalyzedSha?: string;
  /**
   * `ANALYSIS_VERSION` (lib/jobs/analyze.ts) of the last analysis: a repo
   * analysed by an older version is re-analysed, like a moved branch.
   */
  analysisVersion?: number;
  /**
   * Set when a feature merge/unmerge moved modules between domains after the
   * last labeling run (DESIGN.md §6.3), so the domain tier may no longer fit.
   * Cleared by the next labeling run.
   */
  domainsStale?: boolean;
}

export type ComponentCreatedBy = "auto" | "user";
/** Tier within the hierarchical clustering. */
export type ComponentTier = "domain" | "module" | "file";
/**
 * How a module-tier component came to be (DESIGN.md §6.3): `folder` is the
 * folder-depth clustering of static analysis, `merge` a feature module the
 * user accepted from a merge suggestion. Absent on older nodes and on the
 * domain tier; read as `folder` for modules.
 */
export type ComponentOrigin = "folder" | "merge";

export interface ComponentRecord {
  id: string;
  repoId: string;
  name: string;
  description?: string;
  createdBy: ComponentCreatedBy;
  /**
   * Folder modules: the one `<dir>/**` pattern they were clustered from.
   * Merged modules: the folders (`<dir>/**`) and exact file paths they own —
   * the source of truth for their membership.
   */
  pathPatterns: string[];
  tier: ComponentTier;
  origin?: ComponentOrigin;
  /** Merged modules only: the folder module ids the merge replaced. Findings without a `filePath` follow these; Unmerge falls back to them. */
  absorbedModuleIds?: string[];
  /**
   * Merged modules only: the absorbed folder modules' descriptions, as a
   * JSON object (id → description). Pruning deletes those nodes; Unmerge
   * writes the descriptions back onto the folder modules it restores.
   */
  absorbedDescriptions?: string;
  /**
   * Merged modules only: folders that disappeared from the repo, with the
   * file names they held, as a JSON string (`LostFolder[]`). Used to spot a
   * rename and suggest adding the new folder back.
   */
  lostFolders?: string;
}

/** One entry of {@link ComponentRecord.lostFolders}. */
export interface LostFolder {
  pattern: string;
  fileNames: string[];
  lostAt: string;
}

export type MergeSuggestionKind = "merge" | "extend" | "move-file";
export type MergeSuggestionStatus = "open" | "rejected";

/**
 * A merge suggestion — a proposed change to the module tier, computed by
 * free heuristics after every analysis (DESIGN.md §6.3).
 *
 * - `merge`: turn the folders in `members` into one new feature module.
 * - `extend`: add the folders in `members` to the existing merged module `targetComponentId`.
 * - `move-file`: move the exact file paths in `members` into `targetComponentId` (a split).
 */
export interface MergeSuggestionRecord {
  /** Derived from `key`, so the same suggestion keeps its id across runs. */
  id: string;
  repoId: string;
  /** Identity across runs: kind, target and the sorted members. */
  key: string;
  kind: MergeSuggestionKind;
  /** `<dir>/**` folder patterns, or exact file paths for `move-file`. */
  members: string[];
  targetComponentId?: string;
  /** Proposed name for a `merge` (the shared feature name, title-cased). */
  name: string;
  /** 0–1. */
  score: number;
  /** Short human-readable reasons, e.g. "shared name 'map'". */
  reasons: string[];
  status: MergeSuggestionStatus;
  /** The score when the user rejected it; it reopens at ≥ 1.5× this. */
  scoreAtRejection?: number;
  updatedAt: string;
}

export interface FileRecord {
  id: string;
  repoId: string;
  path: string;
  language: string;
  loc: number;
  lastSeenCommit: string;
}

export type PullRequestState = "open" | "closed" | "merged";

export interface PullRequestRecord {
  id: string;
  repoId: string;
  number: number;
  title: string;
  description?: string;
  author: string;
  state: PullRequestState;
  baseRef: string;
  headRef: string;
  headSha: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface RefSnapshotRecord {
  /** Natural key for this node label — see the constraint note in schema.ts. */
  sha: string;
  repoId: string;
  ref: string;
  message: string;
  author: string;
  timestamp: string;
}

/** Is the change sound on its own terms? The only field that drives the verdict. */
export type FindingAssessment = "defect" | "concern" | "unknown" | "ok";
/** How a change relates to what the PR says it does. PR reviews only — informational, never a verdict. */
export type FindingScope = "described" | "supporting" | "unmentioned";
/** What sort of change it is. */
export type FindingKind = "fix" | "feature" | "refactor" | "test" | "docs" | "config" | "chore";
/**
 * Which pass wrote the finding: `change` — the per-component review of the
 * diff; `impact` — a usage of a changed contract that the PR left behind
 * (its file is usually outside the diff); `intent` — the one PR-level
 * "does it deliver what it claims" verdict (no component).
 */
/**
 * `change` (per component), `impact` (callers the change left behind),
 * `intent` (does the PR deliver what it says), `structure` (an import cycle
 * the change creates — static analysis, no model), `infra` (a certain
 * infrastructure problem — static analysis, no model, DESIGN.md §6.12),
 * `schema` (a hazard in a migration the change adds — static analysis, no
 * model, DESIGN.md §6.13),
 * `chat` (recorded by the PR chat when the reviewer asked it to; no review
 * pass replaces it).
 */
export type FindingCategory = "change" | "impact" | "intent" | "structure" | "infra" | "schema" | "chat";

/**
 * Categories the target-graph job writes from static analysis, before and
 * independently of any AI review — their presence doesn't mean the target
 * was reviewed.
 */
export const STATIC_FINDING_CATEGORIES: ReadonlySet<FindingCategory> = new Set<FindingCategory>(["structure", "infra", "schema"]);

export interface FindingRecord {
  id: string;
  repoId: string;
  /**
   * What was reviewed, as a stable string key: `pr:<number>` for a pull
   * request, or `refs:<baseRef>...<headRef>` for an ad-hoc ref comparison.
   *
   * A finding only has a nullable `prId`, which cannot identify a
   * ref-comparison review at all — two different ref comparisons of the same
   * repo would be indistinguishable, and "overwrite, don't version"
   * needs an exact identity for *what* is being overwritten. `targetKey` is
   * that identity; `prId` stays alongside it for PR reviews.
   */
  targetKey: string;
  /** Nullable — absent for a finding generated from an ad-hoc ref comparison rather than a PR. */
  prId?: string;
  componentId: string;
  filePath?: string;
  lineRange?: string;
  summary: string;
  assessment: FindingAssessment;
  /** Absent for ref comparisons (no stated intent) and for impact/intent findings. */
  scope?: FindingScope;
  kind?: FindingKind;
  category: FindingCategory;
  confidence: number;
  rationale: string;
  model: string;
  createdAt: string;
  /**
   * The commits this finding's review was run against — recorded so a later
   * read can tell whether the branch/PR has moved since (see
   * `lib/jobs/review-freshness.ts`). Stored on the finding itself, not just
   * in the job result, because job records age out and findings don't.
   * All three are absent on findings written before this existed ("legacy"),
   * and `reviewedBaseSha` can be absent alone if the base couldn't be resolved.
   */
  reviewedBaseSha?: string;
  reviewedHeadSha?: string;
  /** ISO-8601 time the shas above were captured (start of the review run). */
  reviewedAt?: string;
  /**
   * ISO-8601 time a reviewer marked this finding resolved; absent while it
   * is open. Only non-`ok` findings can be resolved. A resolved finding
   * counts as OK in the overall verdict. Not carried over by a re-review:
   * that replaces the findings, so fresh ones start unresolved.
   */
  resolvedAt?: string;
  /**
   * Set when the model call behind this finding never completed (provider
   * error, timeout, network) — the finding is a placeholder saying so, not
   * a judgement of the code. "Retry failed" re-runs exactly these.
   */
  callFailed?: boolean;
  /**
   * Replies to the finding, oldest first — today written by coding agents
   * over MCP (`lib/mcp/`). Like `resolvedAt`, not carried over by a
   * re-review.
   */
  responses?: FindingResponse[];
}

/**
 * How a reply settles a finding: `answered` — the concern does not hold (or
 * is already handled), and the reply says why; resolves the finding.
 * `fixing` — the concern is right and a fix is under way; the finding stays
 * open until a re-review of the fixed code drops it. `comment` — neither.
 */
export type FindingResponseKind = "answered" | "fixing" | "comment";

export interface FindingResponse {
  id: string;
  kind: FindingResponseKind;
  /** Who wrote it — the agent's name as it gave it, e.g. "claude-code". */
  author: string;
  body: string;
  createdAt: string;
}

// Note: `SettingsRecord` is defined in settings.ts, not here — re-declaring
// it in both places would create a duplicate-export collision in index.ts.

/** `(File)-[:IMPORTS {kind}]->(File)` */
export type ImportKind = "import" | "require" | "call";
export interface ImportsProps {
  kind: ImportKind;
  /** How much the importer uses the imported file (lines referring to its names); 1 when unknown. */
  weight?: number;
  /** Every import between the two files is type-only. */
  typeOnly?: boolean;
}

/** `(Component)-[:DEPENDS_ON {weight}]->(Component)` */
export interface DependsOnProps {
  weight: number;
}

/** `(PullRequest)-[:CHANGES {additions, deletions}]->(File)` */
export interface ChangesProps {
  additions: number;
  deletions: number;
}
