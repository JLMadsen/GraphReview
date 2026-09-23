// Typed shapes for every node label and relationship property bag defined
// in the Neo4j schema. These are intentionally local to lib/neo4j/ (not
// types/) since this task is scoped to the Neo4j data-access layer only —
// promote them to types/ later if/when other layers want to import the
// canonical shapes directly instead of going through the repository
// functions.
//
// Timestamps are stored and returned as ISO-8601 strings (not Neo4j's
// native temporal type) to keep the driver boundary plain-JSON-friendly
// for route handlers and BullMQ job payloads.

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
}

export type ComponentCreatedBy = "auto" | "user";
/** Tier within the hierarchical clustering. */
export type ComponentTier = "domain" | "module" | "file";

export interface ComponentRecord {
  id: string;
  repoId: string;
  name: string;
  description?: string;
  createdBy: ComponentCreatedBy;
  pathPatterns: string[];
  tier: ComponentTier;
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

export type FindingIntentMatch = "match" | "partial" | "mismatch" | "unknown";

export interface FindingRecord {
  id: string;
  repoId: string;
  /**
   * What was reviewed, as a stable string key: `pr:<number>` for a pull
   * request, or `refs:<baseRef>...<headRef>` for an ad-hoc ref comparison.
   *
   * `Finding` only has a nullable `prId`, which cannot identify a
   * ref-comparison review at all — two different ref comparisons of the same
   * repo would be indistinguishable, and "overwrite, don't version"
   * needs an exact identity for *what* is being overwritten. `targetKey` is
   * that identity; `prId` stays alongside it purely so the `FOR ->
   * (:PullRequest)` edge and the property list still hold for PR reviews.
   */
  targetKey: string;
  /** Nullable — absent for a finding generated from an ad-hoc ref comparison rather than a PR. */
  prId?: string;
  componentId: string;
  filePath?: string;
  lineRange?: string;
  summary: string;
  intentMatch: FindingIntentMatch;
  confidence: number;
  rationale: string;
  model: string;
  createdAt: string;
  /**
   * The commits this finding's review was run against — recorded so a later
   * read can tell whether the branch/PR has moved since (see
   * `lib/jobs/review-freshness.ts`). Stored on the finding itself, not just
   * in the BullMQ job result, because job records age out and findings don't.
   * All three are absent on findings written before this existed ("legacy"),
   * and `reviewedBaseSha` can be absent alone if the base couldn't be resolved.
   */
  reviewedBaseSha?: string;
  reviewedHeadSha?: string;
  /** ISO-8601 time the shas above were captured (start of the review run). */
  reviewedAt?: string;
  /**
   * ISO-8601 time a reviewer marked this finding resolved; absent while it
   * is open. Only non-`match` findings can be resolved. A resolved finding
   * counts as OK in the overall verdict. Not carried over by a re-review:
   * that replaces the findings, so fresh ones start unresolved.
   */
  resolvedAt?: string;
}

// Note: `SettingsRecord` is intentionally defined in settings.ts, not here
// — the integration contract for that module specifies its exact shape
// there (singleton `(:Settings {id: "global"})`), and re-declaring
// it in both places would create a duplicate-export collision in index.ts.

/** `(File)-[:IMPORTS {kind}]->(File)` */
export type ImportKind = "import" | "require" | "call";
export interface ImportsProps {
  kind: ImportKind;
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
