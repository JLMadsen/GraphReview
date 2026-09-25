# lib/ai

> `lib/ai/` OpenAI-compatible client wrapper, output parser, token-budget helper, per-component change review, AI-assisted labeling, mock AI server

Because a fully generic OpenAI-compatible endpoint is required, the
integration **does not rely on `response_format` or tool-calling** for
structured output, since these aren't universally supported (e.g. by some
Ollama/LM Studio setups). Output uses plain prompted instructions with a
robust parser (fenced-JSON extraction plus a fallback). The per-call token
budget is configurable, with a conservative default (e.g. 6-8k input
tokens), since local models often have much smaller context windows than
hosted ones.

## Scope (current)

This is the library layer only — the job/API/UI that fans reviews out per
touched component lives elsewhere and calls `reviewComponentChange`. What's
here:

- `client.ts` — `chatCompletion(config, messages, options?)`: a generic
  OpenAI-compatible chat-completions client (base URL + API key + model
  name, all user-configured — never hardcoded to one provider). Sends the
  standard `{ model, messages, ... }` request shape, never
  sets `response_format`/`tools`, and returns the assistant's text plus
  token usage when the provider reports it.
  Requests use undici's `fetch` with its own dispatcher, so the
  `AI_REQUEST_TIMEOUT_MS` limit (default 30 min, `0` = none) applies instead
  of Node's built-in 5-minute wait for response headers, which slow local
  models exceed.
- `parse.ts` — `extractJson<T>(text)`: pulls a JSON object/array back out of
  a model's plain-text response. Tries a fenced ` ```json ` block, then any
  other fenced block, then the first brace-matched `{...}`/`[...]` span in
  the text, then gives up and returns `null`. Never throws.
- `budget.ts` — `truncateMessagesToBudget(messages, budgetTokens?)`: a
  character-count token estimate (`CHARS_PER_TOKEN = 4`, no real tokenizer
  dependency) plus a helper that trims a `ChatMessage[]` down to
  `DEFAULT_TOKEN_BUDGET` (7000) tokens, documented in-file for exactly what
  "least-important" means for the message shape this library expects.
- `types.ts` — `AiProviderConfig`, `ChatMessage`, `ChatCompletionResult`,
  `TokenUsage`.
- `errors.ts` — `AiClientError`, mirroring `lib/github/errors.ts`'s shape
  (status + endpoint + original error as `cause`).
- `smoke-test.ts` — `npx tsx lib/ai/smoke-test.ts`: exercises `parse.ts`
  against realistic model-output fixtures (clean JSON, fenced JSON, JSON
  buried in prose, garbage) and a couple of `budget.ts` sanity checks.
  `client.ts` has no live provider to test against here — it's covered by
  careful typing against the OpenAI chat-completions request/response shape
  instead, not by a live call.
- `effort.ts` — the four review effort levels (low/medium/high/max: 7k/16k/
  32k/128k tokens per call) and what context each adds (neighbour
  descriptions, related-file signatures, referenced source). The context
  itself is gathered by `lib/jobs/review-context.ts`.
- `prompts.ts` — `buildSystemPrompt(source)` / `buildUserMessage(input)`.
  Plain-prompted output only (no `response_format`, no tool-calling): the
  model must answer with exactly one ```` ```json ```` block of
  `{"findings":[{filePath,lineRange,summary,intentMatch,confidence,rationale}]}`.
  The system prompt defines `intentMatch` (`match` / `partial` /
  `mismatch` = contradicts the intent *or* an apparent defect / `unknown`),
  caps findings at 6, and — for `ref_comparison` (no PR) — tells the model
  to judge against the code's own evident purpose. The user message has a
  stable labelled layout: `## Intent`, `## Component` (with an exact
  `Component: <name>` line, description, depends-on / depended-on-by), then
  `## Changed files` with `File: <path> (<status>, +A/-D)` followed by the
  patch in a fenced diff block. Free-text PR bodies are quoted (`> `) so
  they can't forge label lines. The mock server parses this layout.
