/**
 * Mock OpenAI-compatible AI server, for exercising the review pipeline (and a
 * UI's progress/finding states) without a real model.
 *
 *   npx tsx lib/ai/mock-server.ts [--port 4010]
 *
 * Listens on 0.0.0.0 so a Docker container can reach it as
 * `http://host.docker.internal:<port>/v1` (API key: any non-empty string).
 *
 * Endpoints (all require `Authorization: Bearer ...`, else 401):
 *   POST /v1/chat/completions   (also /chat/completions)
 *   GET  /v1/models             (also /models)
 *
 * Responses are deterministic. The user message is parsed for the
 * `Component: <name>` and `File: <path> (...)` lines that `prompts.ts`
 * emits; an assessment is picked by a stable hash of the component name
 * (~50% ok, ~25% concern, ~25% defect) and 1-2 findings referencing the
 * real file paths come back in a ```json fence, with a `kind` and — for a
 * pull request — a `scope` (the second finding is a drive-by fix).
 *
 * The impact check (`TASK: impact-check`) answers every usage of a removed
 * declaration, and every other usage whose id hashes odd, `incompatible`;
 * the rest `compatible`. The PR intent check (`TASK: pr-intent`) answers
 * `delivers` unless the title contains MOCK_PARTIAL. The test plan
 * (`TASK: test-plan`) gets one item per evidence line (at most 12).
 *
 * The PR map call (lib/ai/pr-map.ts, `TASK: pr-map`) is answered from its
 * `File: <path> (...) card: <name>` lines: the same grouping as the current
 * cards, each renamed from its folder to a Title Case name, a `[mock] `
 * description, and the listed links echoed back with the mock verb "feeds".
 *
 * Special tokens anywhere in the prompt (e.g. in a PR title):
 *   MOCK_FAIL     -> HTTP 500
 *   MOCK_GARBAGE  -> non-JSON prose (exercises the parse-failure path)
 *
 * Env: MOCK_DELAY_MS (default 900) — simulated latency before each answer.
 *      MOCK_UNAVAILABLE=<n> — the next n chat requests answer 503 "model
 *      overloaded" (Gemini's wording), then normal service resumes: exercises
 *      the client's transient retries and the review's "Retry failed".
 * Dependency-free (`node:http`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
// The task markers are imported rather than re-typed so the mock can
// never drift out of sync with the prompts it is pretending to answer.
import { CHECKLIST_TASK_MARKER } from "./checklist";
import { PR_CHAT_TASK_MARKER, REPO_CHAT_SCOPE_MARKER } from "./pr-chat";
import { PR_MAP_TASK_MARKER } from "./pr-map";
import { APP_EXPLAIN_TASK_MARKER, APP_FEATURES_TASK_MARKER, APP_LAYERS_TASK_MARKER, APP_PLACE_TASK_MARKER } from "./app-map";
import { PREVIEW_INPUTS_TASK_MARKER } from "./preview-inputs";
import { IMPACT_TASK_MARKER } from "./impact";
import { PR_INTENT_TASK_MARKER } from "./pr-intent";
import { BRIEF_FACT_HEADINGS, CHANGE_BRIEF_TASK_MARKER } from "./change-brief";
import { API_SHAPE_TASK_MARKER } from "./api-shape";
import { TEST_PLAN_TASK_MARKER } from "./test-plan";

export const DEFAULT_MOCK_PORT = 4010;
export const DEFAULT_MOCK_DELAY_MS = 900;

/** Requests still to answer with 503 (`MOCK_UNAVAILABLE`). */
let unavailableLeft = Math.max(0, Number(process.env.MOCK_UNAVAILABLE) || 0);
const MAX_BODY_BYTES = 20 * 1024 * 1024;

export type MockOutcome = "ok" | "concern" | "defect";

export interface MockServerOptions {
  /** 0 = ephemeral. Default 4010. */
  port?: number;
  /** Default "0.0.0.0". */
  host?: string;
  /** Simulated latency in ms. Default: `MOCK_DELAY_MS` env, else 900. */
  delayMs?: number;
  /** One line per request. Default: `console.log`. Pass `() => {}` to silence. */
  log?: (line: string) => void;
}

