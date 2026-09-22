// Per-component change review — §9 of docs/DESIGN.md ("one LLM call per
// touched component"). Sits on top of the generic client (`client.ts`),
// parser (`parse.ts`) and budget helper (`budget.ts`):
//
//   build prompt (prompts.ts) -> per-file hunk truncation -> message-level
//   budget fit -> ONE chat call -> extractJson -> validate/normalize.
//
// Errors from the chat call (`AiClientError`) are deliberately NOT caught —
// the calling job decides how to record a failed component. Only *model
// output* problems (unparseable/invalid JSON) are handled here, via a single
// `unknown` fallback finding and `parseFailed: true`.

import { chatCompletion } from "./client";
import { extractJson } from "./parse";
import {
  CHARS_PER_TOKEN,
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  truncateMessagesToBudget,
} from "./budget";
import { buildSystemPrompt, buildUserMessage } from "./prompts";
import type { AiProviderConfig, ChatMessage, TokenUsage } from "./types";

export interface ReviewIntent {
  source: "pull_request" | "ref_comparison";
  title?: string; // PR title
  body?: string; // PR description
  linkedIssues?: Array<{ number: number; title: string; body?: string }>;
}

export interface ReviewComponentContext {
  id: string;
  name: string;
  description?: string;
  dependsOn: string[]; // names of components this one depends on
  dependents: string[]; // names of components that depend on it
}

export interface ReviewFileDiff {
  path: string;
  status?: string; // added | modified | removed | renamed ...
  additions?: number;
  deletions?: number;
  patch?: string; // unified-diff text; absent for binary / oversized files
}

export interface ReviewInput {
  intent: ReviewIntent;
  component: ReviewComponentContext;
  files: ReviewFileDiff[];
}

export type IntentMatch = "match" | "partial" | "mismatch" | "unknown";

export interface ReviewFinding {
  filePath?: string; // MUST be one of the input file paths, else omitted
  lineRange?: string; // e.g. "12-18"
  summary: string; // plain-English: what this change does
  intentMatch: IntentMatch;
  confidence: number; // clamped to 0..1
  rationale: string; // why; for partial/mismatch cite the specific code/identifiers
}

export interface ReviewResult {
  findings: ReviewFinding[];
  usage: TokenUsage; // summed over all model calls made (zeros if none)
  calls: number; // number of model calls actually made (0 or 1)
  truncated: boolean; // some diff text was cut to fit the token budget
  parseFailed: boolean; // model output wasn't parseable; `findings` holds one "unknown" fallback
}

export interface ReviewOptions {
  tokenBudget?: number; // default = DEFAULT_TOKEN_BUDGET from budget.ts
  temperature?: number; // default 0.2
  chat?: typeof chatCompletion; // injectable for tests
}

const DEFAULT_TEMPERATURE = 0.2;
const MAX_FINDINGS = 6;
const MAX_SUMMARY_CHARS = 600;
const MAX_RATIONALE_CHARS = 1500;
const FALLBACK_TEXT_CHARS = 400;
const DIFF_TRUNCATED_MARKER = "[diff truncated]";
/** Slack for the fence lines/labels that wrap each diff, plus the model's own framing. */
const PROMPT_MARGIN_TOKENS = 48;
/** Even under a tiny budget every patch keeps at least this much, so the model always sees something. */
const MIN_PATCH_CHARS_PER_FILE = 200;
// Generous on purpose: a reasoning ("thinking") model can take 10+ seconds to
// answer even "ok" (observed: ~11 s against Gemini), and a timeout here reads
// as "your provider is broken" when it is merely slow.
const PING_TIMEOUT_MS = 60_000;

const INTENT_MATCHES: readonly IntentMatch[] = ["match", "partial", "mismatch", "unknown"];

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * Reviews one component's change against the stated intent with a single
 * model call. Throws (`AiClientError`) if the call itself fails.
 */