- `review.ts` — `reviewComponentChange(config, input, options?)` and
  `pingProvider(config, options?)`, plus the `Review*` / `IntentMatch`
  types. One model call per component:
  1. If no file has patch text (binary/oversized) -> **no call**, one
     `unknown` finding, `calls: 0`, zero usage.
  2. Per-file diff truncation before the message-level fit: if the
     combined patches exceed the budget share (budget minus system prompt
     and non-diff prompt text), whole `@@` hunks are kept in order per file
     (allowances are water-filled so a huge file can't starve small ones)
     and a `[diff truncated]` marker is appended -> `truncated: true`.
     `truncateMessagesToBudget` then runs as the final backstop.
  3. One `chat` call (`temperature` default 0.2), `extractJson`, then
     per-finding validation: `intentMatch` outside the four values ->
     `unknown`; `confidence` clamped to 0..1 (missing/non-numeric -> 0.5);
     `filePath` not among the input paths is dropped; `lineRange` normalized
     to `"12"` / `"12-18"`; non-string fields coerced; junk entries ignored;
     max 6 findings. If nothing valid remains: `parseFailed: true` and a
     single `unknown` fallback finding holding the first ~400 chars of the
     raw reply.
  4. Errors from the chat call (`AiClientError`) **propagate** — the calling
     job decides how to record a failed component.

  `pingProvider` makes one tiny chat call and returns
  `{ ok, latencyMs, error?, model? }`; it never throws. `options.chat`
  injects a fake `chatCompletion` for tests.
- `label.ts` — `labelComponents(config, input, options?)` (plus the two
  phases on their own, `labelDomains` / `describeModules`) — the
  **AI-assisted labeling**, which is what populates the domain
  tier that folder structure alone cannot infer. Two tasks, each
  marked in its system prompt so the mock can recognise it:
  1. `TASK: label-domains` — one call. Input is the repo name, an optional
     README excerpt and every module (`{id, name, fileCount, sampleFiles≤3,
     dependsOn≤5}`); output `{"domains":[{name, description, moduleIds}]}`.
     Normalisation guarantees a **total, disjoint** assignment: names
     trimmed and case-insensitively merged, unknown/duplicate members
     dropped, at most `MAX_DOMAINS` (8) domains (the largest survive), empty
     domains dropped, and every module the model forgot lands in `Other`.
     If the reply names domains but leaves modules unassigned (small models
     such as gemma3:4b drop the member lists), one follow-up
     `TASK: assign-modules` call asks for a flat `{"assignments":{ref: name}}`
     map instead. Unparseable output -> no domains + `parseFailed`; the
     start of every unusable reply is returned in `unusableReplies` for the
     job log.
  2. `TASK: describe-modules` — batches of `DEFAULT_DESCRIPTION_BATCH` (25)
     modules per call; output `{"modules":[{id, description}]}`. One
     sentence each, collapsed to one line and clipped to 160 chars at a word
     boundary. Unknown ids dropped; a module the model skipped simply gets
     no description; a batch that fails to parse costs only that batch.

  Modules are referenced on the wire by a short per-call ref (`m1`, `m2`, …)
  rather than their real `<repoId>:module:<name>` id — the real ids are
  ~50 characters that a model copies unreliably and that would dominate a
  100-module prompt. Refs are mapped back to real ids before returning, and
  an echoed real id is accepted too. When the module list doesn't fit the
  token budget, **detail is dropped progressively** (sample paths, then
  dependencies, then the README) rather than letting the tail of the list be
  truncated away, which would silently lose whole modules.
  `options.onProgress` fires after every call with `{phase, done, total,
  calls, promptTokens, completionTokens}` for a running cost counter,
  and `options.chat` injects a fake client exactly as `review.ts` does.
  File *contents* are never sent — only names, paths and dependency names.
- `mock-server.ts` — dependency-free (`node:http`) OpenAI-compatible mock for
  testing without a real model. `POST /v1/chat/completions` (also
  `/chat/completions`) and `GET /v1/models`, both requiring
  `Authorization: Bearer ...` (else 401). It parses `Component:` / `File:`
  lines from the user message and returns a deterministic ```` ```json ````
  reply: outcome chosen by a stable hash of the component name (~50%
  `match`, ~25% `partial`, ~25% `mismatch`), 1-2 findings referencing the
  real file paths, and an OpenAI-shaped `usage` estimated from prompt
  length. The token `MOCK_FAIL` anywhere in the prompt -> HTTP 500;
  `MOCK_GARBAGE` -> non-JSON prose (parse-failure path). `MOCK_DELAY_MS`
  (default 900) simulates latency. It also answers the two labeling tasks
  above, recognised by their `TASK:` marker and parsed from the `- m1 | name
  | N files | files: … | depends on: …` module lines: domains by crude
  folder-name heuristics (`app`/`pages`/`components`/`ui`/`hooks`/`styles`
  -> Frontend, `api`/`server`/`lib`/`db`/`services`/`actions`/`auth` ->
  Backend, `docker`/`scripts`/`config`/`infra`/`github` -> Infrastructure,
  else Shared — the module's own name first, then its sample paths), and
  descriptions always prefixed with the literal `[mock] ` so mock-generated
  test data is obvious in the UI and trivially deletable from Neo4j. Also
  exports `startMockServer({port, host, delayMs, log})` for in-process
  tests. Deliberately **not** in the `index.ts` barrel (it imports
  `node:http`).
- `smoke-test-review.ts` — `npx tsx lib/ai/smoke-test-review.ts`: part A
  drives `reviewComponentChange` with an injected fake `chat` (clean /
  prose-wrapped / garbage JSON, invalid `intentMatch`, foreign `filePath`,
  no-patch -> zero calls, oversized diff -> truncated, `ref_comparison`
  wording, error propagation); part B starts the mock server on an
  ephemeral port and goes through the **real** `chatCompletion` client
  (including `MOCK_FAIL`, `MOCK_GARBAGE`, `pingProvider`).
- `smoke-test-label.ts` — `npx tsx lib/ai/smoke-test-label.ts`: the same
  two-part shape for the labeling layer — prompt shape and ref mapping, the
  normalisation invariants (total/disjoint assignment, the 8-domain cap,
  tolerated output shapes, description clipping), batching and progress,
  budget-driven detail dropping and the parse-failure paths with a fake
  `chat`; then the real client against the mock server, including the
  heuristic buckets, the `[mock] ` prefix, determinism, `MOCK_FAIL` and
  `MOCK_GARBAGE`.

- `pr-map.ts` — `groupPrMap(config, input)`: the PR map's one call per
  review (DESIGN.md §6.4). Regroups a diff's changed files by their role in
  the change and names each group plus one verb per edge; the caller only
  applies verbs to edges the import graph already justifies.
  `normalizePrMapGrouping` drops unknown paths, files placed twice,
  duplicate names and labels that aren't a short verb. `TASK: pr-map`
  marker; covered by `lib/jobs/smoke-test-pr-map.ts`.

## Not yet built (follow-up work)

- Per-component orchestration (fan out one call per touched component, run
  via `lib/jobs/`, persist `Finding` nodes) — `reviewComponentChange` is the
  per-component unit it builds on.
- Smarter oversized-diff handling (hunks touching top-level
  declarations; pre-summarization is a v2 idea) — today it keeps leading
  whole hunks.
- A description *editor* in the UI. `label.ts` writes one sentence per
  module and `lib/jobs/label.ts` refuses to overwrite a non-empty
  description without `force`, but nothing lets a human curate one yet.
- Module-tier *renaming* by the model — today labeling
  writes descriptions and the domain tier, never a module's name.

## Usage

```ts
import {
  chatCompletion,
  extractJson,
  truncateMessagesToBudget,
  type AiProviderConfig,
  type ChatMessage,
} from "@/lib/ai";

const config: AiProviderConfig = {
  baseUrl: "http://localhost:11434/v1", // or any OpenAI-compatible endpoint
  apiKey: "unused-by-local-servers",
  model: "llama3.1",
};

const messages: ChatMessage[] = truncateMessagesToBudget([
  { role: "system", content: "You are a code reviewer. Respond with a ```json fenced block only." },
  { role: "user", content: "…PR intent + diff hunks + structural context…" },
]);

const { content, usage } = await chatCompletion(config, messages);
const finding = extractJson<{ summary: string; concern: boolean }>(content);
if (finding === null) {
  // model didn't return parseable JSON — caller decides: retry, skip, flag "unparseable"
}
```

### Reviewing a component

```ts
import { reviewComponentChange, pingProvider } from "@/lib/ai";

const { ok, error } = await pingProvider(config); // e.g. for a "Test connection" button

const result = await reviewComponentChange(config, {
  intent: { source: "pull_request", title: pr.title, body: pr.body },
  component: { id: "c1", name: "Math", description: "Numeric helpers", dependsOn: ["Core"], dependents: ["Charts"] },
  files: [{ path: "src/math/square.ts", status: "modified", additions: 3, deletions: 1, patch }],
});
// result.findings[i] -> { filePath?, lineRange?, summary, intentMatch, confidence, rationale }
// result.parseFailed / result.truncated / result.calls / result.usage
```

### Labeling the component graph

```ts
import { labelComponents } from "@/lib/ai";

const { domains, descriptions, usage, calls, parseFailed } = await labelComponents(
  config,
  {
    repoName: "MultiTool",
    readme: readmeSnippet,            // optional
    modules: [
      { id: "repo:module:auth", name: "auth", fileCount: 9,
        sampleFiles: ["lib/auth/session.ts"], dependsOn: ["db"] },
      // …
    ],
  },
  { onProgress: (e) => job.updateProgress(e) }
);
// domains[i]      -> { name, description?, moduleIds }  (real ids, every module exactly once)
// descriptions[i] -> { id, description }                (one sentence, ≤160 chars)
```

### Running the mock AI server

```
npx tsx lib/ai/mock-server.ts --port 4010     # default port 4010
MOCK_DELAY_MS=0 npx tsx lib/ai/mock-server.ts # no simulated latency
```

Point the app's AI settings at `http://localhost:4010/v1` (or
`http://host.docker.internal:4010/v1` from inside a container) with any
non-empty API key and any model name.
