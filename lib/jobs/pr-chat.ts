// The PR chat (DESIGN.md §6.7): one conversation turn, and the read-only
// tools the model can use during it.
//
// Tools, all read-only and scoped to this repo and target:
//
//   list_changed_files   the diff's files, with +/- and the component each belongs to
//   get_diff             one changed file's patch
//   read_file            a file at the PR's head (or base), a line range at a time
//   search_code          fixed-string search — "who calls X", "where is Y defined"
//   get_component        a component: description, files, what it depends on, what depends on it
//   get_callers/_callees the call edges of a declaration (./chat-lookups.ts)
//   get_imports          a file's imports, both ways
//   git_log, blame       the history of the commit the chat is about
//   get_pr_map           the change's areas, as the PR map shows them
//   get_checklist        the PR checklist's results
//   get_ci_status        the CI checks on the head commit
//   get_findings         the review's findings, optionally for one component
//
//   add_finding          records a finding in the change's review — only when
//                        the reviewer asks for it ("add this to the findings")
//   suggest_finding      offers a finding the model noticed on its own; it is
//                        stored on the answer, and only the reviewer's Add
//                        (addSuggestedFinding) puts it in the review
//
//   triage_finding       offers a verdict on a finding already in the review
//                        (holds / wrong / re-rate); only the reviewer's Apply
//                        (applyChatTriage) changes the finding
//
//   show, highlight,     change what the reviewer's screen shows (a view, a
//   filter_findings,     selection, the findings list, the file viewer).
//   switch_view,         Resolved to ids here and stored on the answer as
//   open_diff            `actions`; the chat column applies them when the
//                        answer arrives. The final answer's `point_to` and
//                        `next` are resolved the same way into actions that
//                        are only offered (chips), never applied.
//
// Nothing here writes to the repo, runs code, or reaches outside the repo's
// own host (GitHub/GitLab/local checkout). The one write is add_finding, into
// GraphReview's own review (category `chat`, which no review pass replaces).
//
// With no target, the same turn runs the repo-wide chat (the Graph tab with
// no diff selected): one thread per repo, a repo summary instead of a change
// summary, files read at the analyzed commit, and only the tools that don't
// need a diff — plus `list_components`.
//
// Kept out of lib/jobs' barrel: it pulls in lib/ai.

import { randomUUID } from "node:crypto";
import type { AnalysisResult, CallGraph } from "@/lib/analysis";
import { runPrChat, type PrChatStep, type PrChatTool, type PrChatToolOutput } from "@/lib/ai";
import type { PrMapResponseDTO } from "@/components/graph/pr-map-types";
import { emitFindingsChanged } from "@/lib/mcp/events";
import {
  addChatMessage,
  addFindingResponse,
  getFileOwnerMap,
  listChatMessages,
  listComponentsByRepoId,
  listFindingsByTargetKey,
  getComponentOverview,
  readInfraCatalog,
  readDbSchema,
  readEnvCatalog,
  rateFinding,
  readTargetGraph,
  updateChatSuggestion,
  updateChatTriage,
  upsertFinding,
} from "@/lib/db";
import type { ApiChange } from "@/lib/analysis/api/types";
import { describeApiChange, endpointLabel } from "@/lib/analysis/api/describe";
import type { InfraChange } from "@/lib/analysis/infra/types";
import type { DbChange } from "@/lib/analysis/db/types";
import type { EnvChange } from "@/lib/analysis/env/types";
import { describeEnvChange, describeEnvFinding, describeEnvVar, filterEnv } from "@/lib/analysis/env/describe";
import { describeDbFinding, describeSchemaChange, describeTable, filterTables } from "@/lib/analysis/db/describe";
import { describeInfraChange, describeInfraFinding, describeInfraResource, filterInfra } from "@/lib/analysis/infra/describe";
import { readServedApiCatalog } from "./api-catalog";
import type { TargetGraphData } from "./target-graph-queue";
import type {
  ChatActionRecord,
  ChatFileTab,
  ChatMessageRecord,
  ChatShowKind,
  ChatSuggestionRecord,
  ChatTriageRecord,
  ChatViewName,
  ComponentRecord,
  FindingRecord,
  FindingWithComponent,
  RepoRecord,
} from "@/lib/db";
import type { JobLogger } from "./analyze";
import { loadAiConfigOrNull } from "./ai-config";
import { describeCalls, describeImports, findDeclarations, gitBlame, gitLog, loadChatAnalysis, repoDirWithCommit } from "./chat-lookups";
import { evaluateChecklist } from "./checklist";
import { loadCiStatus, loadPrContext, readFileAtCommit, searchCode } from "./pr-context";
import { buildPrMapFor } from "./pr-map";
import type { ResolvedTarget } from "./review-target";
import { reviewTargetKey, type ReviewTarget } from "./review-queue";

/** The thread key of the repo-wide chat — review target keys are `pr:…` / `refs:…`, so it can't collide. */
export const REPO_CHAT_THREAD_KEY = "repo";

/** How many earlier messages go back to the model as history. */
const HISTORY_MESSAGES = 12;
const READ_FILE_MAX_LINES = 250;
const CONTEXT_MAX_FILES = 80;
const CONTEXT_MAX_BODY_CHARS = 1500;
/** The screen note is the UI's own summary — a line or two; anything longer is cut. */
const SCREEN_MAX_CHARS = 600;

export const PR_CHAT_TOOLS: PrChatTool[] = [
  { name: "list_changed_files", args: "{}", description: "every file this change touches, with +/- line counts and its component" },
  { name: "get_diff", args: '{"path":"<changed file>"}', description: "the unified diff of one changed file" },
  {
    name: "read_file",
    args: '{"path":"<file>","start":1,"end":200,"ref":"head"}',
    description: `a file's lines at the PR's head (or "base"); up to ${READ_FILE_MAX_LINES} lines per call`,
  },
  {
    name: "search_code",
    args: '{"query":"<exact text, e.g. a function name>"}',
    description: "fixed-string search across the code, to find where something is defined or used",
  },
  {
    name: "get_component",
    args: '{"name":"<component name>"}',
    description: "a component of the repo graph: what it's for, its files, what it depends on and what depends on it",
  },
  {
    name: "get_callers",
    args: '{"name":"<function, or Class.method>","path":"<optional file, to pick one of several>"}',
    description:
      "every place that calls a function, method or class, from static analysis (TS/JS, Python, Java, Kotlin) — better than search_code for \"who breaks if this changes\"",
  },
  {
    name: "get_callees",
    args: '{"name":"<function, or Class.method>","path":"<optional file>"}',
    description: "the repo functions a function, method or class calls, with where each is defined",
  },
  {
    name: "get_imports",
    args: '{"path":"<file>"}',
    description: "the repo files a file imports and the files that import it, each with its component",
  },
  {
    name: "git_log",
    args: '{"path":"<optional file>","limit":10}',
    description: "the latest commits (hash, date, author, subject), optionally only those touching one file",
  },
  {
    name: "blame",
    args: '{"path":"<file>","start":1,"end":40}',
    description: "who last changed each line of a range and in which commit — why the code looks the way it does",
  },
  {
    name: "list_endpoints",
    args: '{"query":"<optional text in the path, handler or framework>"}',
    description: "the app's API: endpoints (HTTP routes, server actions, tRPC, GraphQL) with handler, middleware/auth and request/response shapes",
  },
  {
    name: "list_infra",
    args: '{"query":"<optional text in the address, kind, file or tool>"}',
    description:
      "the repo's infrastructure as code (Terraform/OpenTofu, Nomad, Kubernetes, Helm, Dockerfiles): resources with versions, which workload ships which code, env vars read but not set, routes",
  },
  {
    name: "get_infra_changes",
    args: "{}",
    description: "what this change does to the infrastructure, plan-style (create/destroy/update/moved/version), its link deltas and the certain infra findings",
  },
  {
    name: "list_env",
    args: '{"query":"<optional text in the name, a file or a value>","tag":"<optional: undeclared, not-set, set-not-read, maybe-set, secret, client, undefined-in-client>","environment":"<optional: example, default, production, compose:web, ci:deploy, …>"}',
    description:
      "the env vars the code reads, declares (typed schemas, .env.example) and sets (.env files, CI, Compose, framework config, workloads), per environment, with gaps such as read but undeclared; secret values masked",
  },
  {
    name: "get_env_changes",
    args: "{}",
    description: "what this change does to the env vars — reads, declarations and values per environment added, removed or changed — and the certain env findings",
  },
  {
    name: "list_tables",
    args: '{"query":"<optional text in the table, column, model or file>"}',
    description:
      "the database schema the repo's migrations, schema files and ORM models declare: tables with columns, keys, FKs, the models that map them, the endpoints that read or write them, and drift between models and migrations",
  },
  {
    name: "get_schema_changes",
    args: "{}",
    description: "what this change does to the database schema: tables and columns added, dropped, retyped or renamed, indexes, FKs, enums, the migrations it adds, drift it introduces and the certain schema findings",
  },
  {
    name: "get_pr_map",
    args: "{}",
    description: "the change grouped into areas as the PR map shows them: each area's files and components, and how the areas connect",
  },
  {
    name: "get_checklist",
    args: "{}",
    description: "the PR checklist for this change: each check (CI, description, size, protected paths, AI questions) with pass/fail and why",
  },
  {
    name: "get_ci_status",
    args: "{}",
    description: "the CI checks on the change's head commit (GitHub/GitLab), each passing, failing or running, with links",
  },
  {
    name: "get_findings",
    args: '{"component":"<optional component name>"}',
    description: "the AI review's findings for this change, optionally for one component",
  },
  {
    name: "show",
    args: '{"kind":"component|file|endpoint|table|env|infra|area|function|finding","name":"<its name, path or id>","line":12}',
    description:
      "moves the reviewer's screen to one thing: a component's card on the App map, a file (at a line), an endpoint, a table (on the Data view), an env var (on the Env view), an infra resource, an area of the PR map, a function of the change or a finding in the review list (by its #id) — changes nothing else",
  },
  {
    name: "switch_view",
    args: '{"view":"pr|app|api|infra|data|env|files","level":"architecture|features|modules","mode":"<pr: files|functions; infra: diagram|files|requests|list; data: canvas|list>","changed_only":true}',
    description:
      "switches the Graph tab to a view, optionally with the App map's level, the view's mode or its \"changed only\" toggle — e.g. the infra diagram, the PR map's functions, the App map by feature",
  },
  {
    name: "open_diff",
    args: '{"path":"<changed file>","tab":"diff|file|base|preview","line":12,"end":20,"symbol":"<component or function, for preview>"}',
    description:
      "opens a changed file in the file viewer: its diff with lines marked (diff), the whole new file (file), the whole file before the change (base), or the Before / after preview of a component or function in it (preview — only offered as a chip, since it starts a sandbox)",
  },
  {
    name: "highlight",
    args: '{"components":["<component>","<component>"]}',
    description: "rings several components' cards on the App map, e.g. the path a request takes — changes nothing else",
  },
  {
    name: "filter_findings",
    args: '{"assessment":["defect","concern"],"category":"<optional: structure, infra or schema>","component":"<optional component name>"}',
    description: "sets which findings the review list under the map shows (verdicts, one static-analysis category, one component) — changes nothing else",
  },
  {
    name: "add_finding",
    args: '{"path":"<file>","line":12,"assessment":"defect","summary":"<one sentence>","rationale":"<why, with the evidence>"}',
    description:
      "WRITES a finding into this change's review (assessment defect, concern, unknown or ok) — only when the reviewer asks you to add, record or flag something",
  },
  {
    name: "suggest_finding",
    args: '{"path":"<file>","line":12,"assessment":"concern","summary":"<one sentence>","rationale":"<why, with the evidence>"}',
    description:
      "offers the reviewer a problem you noticed that the review doesn't have yet; they choose whether to add it — use without being asked",
  },
  {
    name: "triage_finding",
    args: '{"id":"<#id from get_findings>","verdict":"holds|wrong|rerate","assessment":"<rerate: defect|concern|unknown|ok>","reason":"<the evidence, a sentence or two>"}',
    description:
      "offers your verdict on a finding already in the review — it holds, it is wrong (resolves it), or its verdict should change; the reviewer chooses whether to apply it",
  },
];

