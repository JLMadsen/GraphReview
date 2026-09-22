// Per-call token budget: the per-call token budget is configurable, with a
// conservative default (e.g. 6-8k input tokens), since local models often
// have much smaller context windows than hosted ones. No real tokenizer
// dependency — just a character-count estimate.

import type { ChatMessage } from "./types";

/** Rough average for English/code text. No provider/model-specific tokenizer — a deliberate simplification. */
export const CHARS_PER_TOKEN = 4;

/** Conservative default input budget (e.g. 6-8k input tokens). */
export const DEFAULT_TOKEN_BUDGET = 7000;

const TRUNCATION_MARKER = "\n…[truncated]";

/** `Math.ceil(text.length / CHARS_PER_TOKEN)` — a cheap stand-in for a real tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Sum of `estimateTokens` over every message's `content`. Role/formatting overhead isn't counted — negligible next to the conservative default budget. */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

/**
 * Truncates a `ChatMessage[]` to fit within `budgetTokens`, trimming from
 * the "least-important end" of the list.
 *
 * What counts as least-important, by design:
 *   - `system` messages are always kept in full, and first. They carry
 *     fixed behavioral instructions (typically short and unrelated to the
 *     size of any particular call's content), not per-call data — nothing
 *     is gained by trimming them, and a lot can break if the model loses
 *     its instructions.
 *   - Among the rest, given the call shape (shared intent context once,
 *     then that component's diff hunks, then structural/neighbor context),
 *     later messages carry more call-specific, load-bearing content than
 *     earlier ones. So the **last** message is kept with highest priority,
 *     and messages are dropped starting from the **front** of the
 *     non-system messages (the oldest/most-generic context) inward.
 *   - If even the single most recent non-system message doesn't fit the
 *     remaining budget on its own, its *content* is truncated (with a
 *     trailing marker) rather than the message being dropped entirely —
 *     returning zero non-system messages would usually make the call
 *     meaningless, whereas a truncated diff hunk is still useful context.
 *
 * Returns the original array unchanged (same reference) when it already
 * fits — cheap to call unconditionally before every `chatCompletion`.
 */
export function truncateMessagesToBudget(
  messages: ChatMessage[],
  budgetTokens: number = DEFAULT_TOKEN_BUDGET
): ChatMessage[] {
  if (messages.length === 0) return messages;
  if (estimateMessagesTokens(messages) <= budgetTokens) return messages;

  const systemMessages = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");

  const systemTokens = estimateMessagesTokens(systemMessages);
  if (systemTokens >= budgetTokens) {
    // Pathological case: even the "always keep" system messages don't fit.
    // Truncate their contents too, splitting the budget evenly, so this
    // still never returns something over budget.
    const per = Math.max(1, Math.floor(budgetTokens / Math.max(1, systemMessages.length)));
    return systemMessages.map((m) => ({ ...m, content: truncateToTokens(m.content, per) }));
  }

  let remaining = budgetTokens - systemTokens;
  const kept: ChatMessage[] = [];

  for (let i = rest.length - 1; i >= 0; i--) {
    const message = rest[i];
    const tokens = estimateTokens(message.content);

    if (tokens <= remaining) {
      kept.unshift(message);
      remaining -= tokens;
      continue;
    }

    if (kept.length === 0) {
      // The most recent message alone doesn't fit — truncate rather than
      // drop it, so a caller never gets back zero call-specific content.
      kept.unshift({ ...message, content: truncateToTokens(message.content, remaining) });
    }
    // Older messages (everything before index i) are dropped: the
    // least-important end of the list.
    break;
  }

  return [...systemMessages, ...kept];
}

function truncateToTokens(text: string, budgetTokens: number): string {
  const maxChars = Math.max(0, budgetTokens * CHARS_PER_TOKEN);
  if (text.length <= maxChars) return text;
  const sliceLen = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return text.slice(0, sliceLen) + TRUNCATION_MARKER;
}
