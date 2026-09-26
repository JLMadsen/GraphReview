// Wire shapes for the PR prerequisite checklist (DESIGN.md §6.6) — the
// contract between app/api/repos/[repoId]/checklist, app/api/checklist/items
// and the UI. Duplicated from lib/neo4j + lib/jobs rather than imported,
// for the same client/server boundary reason as ./types.ts.

export type ChecklistItemKindDTO =
  | "ci"
  | "description"
  | "linked-issue"
  | "max-files"
  | "max-lines"
  | "protected-paths"
  | "ai";

export type ChecklistStatusDTO = "pass" | "fail" | "pending" | "unknown" | "not_applicable";

/** Editor labels and which fields each kind uses. */
export const CHECKLIST_KIND_OPTIONS: Array<{
  kind: ChecklistItemKindDTO;
  label: string;
  hint: string;
  field?: "limit" | "patterns" | "question";
  defaultLimit?: number;
}> = [
  { kind: "ci", label: "CI passes", hint: "GitHub checks / GitLab pipeline of the head commit." },
  { kind: "description", label: "Has a description", hint: "At least this many characters.", field: "limit", defaultLimit: 30 },
  { kind: "linked-issue", label: "Links an issue", hint: "The PR closes or links at least one issue." },
  { kind: "max-files", label: "Max changed files", hint: "At most this many files.", field: "limit", defaultLimit: 30 },
  { kind: "max-lines", label: "Max changed lines", hint: "Additions + deletions.", field: "limit", defaultLimit: 500 },
  {
    kind: "protected-paths",
    label: "Protected paths",
    hint: "Fails when any of these is touched: dir/**, *.ext or exact paths, one per line.",
    field: "patterns",
  },
  { kind: "ai", label: "AI question", hint: "Asked about the whole PR; answered pass / fail / unknown.", field: "question" },
];

export interface ChecklistItemDTO {
  id: string;
  /** `"global"` or the repo id. */
  scope: string;
  kind: ChecklistItemKindDTO;
  label: string;
  question?: string;
  limit?: number;
  patterns?: string[];
  enabled: boolean;
  /** Global items, when listed for a repo: that repo switched it off. */
  disabledForRepo?: boolean;
}

/** `GET /api/checklist/items[?repoId=]`. */
export interface ChecklistItemsResponseDTO {
  items: ChecklistItemDTO[];
}

export interface ChecklistItemResultDTO {
  itemId: string;
  kind: ChecklistItemKindDTO;
  label: string;
  status: ChecklistStatusDTO;
  detail: string;
  links?: Array<{ label: string; url: string }>;
  checkedAt?: string;
  model?: string;
}

/** `GET|POST /api/repos/[repoId]/checklist`. */
export interface ChecklistEvaluationDTO {
  targetKey: string;
  headSha?: string;
  items: ChecklistItemResultDTO[];
  /** Enabled AI items with no answer for the current head commit. */
  aiPending: number;
  aiConfigured: boolean;
}
