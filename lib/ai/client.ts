// Generic OpenAI-compatible chat-completions client.
//
// Deliberately provider-agnostic: `AiProviderConfig` is just
// `{ baseUrl, apiKey, model }`, nothing here special-cases OpenAI, Ollama,
// LM Studio, vLLM, etc. This never sets `response_format` or
// `tools`/`tool_choice` on the request — those aren't universally supported
// by OpenAI-*compatible* servers, so structured output is the caller's
// problem via plain prompting + `parse.ts`, not this client's.
//
// "Compatible" is a loose word in practice, so the client also tolerates the
// three deviations real providers were seen to have:
//   - reasoning models that spend `max_tokens` on hidden thinking and return
//     no text at all (Gemini's OpenAI endpoint) — reported with a clear error;
//   - models that reject a non-default `temperature` (OpenAI o-series/gpt-5) —
//     the request is retried once without it;
//   - models that reject `max_tokens` in favour of `max_completion_tokens` —
//     the request is retried once with the renamed field;
//   - gateways that return `message.content` as an array of text parts.
//
// Transient failures — 429 (rate limit), 500/502/503/504 ("model overloaded,
// try again later") and network errors — are retried up to
// TRANSIENT_RETRIES times with growing waits, honouring `Retry-After`. Only
// then does the caller see the error (a review records the component as
// failed, and "Retry failed" can re-run it later).
//
// Requests go through undici's own `fetch` with a dedicated dispatcher rather
// than the global `fetch`: Node's built-in one gives up if response headers
// haven't arrived within 5 minutes, and a non-streaming call to a local model
// sends no headers until the whole answer is generated — a 12B model grouping
// a repo's modules on a laptop hit exactly that ("fetch failed" at 300 s).

import { Agent, fetch as undiciFetch } from "undici";
import { AiClientError } from "./errors";
import type { AiProviderConfig, ChatCompletionResult, ChatMessage, TokenUsage } from "./types";

export interface ChatCompletionOptions {
  /** Forwarded as `temperature` when set. Omitted from the request body otherwise, so the provider's own default applies. Dropped automatically if the provider rejects it. */
  temperature?: number;
  /**
   * Forwarded as `max_tokens` when set (the field every OpenAI-compatible
   * server — Ollama, LM Studio, vLLM, llama.cpp — accepts). Renamed to
   * `max_completion_tokens` automatically if the provider rejects it.
   *
   * Be careful setting this at all: on reasoning ("thinking") models the cap
   * also covers the hidden reasoning, so a small value can leave no room for
   * any visible answer.
   */
  maxTokens?: number;
  /** Lets a caller cancel/timeout the underlying `fetch`. */
  signal?: AbortSignal;
}

/** `message.content` as seen in the wild: a string, an array of text parts, or absent/null. */
type RawContent = string | Array<{ type?: string; text?: unknown }> | null | undefined;

/**
 * The subset of the standard chat-completions response shape this client
 * relies on — see https://platform.openai.com/docs/api-reference/chat.
 */
interface RawChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: RawContent;
      refusal?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * How long one AI request may take, in ms: `AI_REQUEST_TIMEOUT_MS`, default
 * 30 minutes, `0` for no limit. Applies to waiting for the response to start
 * and to gaps while it arrives. A cancelled labeling run still stops at once
 * via the request's AbortSignal, whatever this is.
 */
function aiRequestTimeoutMs(): number {
  const raw = process.env.AI_REQUEST_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30 * 60_000;
}

let aiDispatcher: Agent | undefined;

function getAiDispatcher(): Agent {
  if (!aiDispatcher) {
    const timeout = aiRequestTimeoutMs();
    aiDispatcher = new Agent({ headersTimeout: timeout, bodyTimeout: timeout });
  }
  return aiDispatcher;
}

function buildEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return `${trimmed}/chat/completions`;
}

