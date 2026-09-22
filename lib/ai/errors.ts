// Error handling for lib/ai. Mirrors lib/github/errors.ts's shape: never
// swallow a failure, wrap it with enough context (HTTP status + the URL
// that was called) for a caller to show something sensible.

/**
 * Thrown for any failure while talking to an OpenAI-compatible
 * chat-completions endpoint — network errors, non-2xx responses, a
 * response body that isn't JSON, or a response whose shape doesn't carry
 * an assistant message. Wraps the original error as `cause`.
 */
export class AiClientError extends Error {
  override readonly name = "AiClientError";

  /** HTTP status code when known. `0` when the failure never reached an HTTP response (network error, or a locally-detected shape problem). */
  readonly status: number;

  /** The full URL that was called, e.g. `"http://localhost:11434/v1/chat/completions"`. */
  readonly endpoint: string;

  constructor(message: string, options: { status: number; endpoint: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.status = options.status;
    this.endpoint = options.endpoint;
  }
}
