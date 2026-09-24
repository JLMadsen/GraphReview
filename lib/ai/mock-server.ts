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
 * emits; an outcome is picked by a stable hash of the component name
 * (~50% match, ~25% partial, ~25% mismatch) and 1-2 findings referencing the
 * real file paths come back in a ```json fence.
 *
 * The AI-labeling calls (lib/ai/label.ts) are recognised by
 * the `TASK: label-domains` / `TASK: describe-modules` marker in their system
 * prompt and answered from the `- m1 | name | N files | files: … | depends
 * on: …` module lines that file emits:
 *   - domains      -> folder-name heuristics (Frontend / Backend /
 *                     Infrastructure / Shared), every module assigned once.
 *   - descriptions -> one sentence per module, always prefixed `[mock] ` so
 *                     mock-generated test data is obvious in the UI and easy
 *                     to delete again.
 *
 * Special tokens anywhere in the prompt (e.g. in a PR title):
 *   MOCK_FAIL     -> HTTP 500
 *   MOCK_GARBAGE  -> non-JSON prose (exercises the parse-failure path)
 *
 * Env: MOCK_DELAY_MS (default 900) — simulated latency before each answer.
 * Dependency-free (`node:http`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
// The two task markers are imported rather than re-typed so the mock can
// never drift out of sync with the prompts it is pretending to answer.
import { DESCRIBE_TASK_MARKER, DOMAIN_TASK_MARKER } from "./label";
import { MERGE_NAME_TASK_MARKER } from "./merge-name";

export const DEFAULT_MOCK_PORT = 4010;
export const DEFAULT_MOCK_DELAY_MS = 900;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

export type MockOutcome = "match" | "partial" | "mismatch";

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

/** ~50% match, ~25% partial, ~25% mismatch, by stable hash of the component name. */
export function mockOutcomeFor(componentName: string): MockOutcome {
  const bucket = stableHash(componentName) % 100;
  if (bucket < 50) return "match";
  if (bucket < 75) return "partial";
  return "mismatch";
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
    // path can be exercised for the labeling prompts too.
    const { content, note } = prompt.includes("MOCK_GARBAGE")
      ? { content: garbageContent(userText), note: "MOCK_GARBAGE" }
      : prompt.includes(DOMAIN_TASK_MARKER)
        ? domainContent(userText)
        : prompt.includes(DESCRIBE_TASK_MARKER)
          ? describeContent(userText)
          : prompt.includes(MERGE_NAME_TASK_MARKER)
            ? mergeNameContent(userText)
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
    findings.push(makeFinding(name, "match", files[1], h >>> 7, parsed.refComparison, true));
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
  const basis = refComparison ? "the code's own evident purpose (there is no stated intent)" : "the stated intent";

  let summary: string;
  let rationale: string;
  let confidence: number;

  if (outcome === "match") {
    summary = secondary
      ? `Small supporting edit in ${where} that keeps the ${name} component consistent with the main change.`
      : `Updates how the ${name} component handles its core logic in ${where}; the edit is small and self-contained.`;
    rationale =
      `Lines ${start}-${end} of ${where} change ${ident} in a way that plausibly implements ${basis} for ${name}. ` +
      "No unrelated edits or suspicious operators were found in this hunk.";
    confidence = 0.85 + (seed % 10) / 100;
  } else if (outcome === "partial") {
    summary = `Changes ${ident} in the ${name} component, covering the main path but not everything that was asked for.`;
    rationale =
      `${where} lines ${start}-${end} implement only part of ${basis} for ${name}: ${ident} is updated, ` +
      "but an expected companion change (tests, or the caller in a neighbouring component) is not in this diff, " +
      "and there is an unrelated formatting edit alongside it.";
    confidence = 0.6 + (seed % 15) / 100;
  } else {
    summary = `Rewrites ${ident} in the ${name} component, but the new behaviour appears to differ from what it should do.`;
    rationale =
      `In ${where} lines ${start}-${end}, ${ident} now computes a different result than its name and ${basis} imply ` +
      "(for example it doubles its input where it should square it), so this looks like a defect in " +
      `${name} rather than an implementation of the intent.`;
    confidence = 0.75 + (seed % 15) / 100;
  }

  const finding: Record<string, unknown> = {};
  if (filePath !== undefined) {
    finding.filePath = filePath;
    finding.lineRange = `${start}-${end}`;
  }
  finding.summary = summary;
  finding.intentMatch = outcome;
  finding.confidence = Math.round(confidence * 100) / 100;
  finding.rationale = rationale;
  return finding;
}

// ---------------------------------------------------------------------------
// Canned responses — AI labeling (lib/ai/label.ts)
// ---------------------------------------------------------------------------

interface MockModuleLine {
  /** The short per-call ref (`m1`, `m2`, …) label.ts sends instead of the real component id. */
  ref: string;
  name: string;
  fileCount: number;
  sampleFiles: string[];
  dependsOn: string[];
}

/**
 * Parses the `- m1 | name | 8 files | files: a, b | depends on: x, y` lines
 * `lib/ai/label.ts` emits. Segments after the first three are optional and
 * order-independent, matching what that file drops when the token budget is
 * tight.
 */
function parseModuleLines(userText: string): MockModuleLine[] {
  const out: MockModuleLine[] = [];
  for (const line of userText.split(/\r?\n/)) {
    if (!line.startsWith("- m")) continue;
    const parts = line.slice(2).split(" | ").map((part) => part.trim());
    if (parts.length < 3 || !/^m\d+$/.test(parts[0])) continue;

    const parsed: MockModuleLine = {
      ref: parts[0],
      name: parts[1],
      fileCount: Number.parseInt(parts[2], 10) || 0,
      sampleFiles: [],
      dependsOn: [],
    };
    for (const part of parts.slice(3)) {
      if (part.startsWith("files:")) {
        parsed.sampleFiles = splitList(part.slice("files:".length));
      } else if (part.startsWith("depends on:")) {
        parsed.dependsOn = splitList(part.slice("depends on:".length));
      }
    }
    out.push(parsed);
  }
  return out;
}

function splitList(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Folder-name heuristics, deliberately crude and fully deterministic — the
 * point is recognisable, stable test data, not good labels. The module's own
 * name is consulted first, then its sample paths, so `components/graph`
 * (name "graph") still lands in Frontend.
 */
const DOMAIN_RULES: Array<{ name: string; description: string; keywords: string[] }> = [
  {
    name: "Frontend",
    description: "User-facing pages, components and client-side state.",
    keywords: ["app", "pages", "components", "ui", "hooks", "styles"],
  },
  {
    name: "Backend",
    description: "Server-side routes, data access and domain services.",
    keywords: ["api", "server", "lib", "db", "services", "actions", "auth"],
  },
  {
    name: "Infrastructure",
    description: "Build, deployment and environment configuration.",
    keywords: ["docker", "scripts", "config", "infra", "github"],
  },
];

const SHARED_DOMAIN = {
  name: "Shared",
  description: "Modules that are not clearly part of any other domain.",
};

function matchesKeyword(haystack: string, keyword: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${keyword}([^a-z0-9]|$)`).test(haystack);
}