export async function reviewComponentChange(
  config: AiProviderConfig,
  input: ReviewInput,
  options: ReviewOptions = {}
): Promise<ReviewResult> {
  const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const chat = options.chat ?? chatCompletion;

  if (!input.files.some(hasPatchText)) {
    return {
      findings: [
        {
          summary:
            "The diff text for this component's changed files was unavailable (binary or oversized files), so the change could not be reviewed.",
          intentMatch: "unknown",
          confidence: 0,
          rationale:
            "No patch text was provided for any changed file, so no model call was made.",
        },
      ],
      usage: { ...ZERO_USAGE },
      calls: 0,
      truncated: false,
      parseFailed: false,
    };
  }

  const system = buildSystemPrompt(input.intent.source);

  // Per-file hunk truncation (§9), BEFORE the message-level fit: work out how
  // much of the budget is left for diff text once the system prompt and the
  // non-diff parts of the user message are paid for.
  const overheadTokens =
    estimateTokens(system) +
    estimateTokens(buildUserMessage(input, { omitPatchText: true })) +
    PROMPT_MARGIN_TOKENS;
  const shareChars = Math.max(0, budget - overheadTokens) * CHARS_PER_TOKEN;
  const { files, truncated: diffTruncated } = truncatePatchesToShare(input.files, shareChars);

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: buildUserMessage({ ...input, files }) },
  ];
  const fitted = truncateMessagesToBudget(messages, budget);
  const truncated = diffTruncated || fitted !== messages;

  const result = await chat(config, fitted, { temperature });
  const usage: TokenUsage = result.usage ? { ...result.usage } : { ...ZERO_USAGE };

  const parsed = extractJson(result.content);
  const findings = normalizeFindings(parsed, new Set(input.files.map((f) => f.path)));

  if (findings.length === 0) {
    const raw = result.content.trim().slice(0, FALLBACK_TEXT_CHARS);
    return {
      findings: [
        {
          summary: raw || "(The model returned an empty response.)",
          intentMatch: "unknown",
          confidence: 0,
          rationale: "Model output could not be parsed as structured JSON.",
        },
      ],
      usage,
      calls: 1,
      truncated,
      parseFailed: true,
    };
  }

  return { findings, usage, calls: 1, truncated, parseFailed: false };
}

/** Cheap "does this provider config work" probe: one tiny chat call. Never throws. */
export async function pingProvider(
  config: AiProviderConfig,
  options: { chat?: typeof chatCompletion } = {}
): Promise<{ ok: boolean; latencyMs: number; error?: string; model?: string }> {
  const chat = options.chat ?? chatCompletion;
  const started = Date.now();
  try {
    // No `maxTokens` and no `temperature`: this only has to prove the endpoint,
    // key and model answer. A 16-token cap made reasoning models (Gemini)
    // spend the whole budget thinking and return no text, so a perfectly
    // working provider failed the test; a fixed temperature is rejected by
    // OpenAI's o-series. The reply is one word either way.
    await chat(
      config,
      [{ role: "user", content: "Reply with the single word: ok" }],
      { signal: AbortSignal.timeout(PING_TIMEOUT_MS) }
    );
    return { ok: true, latencyMs: Date.now() - started, model: config.model };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      model: config.model,
    };
  }
}

// ---------------------------------------------------------------------------
// Diff truncation
// ---------------------------------------------------------------------------

function hasPatchText(file: ReviewFileDiff): boolean {
  return typeof file.patch === "string" && file.patch.trim().length > 0;
}

/**
 * If the combined patches exceed `shareChars`, keeps whole hunks (split on
 * `@@` headers) in order per file until each file's allowance is used, and
 * appends a `[diff truncated]` marker. Allowances are water-filled: small
 * patches keep everything and the space they don't need is redistributed to
 * the larger ones, so one huge file can't starve the rest.
 */