/** The assistant text from `message.content`, whether a plain string or an array of text parts; `undefined` when there is none. */
function contentToText(content: RawContent): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .join("");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function extractResult(body: unknown, endpoint: string, rawText: string): ChatCompletionResult {
  const response = body as RawChatCompletionResponse;
  const choice = response?.choices?.[0];
  const content = contentToText(choice?.message?.content);
  const rawUsage = response?.usage;

  // No text at all — or an empty answer that was cut off by the token limit.
  // (An empty answer with finish_reason "stop" is returned as-is: the caller
  // decides what an empty answer means.)
  if (content === undefined || (content.length === 0 && choice?.finish_reason === "length")) {
    const finish = choice?.finish_reason ?? "unknown";
    const refusal = choice?.message?.refusal;
    let why: string;
    if (finish === "length") {
      why =
        `The model stopped at its output limit (finish_reason: length` +
        `${rawUsage?.completion_tokens !== undefined ? `, ${rawUsage.completion_tokens} completion tokens` : ""}) ` +
        `before writing any text. Reasoning ("thinking") models spend their token budget on reasoning first — ` +
        `raise the provider's output-token limit or use a non-thinking model/variant.`;
    } else if (refusal) {
      why = `The model refused to answer: ${refusal.slice(0, 200)}`;
    } else if (finish === "content_filter") {
      why = "The provider's content filter blocked the response (finish_reason: content_filter).";
    } else {
      why =
        `The response contained no assistant text (finish_reason: ${finish}). ` +
        `Check that the base URL points at an OpenAI-compatible /chat/completions endpoint and the model name is right.`;
    }
    throw new AiClientError(
      `AI response had no assistant message content. ${why} Response: ${rawText.slice(0, 300)}`,
      { status: 0, endpoint }
    );
  }

  const usage: TokenUsage | null =
    rawUsage &&
    (rawUsage.prompt_tokens !== undefined ||
      rawUsage.completion_tokens !== undefined ||
      rawUsage.total_tokens !== undefined)
      ? {
          promptTokens: rawUsage.prompt_tokens ?? 0,
          completionTokens: rawUsage.completion_tokens ?? 0,
          totalTokens: rawUsage.total_tokens ?? 0,
        }
      : null;

  return { content, usage };
}

/**
 * Calls `POST {baseUrl}/chat/completions` with the standard OpenAI request
 * shape (`{ model, messages, ... }`) and returns the first choice's
 * assistant text plus token usage when the provider reports it.
 *
 * No `response_format`/`tools` are ever sent — `messages` must already
 * contain plain prompted instructions asking for whatever shape of answer
 * the caller wants; use `parse.ts` to pull structured data back out of the
 * returned text.
 */
/** Retries for a transient failure, after the first attempt. */
const TRANSIENT_RETRIES = 3;
/** Wait before retry n (0-based) when the provider gives no `Retry-After`: 2 s, 5 s, 12 s. */
const RETRY_DELAYS_MS = [2_000, 5_000, 12_000];
/** Longest `Retry-After` honoured; a provider asking for more is treated as a hard failure. */
const MAX_RETRY_AFTER_MS = 60_000;

function isTransientStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** `Retry-After` in ms (seconds or an HTTP date), or `undefined`. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function chatCompletion(
  config: AiProviderConfig,
  messages: ChatMessage[],
  options: ChatCompletionOptions = {}
): Promise<ChatCompletionResult> {
  const endpoint = buildEndpoint(config.baseUrl);

  if (messages.length === 0) {
    throw new AiClientError("chatCompletion requires at least one message", {
      status: 0,
      endpoint,
    });
  }

  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages,
  };
  if (options.temperature !== undefined) requestBody.temperature = options.temperature;
  if (options.maxTokens !== undefined) requestBody.max_tokens = options.maxTokens;

  // Each adaptation happens at most once, and transient failures are retried
  // at most TRANSIENT_RETRIES times, so this loop is bounded.
  let transientRetries = 0;
  for (let adaptations = 0; ; adaptations++) {
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(endpoint, {
        dispatcher: getAiDispatcher(),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: options.signal,
      });
    } catch (err) {
      if (!options.signal?.aborted && transientRetries < TRANSIENT_RETRIES) {
        await sleep(RETRY_DELAYS_MS[transientRetries++], options.signal);
        adaptations--;
        continue;
      }
      throw new AiClientError(
        `AI request failed (network error${transientRetries > 0 ? `, after ${transientRetries} retries` : ""}): ${err instanceof Error ? err.message : String(err)}`,
        { status: 0, endpoint, cause: err }
      );
    }

    const rawText = await response.text();

    if (!response.ok && isTransientStatus(response.status) && transientRetries < TRANSIENT_RETRIES) {
      const wait = retryAfterMs(response.headers.get("retry-after")) ?? RETRY_DELAYS_MS[transientRetries];
      if (wait <= MAX_RETRY_AFTER_MS) {
        transientRetries++;
        await sleep(wait, options.signal);
        adaptations--;
        continue;
      }
    }

    if (!response.ok) {
      if (response.status === 400 && adaptations < 2) {
        if ("temperature" in requestBody && /temperature/i.test(rawText)) {
          delete requestBody.temperature;
          continue;
        }
        if ("max_tokens" in requestBody && /max_completion_tokens|max_tokens/i.test(rawText)) {
          requestBody.max_completion_tokens = requestBody.max_tokens;
          delete requestBody.max_tokens;
          continue;
        }
      }
      const retried = transientRetries > 0 ? ` after ${transientRetries} retr${transientRetries === 1 ? "y" : "ies"}` : "";
      throw new AiClientError(`AI request failed (${response.status})${retried}: ${rawText.slice(0, 500)}`, {
        status: response.status,
        endpoint,
      });
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawText);
    } catch (err) {
      throw new AiClientError(
        `AI response was not valid JSON (${response.status}): ${rawText.slice(0, 500)}`,
        { status: response.status, endpoint, cause: err }
      );
    }

    return extractResult(parsedBody, endpoint, rawText);
  }
}
