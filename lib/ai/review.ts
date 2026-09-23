// Per-component change review — one LLM call per touched component. Sits
// on top of the generic client (`client.ts`),
// parser (`parse.ts`) and budget helper (`budget.ts`):
//
//   build prompt (prompts.ts) -> fit related-code context -> split the diff
//   into budget-sized chunks -> one chat call per chunk -> extractJson ->
//   validate/normalize -> merge.
//
// A diff that fits the budget is one chunk and one call, exactly as before.
// A bigger one is reviewed in several parts instead of being cut off; only
// past MAX_CHUNKS does anything get truncated.
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
import { buildSystemPrompt, buildUserMessage, renderRelatedSections } from "./prompts";
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

/** A component one DEPENDS_ON hop away from the reviewed one. */
export interface ReviewNeighbor {
  name: string;
  description?: string;
  /** `dependsOn`: the reviewed component depends on it. `dependent`: it depends on the reviewed component. */
  direction: "dependsOn" | "dependent";
}

/** A file in another component that the changed files import, or that imports them. */
export interface ReviewRelatedFile {
  path: string;
  componentName: string;
  relation: "imported" | "importer";
  /** One-line declaration signatures, bodies stripped. */
  signatures: string[];
  /** Full source of declarations the diff refers to by name. */
  snippets: Array<{ name: string; code: string }>;
}

/** Extra context beyond the diff, gathered according to the review's effort level. */
export interface ReviewRelatedContext {
  neighbors?: ReviewNeighbor[];
  files?: ReviewRelatedFile[];
}

export interface ReviewInput {
  intent: ReviewIntent;
  component: ReviewComponentContext;
  files: ReviewFileDiff[];
  related?: ReviewRelatedContext;
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
  calls: number; // number of model calls actually made (one per chunk)
  chunks: number; // parts the diff was split into (1 when it fit the budget)
  truncated: boolean; // some diff text was cut to fit the token budget (beyond MAX_CHUNKS)
  parseFailed: boolean; // model output wasn't parseable; `findings` holds one "unknown" fallback
}

export interface ReviewOptions {
  tokenBudget?: number; // default = DEFAULT_TOKEN_BUDGET from budget.ts
  temperature?: number; // default 0.2
  chat?: typeof chatCompletion; // injectable for tests
}

