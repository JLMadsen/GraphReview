// Shapes of the post-review, report and change-brief routes (DESIGN.md §6.23).
// Types only, so client components can import them.

import type { FindingAssessment } from "@/lib/db/types";
import type { PostHost, PostVerdict, PostedReview } from "./store";

export type { PostHost, PostVerdict, PostedReview };

/** One finding the dialog can tick: what it would post, and whether it already was. */
export interface PostDraftItem {
  findingId: string;
  assessment: FindingAssessment;
  resolved: boolean;
  /** "**Defect** · Jobs · `lib/x.ts:12` — summary" as plain text, for the list. */
  title: string;
  /** The finding's one-line summary, plain. */
  summary: string;
  location: string | null;
  /** On a diff line: where. `null`: it goes into the summary, for `notInlineReason`. */
  inline: { path: string; line: number; startLine?: number } | null;
  notInlineReason?: string;
  /** The Markdown the inline comment (or summary bullet) would carry. */
  body: string;
  /** Ticked when the dialog opens: open defects and concerns not posted yet. */
  picked: boolean;
  posted?: { postedAt: string; url: string };
}

/** `GET /api/repos/[repoId]/review/post?prNumber=` */
export interface PostDraftResponse {
  host: PostHost | null;
  /** Why posting can't work right now (no PAT, ref target, local repo …); the dialog shows it instead of the button. */
  unavailable?: string;
  prNumber: number;
  prUrl?: string;
  /** The head the inline lines are checked against — sent back with the post. */
  headSha?: string;
  /** The head the review ran at, when it isn't `headSha` (the PR moved since). */
  reviewedHeadSha?: string;
  items: PostDraftItem[];
  /** Editable summary body, prefilled. */
  summary: string;
  reviews: PostedReview[];
  /** GitLab has no "request changes": what that verdict does there instead. */
  requestChangesNote?: string;
}

/** `POST /api/repos/[repoId]/review/post` body. */
export interface PostReviewRequest {
  prNumber: number;
  findingIds: string[];
  summary: string;
  verdict: PostVerdict;
  headSha?: string;
}

export interface PostReviewResponse {
  url: string;
  inline: number;
  inSummary: number;
  verdict: PostVerdict;
}

/** `GET /api/repos/[repoId]/review/report` */
export interface ReportResponse {
  markdown: string;
  filename: string;
  /** Section ids that rendered, in order. */
  sections: string[];
}

/** One list of the change brief. */
export interface ChangeBrief {
  summary: string;
  userVisible: string[];
  contracts: string[];
  risks: string[];
  questions: string[];
}

/** `GET|POST /api/repos/[repoId]/review/brief` */
export interface ChangeBriefResponse {
  /** "Change brief" for a PR, "Release notes" for a ref range. */
  kind: "change_brief" | "release_notes";
  brief: ChangeBrief;
  markdown: string;
  filename: string;
  /** `ai`: written by the model · `facts`: built from stored data, no model. */
  source: "ai" | "facts";
  model?: string;
  generatedAt: string;
  headSha?: string;
  /** Why the deterministic brief stands in (no provider, unreadable answer, call failed). */
  note?: string;
  aiConfigured: boolean;
}
