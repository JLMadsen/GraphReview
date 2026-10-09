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

/** One line of the `POST /api/repos/[repoId]/chat` NDJSON stream. */
export type ChatStreamEventDTO =
  | { type: "user"; message: ChatMessageDTO }
  | { type: "step"; step: ChatStepDTO }
  | { type: "answer"; message: ChatMessageDTO }
  | { type: "error"; error: string };
