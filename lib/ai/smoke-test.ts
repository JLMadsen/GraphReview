/**
 * Smoke test for lib/ai's output parser and token-budget helper.
 *
 *   npx tsx lib/ai/smoke-test.ts
 *
 * `client.ts` has no live OpenAI-compatible endpoint to test against here —
 * it's checked by hand against the OpenAI chat-completions request/response
 * shape instead (see README.md). This exercises the parts that run
 * entirely offline: `extractJson` (§9's "robust parser") against realistic
 * model-output fixtures, and `truncateMessagesToBudget`.
 */
import { extractJson } from "./parse";
import { truncateMessagesToBudget, estimateTokens, DEFAULT_TOKEN_BUDGET } from "./budget";
import type { ChatMessage } from "./types";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function main(): void {
  console.log("extractJson:");

  // --- clean JSON, no fences, no prose ---
  const clean = extractJson<{ summary: string; concern: boolean }>(
    `{"summary": "Renamed helper, no behavior change", "concern": false}`
  );
  check("clean JSON object", clean?.summary === "Renamed helper, no behavior change" && clean.concern === false);

  const cleanArray = extractJson<number[]>(`[1, 2, 3]`);
  check("clean JSON array", Array.isArray(cleanArray) && cleanArray.length === 3 && cleanArray[1] === 2);

  // --- JSON inside a ```json fenced block ---
  const fenced = extractJson<{ filePath: string; lineRange: [number, number] }>(
    [
      "Here's my analysis of the change:",
      "",
      "```json",
      '{"filePath": "src/auth/token.ts", "lineRange": [12, 40]}',
      "```",
      "",
      "Let me know if you need more detail.",
    ].join("\n")
  );
  check(
    "JSON in a ```json fenced block",
    fenced?.filePath === "src/auth/token.ts" &&
      Array.isArray(fenced.lineRange) &&
      fenced.lineRange[0] === 12 &&
      fenced.lineRange[1] === 40
  );

  // --- JSON inside a plain (unlabeled) fenced block ---
  const plainFence = extractJson<{ ok: boolean }>("prose before\n```\n{\"ok\": true}\n```\nprose after");
  check("JSON in a plain ``` fenced block", plainFence?.ok === true);

  // --- JSON with surrounding prose, no fence at all ---
  const proseWrapped = extractJson<{ summary: string; concern: boolean; rationale: string }>(
    `Sure, here's the intent check for this component: {"summary": "Adds input validation", "concern": true, "rationale": "The PR description doesn't mention this new validation path."} Hope that helps!`
  );
  check(
    "JSON with surrounding prose, no fence",
    proseWrapped?.summary === "Adds input validation" &&
      proseWrapped.concern === true &&
      proseWrapped.rationale.includes("validation path")
  );

  // --- prose containing literal braces before the real JSON ---
  const literalBraces = extractJson<{ real: boolean }>(
    `The template uses "{{placeholder}}" syntax. Anyway, here's the result: {"real": true}`
  );
  check("literal braces in prose don't desync brace matching", literalBraces?.real === true);

  // --- nested JSON ---
  const nested = extractJson<{ finding: { summary: string; tags: string[] } }>(
    `{"finding": {"summary": "looks fine", "tags": ["auth", "low-risk"]}}`
  );
  check(
    "nested object/array JSON",
    nested?.finding?.summary === "looks fine" &&
      Array.isArray(nested?.finding?.tags) &&
      nested?.finding?.tags.length === 2
  );

  // --- garbage / no JSON at all ---
  const garbage = extractJson("I think this change looks reasonable overall, no concerns here.");
  check("garbage text returns null", garbage === null);

  const empty = extractJson("");
  check("empty string returns null", empty === null);

  const malformed = extractJson("```json\n{summary: 'missing quotes, not valid JSON'}\n```");
  check("malformed JSON-looking text returns null (never throws)", malformed === null);

  const bareLiteral = extractJson("true");
  check("bare non-object/array JSON literal returns null", bareLiteral === null);

  // --- unescaped inner quotes (observed from smaller/local models, e.g. Ollama) ---
  const innerQuote = extractJson<{ rationale: string }>(
    '```json\n{"rationale": "adds console.log("TESTING") for debugging"}\n```'
  );
  check(
    "unescaped quote inside a string value is repaired, not lost",
    innerQuote?.rationale === 'adds console.log("TESTING") for debugging'
  );

  const innerQuoteMultiField = extractJson<{ filePath: string; summary: string; rationale: string }>(
    '{"filePath":"a.ts","summary":"Added a console log for testing purposes.","rationale":"The change adds a `console.log("TESTING")` line at line 449."}'
  );
  check(
    "unescaped inner quote repair works alongside other fields",
    innerQuoteMultiField?.filePath === "a.ts" &&
      innerQuoteMultiField?.summary === "Added a console log for testing purposes." &&
      innerQuoteMultiField?.rationale === 'The change adds a `console.log("TESTING")` line at line 449.'
  );

  const properlyEscaped = extractJson<{ text: string }>('{"text": "already \\"escaped\\" quotes"}');
  check(
    "properly-escaped quotes are untouched (repair only runs after a parse failure)",
    properlyEscaped?.text === 'already "escaped" quotes'
  );

  console.log("\nbudget:");

  check("estimateTokens ~ 4 chars/token", estimateTokens("abcd".repeat(10)) === 10);

  const small: ChatMessage[] = [
    { role: "system", content: "You are a reviewer." },
    { role: "user", content: "short diff" },
  ];
  const untouched = truncateMessagesToBudget(small, DEFAULT_TOKEN_BUDGET);
  check("messages already under budget pass through unchanged", untouched === small);

  const bigContext = "x".repeat(4 * DEFAULT_TOKEN_BUDGET); // ~budget tokens on its own
  const oversized: ChatMessage[] = [
    { role: "system", content: "You are a reviewer. Respond with JSON only." },
    { role: "user", content: "old, less relevant context: " + bigContext },
    { role: "user", content: "most recent, specific diff hunk for this component" },
  ];
  const truncated = truncateMessagesToBudget(oversized, 500);
  const truncatedTotal = truncated.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  check("truncated result fits the budget", truncatedTotal <= 500, `got ${truncatedTotal} tokens`);
  check(
    "system message always kept",
    truncated.some((m) => m.role === "system" && m.content === "You are a reviewer. Respond with JSON only.")
  );
  check(
    "last (most recent) message survives, oldest context dropped first",
    truncated.some((m) => m.content.includes("most recent, specific diff hunk")) &&
      !truncated.some((m) => m.content.includes("old, less relevant context"))
  );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
