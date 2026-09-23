// Review effort levels — how much each per-component review call may spend
// and how much surrounding code it gets to see.
//
//   low     7k tokens   the changed component's diff + neighbour *names*
//   medium  16k tokens  + what each neighbouring component is (its description)
//   high    32k tokens  + signatures from the files the changed files import
//                         or are imported by, in other components
//   max     128k tokens + the source of those files' declarations that the
//                         diff actually refers to
//
// `low` is exactly what every review did before effort levels existed.
// Whatever the level, a diff too big for the budget is reviewed in several
// chunks rather than cut off (see review.ts), so a higher level mostly buys
// context and fewer, larger chunks.

export const REVIEW_EFFORTS = ["low", "medium", "high", "max"] as const;

export type ReviewEffort = (typeof REVIEW_EFFORTS)[number];

/** What the UI pre-selects, and what a request without an explicit effort gets. */
export const DEFAULT_REVIEW_EFFORT: ReviewEffort = "medium";

export interface ReviewEffortSettings {
  /** Per-call input budget, in estimated tokens. */
  tokenBudget: number;
  /** Include each neighbouring component's description, not just its name. */
  neighborDescriptions: boolean;
  /** Include declaration signatures from related files in other components. */
  signatures: boolean;
  /** Include the source of related declarations the diff mentions. */
  relatedSource: boolean;
}

export const REVIEW_EFFORT_SETTINGS: Record<ReviewEffort, ReviewEffortSettings> = {
  low: { tokenBudget: 7_000, neighborDescriptions: false, signatures: false, relatedSource: false },
  medium: { tokenBudget: 16_000, neighborDescriptions: true, signatures: false, relatedSource: false },
  high: { tokenBudget: 32_000, neighborDescriptions: true, signatures: true, relatedSource: false },
  max: { tokenBudget: 128_000, neighborDescriptions: true, signatures: true, relatedSource: true },
};

export function isReviewEffort(value: unknown): value is ReviewEffort {
  return typeof value === "string" && (REVIEW_EFFORTS as readonly string[]).includes(value);
}