export interface MockServerHandle {
  server: Server;
  port: number;
  /** `http://127.0.0.1:<port>` — append `/v1` for an `AiProviderConfig.baseUrl`. */
  url: string;
  close(): Promise<void>;
}

/** FNV-1a, 32-bit: small, dependency-free and stable across runs/platforms. */
export function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** ~50% ok, ~25% concern, ~25% defect, by stable hash of the component name. */
export function mockOutcomeFor(componentName: string): MockOutcome {
  const bucket = stableHash(componentName) % 100;
  if (bucket < 50) return "ok";
  if (bucket < 75) return "concern";
  return "defect";
}

export function startMockServer(options: MockServerOptions = {}): Promise<MockServerHandle> {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? DEFAULT_MOCK_PORT;
  const log = options.log ?? ((line: string) => console.log(line));
  const delayMs = options.delayMs ?? envDelayMs();

  const server = createServer((req, res) => {
    handle(req, res, { delayMs, log }).catch((err: unknown) => {
      log(`mock-ai ${req.method} ${req.url} -> 500 (internal: ${err instanceof Error ? err.message : String(err)})`);
      if (!res.headersSent) sendJson(res, 500, errorBody("internal mock server error", "server_error"));
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const actualPort = (server.address() as AddressInfo).port;
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.(); // drop keep-alive sockets so close() resolves promptly
          }),
      });
    });
  });
}