const DEFAULT_TEMPERATURE = 0.2;
const MAX_FINDINGS = 6;
/** Findings kept across all chunks of one component, worst first. */
const MAX_MERGED_FINDINGS = 12;
/** Cost guard: a component's diff is split into at most this many calls; past that, the tail is truncated. */
const MAX_CHUNKS = 6;
/** Share of the budget related-code context may use; the diff gets the rest. */
const RELATED_SHARE = 0.3;
/** Room for the `File:` header and fences each file adds to a chunk. */
const FILE_OVERHEAD_CHARS = 120;
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
 * Reviews one component's change against the stated intent — one model call
 * when the diff fits the budget, one per part when it has to be split.
 * Throws (`AiClientError`) if a call itself fails.
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
      chunks: 0,
      truncated: false,
      parseFailed: false,
    };
  }

  const system = buildSystemPrompt(input.intent.source);

  // Related code first, capped at its share, so the diff's share is known.
  const related = fitRelatedContext(
    input.related,
    Math.floor(budget * RELATED_SHARE) * CHARS_PER_TOKEN
  );
  const base: ReviewInput = { ...input, related };

  // Work out how much of the budget is left for diff text once the system
  // prompt and the non-diff parts of the user message are paid for (the
  // part note is included, as if the diff were going to be split).
  const overheadTokens =
    estimateTokens(system) +
    estimateTokens(
      buildUserMessage(base, { omitPatchText: true, part: { index: MAX_CHUNKS, total: MAX_CHUNKS } })
    ) +
    PROMPT_MARGIN_TOKENS;
  const shareChars = Math.max(
    MIN_PATCH_CHARS_PER_FILE * 4,
    (budget - overheadTokens) * CHARS_PER_TOKEN
  );
  const { chunks, truncated: diffTruncated } = chunkFiles(input.files, shareChars);

  const usage: TokenUsage = { ...ZERO_USAGE };
  const merged: ReviewFinding[] = [];
  let calls = 0;
  let truncated = diffTruncated;
  let parseFailures = 0;

  // Sequential on purpose: the job already runs several components in
  // parallel, and a big component's parts should not multiply that.
  for (let index = 0; index < chunks.length; index++) {
    const files = chunks[index];
    const part = chunks.length > 1 ? { index: index + 1, total: chunks.length } : undefined;
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: buildUserMessage({ ...base, files }, { part }) },
    ];
    const fitted = truncateMessagesToBudget(messages, budget);
    if (fitted !== messages) truncated = true;

    const result = await chat(config, fitted, { temperature });
    calls += 1;
    if (result.usage) {
      usage.promptTokens += result.usage.promptTokens;
      usage.completionTokens += result.usage.completionTokens;
      usage.totalTokens += result.usage.totalTokens;
    }

    const findings = normalizeFindings(
      extractJson(result.content),
      new Set(files.map((f) => f.path))
    );
    if (findings.length > 0) {
      merged.push(...findings);
      continue;
    }
    parseFailures += 1;
    const raw = result.content.trim().slice(0, FALLBACK_TEXT_CHARS);
    merged.push({
      summary: raw || "(The model returned an empty response.)",
      intentMatch: "unknown",
      confidence: 0,
      rationale:
        "Model output could not be parsed as structured JSON" +
        (part ? ` (diff part ${part.index} of ${part.total}).` : "."),
    });
  }

  return {
    findings: capFindings(merged),
    usage,
    calls,
    chunks: chunks.length,
    truncated,
    parseFailed: parseFailures > 0,
  };
}