/** Most suggestions one answer may carry — beyond that they stop being worth reading. */
export const MAX_SUGGESTIONS_PER_ANSWER = 3;

const REPO_TOOL_NAMES = new Set([
  "read_file",
  "search_code",
  "get_component",
  "get_callers",
  "get_callees",
  "get_imports",
  "git_log",
  "blame",
  "list_endpoints",
  "list_infra",
  "list_env",
  "list_tables",
  "show",
  "highlight",
  "switch_view",
]);

/** Most view changes one answer may make — the reviewer should still recognise their screen. */
export const MAX_ACTIONS_PER_ANSWER = 4;

export const REPO_CHAT_TOOLS: PrChatTool[] = [
  {
    name: "list_components",
    args: "{}",
    description: "every module of the repo graph with its file count and one-line description",
  },
  ...PR_CHAT_TOOLS.filter((t) => REPO_TOOL_NAMES.has(t.name)).map((t) =>
    t.name === "read_file"
      ? {
          ...t,
          args: '{"path":"<file>","start":1,"end":200}',
          description: `a file's lines at the analyzed commit; up to ${READ_FILE_MAX_LINES} lines per call`,
        }
      : t.name === "show"
        ? {
            ...t,
            args: '{"kind":"component|file|endpoint|table|env|infra","name":"<its name, path or id>","line":12}',
            description:
              "moves the developer's screen to one thing: a component's card on the App map, a file (at a line), an endpoint, a table, an env var or an infra resource — changes nothing else",
          }
        : t.name === "switch_view"
          ? { ...t, args: t.args.replace("pr|app", "app").replace("pr: files|functions; ", "") }
          : t
  ),
];

/** Most offered stops (`point_to`) one answer carries, besides its `next`. */
export const MAX_OFFERS_PER_ANSWER = 4;

interface ToolContext {
  repo: RepoRecord;
  /** The change being discussed — `null` in the repo-wide chat. */
  ctx: ResolvedTarget | null;
  components: ComponentRecord[];
  ownerByFile: Map<string, string>;
  findings: FindingWithComponent[];
  /** For add_finding: where findings go, and the model to credit. */
  targetKey: string;
  prId?: string;
  model: string;
  /** What the change does to the endpoints, when the base/head comparison has run (DESIGN.md §6.11). */
  api?: ApiChange;
  /** What the change does to the infrastructure, likewise (DESIGN.md §6.12). */
  infra?: InfraChange;
  /** What the change does to the database schema, likewise (DESIGN.md §6.13). */
  db?: DbChange;
  /** What the change does to the env vars, likewise (DESIGN.md §6.15). */
  env?: EnvChange;
  /** The change's call graph (functions it touches and their neighbours), for `show` a function. */
  callGraph?: CallGraph;
  /** suggest_finding's offers in this turn, stored on the answer. */
  suggestions: ChatSuggestionRecord[];
  /** show / highlight / filter_findings / switch_view / open_diff in this turn, stored on the answer and applied by the UI. */
  actions: ChatActionRecord[];
  /** triage_finding's verdicts in this turn, stored on the answer. */
  triage: ChatTriageRecord[];
  /** The review target, for fetching its commits; null in the repo chat. */
  target: ReviewTarget | null;
  /** The commit analysis the call and import tools read, loaded on first use. */
  analysis?: Promise<AnalysisResult>;
  /** The PR map, built on first use. */
  prMap?: Promise<PrMapResponseDTO>;
}

/** The commit the chat is about: the change's head, or the repo's analysed commit. */
function chatSha(tc: ToolContext): string | undefined {
  return tc.ctx ? tc.ctx.reviewed.headSha : tc.repo.lastAnalyzedSha;
}

function analysisOf(tc: ToolContext): Promise<AnalysisResult> {
  const sha = chatSha(tc);
  if (!sha) return Promise.reject(new Error("No commit to analyse — the repo hasn't been analysed yet."));
  tc.analysis ??= loadChatAnalysis(tc.repo, sha, tc.target);
  tc.analysis.catch(() => (tc.analysis = undefined));
  return tc.analysis;
}

function prMapOf(tc: ToolContext): Promise<PrMapResponseDTO> {
  if (!tc.prMap) {
    const seen = new Set<string>();
    const files = tc.ctx!.files.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
    tc.prMap = buildPrMapFor(tc.repo.id, tc.targetKey, files);
    tc.prMap.catch(() => (tc.prMap = undefined));
  }
  return tc.prMap;
}

/** The owner's name of a path, "" when the graph doesn't know it. */
function componentLabel(tc: ToolContext, path: string): string {
  const owner = ownerOf(tc, path);
  return owner ? componentName(tc, owner) : "";
}

/** Component ids owning any of `paths`. */
function ownersOf(tc: ToolContext, paths: readonly string[]): string[] {
  return [...new Set(paths.map((p) => ownerOf(tc, p)).filter(Boolean))];
}

const ASSESSMENTS = new Set(["defect", "concern", "unknown", "ok"]);

/** A path's owning component; a file the graph doesn't know yet takes its folder's. */
function ownerOf(tc: ToolContext, path: string): string {
  const own = tc.ownerByFile.get(path);
  if (own) return own;
  let dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  while (dir) {
    for (const [file, owner] of tc.ownerByFile) if (file.startsWith(`${dir}/`)) return owner;
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
  return "";
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/** The first non-empty argument among `keys` — models don't always use the names the prompt shows. */
function arg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = str(args[key]);
    if (value) return value;
  }
  return "";
}

const PATH_KEYS = ["path", "file", "filePath", "file_path", "filename"];

function missing(tool: string): PrChatToolOutput {
  const spec = PR_CHAT_TOOLS.find((t) => t.name === tool);
  return {
    text: `${tool} needs arguments: {"tool":"${tool}","args":${spec?.args ?? "{}"}}`,
    summary: `${tool} called without arguments`,
  };
}