export function mockDomainFor(module: Pick<MockModuleLine, "name" | "sampleFiles">): string {
  const name = module.name.toLowerCase();
  for (const rule of DOMAIN_RULES) {
    if (rule.keywords.some((keyword) => matchesKeyword(name, keyword))) return rule.name;
  }
  const paths = module.sampleFiles.join(" ").toLowerCase();
  for (const rule of DOMAIN_RULES) {
    if (rule.keywords.some((keyword) => matchesKeyword(paths, keyword))) return rule.name;
  }
  return SHARED_DOMAIN.name;
}

function domainContent(userText: string): { content: string; note: string } {
  const modules = parseModuleLines(userText);
  if (modules.length === 0) {
    // No module lines at all — answer with an empty (but valid) shape rather
    // than pretending to have grouped something.
    return { content: ["```json", JSON.stringify({ domains: [] }), "```"].join("\n"), note: "label-domains(0)" };
  }

  const buckets = new Map<string, string[]>();
  for (const entry of modules) {
    const domain = mockDomainFor(entry);
    const bucket = buckets.get(domain);
    if (bucket) bucket.push(entry.ref);
    else buckets.set(domain, [entry.ref]);
  }

  const described = new Map(
    [...DOMAIN_RULES, SHARED_DOMAIN].map((rule) => [rule.name, rule.description])
  );
  const domains = [...DOMAIN_RULES.map((r) => r.name), SHARED_DOMAIN.name]
    .filter((name) => buckets.has(name))
    .map((name) => ({
      name,
      description: described.get(name) ?? "",
      moduleIds: buckets.get(name) ?? [],
    }));

  const content = ["```json", JSON.stringify({ domains }, null, 2), "```"].join("\n");
  return {
    content,
    note: `label-domains modules=${modules.length} domains=${domains.length}`,
  };
}

/** The literal prefix every mock-written module description carries, so test data is recognisable (and deletable) in the UI and in Neo4j. */
export const MOCK_DESCRIPTION_PREFIX = "[mock] ";

function describeContent(userText: string): { content: string; note: string } {
  const modules = parseModuleLines(userText);
  const described = modules.map((module) => ({
    id: module.ref,
    description: mockDescriptionFor(module),
  }));
  const content = ["```json", JSON.stringify({ modules: described }, null, 2), "```"].join("\n");
  return { content, note: `describe-modules modules=${modules.length}` };
}

/** Echoes the proposed feature name back, with a recognisable mock description. */
function mergeNameContent(userText: string): { content: string; note: string } {
  const proposed = /^Proposed name: (.*)$/m.exec(userText)?.[1]?.trim() || "Feature";
  const members = (userText.match(/^- .*\*\*$/gm) ?? []).length;
  const body = {
    name: proposed,
    description: `${MOCK_DESCRIPTION_PREFIX}Brings together ${members} folder(s) that implement ${proposed.toLowerCase()}.`,
  };
  const content = ["```json", JSON.stringify(body, null, 2), "```"].join("\n");
  return { content, note: `name-feature "${proposed}"` };
}

function mockDescriptionFor(module: MockModuleLine): string {
  const where = module.sampleFiles[0]?.split("/").slice(0, -1).join("/") || module.name;
  const files = `${module.fileCount} file${module.fileCount === 1 ? "" : "s"}`;
  const deps =
    module.dependsOn.length > 0
      ? ` and depends on ${module.dependsOn.slice(0, 2).join(" and ")}`
      : "";
  return `${MOCK_DESCRIPTION_PREFIX}Groups ${files} under ${where}${deps}.`;
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
