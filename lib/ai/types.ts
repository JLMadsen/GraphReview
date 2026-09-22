// Shared types for lib/ai. See README.md — decision #8 (docs/DESIGN.md §8)
// requires a fully generic OpenAI-compatible provider, so this is
// intentionally the whole provider "shape": no per-vendor fields.

/** User-configured AI provider connection (decision #8). Never hardcoded. */
export interface AiProviderConfig {
  /**
   * The provider's base URL, e.g. `"https://api.openai.com/v1"` or
   * `"http://localhost:11434/v1"` for a local Ollama/LM Studio server.
   * `chatCompletion` appends `/chat/completions` to this verbatim (after
   * stripping a trailing slash) — any versioned path segment (`/v1`) the
   * provider needs must already be part of `baseUrl`.
   */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>`. Local servers that don't check it can be given any placeholder string. */
  apiKey: string;
  /** Sent as the request's `model` field, verbatim. */
  model: string;
}

export type ChatRole = "system" | "user" | "assistant";

/** One message in the standard OpenAI chat-completions `messages` array. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Token usage as reported by the provider (§10: "approximate tokens used"). Fields default to `0` when the provider's `usage` object omits them, but the object itself is only present when the provider reports usage at all. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Result of a successful `chatCompletion` call. */
export interface ChatCompletionResult {
  /** The first choice's assistant message content — plain text, never parsed (§9: no `response_format`/tool-calling reliance). */
  content: string;
  /** `null` when the provider's response carries no `usage` object at all. */
  usage: TokenUsage | null;
}