function truncatePatchesToShare(
  files: ReviewFileDiff[],
  shareChars: number
): { files: ReviewFileDiff[]; truncated: boolean } {
  const total = files.reduce((sum, f) => sum + (hasPatchText(f) ? f.patch!.length : 0), 0);
  if (total <= shareChars) return { files, truncated: false };

  const order = files
    .map((file, index) => ({ index, length: hasPatchText(file) ? file.patch!.length : 0 }))
    .filter((entry) => entry.length > 0)
    .sort((a, b) => a.length - b.length);

  const out = files.slice();
  let remaining = shareChars;
  let left = order.length;
  let truncated = false;

  for (const { index, length } of order) {
    const allowance = Math.max(MIN_PATCH_CHARS_PER_FILE, Math.floor(remaining / left));
    left--;
    if (length <= allowance) {
      remaining -= length;
      continue;
    }
    const patch = keepWholeHunks(files[index].patch!, allowance);
    out[index] = { ...files[index], patch };
    remaining -= patch.length;
    truncated = true;
  }

  return { files: out, truncated };
}

/**
 * Unified-diff hunk headers carry an optional trailing "section heading" —
 * `@@ -12,7 +12,9 @@ function handleSubmit() {` — that git's own diff
 * driver derives from the nearest preceding function/class/method signature.
 * When a hunk gets dropped for length, this is the cheapest possible signal
 * of *what* was dropped: no extra model call, no extra cost, just reading
 * text `git diff` already generated. Empty when the driver found no
 * enclosing declaration (e.g. top-of-file changes, or a language git's
 * default heuristics don't know).
 */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[ \t]*(.*)$/;

function hunkHeading(hunk: string): string {
  return HUNK_HEADER.exec(hunk.split("\n", 1)[0])?.[1]?.trim() ?? "";
}

/**
 * A short, cheap summary of what a truncation dropped, built purely from the
 * hunks' own section headings — the "smarter pre-summarization" §9 flagged
 * as owed, short of an actual second model call (which §9's "one call per
 * component" deliberately rules out spending on every oversized file).
 * Named headings are deduped and capped; anonymous ones (no heading) just
 * add to the trailing "+N more" count so they aren't silently invisible.
 */
const MAX_NAMED_HEADINGS = 3;

function summarizeDropped(droppedHunks: string[]): string {
  if (droppedHunks.length === 0) return DIFF_TRUNCATED_MARKER;

  const headingOf = droppedHunks.map(hunkHeading);
  const uniqueHeadings = [...new Set(headingOf.filter((h) => h.length > 0))];
  const named = uniqueHeadings.slice(0, MAX_NAMED_HEADINGS);
  const namedSet = new Set(named);

  if (named.length === 0) {
    return `${DIFF_TRUNCATED_MARKER} (${droppedHunks.length} more hunk${droppedHunks.length === 1 ? "" : "s"} omitted)`;
  }
  // Every dropped hunk not represented by one of the named headings above —
  // whether it had no heading at all, or a heading that didn't make the cap —
  // is still real, dropped content, so it's counted rather than silently
  // disappearing. A hunk whose heading *is* named isn't double-counted here,
  // even if another hunk happens to share that same heading.
  const unnamedCount = headingOf.filter((h) => !namedSet.has(h)).length;
  const suffix = unnamedCount > 0 ? `, +${unnamedCount} more hunk${unnamedCount === 1 ? "" : "s"}` : "";
  return `${DIFF_TRUNCATED_MARKER} (also touches: ${named.join(", ")}${suffix})`;
}