function envDelayMs(): number {
  const raw = process.env.MOCK_DELAY_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MOCK_DELAY_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MOCK_DELAY_MS;
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

interface HandlerContext {
  delayMs: number;
  log: (line: string) => void;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
  const started = Date.now();
  const done = (status: number, note = ""): void =>
    ctx.log(`mock-ai ${method} ${path} -> ${status}${note ? ` ${note}` : ""} (${Date.now() - started}ms)`);

  const auth = req.headers.authorization ?? "";
  if (!/^Bearer\s+\S+/i.test(auth)) {
    sendJson(res, 401, errorBody("Missing or malformed Authorization: Bearer header", "invalid_request_error"));
    return done(401);
  }

  const isChat = path === "/v1/chat/completions" || path === "/chat/completions";
  const isModels = path === "/v1/models" || path === "/models";

  if (isModels && method === "GET") {
    sendJson(res, 200, {
      object: "list",
      data: [{ id: "mock-review-1", object: "model", created: 1_700_000_000, owned_by: "graphreview-mock" }],
    });
    return done(200);
  }

  if (isChat && method === "POST") {
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, errorBody("Request body is not valid JSON", "invalid_request_error"));
      return done(400);
    }
    const messages = extractMessages(payload);
    if (messages === null) {
      sendJson(res, 400, errorBody("`messages` must be a non-empty array", "invalid_request_error"));
      return done(400);
    }
    const model = isRecord(payload) && typeof payload.model === "string" ? payload.model : "mock-review-1";

    if (ctx.delayMs > 0) await sleep(ctx.delayMs);

    if (unavailableLeft > 0) {
      unavailableLeft--;
      sendJson(res, 503, {
        error: {
          code: 503,
          message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
          status: "UNAVAILABLE",
        },
      });
      return done(503, `MOCK_UNAVAILABLE (${unavailableLeft} left)`);
    }

    const prompt = messages.map((m) => m.content).join("\n");
    if (prompt.includes("MOCK_FAIL")) {
      sendJson(res, 500, errorBody("MOCK_FAIL requested: simulated provider failure", "server_error"));
      return done(500, "MOCK_FAIL");
    }

    const userText = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    // Task dispatch. MOCK_GARBAGE wins over everything so the parse-failure
    // path can be exercised for every task.
    const { content, note } = prompt.includes("MOCK_GARBAGE")
      ? { content: garbageContent(userText), note: "MOCK_GARBAGE" }
      : prompt.includes(PR_MAP_TASK_MARKER)
              ? prMapContent(userText)
              : prompt.includes(APP_FEATURES_TASK_MARKER)
                ? appFeaturesContent(userText)
                : prompt.includes(APP_PLACE_TASK_MARKER)
                ? appPlaceContent(userText)
                : prompt.includes(APP_LAYERS_TASK_MARKER)
                  ? appLayersContent(userText)
                  : prompt.includes(APP_EXPLAIN_TASK_MARKER)
                    ? appExplainContent(userText)
                    : prompt.includes(PREVIEW_INPUTS_TASK_MARKER)
                    ? previewInputsContent(userText)
                    : prompt.includes(IMPACT_TASK_MARKER)
                    ? impactContent(userText)
                    : prompt.includes(CHANGE_BRIEF_TASK_MARKER)
                    ? changeBriefContent(userText)
                    : prompt.includes(PR_INTENT_TASK_MARKER)
                    ? prIntentContent(userText)
                    : prompt.includes(TEST_PLAN_TASK_MARKER)
                    ? testPlanContent(userText)
                    : prompt.includes(API_SHAPE_TASK_MARKER)
                    ? apiShapeContent(userText)
                    : prompt.includes(CHECKLIST_TASK_MARKER)
                      ? checklistContent(userText)
                      : prompt.includes(PR_CHAT_TASK_MARKER)
                        ? prompt.includes(REPO_CHAT_SCOPE_MARKER)
                          ? repoChatContent(userText)
                          : prChatContent(userText)
                        : cannedContent(userText);

    const promptTokens = Math.ceil(prompt.length / 4);
    const completionTokens = Math.ceil(content.length / 4);
    sendJson(res, 200, {
      id: `chatcmpl-mock-${stableHash(prompt).toString(16)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
    return done(200, note);
  }

  sendJson(res, 404, errorBody(`No mock route for ${method} ${path}`, "invalid_request_error"));
  done(404);
}

/** `TASK: api-shape`: every `req.body.<name>` the handler reads becomes a request field; the response is `{ ok }`. */
function apiShapeContent(userText: string): { content: string; note: string } {
  const fields = [...new Set([...userText.matchAll(/(?:req|request)\.body\.(\w+)/g)].map((m) => m[1]))];
  const queries = [...new Set([...userText.matchAll(/(?:req|request)\.query\.(\w+)/g)].map((m) => m[1]))];
  const answer = {
    summary: "Mock summary of the endpoint.",
    params: queries.map((name) => ({ name, in: "query", type: "string", required: false })),
    request: fields.length ? { type: null, fields: fields.map((name) => ({ name, type: "string", required: true })) } : null,
    response: { type: null, fields: [{ name: "ok", type: "boolean", required: true }] },
  };
  return { content: "```json\n" + JSON.stringify(answer) + "\n```", note: "api-shape" };
}

function extractMessages(payload: unknown): Array<{ role: string; content: string }> | null {
  if (!isRecord(payload) || !Array.isArray(payload.messages) || payload.messages.length === 0) return null;
  const out: Array<{ role: string; content: string }> = [];
  for (const m of payload.messages) {
    if (isRecord(m) && typeof m.content === "string") {
      out.push({ role: typeof m.role === "string" ? m.role : "user", content: m.content });
    }
  }
  return out.length > 0 ? out : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function errorBody(message: string, type: string): unknown {
  return { error: { message, type, code: null } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Canned responses
// ---------------------------------------------------------------------------

interface ParsedPrompt {
  component?: string;
  files: string[];
  refComparison: boolean;
}

function parsePrompt(userText: string): ParsedPrompt {
  const component = /^Component:[ \t]*(.+?)[ \t]*$/m.exec(userText)?.[1];
  const files = [...userText.matchAll(/^File:[ \t]*(.+) \([^()\r\n]*\)[ \t]*$/gm)].map((m) => m[1]);
  const refComparison = /^Source:[ \t]*ref_comparison/m.test(userText);
  return { component, files, refComparison };
}

function garbageContent(userText: string): string {
  const name = parsePrompt(userText).component ?? "this component";
  return (
    `I took a look at the ${name} changes and honestly they seem fine to me overall. ` +
    "The edits are small and readable, though I would want to see the surrounding tests before signing off. " +
    "Let me know if you would like a deeper pass."
  );
}

function cannedContent(userText: string): { content: string; note: string } {
  const parsed = parsePrompt(userText);
  if (parsed.component === undefined) {
    // Not a review prompt (e.g. pingProvider's "Reply with the single word: ok").
    return { content: "ok", note: "(non-review prompt)" };
  }

  const name = parsed.component;
  const outcome = mockOutcomeFor(name);
  const h = stableHash(name);
  const files = parsed.files;
  const findings: Array<Record<string, unknown>> = [];

  findings.push(makeFinding(name, outcome, files[0], h, parsed.refComparison));
  // Second finding for multi-file changes, on roughly half the components.
  if (files.length >= 2 && ((h >>> 3) & 1) === 0) {
    findings.push(makeFinding(name, "ok", files[1], h >>> 7, parsed.refComparison, true));
  }

  const content = ["```json", JSON.stringify({ findings }, null, 2), "```"].join("\n");
  return { content, note: `component=${name} outcome=${outcome} findings=${findings.length}` };
}

function makeFinding(
  name: string,
  outcome: MockOutcome,
  filePath: string | undefined,
  seed: number,
  refComparison: boolean,
  secondary = false
): Record<string, unknown> {
  const start = 5 + (seed % 40);
  const end = start + 3 + ((seed >>> 5) % 12);
  const where = filePath ?? "the changed code";
  const ident = identifierFor(filePath, name);
  const basis = refComparison ? "the code's own evident purpose (there is no stated intent)" : "what the code is for";

  let summary: string;
  let rationale: string;
  let confidence: number;

  if (outcome === "ok") {
    summary = secondary
      ? `Small supporting edit in ${where} that keeps the ${name} component consistent with the main change.`
      : `Updates how the ${name} component handles its core logic in ${where}; the edit is small and self-contained.`;
    rationale =
      `Lines ${start}-${end} of ${where} change ${ident} in a way that is consistent with ${basis} in ${name}. ` +
      "No suspicious operators or missing checks were found in this hunk.";
    confidence = 0.85 + (seed % 10) / 100;
  } else if (outcome === "concern") {
    summary = `Changes ${ident} in the ${name} component; the main path looks right but an edge case is not handled.`;
    rationale =
      `${where} lines ${start}-${end}: ${ident} is updated, but the empty/error case is not handled ` +
      "and the behaviour change may affect callers in a neighbouring component.";
    confidence = 0.6 + (seed % 15) / 100;
  } else {
    summary = `Rewrites ${ident} in the ${name} component, but the new behaviour appears to differ from what it should do.`;
    rationale =
      `In ${where} lines ${start}-${end}, ${ident} now computes a different result than its name and ${basis} imply ` +
      "(for example it doubles its input where it should square it), so this looks like a defect in " +
      `${name}.`;
    confidence = 0.75 + (seed % 15) / 100;
  }

  const finding: Record<string, unknown> = {};
  if (filePath !== undefined) {
    finding.filePath = filePath;
    finding.lineRange = `${start}-${end}`;
  }
  finding.summary = summary;
  finding.kind = secondary ? "fix" : ["feature", "fix", "refactor"][seed % 3];
  finding.assessment = outcome;
  if (!refComparison) finding.scope = secondary ? "unmentioned" : seed % 4 === 0 ? "supporting" : "described";
  finding.confidence = Math.round(confidence * 100) / 100;
  finding.rationale = rationale;
  return finding;
}

// ---------------------------------------------------------------------------
// Canned responses — the other tasks
// ---------------------------------------------------------------------------

/** The literal prefix every mock-written module description carries, so test data is recognisable (and deletable) in the UI and in the database. */
export const MOCK_DESCRIPTION_PREFIX = "[mock] ";

/** Impact check: removed declarations break every usage; otherwise usages whose id hashes odd do. */
function impactContent(userText: string): { content: string; note: string } {
  const results: Array<Record<string, string>> = [];
  let removed = false;
  for (const line of userText.split("\n")) {
    const heading = /^### (\S+) \((\w+), (changed|removed)\) in /.exec(line);
    if (heading) {
      removed = heading[3] === "removed";
      continue;
    }
    const usage = /^Usage (u\d+): (.+):(\d+)$/.exec(line);
    if (!usage) continue;
    const breaks = removed || (stableHash(usage[1]) & 1) === 1;
    results.push({
      usage: usage[1],
      verdict: breaks ? "incompatible" : "compatible",
      reason: `${MOCK_DESCRIPTION_PREFIX}${breaks ? "Still calls it the old way." : "Still fits."}`,
    });
  }
  const content = ["```json", JSON.stringify({ results }, null, 2), "```"].join("\n");
  return { content, note: `impact usages=${results.length}` };
}

/**
 * Acceptance criteria (DESIGN.md §6.27), when listed: each passes, citing the
 * first diff hunk (or the first changed file), unless its text says
 * MOCK_CRITERION_FAIL or MOCK_CRITERION_UNKNOWN.
 */
function mockCriteria(userText: string): unknown[] | undefined {
  // Anchored: the quoted description may have an "## Acceptance criteria" heading of its own.
  const section = /^## Acceptance criteria \(judge each one\)\n([\s\S]*?)(?:\n## |(?![\s\S]))/m.exec(userText)?.[1];
  if (!section) return undefined;
  const file = /^File: (.+)$/m.exec(userText);
  const hunk = file ? /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/m.exec(userText.slice(file.index)) : null;
  const firstChanged = /## Changed files[^\n]*\n- (.+?) \(/.exec(userText)?.[1];
  const evidence = file && hunk
    ? [`${file[1]}:${hunk[1]}-${Number(hunk[1]) + Math.max(1, Number(hunk[2] ?? 1)) - 1}`]
    : firstChanged ? [firstChanged] : [];
  return [...section.matchAll(/^- (c\d+): (.*)$/gm)].map(([, id, text]) =>
    /MOCK_CRITERION_FAIL/.test(text)
      ? { id, verdict: "fail", reason: `${MOCK_DESCRIPTION_PREFIX}Nothing in the diff does this.`, evidence: [] }
      : /MOCK_CRITERION_UNKNOWN/.test(text)
        ? { id, verdict: "unknown", reason: `${MOCK_DESCRIPTION_PREFIX}No evidence either way in what I was shown.`, evidence: [] }
        : { id, verdict: "pass", reason: `${MOCK_DESCRIPTION_PREFIX}Implemented in the changed code.`, evidence }
  );
}

/** One item per evidence line: findings, impact and callers as regressions, the rest as new behaviour. */
function testPlanContent(userText: string): { content: string; note: string } {
  const items: Array<Record<string, unknown>> = [];
  let kind = "";
  for (const line of userText.split("\n")) {
    const heading = /^## .* — kind (\w+)$/.exec(line);
    if (heading) {
      kind = heading[1];
      continue;
    }
    if (line.startsWith("## ")) kind = "";
    const evidence = /^\[([^\]]+)\] (.+)$/.exec(line);
    if (!evidence || !kind || items.length >= 12) continue;
    const regression = kind === "finding" || kind === "impact" || kind === "caller";
    items.push({
      title: `${MOCK_DESCRIPTION_PREFIX}${regression ? "Check it still works" : "Check the new behaviour"}: ${evidence[2].slice(0, 80)}`,
      steps: ["Set up the case the evidence describes.", "Check the result matches the intent."],
      type: regression ? "regression" : "new-behaviour",
      source: { kind, ref: evidence[1] },
    });
  }
  const content = ["```json", JSON.stringify({ items }, null, 2), "```"].join("\n");
  return { content, note: `test-plan items=${items.length}` };
}

function prIntentContent(userText: string): { content: string; note: string } {
  const verdict = /MOCK_PARTIAL/.test(userText) ? "partial" : "delivers";
  const criteria = mockCriteria(userText);
  const content = [
    "```json",
    JSON.stringify({
      ...(criteria ? { criteria } : {}),
      verdict,
      summary: `${MOCK_DESCRIPTION_PREFIX}${verdict === "delivers" ? "Everything the description promises is in the diff." : "Part of what the description promises is missing."}`,
      rationale: `${MOCK_DESCRIPTION_PREFIX}Judged from the changed files and the review findings.`,
    }),
    "```",
  ].join("\n");
  return { content, note: `pr-intent ${verdict}${criteria ? ` criteria=${criteria.length}` : ""}` };
}

/** `TASK: change-brief`: each list is the facts given under its heading, prefixed; the summary counts the changed files. */
function changeBriefContent(userText: string): { content: string; note: string } {
  const section = (heading: string): string[] => {
    const start = userText.indexOf(heading);
    if (start < 0) return [];
    const rest = userText.slice(start + heading.length).split("\n").map((l) => l.trimEnd()).slice(1);
    const items: string[] = [];
    for (const line of rest) {
      if (!line.startsWith("- ")) break;
      if (line !== "- (none)") items.push(`${MOCK_DESCRIPTION_PREFIX}${line.slice(2)}`);
    }
    return items;
  };
  const files = /^## Changed files \((\d+)\)$/m.exec(userText)?.[1] ?? "0";
  const brief = {
    summary: `${MOCK_DESCRIPTION_PREFIX}A change across ${files} file(s).`,
    userVisible: section(BRIEF_FACT_HEADINGS.userVisible),
    contracts: section(BRIEF_FACT_HEADINGS.contracts),
    risks: section(BRIEF_FACT_HEADINGS.risks),
    questions: section(BRIEF_FACT_HEADINGS.questions),
  };
  return { content: ["```json", JSON.stringify(brief), "```"].join("\n"), note: `change-brief files=${files}` };
}

/** Answers every checklist question: "pass" when the PR has a description, "unknown" otherwise. */
function checklistContent(userText: string): { content: string; note: string } {
  const ids = [...userText.matchAll(/^- (q\d+): /gm)].map((m) => m[1]);
  const hasDescription = !/^Description: \(none\)$/m.test(userText);
  const answers = ids.map((id) => ({
    id,
    status: hasDescription ? "pass" : "unknown",
    rationale: `${MOCK_DESCRIPTION_PREFIX}${hasDescription ? "The description covers it." : "There is no description to judge from."}`,
  }));
  const content = ["```json", JSON.stringify({ answers }, null, 2), "```"].join("\n");
  return { content, note: `pr-checklist questions=${ids.length}` };
}

/**
 * First turn: look at the changed files. Asked about a finding, then: say it
 * holds (triage_finding). Then answer, quoting the first file, pointing at it
 * (point_to) and at the second as the next stop.
 */
function prChatContent(userText: string): { content: string; note: string } {
  const json = (value: unknown) => ["```json", JSON.stringify(value), "```"].join("\n");
  if (!userText.includes("Result of list_changed_files")) {
    return { content: json({ tool: "list_changed_files", args: {} }), note: "pr-chat tool" };
  }
  const finding = /The question is about this finding of the review:\n(#[0-9a-f]{8})/.exec(userText)?.[1];
  if (finding && !userText.includes("Result of triage_finding")) {
    return {
      content: json({ tool: "triage_finding", args: { id: finding, verdict: "holds", reason: `${MOCK_DESCRIPTION_PREFIX}The diff does what the finding says.` } }),
      note: "pr-chat triage",
    };
  }
  const files = /Result of list_changed_files:\n```\n([\s\S]*?)\n```/.exec(userText)?.[1]?.split("\n").map((line) => line.split(" ")[0]) ?? [];
  const firstFile = files[0] ?? "(none)";
  const answer = `${MOCK_DESCRIPTION_PREFIX}I looked at the changed files; the first one is \`${firstFile}\`.`;
  return {
    content: json({
      answer,
      ...(files[0] ? { point_to: [{ kind: "file", name: files[0] }] } : {}),
      ...(files[1] ? { next: { kind: "file", name: files[1], why: `${MOCK_DESCRIPTION_PREFIX}the second changed file` } } : {}),
    }),
    note: "pr-chat answer",
  };
}

/** Repo-wide chat. First turn: list the components. After the result: answer, naming the first one. */
function repoChatContent(userText: string): { content: string; note: string } {
  if (!userText.includes("Result of list_components")) {
    const content = ["```json", JSON.stringify({ tool: "list_components", args: {} }), "```"].join("\n");
    return { content, note: "repo-chat tool" };
  }
  const first = /Result of list_components:\n```\n- ([^\n(]+)/.exec(userText)?.[1]?.trim() ?? "(none)";
  const answer = `${MOCK_DESCRIPTION_PREFIX}I looked at the components; the first one is ${first}.`;
  const content = ["```json", JSON.stringify({ answer }), "```"].join("\n");
  return { content, note: "repo-chat answer" };
}

/** "src/ffi" → "Ffi", "lib/jobs tests" → "Jobs Tests" — recognisably renamed, still traceable. */
function mockCardName(card: string): string {
  const words = card
    .split(/[\s/_.-]+/)
    .filter(Boolean)
    .filter((word, index, all) => index === all.length - 1 || !/^(src|lib|app|packages?|components?)$/i.test(word));
  const tail = words.slice(-2).map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return tail.join(" ") || "Changes";
}

function prMapContent(userText: string): { content: string; note: string } {
  const filesByCard = new Map<string, string[]>();
  for (const match of userText.matchAll(/^File: (.+?) \([^)]*\) card: (.*)$/gm)) {
    const [, path, card] = match;
    const list = filesByCard.get(card) ?? [];
    list.push(path);
    filesByCard.set(card, list);
  }
  const rename = new Map<string, string>();
  const used = new Set<string>();
  for (const card of filesByCard.keys()) {
    let name = mockCardName(card);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${mockCardName(card)} ${n}`;
    used.add(name.toLowerCase());
    rename.set(card, name);
  }
  const groups = [...filesByCard].map(([card, files]) => ({
    name: rename.get(card)!,
    description: `${MOCK_DESCRIPTION_PREFIX}${files.length} changed file${files.length === 1 ? "" : "s"} from ${card}`,
    files,
  }));
  const edges = [...userText.matchAll(/^- (.+?) -> (.+?) \([^)]*\)$/gm)].map(([, from, to]) => ({
    from: rename.get(from) ?? from,
    to: rename.get(to) ?? to,
    label: "feeds",
  }));
  const content = ["```json", JSON.stringify({ groups, edges }, null, 2), "```"].join("\n");
  return { content, note: `pr-map groups=${groups.length} edges=${edges.length}` };
}