/** Keeps at most MAX_MERGED_FINDINGS, preferring the most severe, in their original order. */
function capFindings(findings: ReviewFinding[]): ReviewFinding[] {
  if (findings.length <= MAX_MERGED_FINDINGS) return findings;
  const rank: Record<IntentMatch, number> = { mismatch: 0, partial: 1, unknown: 2, match: 3 };
  const keep = new Set(
    findings
      .map((finding, index) => ({ finding, index }))
      .sort(
        (a, b) =>
          rank[a.finding.intentMatch] - rank[b.finding.intentMatch] ||
          b.finding.confidence - a.finding.confidence ||
          a.index - b.index
      )
      .slice(0, MAX_MERGED_FINDINGS)
      .map(({ index }) => index)
  );
  return findings.filter((_, index) => keep.has(index));
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
// Related-code context
// ---------------------------------------------------------------------------

/**
 * Trims related context to `maxChars` of rendered prompt text, dropping the
 * most expensive and least essential parts first: source snippets (from the
 * last file backwards), then whole files' signatures, then neighbour
 * descriptions.
 */
function fitRelatedContext(
  related: ReviewRelatedContext | undefined,
  maxChars: number
): ReviewRelatedContext | undefined {
  if (!related) return undefined;
  const size = (ctx: ReviewRelatedContext) => renderRelatedSections(ctx).length;
  const ctx: ReviewRelatedContext = {
    neighbors: related.neighbors?.map((n) => ({ ...n })),
    files: related.files?.map((f) => ({ ...f, snippets: [...f.snippets] })),
  };
  if (size(ctx) <= maxChars) return ctx;

  for (let i = (ctx.files?.length ?? 0) - 1; i >= 0 && size(ctx) > maxChars; i--) {
    const file = ctx.files![i];
    while (file.snippets.length > 0 && size(ctx) > maxChars) file.snippets.pop();
  }
  while ((ctx.files?.length ?? 0) > 0 && size(ctx) > maxChars) ctx.files!.pop();
  if (size(ctx) > maxChars && ctx.neighbors) {
    ctx.neighbors = ctx.neighbors.map(({ name, direction }) => ({ name, direction }));
  }
  while ((ctx.neighbors?.length ?? 0) > 0 && size(ctx) > maxChars) ctx.neighbors!.pop();
  return ctx;
}

// ---------------------------------------------------------------------------
// Diff chunking / truncation
// ---------------------------------------------------------------------------

function hasPatchText(file: ReviewFileDiff): boolean {
  return typeof file.patch === "string" && file.patch.trim().length > 0;
}

/**
 * Splits a component's changed files into parts that each fit `shareChars`
 * of diff text, keeping whole hunks together and files in order. A diff
 * that already fits comes back as a single part, unchanged.
 *
 * A single hunk larger than a whole part is cut to a line-boundary prefix
 * (with a marker). More than MAX_CHUNKS parts are not made: the remainder is
 * folded into the last part and truncated the old way, water-filled across
 * its files.
 */
function chunkFiles(
  files: ReviewFileDiff[],
  shareChars: number
): { chunks: ReviewFileDiff[][]; truncated: boolean } {
  const total = files.reduce((sum, f) => sum + (hasPatchText(f) ? f.patch!.length : 0), 0);
  if (total <= shareChars) return { chunks: [files], truncated: false };

  // Parts as file index -> the hunks of that file in the part.
  const parts: Array<Map<number, string[]>> = [];
  let current = new Map<number, string[]>();
  let used = 0;
  let truncated = false;

  files.forEach((file, fileIndex) => {
    if (!hasPatchText(file)) {
      // No diff text to split: the header rides along in the first part.
      const first = parts[0] ?? current;
      first.set(fileIndex, first.get(fileIndex) ?? []);
      return;
    }
    for (let hunk of file.patch!.split(/^(?=@@ )/m)) {
      const overhead = current.has(fileIndex) ? 0 : FILE_OVERHEAD_CHARS;
      if (used + overhead + hunk.length > shareChars && current.size > 0) {
        parts.push(current);
        current = new Map();
        used = 0;
      }
      if (hunk.length + FILE_OVERHEAD_CHARS > shareChars) {
        hunk = keepWholeHunks(hunk, Math.max(MIN_PATCH_CHARS_PER_FILE, shareChars - FILE_OVERHEAD_CHARS));
        truncated = true;
      }
      const hunks = current.get(fileIndex) ?? [];
      if (!current.has(fileIndex)) used += FILE_OVERHEAD_CHARS;
      hunks.push(hunk);
      current.set(fileIndex, hunks);
      used += hunk.length;
    }
  });
  if (current.size > 0) parts.push(current);

  const toFiles = (part: Map<number, string[]>): ReviewFileDiff[] =>
    [...part.entries()]
      .sort(([a], [b]) => a - b)
      .map(([fileIndex, hunks]) =>
        hunks.length === 0 ? files[fileIndex] : { ...files[fileIndex], patch: hunks.join("") }
      );

  if (parts.length <= MAX_CHUNKS) return { chunks: parts.map(toFiles), truncated };

  // Over the cap: merge the tail into the last allowed part and truncate it.
  const head = parts.slice(0, MAX_CHUNKS - 1).map(toFiles);
  const tail = new Map<number, string[]>();
  for (const part of parts.slice(MAX_CHUNKS - 1)) {
    for (const [fileIndex, hunks] of part) {
      tail.set(fileIndex, [...(tail.get(fileIndex) ?? []), ...hunks]);
    }
  }
  const { files: last } = truncatePatchesToShare(toFiles(tail), shareChars);
  return { chunks: [...head, last], truncated: true };
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
 * hunks' own section headings — a "smarter pre-summarization" that's still
 * owed, short of an actual second model call (which the "one call per
 * component" design deliberately rules out spending on every oversized file).
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