/** Keeps leading whole hunks that fit in `maxChars`; if not even the first fits, keeps a line-boundary prefix of it. Appends a summary of what was dropped, built from the dropped hunks' own section headings — see {@link summarizeDropped}. */
function keepWholeHunks(patch: string, maxChars: number): string {
  const hunks = patch.split(/^(?=@@ )/m);
  const kept: string[] = [];
  let used = 0;
  let splitIndex = 0;
  for (; splitIndex < hunks.length; splitIndex++) {
    const hunk = hunks[splitIndex];
    if (used + hunk.length > maxChars) break;
    kept.push(hunk);
    used += hunk.length;
  }

  let text: string;
  let dropped: string[];
  if (kept.length > 0) {
    text = kept.join("");
    dropped = hunks.slice(splitIndex);
  } else {
    const cut = patch.slice(0, maxChars);
    const lastNewline = cut.lastIndexOf("\n");
    text = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
    // The one hunk that didn't fit even partially still counts as dropped,
    // so its heading (if any) still reaches the summary.
    dropped = hunks.slice(0, 1);
  }

  return `${text.replace(/\s+$/, "")}\n${summarizeDropped(dropped)}`;
}

// ---------------------------------------------------------------------------
// Output validation / normalization
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFindings(parsed: unknown, allowedPaths: Set<string>): ReviewFinding[] {
  let entries: unknown[];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed.findings)) {
    entries = parsed.findings;
  } else if (isRecord(parsed) && "summary" in parsed) {
    entries = [parsed]; // model returned a bare finding instead of {"findings":[...]}
  } else {
    return [];
  }

  const findings: ReviewFinding[] = [];
  for (const entry of entries) {
    if (findings.length >= MAX_FINDINGS) break;
    const finding = normalizeFinding(entry, allowedPaths);
    if (finding) findings.push(finding);
  }
  return findings;
}

function normalizeFinding(entry: unknown, allowedPaths: Set<string>): ReviewFinding | null {
  if (!isRecord(entry)) return null;

  const rationaleText = coerceText(entry.rationale);
  const summary = coerceText(entry.summary) || rationaleText;
  if (!summary) return null; // nothing human-readable: junk

  const finding: ReviewFinding = {
    summary: clip(summary, MAX_SUMMARY_CHARS),
    intentMatch: normalizeIntentMatch(entry.intentMatch),
    confidence: normalizeConfidence(entry.confidence),
    rationale: clip(rationaleText || "No rationale provided by the model.", MAX_RATIONALE_CHARS),
  };

  const filePath = normalizeFilePath(entry.filePath, allowedPaths);
  if (filePath) finding.filePath = filePath;

  const lineRange = normalizeLineRange(entry.lineRange);
  if (lineRange) finding.lineRange = lineRange;

  return finding;
}

function coerceText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function normalizeIntentMatch(value: unknown): IntentMatch {
  if (typeof value !== "string") return "unknown";
  const lowered = value.trim().toLowerCase();
  return (INTENT_MATCHES as readonly string[]).includes(lowered) ? (lowered as IntentMatch) : "unknown";
}

/** Clamped to 0..1. A missing/non-numeric value becomes a neutral 0.5 (the model gave no signal either way). */
function normalizeConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** Accepts the path only if it is one of the inputs (tolerating a leading `./`, `/`, `a/` or `b/`); otherwise omitted. */
function normalizeFilePath(value: unknown, allowedPaths: Set<string>): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (allowedPaths.has(raw)) return raw;
  const stripped = raw.replace(/^(?:\.\/|\/|[ab]\/)/, "");
  return allowedPaths.has(stripped) ? stripped : undefined;
}

/** Produces `"12"` or `"12-18"` from strings like `"12-18"`, `"L12-L18"`, `"lines 12 to 18"`, numbers, or `[12, 18]`; else omitted. */
function normalizeLineRange(value: unknown): string | undefined {
  let text: string;
  if (Array.isArray(value)) {
    text = value.filter((v) => typeof v === "number" || typeof v === "string").join("-");
  } else if (typeof value === "number") {
    text = String(value);
  } else if (typeof value === "string") {
    text = value;
  } else {
    return undefined;
  }
  const range = /(\d+)\s*(?:-|–|—|to)\s*L?(\d+)/i.exec(text);
  if (range) return range[1] === range[2] ? range[1] : `${range[1]}-${range[2]}`;
  const single = /\d+/.exec(text);
  return single ? single[0] : undefined;
}