// --- App map (lib/ai/app-map.ts) ------------------------------------------

/** Two cases per symbol: small integers for functions (1 + 1 shows int-vs-float changes), a title prop for components. */
function previewInputsContent(userText: string): { content: string; note: string } {
  const symbols = [...userText.matchAll(/^### (component|function) `([^`]+)`/gm)].map((m) => ({
    name: m[2],
    cases:
      m[1] === "component"
        ? [
            { label: "short title", props: { title: "Hello", label: "Save" } },
            { label: "long title", props: { title: "A much longer title than usual", label: "Cancel" } },
          ]
        : [
            { label: "1 + 1", args: [1, 1] },
            { label: "2 + 3", args: [2, 3] },
          ],
  }));
  return { content: fenced({ symbols }), note: `preview-inputs ${symbols.length}` };
}

function fenced(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

/** Folder lines of the rendered tree: `lib/gitlab/ — module …` or `(root)/`. */
function appTreeFolders(userText: string): string[] {
  return [...userText.matchAll(/^(\S+)\/(?: — .*)?$/gm)].map((m) => m[1]).filter((d) => d !== "(root)");
}

/** One feature per top-level folder pair (`lib/gitlab`), named after it. */
function appFeaturesContent(userText: string): { content: string; note: string } {
  const byTop = new Map<string, string[]>();
  for (const dir of appTreeFolders(userText)) {
    const top = dir.split("/").slice(0, 2).join("/");
    byTop.set(top, [...(byTop.get(top) ?? []), dir]);
  }
  const features = [...byTop].map(([top]) => ({
    name: `Mock ${top.split("/").pop()}`,
    description: `${MOCK_DESCRIPTION_PREFIX}Everything under ${top}`,
    members: [`${top}/`],
  }));
  return { content: fenced({ features }), note: `app-map-features features=${features.length}` };
}

/**
 * Every listed file into the first feature, and each folder whose files were
 * cut for length ("+N more in dir/") as a folder. The features answer above
 * skips root files, so a job run against the mock always has some to place.
 */
function appPlaceContent(userText: string): { content: string; note: string } {
  const [featuresPart, filesPart = ""] = userText.split(/^## Files to place.*$/m);
  const feature = /^- (.+?)(?: — | \(holds |$)/m.exec(featuresPart.slice(featuresPart.indexOf("## Features")))?.[1];
  const placements: Array<{ member: string; feature: string }> = [];
  if (feature) {
    for (const line of filesPart.split("\n")) {
      const more = /^\(\+\d+ more in (\S+) /.exec(line);
      if (more) placements.push({ member: more[1], feature });
      else if (/^[^\s(]/.test(line)) placements.push({ member: line.split(":")[0], feature });
    }
  }
  return { content: fenced({ placements }), note: `app-map-place placements=${placements.length}` };
}

/** Every hinted layer described, no moves. */
function appLayersContent(userText: string): { content: string; note: string } {
  const layers = [...new Set([...userText.matchAll(/ \[([a-z]+)\]/g)].map((m) => m[1]))].map((layer) => ({
    layer,
    description: `${MOCK_DESCRIPTION_PREFIX}The ${layer} layer of this repo`,
  }));
  return { content: fenced({ layers, moves: [] }), note: `app-map-layers layers=${layers.length}` };
}

/** An explanation, the first listed file as key file, and "calls" on every outgoing connection. */
function appExplainContent(userText: string): { content: string; note: string } {
  const cards: unknown[] = [];
  const edges: unknown[] = [];
  for (const block of userText.split(/^### Card: /m).slice(1)) {
    const name = block.split("\n")[0].trim();
    const firstFile = /^ {2}(\S+?)(?::|$)/m.exec(block.slice(block.indexOf("Files (")))?.[1];
    cards.push({
      name,
      description: `${MOCK_DESCRIPTION_PREFIX}What ${name} is for`,
      explanation: `${MOCK_DESCRIPTION_PREFIX}${name} does its part of the app. It works through its files. It connects to its neighbours.`,
      keyFiles: firstFile ? [{ path: firstFile, role: `${MOCK_DESCRIPTION_PREFIX}Entry point` }] : [],
    });
    for (const m of block.matchAll(/^ {2}-> (.+?) \(\d+ imports\)/gm)) {
      edges.push({ from: name, to: m[1], label: "calls", explanation: `${MOCK_DESCRIPTION_PREFIX}${name} calls ${m[1]}` });
    }
  }
  return { content: fenced({ cards, edges }), note: `app-map-explain cards=${cards.length} edges=${edges.length}` };
}

/** A plausible identifier from the file's basename, e.g. `src/math/square.ts` -> `square()`. */
function identifierFor(filePath: string | undefined, fallbackName: string): string {
  const base = (filePath ?? fallbackName).split("/").pop() ?? fallbackName;
  const stem = base.replace(/\.[^.]*$/, "");
  const words = stem.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return "the modified function";
  const camel = words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");
  return `${camel}()`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parsePortArg(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = arg === "--port" ? argv[i + 1] : arg.startsWith("--port=") ? arg.slice("--port=".length) : undefined;
    if (value !== undefined) {
      const n = Number(value);
      if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
      throw new Error(`Invalid --port value: ${value}`);
    }
  }
  return DEFAULT_MOCK_PORT;
}

async function main(): Promise<void> {
  const port = parsePortArg(process.argv.slice(2));
  const handle = await startMockServer({ port });
  const delay = envDelayMs();
  console.log(`mock-ai listening on http://0.0.0.0:${handle.port}/v1 (delay ${delay}ms per request)`);
  console.log(`  from the host:   http://localhost:${handle.port}/v1`);
  console.log(`  from a container: http://host.docker.internal:${handle.port}/v1   (API key: any non-empty string, model: any)`);
  console.log("  special prompt tokens: MOCK_FAIL -> HTTP 500, MOCK_GARBAGE -> non-JSON reply");
}

// Run only when executed directly (`tsx lib/ai/mock-server.ts`), not when imported by the smoke test.
if (/mock-server\.(?:ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