function num(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Tools that need a change to talk about; the repo-wide chat answers them with NO_CHANGE. */
const CHANGE_TOOL_NAMES = new Set([
  "list_changed_files",
  "get_diff",
  "get_findings",
  "add_finding",
  "suggest_finding",
  "get_infra_changes",
  "get_env_changes",
  "get_schema_changes",
  "get_pr_map",
  "get_checklist",
  "get_ci_status",
  "filter_findings",
  "open_diff",
  "triage_finding",
]);

/** A chat finding as the model gave it, before it is recorded or offered. */
type FindingDraft = Omit<ChatSuggestionRecord, "id" | "status" | "findingId">;

/** add_finding's / suggest_finding's arguments, read leniently; null without a summary. Needs a change (tc.ctx). */
function findingDraft(tc: ToolContext, args: Record<string, unknown>): FindingDraft | null {
  const summary = arg(args, "summary", "title", "finding");
  if (!summary) return null;
  const rationale = arg(args, "rationale", "why", "reason", "explanation") || summary;
  const rawAssessment = arg(args, "assessment", "severity", "verdict").toLowerCase();
  const assessment = (ASSESSMENTS.has(rawAssessment) ? rawAssessment : "concern") as FindingDraft["assessment"];
  const filePath = arg(args, ...PATH_KEYS).replace(/^\/+/, "").replace(/:\d+(-\d+)?$/, "") || undefined;
  const line = num(args.line) ?? num(args.start) ?? num(args.lineStart);
  const reviewed = tc.ctx!.reviewed;
  return {
    assessment,
    summary,
    rationale,
    ...(filePath ? { filePath } : {}),
    ...(line ? { line } : {}),
    componentId: filePath ? ownerOf(tc, filePath) : "",
    ...(tc.prId ? { prId: tc.prId } : {}),
    ...(reviewed.baseSha ? { reviewedBaseSha: reviewed.baseSha } : {}),
    ...(reviewed.headSha ? { reviewedHeadSha: reviewed.headSha } : {}),
  };
}

/** A chat finding already in the review with this summary on this file. */
function sameFinding(tc: ToolContext, summary: string, filePath: string | undefined): FindingWithComponent | undefined {
  return tc.findings.find(
    (f) => f.category === "chat" && f.summary.trim().toLowerCase() === summary.trim().toLowerCase() && (f.filePath ?? "") === (filePath ?? "")
  );
}

/** Writes a chat finding (category `chat`, which no review pass replaces) and tells an open review dock to refetch. */
async function recordChatFinding(repoId: string, targetKey: string, draft: FindingDraft, model: string): Promise<FindingRecord> {
  const record = await upsertFinding({
    id: randomUUID(),
    repoId,
    targetKey,
    ...(draft.prId ? { prId: draft.prId } : {}),
    componentId: draft.componentId,
    category: "chat",
    ...(draft.filePath ? { filePath: draft.filePath } : {}),
    ...(draft.line ? { lineRange: String(draft.line) } : {}),
    summary: draft.summary,
    assessment: draft.assessment,
    confidence: 0.9,
    rationale: draft.rationale,
    model,
    ...(draft.reviewedBaseSha ? { reviewedBaseSha: draft.reviewedBaseSha } : {}),
    ...(draft.reviewedHeadSha ? { reviewedHeadSha: draft.reviewedHeadSha } : {}),
    reviewedAt: new Date().toISOString(),
  });
  // An open review dock refetches (the same signal as an MCP reply).
  emitFindingsChanged(repoId, targetKey, record.id);
  return record;
}

/**
 * The reviewer's Add on a suggested finding: records it in the review the
 * message belongs to and marks the suggestion added. Adding twice returns the
 * finding from the first time.
 */
export async function addSuggestedFinding(
  message: ChatMessageRecord,
  suggestionId: string
): Promise<{ message: ChatMessageRecord; findingId: string } | undefined> {
  const suggestion = message.suggestions?.find((x) => x.id === suggestionId);
  if (!suggestion) return undefined;
  if (suggestion.status === "added" && suggestion.findingId) return { message, findingId: suggestion.findingId };
  const record = await recordChatFinding(message.repoId, message.targetKey, suggestion, message.model ?? "chat");
  const updated = await updateChatSuggestion(message.repoId, message.id, suggestionId, { status: "added", findingId: record.id });
  return updated ? { message: updated, findingId: record.id } : undefined;
}

/** A finding's short handle for the model: `#` and the start of its id. */
function findingRef(f: { id: string }): string {
  return `#${f.id.slice(0, 8)}`;
}

/** A finding of this change by its `#id` (or the start of its id). */
function findFinding(tc: ToolContext, query: string): FindingWithComponent | undefined {
  const q = query.trim().replace(/^#/, "").toLowerCase();
  return q.length >= 4 ? tc.findings.find((f) => f.id.toLowerCase().startsWith(q)) : undefined;
}

/** A finding as the model reads it: handle, verdict and kind, where, what, why. */
export function describeFinding(f: FindingWithComponent): string {
  return (
    `${findingRef(f)} [${findingLabels(f)}${f.resolvedAt ? ", resolved" : ""}] ${f.componentName || "whole PR"}` +
    `${f.filePath ? ` ${f.filePath}${f.lineRange ? `:${f.lineRange}` : ""}` : ""}: ${f.summary}\n  why: ${f.rationale}`
  );
}

/** `"defect, impact"`, `"ok, fix, unmentioned"` — the verdict first, then what kind of finding it is. */
function findingLabels(f: FindingWithComponent): string {
  return [f.assessment, f.category !== "change" ? f.category : "", f.kind, f.scope].filter(Boolean).join(", ");
}

function componentName(tc: ToolContext, id: string | undefined): string {
  return (id && tc.components.find((c) => c.id === id)?.name) || "(no component)";
}

/** Exact name/id first, then case-insensitive, then "contains". */
function findComponent(tc: ToolContext, query: string): ComponentRecord | undefined {
  const q = query.toLowerCase();
  const modules = tc.components.filter((c) => c.tier === "module");
  return (
    tc.components.find((c) => c.id === query || c.name === query) ??
    modules.find((c) => c.name.toLowerCase() === q) ??
    modules.find((c) => c.name.toLowerCase().includes(q) || c.pathPatterns.some((p) => p.toLowerCase().includes(q)))
  );
}

/** What the repo-wide chat says to a tool that needs a diff. */
const NO_CHANGE: PrChatToolOutput = {
  text: "No change is selected — this conversation is about the repo as a whole. Use read_file, search_code or get_component.",
  summary: "no change selected",
};

/** The file-count of each component, from the file → owner map. */
function fileCounts(tc: ToolContext): Map<string, number> {
  const counts = new Map<string, number>();
  for (const owner of tc.ownerByFile.values()) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  return counts;
}

async function runTool(tc: ToolContext, name: string, args: Record<string, unknown>): Promise<PrChatToolOutput> {
  const ctx = tc.ctx;
  if (!ctx && CHANGE_TOOL_NAMES.has(name)) return NO_CHANGE;
  switch (name) {
    case "list_endpoints": {
      const served = readServedApiCatalog(tc.repo.id);
      if (!served) return { text: "The endpoint list isn't built yet — the repo needs a re-analysis.", summary: "no endpoint list yet" };
      const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const list = served.catalog.endpoints.filter((e) => !q || [e.path, e.framework, e.handler?.file ?? "", e.handler?.name ?? ""].some((t) => t.toLowerCase().includes(q)));
      const lines = list.slice(0, 60).map((e) => {
        const shape = (s: typeof e.request) => (s?.fields?.length ? `{ ${s.fields.map((f) => `${f.name}${f.required ? "" : "?"}`).join(", ")} }` : s?.type);
        return [
          `- ${endpointLabel(e)}`,
          e.handler ? ` → ${e.handler.file}:${e.handler.startLine}` : " (spec only)",
          e.auth.length ? `; auth: ${e.auth.join(" → ")}` : "",
          shape(e.request) ? `; body ${shape(e.request)}` : "",
          shape(e.response) ? `; returns ${shape(e.response)}` : "",
        ].join("");
      });
      if (list.length > 60) lines.push(`… ${list.length - 60} more — narrow it with a query`);
      return {
        text: lines.join("\n") || "(no endpoints match)",
        summary: `listed ${Math.min(list.length, 60)} endpoint(s)`,
        files: [...new Set(list.slice(0, 8).map((e) => e.handler?.file).filter((f): f is string => Boolean(f)))],
      };
    }

    case "list_infra": {
      const stored = readInfraCatalog(tc.repo.id);
      if (!stored) return { text: "The infra catalog isn't built yet — the repo needs a re-analysis.", summary: "no infra catalog yet" };
      const list = filterInfra(stored.catalog, typeof args.query === "string" ? args.query : undefined);
      const lines = list.slice(0, 60).map((r) => `- ${describeInfraResource(r, stored.catalog)}`);
      if (list.length > 60) lines.push(`… ${list.length - 60} more — narrow it with a query`);
      return {
        text: lines.join("\n") || (stored.catalog.resources.length ? "(no resources match)" : "(no infrastructure as code found in this repo)"),
        summary: `listed ${Math.min(list.length, 60)} infra resource(s)`,
        files: [...new Set(list.slice(0, 8).map((r) => r.file))],
      };
    }

    case "get_infra_changes": {
      if (!tc.infra) return { text: "The base/head comparison hasn't run yet (or doesn't cover infrastructure) — try again shortly.", summary: "no infra comparison yet" };
      const lines = describeInfraChange(tc.infra, 40);
      if (tc.infra.findings.length) lines.push("Certain findings (already in the review as `infra`):", ...tc.infra.findings.map((f) => `- ${describeInfraFinding(f)}`));
      return { text: lines.join("\n"), summary: `read the infra change (${tc.infra.changes.length} resource change(s))`, files: [...new Set(tc.infra.changes.slice(0, 8).map((c) => c.resource.file))] };
    }

    case "list_env": {
      const stored = readEnvCatalog(tc.repo.id);
      if (!stored) return { text: "The env catalog isn't built yet — the repo needs a re-analysis.", summary: "no env catalog yet" };
      const list = filterEnv(stored.catalog, { query: typeof args.query === "string" ? args.query : undefined, tag: typeof args.tag === "string" ? args.tag : undefined, environment: typeof args.environment === "string" ? args.environment : undefined });
      const lines = list.slice(0, 60).map((v) => `- ${describeEnvVar(v)}`);
      if (list.length > 60) lines.push(`… ${list.length - 60} more — narrow it with a query`);
      if (stored.catalog.targets.length) lines.unshift(`Environments/targets: ${stored.catalog.targets.map((t) => t.id).join(", ")}`);
      return {
        text: lines.join("\n") || (stored.catalog.vars.length ? "(no env vars match)" : "(no env var reads or settings found in this repo)"),
        summary: `listed ${Math.min(list.length, 60)} env var(s)`,
        files: [...new Set(list.slice(0, 8).flatMap((v) => (v.reads[0] ? [v.reads[0].file] : [])))],
      };
    }

    case "get_env_changes": {
      if (!tc.env) return { text: "The base/head comparison hasn't run yet (or doesn't cover env vars) — try again shortly.", summary: "no env comparison yet" };
      const lines = describeEnvChange(tc.env, 40);
      if (tc.env.findings.length) lines.push("Certain findings (already in the review as `env`):", ...tc.env.findings.map((f) => `- ${describeEnvFinding(f)}`));
      return { text: lines.join("\n"), summary: `read the env change (${tc.env.changes.length} name(s))`, files: [...new Set(tc.env.findings.slice(0, 8).map((f) => f.file))] };
    }

    case "list_tables": {
      const stored = readDbSchema(tc.repo.id);
      if (!stored) return { text: "The schema catalog isn't built yet — the repo needs a re-analysis.", summary: "no schema catalog yet" };
      const list = filterTables(stored.schema, typeof args.query === "string" ? args.query : undefined);
      const lines = list.slice(0, 40).map(({ table, db }) => `- ${describeTable(table, db)}`);
      if (list.length > 40) lines.push(`… ${list.length - 40} more — narrow it with a query`);
      if (stored.schema.pinned) lines.unshift(`Source: ${stored.schema.pinned.file} (pinned by the user — auto-detection is off${stored.schema.pinned.missing ? "; the file isn't in the analysed commit" : ""}).`);
      const problems = stored.schema.databases.flatMap((d) => d.orderProblems.map((p) => `- ${d.name}: ${p}`));
      if (problems.length) lines.push("Migration order problems:", ...problems);
      return {
        text: lines.join("\n") || (stored.schema.databases.length ? "(no tables match)" : "(no migrations, schema files or ORM models found in this repo)"),
        summary: `listed ${Math.min(list.length, 40)} table(s)`,
        files: [...new Set(list.slice(0, 8).map(({ table }) => table.definedAt.file))],
      };
    }

    case "get_schema_changes": {
      if (!tc.db) return { text: "The base/head comparison hasn't run yet (or doesn't cover the schema) — try again shortly.", summary: "no schema comparison yet" };
      const lines = describeSchemaChange(tc.db, 40);
      if (tc.db.findings.length) lines.push("Certain findings (already in the review as `schema`):", ...tc.db.findings.map((f) => `- ${describeDbFinding(f)}`));
      return { text: lines.join("\n"), summary: `read the schema change (${tc.db.tables.length} table change(s))`, files: [...new Set(tc.db.migrations.slice(0, 8).map((m) => m.file))] };
    }

    case "list_components": {
      const counts = fileCounts(tc);
      const modules = tc.components.filter((c) => c.tier === "module").sort((a, b) => a.name.localeCompare(b.name));
      return {
        text:
          modules
            .map((c) => `- ${c.name} (${counts.get(c.id) ?? 0} files)${c.description ? `: ${c.description}` : ""}`)
            .join("\n") || "(no components — the repo hasn't been analyzed)",
        summary: `listed ${modules.length} component(s)`,
      };
    }

    case "list_changed_files": {
      const lines = ctx!.files.map((f) => {
        const owner = tc.ownerByFile.get(f.path);
        return `${f.path} (${f.status}, +${f.additions}/-${f.deletions}) — ${owner ? componentName(tc, owner) : "new/unanalyzed"}`;
      });
      return {
        text: lines.join("\n") || "(no changed files)",
        summary: `listed ${ctx!.files.length} changed file(s)`,
        componentIds: [...new Set(ctx!.files.map((f) => tc.ownerByFile.get(f.path)).filter((id): id is string => !!id))],
      };
    }

    case "get_diff": {
      const path = arg(args, ...PATH_KEYS).replace(/^\/+/, "");
      if (!path) return missing(name);
      const file = ctx!.files.find((f) => f.path === path) ?? ctx!.files.find((f) => f.path.endsWith(`/${path}`));
      if (!file) return { text: `"${path}" is not one of the changed files. Use list_changed_files.`, summary: `no diff for ${path}` };
      const owner = tc.ownerByFile.get(file.path);
      return {
        text: file.patch ?? "(no text diff — binary or too large)",
        summary: `read the diff of ${file.path}`,
        files: [file.path],
        componentIds: owner ? [owner] : [],
      };
    }

    case "read_file": {
      const path = arg(args, ...PATH_KEYS).replace(/:\d+(-\d+)?$/, "");
      if (!path) return missing(name);
      const ref = ctx ? (str(args.ref) === "base" ? "base" : "head") : "the analyzed commit";
      const sha = !ctx ? tc.repo.lastAnalyzedSha : ref === "base" ? ctx.reviewed.baseSha : ctx.reviewed.headSha;
      const found = await readFileAtCommit(tc.repo, sha, path);
      if (!found) return { text: `Could not read "${path}" at ${ref}.`, summary: `could not read ${path}` };
      const all = found.text.split(/\r?\n/);
      const start = Math.min(num(args.start) ?? 1, Math.max(1, all.length));
      const end = Math.min(num(args.end) ?? start + READ_FILE_MAX_LINES - 1, start + READ_FILE_MAX_LINES - 1, all.length);
      const body = all
        .slice(start - 1, end)
        .map((line, i) => `${String(start + i).padStart(5)}  ${line}`)
        .join("\n");
      const note =
        found.source === "default-branch"
          ? ctx
            ? " (from the default branch — the PR head could not be read)"
            : " (from the default branch checkout)"
          : "";
      const owner = tc.ownerByFile.get(path);
      return {
        text: `${path} lines ${start}-${end} of ${all.length} at ${ref}${note}\n${body}`,
        summary: `read ${path}:${start}-${end}`,
        files: [path],
        componentIds: owner ? [owner] : [],
      };
    }

    case "search_code": {
      const query = arg(args, "query", "q", "text", "symbol", "pattern", "term", "search");
      if (!query) return missing(name);
      if (query.length < 2) return { text: "Give a longer query.", summary: "search skipped" };
      const { hits, source } = await searchCode(tc.repo, ctx ? ctx.reviewed.headSha : tc.repo.lastAnalyzedSha, query);
      const ids = new Set<string>();
      const lines = hits.map((h) => {
        const owner = tc.ownerByFile.get(h.path);
        if (owner) ids.add(owner);
        return `${h.path}:${h.line} [${componentName(tc, owner)}] ${h.text}`;
      });
      const where = !ctx
        ? "in the repo"
        : source === "commit"
          ? "at the PR's head"
          : "in the default branch (the PR's own changes are in the diffs)";
      return {
        text: hits.length ? `${hits.length} hit(s) ${where}:\n${lines.join("\n")}` : `No hits for "${query}" ${where}.`,
        summary: `searched for "${query}" (${hits.length} hit${hits.length === 1 ? "" : "s"})`,
        componentIds: [...ids],
      };
    }

    case "get_component": {
      const query = arg(args, "name", "component", "id", "module");
      if (!query) return missing(name);
      const component = findComponent(tc, query);
      if (!component) return { text: `No component matches "${query}".`, summary: `no component "${query}"` };
      const overview = await getComponentOverview(component.id);
      const files = overview.files.sort();
      const deps = overview.deps;
      const users = overview.users;
      const changed = ctx ? files.filter((f) => ctx.files.some((c) => c.path === f)) : null;
      return {
        text: [
          `Component: ${component.name}${component.origin === "merge" ? " (merged feature)" : ""}`,
          `Description: ${component.description ?? "(none)"}`,
          `Files (${files.length}): ${files.slice(0, 40).join(", ")}${files.length > 40 ? ", …" : ""}`,
          ...(changed ? [`Changed in this PR: ${changed.join(", ") || "(none)"}`] : []),
          `Depends on: ${deps.join(", ") || "(nothing)"}`,
          `Depended on by: ${users.join(", ") || "(nothing)"}`,
        ].join("\n"),
        summary: `looked up component ${component.name}`,
        componentIds: [component.id],
      };
    }

    case "get_findings": {
      const query = arg(args, "component", "name", "module");
      const component = query ? findComponent(tc, query) : undefined;
      const findings = component ? tc.findings.filter((f) => f.componentId === component.id) : tc.findings;
      const text = findings.map(describeFinding).join("\n");
      return {
        text: text || (tc.findings.length ? "No findings for that component." : "The review has no findings (it may not have run)."),
        summary: `read ${findings.length} finding(s)${component ? ` for ${component.name}` : ""}`,
        componentIds: [...new Set(findings.map((f) => f.componentId))],
      };
    }

    case "add_finding": {
      const draft = findingDraft(tc, args);
      if (!draft) return missing(name);
      const existing = sameFinding(tc, draft.summary, draft.filePath);
      if (existing) {
        return { text: `That finding is already in the review (id ${existing.id}).`, summary: `finding already recorded: ${draft.summary}` };
      }
      const record = await recordChatFinding(tc.repo.id, tc.targetKey, draft, tc.model);
      tc.findings.push({ ...record, componentName: componentName(tc, draft.componentId) });
      return {
        text: `Added to the review as a ${draft.assessment} (id ${record.id}). It shows in the findings list, marked "From chat".`,
        summary: `added a ${draft.assessment} finding: ${draft.summary}`,
        ...(draft.filePath ? { files: [draft.filePath] } : {}),
        ...(draft.componentId ? { componentIds: [draft.componentId] } : {}),
      };
    }

    case "suggest_finding": {
      const draft = findingDraft(tc, args);
      if (!draft) return missing(name);
      const existing = sameFinding(tc, draft.summary, draft.filePath);
      if (existing) {
        return { text: `The review already has that (id ${existing.id}) — no need to suggest it.`, summary: `already in the review: ${draft.summary}` };
      }
      const key = (x: { summary: string; filePath?: string }) => `${x.filePath ?? ""}\n${x.summary.trim().toLowerCase()}`;
      if (tc.suggestions.some((x) => key(x) === key(draft))) {
        return { text: "You already suggested that in this answer.", summary: `suggested again: ${draft.summary}` };
      }
      if (tc.suggestions.length >= MAX_SUGGESTIONS_PER_ANSWER) {
        return {
          text: `That's ${MAX_SUGGESTIONS_PER_ANSWER} suggestions already — keep to those and give your answer.`,
          summary: "too many suggestions",
        };
      }
      tc.suggestions.push({ id: randomUUID(), ...draft, status: "pending" });
      return {
        text:
          "Shown to the reviewer under your answer as a suggested finding, with Add and Dismiss. Mention it in one line in " +
          "your answer; don't repeat the whole rationale.",
        summary: `suggested a ${draft.assessment}: ${draft.summary}`,
        ...(draft.filePath ? { files: [draft.filePath] } : {}),
        ...(draft.componentId ? { componentIds: [draft.componentId] } : {}),
      };
    }

    case "get_callers":
    case "get_callees": {
      const query = arg(args, "name", "function", "symbol", "method", "query");
      if (!query) return missing(name);
      const path = arg(args, ...PATH_KEYS) || undefined;
      const result = describeCalls(await analysisOf(tc), query, name === "get_callers" ? "callers" : "callees", path, (p) => componentLabel(tc, p));
      return { ...result, componentIds: ownersOf(tc, result.files) };
    }

    case "get_imports": {
      const path = arg(args, ...PATH_KEYS);
      if (!path) return missing(name);
      const result = describeImports(await analysisOf(tc), path, (p) => componentLabel(tc, p));
      return { ...result, componentIds: ownersOf(tc, result.files.slice(0, 1)) };
    }

    case "git_log":
    case "blame": {
      const sha = chatSha(tc);
      if (!sha) return { text: "No commit to read history at — the repo hasn't been analysed yet.", summary: "no commit" };
      const path = arg(args, ...PATH_KEYS);
      if (name === "blame" && !path) return missing(name);
      const dir = await repoDirWithCommit(tc.repo, sha, tc.target);
      if (!dir) return { text: "The repo isn't on disk, so its history can't be read.", summary: "no history" };
      const result =
        name === "git_log"
          ? await gitLog(dir, sha, path || undefined, num(args.limit) ?? num(args.n) ?? 10)
          : await gitBlame(dir, sha, path, num(args.start) ?? 1, num(args.end) ?? (num(args.start) ?? 1) + 39);
      return { ...result, componentIds: ownersOf(tc, result.files) };
    }

    case "get_pr_map": {
      const map = await prMapOf(tc);
      const names = new Map(map.nodes.map((n) => [n.id, n.name]));
      const lines = [
        `${map.source === "ai" ? "Areas named by the review" : "Areas grouped by heuristics (the review hasn't named them yet)"} — ${map.nodes.length}:`,
        ...map.nodes.map((n) => {
          const files = n.files.slice(0, 12).map((f) => `${f.path} (${f.status}, +${f.additions}/-${f.deletions})`);
          return [
            `- ${n.name} [${n.role}]${n.description ? `: ${n.description}` : ""}`,
            ...(files.length ? [`  files: ${files.join(", ")}${n.files.length > 12 ? `, … ${n.files.length - 12} more` : ""}`] : []),
            ...(n.componentIds.length ? [`  components: ${n.componentIds.map((id) => componentName(tc, id)).join(", ")}`] : []),
          ].join("\n");
        }),
        ...(map.edges.length ? ["Links:", ...map.edges.map((e) => `- ${names.get(e.source) ?? e.source} ${e.label} ${names.get(e.target) ?? e.target} (${e.weight})`)] : []),
      ];
      return {
        text: lines.join("\n"),
        summary: `read the PR map (${map.nodes.length} area${map.nodes.length === 1 ? "" : "s"})`,
        componentIds: [...new Set(map.nodes.flatMap((n) => n.componentIds))],
      };
    }

    case "get_checklist": {
      const evaluation = await evaluateChecklist(tc.repo, tc.target!);
      const lines = evaluation.items.map(
        (item) =>
          `- [${item.status}] ${item.label} (${item.kind}): ${item.detail || "—"}` +
          (item.links?.length ? `\n  ${item.links.map((l) => `${l.label}: ${l.url}`).join(" · ")}` : "")
      );
      if (evaluation.aiPending > 0) lines.push(`${evaluation.aiPending} AI check(s) not answered for this commit yet.`);
      const failing = evaluation.items.filter((i) => i.status === "fail").length;
      return {
        text: lines.join("\n") || "The checklist has no items for this repo (Settings → Checklist).",
        summary: `read the checklist (${evaluation.items.length} item${evaluation.items.length === 1 ? "" : "s"}, ${failing} failing)`,
      };
    }

    case "get_ci_status": {
      const ci = await loadCiStatus(tc.repo, ctx!.reviewed.headSha);
      if (!ci.available) return { text: ci.reason, summary: "no CI status" };
      const order = { failure: 0, pending: 1, success: 2, none: 3 } as const;
      const checks = [...ci.status.checks].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
      return {
        text: [
          `Overall: ${ci.status.state === "none" ? "no checks reported for this commit" : ci.status.state} (head ${ctx!.reviewed.headSha?.slice(0, 7) ?? "?"})`,
          ...checks.map((c) => `- [${c.state}] ${c.name}${c.url ? ` — ${c.url}` : ""}`),
        ].join("\n"),
        summary: `read CI (${ci.status.state}, ${checks.length} check${checks.length === 1 ? "" : "s"})`,
      };
    }

    case "show":
    case "highlight":
    case "filter_findings":
    case "switch_view":
    case "open_diff": {
      if (tc.actions.length >= MAX_ACTIONS_PER_ANSWER) {
        return { text: `That's ${MAX_ACTIONS_PER_ANSWER} view changes already — give your answer.`, summary: "too many view changes" };
      }
      const action =
        name === "show"
          ? await resolveShow(tc, args)
          : name === "highlight"
            ? resolveHighlight(tc, args)
            : name === "switch_view"
              ? resolveView(tc, args)
              : name === "open_diff"
                ? resolveOpenDiff(tc, args)
                : resolveFilter(tc, args);
      if (typeof action === "string") return { text: action, summary: `${name}: nothing matched` };
      tc.actions.push(action);
      const ids =
        action.kind === "highlight" ? action.componentIds : action.kind === "show" && action.target === "component" ? [action.id] : [];
      if (action.offer) {
        return {
          text: `Offered as a chip under your answer — ${action.label} starts a sandbox, so it isn't opened by itself. Say so in a few words.`,
          summary: `offered ${action.label}`,
        };
      }
      return {
        text: `Done — the reviewer's screen now ${action.kind === "filter" ? "lists" : "shows"} ${action.label}. Say so in a few words in your answer.`,
        summary: `${action.kind === "filter" ? "filtered the findings to" : action.kind === "highlight" ? "highlighted" : action.kind === "view" ? "switched to" : action.kind === "file" ? "opened" : "showed"} ${action.label}`,
        componentIds: ids,
        ...(action.kind === "file" ? { files: [action.path] } : {}),
      };
    }

    case "triage_finding": {
      const ref = arg(args, "id", "finding", "findingId", "finding_id");
      if (!ref) return missing(name);
      const finding = findFinding(tc, ref);
      if (!finding) return { text: `No finding ${ref} — get_findings lists them with their #id.`, summary: `no finding ${ref}` };
      const rawVerdict = arg(args, "verdict", "decision").toLowerCase().replace(/[\s_-]+/g, "");
      const verdict: ChatTriageRecord["verdict"] | undefined =
        rawVerdict === "holds" || rawVerdict === "correct" || rawVerdict === "right" || rawVerdict === "valid"
          ? "holds"
          : /^(wrong|doesnothold|invalid|falsepositive|incorrect)$/.test(rawVerdict)
            ? "wrong"
            : /^(rerate|reassess|upgrade|downgrade|overstated|understated)$/.test(rawVerdict)
              ? "rerate"
              : undefined;
      if (!verdict) return { text: 'verdict must be "holds", "wrong" or "rerate".', summary: "triage: no verdict" };
      const rawAssessment = arg(args, "assessment", "severity", "to").toLowerCase();
      const assessment = ASSESSMENTS.has(rawAssessment) ? (rawAssessment as ChatTriageRecord["from"]) : undefined;
      if (verdict === "rerate" && (!assessment || assessment === finding.assessment)) {
        return { text: `rerate needs a new assessment other than its current "${finding.assessment}".`, summary: "triage: no new verdict" };
      }
      if (verdict === "wrong" && (finding.assessment === "ok" || finding.resolvedAt)) {
        return { text: "That finding is already OK or resolved — nothing to resolve.", summary: `triage: ${findingRef(finding)} already settled` };
      }
      const reason = arg(args, "reason", "rationale", "why", "evidence");
      if (!reason) return { text: "Give the reason, with the evidence you checked.", summary: "triage: no reason" };
      if (tc.triage.some((t) => t.findingId === finding.id)) return { text: "You already gave a verdict on that finding in this answer.", summary: "triage: again" };
      if (tc.triage.length >= MAX_SUGGESTIONS_PER_ANSWER) {
        return { text: `That's ${MAX_SUGGESTIONS_PER_ANSWER} verdicts already — give your answer.`, summary: "too many verdicts" };
      }
      tc.triage.push({
        id: randomUUID(),
        findingId: finding.id,
        findingSummary: finding.summary,
        from: finding.assessment,
        verdict,
        ...(verdict === "rerate" ? { assessment } : {}),
        reason,
        status: "pending",
      });
      return {
        text: "Shown under your answer with Apply and Dismiss. Mention your verdict in one line; don't repeat the reasoning.",
        summary: `${verdict === "holds" ? "confirmed" : verdict === "wrong" ? "disputed" : `re-rated (${finding.assessment} → ${assessment})`} ${findingRef(finding)}: ${finding.summary}`,
        ...(finding.filePath ? { files: [finding.filePath] } : {}),
        ...(finding.componentId ? { componentIds: [finding.componentId] } : {}),
      };
    }

    default:
      return { text: `Unknown tool "${name}".`, summary: `unknown tool ${name}` };
  }
}

const SHOW_KINDS = new Set<ChatShowKind>(["component", "file", "endpoint", "table", "env", "infra", "area", "function", "finding"]);

/** Exact (case-insensitive) first, then the first that contains the query. */
function bestMatch<T>(items: readonly T[], query: string, keys: (item: T) => string[]): T | undefined {
  const q = query.trim().toLowerCase();
  return (
    items.find((item) => keys(item).some((k) => k.toLowerCase() === q)) ??
    items.find((item) => keys(item).some((k) => k.toLowerCase().includes(q)))
  );
}

/** `show`'s target, resolved to the id the UI opens; a string says why nothing matched. */
async function resolveShow(tc: ToolContext, args: Record<string, unknown>): Promise<ChatActionRecord | string> {
  const rawKind = arg(args, "kind", "type").toLowerCase().replace(/s$/, "");
  const kind = (
    rawKind === "module" ? "component" : rawKind === "resource" ? "infra" : /^(env[ _-]?var|variable|environment)$/.test(rawKind) ? "env" : rawKind === "model" ? "table" : rawKind
  ) as ChatShowKind;
  const query = arg(args, "name", "id", "target", ...PATH_KEYS, "query");
  if (!SHOW_KINDS.has(kind) || !query) return `show needs a kind (${[...SHOW_KINDS].join(", ")}) and a name, e.g. {"kind":"file","name":"app/page.tsx","line":12}.`;
  const line = num(args.line) ?? num(args.start);
  switch (kind) {
    case "finding": {
      if (!tc.ctx) return "Findings belong to a change — none is selected.";
      const f = findFinding(tc, query);
      return f ? { kind: "show", target: "finding", id: f.id, label: `finding: ${clip(f.summary, 60)}` } : `No finding ${query} — get_findings lists them with their #id.`;
    }
    case "component": {
      const c = findComponent(tc, query);
      return c ? { kind: "show", target: "component", id: c.id, label: c.name } : `No component matches "${query}" — list_components or get_component first.`;
    }
    case "file": {
      const path = query.replace(/^\/+/, "").replace(/:(\d+)(-\d+)?$/, "");
      const lineInPath = num(/:(\d+)(-\d+)?$/.exec(query)?.[1]);
      const known = tc.ownerByFile.has(path) || tc.ctx?.files.some((f) => f.path === path);
      if (!known) return `"${path}" isn't a file the graph or the diff knows — check the path with search_code.`;
      const at = line ?? lineInPath;
      return { kind: "show", target: "file", id: path, label: at ? `${path}:${at}` : path, ...(at ? { line: at } : {}) };
    }
    case "endpoint": {
      const served = readServedApiCatalog(tc.repo.id);
      const e = served && bestMatch(served.catalog.endpoints, query, (x) => [endpointLabel(x), x.path, x.id, x.handler?.name ?? ""]);
      return e ? { kind: "show", target: "endpoint", id: e.id, label: endpointLabel(e) } : `No endpoint matches "${query}" — list_endpoints first.`;
    }
    case "table": {
      const stored = readDbSchema(tc.repo.id);
      const hit = stored && bestMatch(filterTables(stored.schema), query, ({ table }) => [table.name, table.id, `${table.schema ?? ""}.${table.name}`]);
      return hit ? { kind: "show", target: "table", id: hit.table.id, label: `table ${hit.table.name}` } : `No table matches "${query}" — list_tables first.`;
    }
    case "env": {
      const stored = readEnvCatalog(tc.repo.id);
      const v = stored && bestMatch(stored.catalog.vars, query.replace(/^\$\{?|\}$/g, ""), (x) => [x.name]);
      return v ? { kind: "show", target: "env", id: v.name, label: `env var ${v.name}` } : `No env var matches "${query}" — list_env first.`;
    }
    case "infra": {
      const stored = readInfraCatalog(tc.repo.id);
      const r = stored && bestMatch(stored.catalog.resources, query, (x) => [x.address, x.id, x.name]);
      return r ? { kind: "show", target: "infra", id: r.id, label: r.address } : `No infrastructure resource matches "${query}" — list_infra first.`;
    }
    case "area": {
      if (!tc.ctx) return "Areas belong to a change — none is selected.";
      const map = await prMapOf(tc);
      const node = bestMatch(map.nodes, query, (n) => [n.name, n.id]);
      return node ? { kind: "show", target: "area", id: node.id, label: `the ${node.name} area` } : `No area matches "${query}" — get_pr_map first.`;
    }
    case "function": {
      if (!tc.ctx) return "Functions are shown for a change — use kind \"file\" with a line instead.";
      const q = query.replace(/\(\)$/, "");
      const fn = tc.callGraph && bestMatch(tc.callGraph.functions.filter((f) => f.status !== "removed"), q, (f) => [f.qualified, f.id, f.name]);
      if (fn) return { kind: "show", target: "function", id: fn.id, label: `${fn.qualified}()` };
      // Not one the change touches: open its file at the declaration instead.
      const decl = findDeclarations(await analysisOf(tc), q)[0];
      return decl
        ? { kind: "show", target: "file", id: decl.file, line: decl.startLine, label: `${decl.qualified} in ${decl.file}:${decl.startLine}` }
        : `No function matches "${query}".`;
    }
  }
}

function resolveHighlight(tc: ToolContext, args: Record<string, unknown>): ChatActionRecord | string {
  const raw = args.components ?? args.names ?? args.path ?? args.name;
  const names = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\s*(?:,|→|->)\s*/) : []).map(str).filter(Boolean);
  if (names.length === 0) return 'highlight needs component names: {"components":["api","jobs"]}.';
  const found = names.map((n) => findComponent(tc, n));
  const components = [...new Map(found.filter((c): c is ComponentRecord => Boolean(c)).map((c) => [c.id, c])).values()];
  if (components.length === 0) return `None of ${names.join(", ")} is a component — list_components first.`;
  const unknown = names.filter((_, i) => !found[i]);
  return {
    kind: "highlight",
    componentIds: components.map((c) => c.id),
    label: components.map((c) => c.name).join(" → ") + (unknown.length ? ` (not found: ${unknown.join(", ")})` : ""),
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const VIEW_LABELS: Record<ChatViewName, string> = {
  pr: "the PR map",
  app: "the App map",
  api: "the API view",
  infra: "the Infra view",
  data: "the Data view",
  env: "the Env view",
  files: "the Files view",
};
const VIEW_ALIASES: Record<string, ChatViewName> = {
  map: "app",
  "app map": "app",
  "pr map": "pr",
  change: "pr",
  endpoints: "api",
  infrastructure: "infra",
  schema: "data",
  database: "data",
  db: "data",
  tables: "data",
  "env vars": "env",
  environment: "env",
  file: "files",
};
const VIEW_MODES: Partial<Record<ChatViewName, string[]>> = {
  pr: ["files", "functions"],
  infra: ["diagram", "files", "requests", "list"],
  data: ["canvas", "list"],
};
const APP_LEVELS = ["architecture", "features", "modules"] as const;

/** `switch_view`'s view, level, mode and toggle, checked against what each view has. */
function resolveView(tc: ToolContext, args: Record<string, unknown>): ChatActionRecord | string {
  const raw = arg(args, "view", "name", "tab").toLowerCase();
  const view = (raw in VIEW_LABELS ? raw : VIEW_ALIASES[raw]) as ChatViewName | undefined;
  if (!view) return `view must be one of ${Object.keys(VIEW_LABELS).join(", ")}.`;
  if (view === "pr" && !tc.ctx) return "The PR map needs a change — none is selected.";
  const rawLevel = arg(args, "level").toLowerCase().replace(/^(module|feature)$/, "$1s");
  const level = APP_LEVELS.find((l) => l === rawLevel || l === `${rawLevel}s`);
  if (rawLevel && (view !== "app" || !level)) return `level is only for the App map: ${APP_LEVELS.join(", ")}.`;
  const rawMode = arg(args, "mode", "sub", "subview").toLowerCase();
  const modes = VIEW_MODES[view] ?? [];
  const mode = modes.find((m) => m === rawMode || m === `${rawMode}s`);
  if (rawMode && !mode) return modes.length ? `mode for ${view} is one of ${modes.join(", ")}.` : `${VIEW_LABELS[view]} has no modes.`;
  const changed = args.changed_only ?? args.changedOnly;
  const changedOnly = typeof changed === "boolean" && ["api", "infra", "data", "env"].includes(view) && tc.ctx ? changed : undefined;
  const label = [VIEW_LABELS[view], level ? `by ${level}` : "", mode ? `(${mode})` : "", changedOnly ? "changes only" : ""].filter(Boolean).join(" ");
  return {
    kind: "view",
    view,
    ...(level ? { level } : {}),
    ...(mode ? { mode } : {}),
    ...(changedOnly !== undefined ? { changedOnly } : {}),
    label,
  };
}

const FILE_TABS = new Set<ChatFileTab>(["diff", "file", "base", "preview"]);

/** `open_diff`'s changed file, tab and lines; the Before / after preview is only offered. */
function resolveOpenDiff(tc: ToolContext, args: Record<string, unknown>): ChatActionRecord | string {
  const query = arg(args, ...PATH_KEYS, "name");
  if (!query) return 'open_diff needs a changed file: {"path":"app/page.tsx","tab":"diff","line":12}.';
  const path = query.replace(/^\/+/, "").replace(/:(\d+)(-\d+)?$/, "");
  const file = tc.ctx!.files.find((f) => f.path === path) ?? tc.ctx!.files.find((f) => f.path.endsWith(`/${path}`));
  if (!file) return `"${path}" isn't one of the changed files — use show {"kind":"file"} for any other file.`;
  const rawTab = arg(args, "tab", "view", "side").toLowerCase();
  const tab = (rawTab === "before" || rawTab === "old" ? "base" : rawTab === "after" || rawTab === "new" || rawTab === "head" ? "file" : rawTab || "diff") as ChatFileTab;
  if (!FILE_TABS.has(tab)) return "tab must be diff, file, base or preview.";
  if (tab === "base" && file.status !== "modified" && file.status !== "changed") {
    return `${file.path} is ${file.status} in this change — the viewer has no "before" of it at this path; use the diff.`;
  }
  if (tab === "file" && file.status === "removed") return `${file.path} is deleted by this change — open its "base" instead.`;
  const suffix = /:(\d+)(?:-(\d+))?$/.exec(query);
  const start = num(args.line) ?? num(args.start) ?? num(suffix?.[1]);
  const end = num(args.end) ?? num(suffix?.[2]);
  const lines = start ? (end && end > start ? `${start}-${end}` : String(start)) : undefined;
  const symbol = arg(args, "symbol", "component", "function") || undefined;
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  const at = lines ? `:${lines}` : "";
  const label =
    tab === "diff"
      ? `the diff of ${name}${at}`
      : tab === "file"
        ? `${name}${at} after the change`
        : tab === "base"
          ? `${name}${at} before the change`
          : `Before / after of ${symbol ?? name}`;
  return {
    kind: "file",
    path: file.path,
    tab,
    ...(lines && tab !== "preview" ? { lines } : {}),
    ...(symbol && tab === "preview" ? { symbol } : {}),
    label,
    // The preview starts a sandbox: only the reviewer's click runs it.
    ...(tab === "preview" ? { offer: true } : {}),
  };
}

/**
 * The answer's `point_to` and `next`, resolved like `show` into actions that
 * are only offered (chips). A stop that matches nothing, repeats one, or is
 * already what a view change put on screen is dropped.
 */
async function resolveStops(
  tc: ToolContext,
  stops: Record<string, unknown>[],
  next: Record<string, unknown> | undefined
): Promise<ChatActionRecord[]> {
  const key = (a: ChatActionRecord) => (a.kind === "show" ? `${a.target}:${a.id}:${a.line ?? ""}` : a.kind === "file" ? `file:${a.path}:${a.lines ?? ""}` : "");
  const seen = new Set(tc.actions.map(key).filter(Boolean));
  const out: ChatActionRecord[] = [];
  const add = async (stop: Record<string, unknown>, why?: string) => {
    const action = await resolveShow(tc, stop).catch(() => "failed");
    if (typeof action === "string" || seen.has(key(action))) return;
    seen.add(key(action));
    out.push({ ...action, offer: true, ...(why !== undefined ? { next: why } : {}) });
  };
  for (const stop of stops.slice(0, MAX_OFFERS_PER_ANSWER + 2)) {
    if (out.length >= MAX_OFFERS_PER_ANSWER) break;
    await add(stop);
  }
  if (next) await add(next, clip(arg(next, "why", "reason", "because"), 100));
  return out;
}

/**
 * The reviewer's Apply on a triage verdict: `holds` adds a confirming reply,
 * `wrong` answers and resolves the finding, `rerate` changes its verdict —
 * each reply authored "chat". Marks the verdict applied; a finding a
 * re-review replaced since is gone (undefined).
 */
export async function applyChatTriage(
  message: ChatMessageRecord,
  triageId: string
): Promise<ChatMessageRecord | undefined> {
  const triage = message.triage?.find((t) => t.id === triageId);
  if (!triage) return undefined;
  if (triage.status === "applied") return message;
  const author = "chat";
  const finding =
    triage.verdict === "rerate" && triage.assessment
      ? await rateFinding(message.repoId, triage.findingId, triage.assessment, { author, body: `Re-rated ${triage.from} → ${triage.assessment}: ${triage.reason}` })
      : await addFindingResponse(message.repoId, triage.findingId, {
          kind: triage.verdict === "wrong" ? "answered" : "comment",
          author,
          body: triage.verdict === "wrong" ? `Doesn't hold: ${triage.reason}` : `Checked, holds: ${triage.reason}`,
        });
  if (!finding) return undefined;
  emitFindingsChanged(message.repoId, message.targetKey, finding.id);
  return updateChatTriage(message.repoId, message.id, triageId, "applied");
}

const BUCKETS = ["defect", "concern", "unknown", "fine"] as const;
const STATIC_CATEGORIES = new Set(["structure", "infra", "schema", "env"]);

function resolveFilter(tc: ToolContext, args: Record<string, unknown>): ChatActionRecord | string {
  const raw = args.assessment ?? args.assessments ?? args.verdict ?? args.severity;
  const words = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,|]+/) : []).map((w) => str(w).toLowerCase()).filter(Boolean);
  const buckets = words.includes("all")
    ? [...BUCKETS]
    : [...new Set(words.map((w) => (w === "ok" || w === "resolved" ? "fine" : w)).filter((w): w is (typeof BUCKETS)[number] => (BUCKETS as readonly string[]).includes(w)))];
  const category = arg(args, "category").toLowerCase();
  if (category && !STATIC_CATEGORIES.has(category)) return `category must be one of ${[...STATIC_CATEGORIES].join(", ")} (or left out).`;
  const componentQuery = arg(args, "component", "module");
  const component = componentQuery ? findComponent(tc, componentQuery) : undefined;
  if (componentQuery && !component) return `No component matches "${componentQuery}".`;
  if (buckets.length === 0 && !category && !component) return 'filter_findings needs an assessment, a category or a component, e.g. {"assessment":["defect"]}.';
  const label = [
    buckets.length ? buckets.join(" + ") : "",
    category ? `${category} findings` : "findings",
    component ? `in ${component.name}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    kind: "filter",
    ...(buckets.length ? { buckets } : {}),
    ...(category ? { category } : {}),
    ...(component ? { componentId: component.id } : {}),
    label: label || "findings",
  };
}

/** The system-message summary of the repo, for the repo-wide chat: what it is and its modules. */
function renderRepoContext(tc: ToolContext): string {
  const { repo } = tc;
  const counts = fileCounts(tc);
  const modules = tc.components
    .filter((c) => c.tier === "module")
    .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
  const domains = tc.components.filter((c) => c.tier === "domain");
  const lines = [
    `Repository: ${repo.name}${repo.defaultBranch ? ` (default branch ${repo.defaultBranch})` : ""}`,
    repo.lastAnalyzedSha ? `Analyzed at commit ${repo.lastAnalyzedSha.slice(0, 7)}; ${tc.ownerByFile.size} files.` : "Not analyzed yet.",
  ];
  if (domains.length > 0) lines.push(`Areas: ${domains.map((d) => d.name).join(", ")}`);
  lines.push("", `Modules, largest first (${modules.length}):`);
  for (const c of modules.slice(0, CONTEXT_MAX_FILES)) {
    lines.push(`- ${c.name} (${counts.get(c.id) ?? 0} files)${c.description ? `: ${c.description}` : ""}`);
  }
  if (modules.length > CONTEXT_MAX_FILES) lines.push(`- … ${modules.length - CONTEXT_MAX_FILES} more (use list_components)`);
  const served = readServedApiCatalog(repo.id);
  if (served && served.catalog.endpoints.length > 0) {
    lines.push("", `API: ${served.catalog.endpoints.length} endpoint(s) (${served.catalog.frameworks.join(", ")}) — use list_endpoints.`);
  }
  const infra = readInfraCatalog(repo.id);
  if (infra && infra.catalog.resources.length > 0) {
    lines.push(`Infrastructure: ${infra.catalog.resources.length} resource(s) in ${infra.catalog.stacks.length} stack(s) (${infra.catalog.tools.join(", ")}) — use list_infra.`);
  }
  const envCatalog = readEnvCatalog(repo.id);
  if (envCatalog && envCatalog.catalog.vars.length > 0) {
    lines.push(`Env vars: ${envCatalog.catalog.vars.length} name(s) across ${envCatalog.catalog.targets.length} environment(s)/target(s) — use list_env.`);
  }
  const db = readDbSchema(repo.id);
  const tableCount = db?.schema.databases.reduce((n, d) => n + d.tables.length, 0) ?? 0;
  if (db && tableCount > 0) {
    lines.push(`Database: ${tableCount} table(s) in ${db.schema.databases.length} database(s) (${[...new Set(db.schema.databases.flatMap((d) => d.tools))].join(", ")}) — use list_tables.`);
  }
  return lines.join("\n");
}

/** The system-message summary of the change: intent, files, the review's verdicts. */
function renderContext(tc: ToolContext): string {
  if (!tc.ctx) return renderRepoContext(tc);
  const { intent, files } = tc.ctx;
  const lines: string[] = [];
  if (intent.source === "pull_request") {
    lines.push(`Title: ${intent.title ?? "(none)"}`);
    const body = intent.body?.trim().slice(0, CONTEXT_MAX_BODY_CHARS);
    lines.push(body ? `Description:\n${body.split(/\r?\n/).map((l) => `> ${l}`).join("\n")}` : "Description: (none)");
    for (const issue of intent.linkedIssues ?? []) lines.push(`Linked issue #${issue.number}: ${issue.title}`);
  } else {
    lines.push("A comparison of two git refs — no PR title or description.");
  }
  lines.push("", `Changed files (${files.length}):`);
  for (const f of files.slice(0, CONTEXT_MAX_FILES)) {
    lines.push(`- ${f.path} (+${f.additions}/-${f.deletions}) [${componentName(tc, tc.ownerByFile.get(f.path))}]`);
  }
  if (files.length > CONTEXT_MAX_FILES) lines.push(`- … ${files.length - CONTEXT_MAX_FILES} more (use list_changed_files)`);

  if (tc.findings.length > 0) {
    const counts = new Map<string, number>();
    for (const f of tc.findings) counts.set(f.assessment, (counts.get(f.assessment) ?? 0) + 1);
    lines.push("", `AI review: ${tc.findings.length} finding(s) — ${[...counts].map(([k, v]) => `${v} ${k}`).join(", ")}.`);
    for (const f of tc.findings.filter((f) => f.assessment === "defect" || f.assessment === "concern").slice(0, 12)) {
      lines.push(`- ${findingRef(f)} [${findingLabels(f)}] ${f.componentName || "whole PR"}${f.filePath ? ` ${f.filePath}` : ""}: ${f.summary}`);
    }
  } else {
    lines.push("", "AI review: no findings yet.");
  }
  if (tc.api) {
    lines.push("", "What the change does to the API (static analysis of base and head; list_endpoints for the whole API):");
    for (const line of describeApiChange(tc.api, 15)) lines.push(`- ${line}`);
  }
  if (tc.infra && (tc.infra.changes.length > 0 || tc.infra.links.length > 0)) {
    lines.push("", "What the change does to the infrastructure (static analysis, plan-style; get_infra_changes for all of it, list_infra for the whole inventory):");
    for (const line of describeInfraChange(tc.infra, 15)) lines.push(`- ${line}`);
  }
  if (tc.env && tc.env.changes.length > 0) {
    lines.push("", "What the change does to the env vars (static analysis, secret values masked; get_env_changes for all of it, list_env for every name):");
    for (const line of describeEnvChange(tc.env, 15)) lines.push(`- ${line}`);
  }
  if (tc.db && (tc.db.tables.length > 0 || tc.db.migrations.length > 0 || tc.db.enums.length > 0)) {
    lines.push("", "What the change does to the database schema (static analysis; get_schema_changes for all of it, list_tables for the whole schema):");
    for (const line of describeSchemaChange(tc.db, 15)) lines.push(`- ${line}`);
  }
  return lines.join("\n");
}

