// Robust structured-output parser for lib/ai — §9 of docs/DESIGN.md.
//
// Because the client never relies on `response_format`/tool-calling (not
// every OpenAI-compatible provider supports it), the model's answer is
// plain text that's *supposed* to contain JSON somewhere in it. This module
// pulls that JSON back out, in three tiers, each a fallback for the last:
//
//   1. A fenced ```json ... ``` code block (tried before a plain ``` ```
//      block, since a model that bothers to label the fence is telling us
//      exactly where the JSON is).
//   2. The first balanced `{...}`/`[...]` span anywhere in the text —
//      brace-matched (not a naive regex), skipping over `{`/`[` that
//      appear inside quoted strings, so prose like `say "{hi}"` around the
//      real JSON doesn't throw off matching.
//   3. `null` — never throw. Malformed model output is an expected case,
//      not an exceptional one; callers decide how to handle a `null`
//      (retry, skip the finding, surface a "couldn't parse" state, etc).
//
// Each tier can yield more than one candidate (e.g. several fenced blocks,
// or several balanced spans starting at different `{`); every candidate is
// tried with `JSON.parse` in document order and the first one that parses
// wins. This keeps the "first JSON-looking span" contract even when an
// earlier candidate merely *looks* like JSON but isn't valid (e.g. uses
// single quotes, or is truncated).

const FENCED_JSON_BLOCK = /```json[ \t]*\r?\n([\s\S]*?)```/gi;
const FENCED_BLOCK = /```[ \t]*\w*[ \t]*\r?\n([\s\S]*?)```/g;

const OPENERS: Record<string, string> = { "{": "}", "[": "]" };
const CLOSERS = new Set(Object.values(OPENERS));

/**
 * Extracts and parses the first JSON value found in `text`, trying (in
 * order) fenced ```json blocks, any other fenced block, then a raw
 * brace-matched span. Returns `null` if nothing in `text` parses as JSON —
 * this function never throws.
 */
export function extractJson<T = unknown>(text: string): T | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;

  for (const candidate of candidatesFromFences(text, FENCED_JSON_BLOCK)) {
    const parsed = tryParse<T>(candidate);
    if (parsed !== null) return parsed;
  }

  for (const candidate of candidatesFromFences(text, FENCED_BLOCK)) {
    const parsed = tryParse<T>(candidate);
    if (parsed !== null) return parsed;
  }

  for (const candidate of candidatesFromSpans(text)) {
    const parsed = tryParse<T>(candidate);
    if (parsed !== null) return parsed;
  }

  return null;
}

function tryParse<T>(candidate: string): T | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  try {
    const value = JSON.parse(trimmed) as T;
    // `JSON.parse` happily accepts bare literals like `"true"` or `"42"`;
    // those aren't the "structured data" this module exists to recover, so
    // only accept object/array results.
    if (value === null || typeof value !== "object") return null;
    return value;
  } catch {
    return null;
  }
}

function* candidatesFromFences(text: string, pattern: RegExp): Generator<string> {
  const re = new RegExp(pattern);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    yield match[1];
    if (match[0].length === 0) re.lastIndex++; // guard against zero-width matches looping forever
  }
}

/**
 * Yields every balanced `{...}`/`[...]` substring starting at each opening
 * bracket in `text`, in document order. Bracket matching ignores
 * brackets that appear inside `"..."`/`'...'` string literals (with `\`
 * escaping), so prose containing literal braces doesn't desync the scan.
 * A span that never closes, or whose brackets don't nest cleanly, is
 * skipped rather than yielded.
 */
function* candidatesFromSpans(text: string): Generator<string> {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      const span = extractBalancedSpan(text, i);
      if (span) yield span;
    }
  }
}

function extractBalancedSpan(text: string, start: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let stringChar = "";
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch in OPENERS) {
      stack.push(OPENERS[ch]);
      continue;
    }

    if (CLOSERS.has(ch)) {
      if (stack.length === 0 || stack[stack.length - 1] !== ch) return null; // mismatched
      stack.pop();
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }

  return null; // never closed
}
