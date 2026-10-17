// Wire shapes for the PR chat (DESIGN.md §6.7) — the contract between
// app/api/repos/[repoId]/chat and the chat column. Duplicated from
// lib/db/chat.ts for the client/server boundary, like ./types.ts.

export interface ChatStepDTO {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

/** A finding the chat offered on its own; the reviewer adds or dismisses it. */
export interface ChatSuggestionDTO {
  id: string;
  assessment: "defect" | "concern" | "unknown" | "ok";
  summary: string;
  rationale: string;
  filePath?: string;
  line?: number;
  status: "pending" | "added" | "dismissed";
  findingId?: string;
}

/**
 * Something an answer did to the view (`show`, `highlight`, `filter_findings`,
 * `switch_view`, `open_diff`) — applied on arrival, redone from its chip — or
 * only offered (`offer`: the answer's `point_to` / `next` stops, a Before /
 * after preview), applied only from its chip.
 */
export type ChatActionDTO = (
  | {
      kind: "show";
      target: "component" | "file" | "endpoint" | "table" | "env" | "infra" | "area" | "function" | "finding";
      id: string;
      label: string;
      line?: number;
    }
  | { kind: "highlight"; componentIds: string[]; label: string }
  | {
      kind: "filter";
      buckets?: Array<"defect" | "concern" | "unknown" | "fine">;
      category?: string;
      componentId?: string;
      label: string;
    }
  | {
      kind: "view";
      view: "pr" | "app" | "api" | "infra" | "data" | "env" | "files" | "tests" | "stats";
      level?: "architecture" | "features" | "modules";
      mode?: string;
      changedOnly?: boolean;
      label: string;
    }
  | { kind: "file"; path: string; tab: "diff" | "file" | "base" | "preview"; lines?: string; symbol?: string; label: string }
) & {
  offer?: boolean;
  /** The suggested next stop: why go there. */
  next?: string;
};

/** The chat's verdict on a finding already in the review; the reviewer applies or dismisses it. */
export interface ChatTriageDTO {
  id: string;
  findingId: string;
  findingSummary: string;
  from: "defect" | "concern" | "unknown" | "ok";
  verdict: "holds" | "wrong" | "rerate";
  assessment?: "defect" | "concern" | "unknown" | "ok";
  reason: string;
  status: "pending" | "applied" | "dismissed";
}

export interface ChatMessageDTO {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps: ChatStepDTO[];
  componentIds: string[];
  files: string[];
  focusComponentId?: string;
  headSha?: string;
  model?: string;
  error?: boolean;
  suggestions?: ChatSuggestionDTO[];
  actions?: ChatActionDTO[];
  triage?: ChatTriageDTO[];
  /** User messages: the finding asked about. */
  findingId?: string;
  /** User messages: what was on screen, as sent. */
  screen?: string;
  createdAt: string;
}

/** `GET /api/repos/[repoId]/chat?…target`. */
export interface ChatThreadDTO {
  messages: ChatMessageDTO[];
  /** The target's current head commit, to mark messages about an older one. */
  headSha?: string;
  aiConfigured: boolean;
}

/** `PATCH /api/repos/[repoId]/chat` — the reviewer's answer to a suggested finding. */
export interface ChatSuggestionActionDTO {
  messageId: string;
  suggestionId: string;
  action: "add" | "dismiss";
}

/** `PATCH /api/repos/[repoId]/chat` — the reviewer's answer to a verdict on a finding. */
export interface ChatTriageActionDTO {
  messageId: string;
  triageId: string;
  action: "apply" | "dismiss";
}

/** One line of the `POST /api/repos/[repoId]/chat` NDJSON stream. */
export type ChatStreamEventDTO =
  | { type: "user"; message: ChatMessageDTO }
  | { type: "step"; step: ChatStepDTO }
  | { type: "answer"; message: ChatMessageDTO }
  | { type: "error"; error: string };