export type ChatEvent =
  | { type: "user"; message: ChatMessageRecord }
  | { type: "step"; step: PrChatStep }
  | { type: "answer"; message: ChatMessageRecord };

/**
 * One turn: store the question, run the agent loop (reporting each lookup
 * through `onEvent` as it happens), store and return the answer. A failed
 * turn is stored as an error message, so the thread shows what happened.
 */
export async function runChatTurn(args: {
  repo: RepoRecord;
  /** `null` for the repo-wide chat. */
  target: ReviewTarget | null;
  question: string;
  focusComponentId?: string;
  /** The finding the question is about (a finding's Ask chat). */
  findingId?: string;
  /** What is on the reviewer's screen, as the UI describes it. */
  screen?: string;
  onEvent: (event: ChatEvent) => void | Promise<void>;
  signal?: AbortSignal;
  log?: JobLogger;
}): Promise<ChatMessageRecord> {
  const { repo, target, question, focusComponentId, onEvent } = args;
  const screen = args.screen?.trim().slice(0, SCREEN_MAX_CHARS) || undefined;
  const targetKey = target ? reviewTargetKey(target) : REPO_CHAT_THREAD_KEY;
  const config = await loadAiConfigOrNull();
  if (!config) throw new Error("No AI provider is configured — set one in Settings.");

  const [ctx, components, ownerByFile, findings, previous] = await Promise.all([
    target ? loadPrContext(repo, target, args.log) : Promise.resolve(null),
    listComponentsByRepoId(repo.id),
    getFileOwnerMap(repo.id),
    target ? listFindingsByTargetKey(repo.id, targetKey) : Promise.resolve([]),
    listChatMessages(repo.id, targetKey),
  ]);
  const headSha = ctx ? ctx.reviewed.headSha : repo.lastAnalyzedSha;
  const tc: ToolContext = {
    repo,
    ctx,
    components,
    ownerByFile,
    findings,
    targetKey,
    ...(target?.kind === "pr" ? { prId: `${repo.id}:pr:${target.prNumber}` } : {}),
    model: config.model,
    ...(target ? (() => {
      const stored = readTargetGraph<TargetGraphData>(repo.id, targetKey)?.data;
      return { api: stored?.api, infra: stored?.infra, db: stored?.db, env: stored?.env, callGraph: stored?.callGraph };
    })() : {}),
    suggestions: [],
    actions: [],
    triage: [],
    target,
  };
  const finding = args.findingId ? tc.findings.find((f) => f.id === args.findingId) : undefined;

  const userMessage = await addChatMessage({
    repoId: repo.id,
    targetKey,
    role: "user",
    content: question,
    focusComponentId,
    ...(finding ? { findingId: finding.id } : {}),
    ...(screen ? { screen } : {}),
    headSha,
  });
  await onEvent({ type: "user", message: userMessage });

  const history = previous
    .filter((m) => !m.error)
    .slice(-HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));

  try {
    const result = await runPrChat(
      config,
      {
        context: renderContext(tc),
        history,
        question,
        focus: focusComponentId ? componentName(tc, focusComponentId) : undefined,
        screen,
        finding: finding ? describeFinding(finding) : undefined,
        tools: ctx ? PR_CHAT_TOOLS : REPO_CHAT_TOOLS,
        scope: ctx ? "change" : "repo",
      },
      (name, toolArgs) => runTool(tc, name, toolArgs),
      { signal: args.signal, onStep: (step) => onEvent({ type: "step", step }) }
    );
    args.log?.(
      `chat: ${result.steps.length} lookup(s), ${result.calls} call(s), ` +
        `${result.usage.promptTokens}+${result.usage.completionTokens} token(s)`
    );
    const offers = await resolveStops(tc, result.stops, result.next);
    const answer = await addChatMessage({
      repoId: repo.id,
      targetKey,
      role: "assistant",
      content: result.answer || "(the model gave an empty answer)",
      steps: result.steps,
      componentIds: result.componentIds,
      files: result.files,
      headSha,
      model: config.model,
      suggestions: tc.suggestions,
      actions: [...tc.actions, ...offers],
      triage: tc.triage,
    });
    await onEvent({ type: "answer", message: answer });
    return answer;
  } catch (error) {
    const failed = await addChatMessage({
      repoId: repo.id,
      targetKey,
      role: "assistant",
      content: `The AI call failed: ${(error as Error).message}`,
      headSha,
      model: config.model,
      error: true,
    });
    await onEvent({ type: "answer", message: failed });
    return failed;
  }
}
