// Wire shapes of the jobs API (DESIGN.md §6.20), shared by the routes and
// the header indicator, the drawer and the inline job states.

export type JobKind = "Analysis" | "Compare" | "Review" | "App map" | "Preview scan" | "Preview";

/** The runner's states, collapsed for the drawer; a job stopped by the user is `cancelled`, not `failed`. */
export type JobStateDto = "running" | "queued" | "failed" | "done" | "cancelled";

export interface JobDto {
  queue: string;
  id: string;
  kind: JobKind;
  state: JobStateDto;
  repoId?: string;
  repoName?: string;
  /** What it runs on: "PR #12", "main @ abc1234", "src/a.tsx · PR #12", "features". */
  target: string;
  /** `pr:<n>` / `refs:<base>...<head>` for jobs about a review target. */
  targetKey?: string;
  /** Preview jobs: the file. */
  filePath?: string;
  /** Queued: 1-based place among the queue's waiting jobs (FIFO). */
  position?: number;
  /** "2nd in the review queue". */
  positionText?: string;
  /** Running: components/cards done, or the latest phase. */
  progress?: string;
  /** Done: the result in one phrase. */
  result?: string;
  failedReason?: string;
  /** Queued for an automatic retry after this failure (analysis). */
  retrying?: string;
  /** A failure retrying can't fix: link to the setting instead of Run again. */
  configIssue?: { label: string; href: string };
  /** Inferred "Triggered by" line; absent when the data can't tell. */
  trigger?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Where the result lives. */
  href?: string;
  cancellable: boolean;
  retryable: boolean;
  /** Failed and not opened yet — what the red count counts. */
  unseen?: boolean;
}

export interface JobsResponse {
  jobs: JobDto[];
  running: number;
  queued: number;
  unseenFailed: number;
}
