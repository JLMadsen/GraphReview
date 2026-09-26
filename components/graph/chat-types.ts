// Wire shapes for the PR chat (DESIGN.md §6.7) — the contract between
// app/api/repos/[repoId]/chat and the chat column. Duplicated from
// lib/neo4j/chat.ts for the client/server boundary, like ./types.ts.

export interface ChatStepDTO {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
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
  createdAt: string;
}

/** `GET /api/repos/[repoId]/chat?…target`. */
export interface ChatThreadDTO {
  messages: ChatMessageDTO[];
  /** The target's current head commit, to mark messages about an older one. */
  headSha?: string;
  aiConfigured: boolean;
}

/** One line of the `POST /api/repos/[repoId]/chat` NDJSON stream. */
export type ChatStreamEventDTO =
  | { type: "user"; message: ChatMessageDTO }
  | { type: "step"; step: ChatStepDTO }
  | { type: "answer"; message: ChatMessageDTO }
  | { type: "error"; error: string };
