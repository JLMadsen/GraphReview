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
//   get_findings         the review's findings, optionally for one component
//
//   add_finding          records a finding in the change's review — only when
//                        the reviewer asks for it ("add this to the findings")
//   suggest_finding      offers a finding the model noticed on its own; it is
//                        stored on the answer, and only the reviewer's Add
//                        (addSuggestedFinding) puts it in the review
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
import { runPrChat, type PrChatStep, type PrChatTool, type PrChatToolOutput } from "@/lib/ai";
import { emitFindingsChanged } from "@/lib/mcp/events";
import {
  addChatMessage,
  getFileOwnerMap,
  listChatMessages,
  listComponentsByRepoId,
  listFindingsByTargetKey,
  getComponentOverview,
  readTargetGraph,
  updateChatSuggestion,
  upsertFinding,
} from "@/lib/db";
import type { ApiChange } from "@/lib/analysis/api/types";
import { describeApiChange, endpointLabel } from "@/lib/analysis/api/describe";
import { readServedApiCatalog } from "./api-catalog";
import type { TargetGraphData } from "./target-graph-queue";
import type { ChatMessageRecord, ChatSuggestionRecord, ComponentRecord, FindingRecord, FindingWithComponent, RepoRecord } from "@/lib/db";
import type { JobLogger } from "./analyze";
import { loadAiConfigOrNull } from "./merge-naming";
import { loadPrContext, readFileAtCommit, searchCode } from "./pr-context";
import type { ResolvedTarget } from "./review";
import { reviewTargetKey, type ReviewTarget } from "./review-queue";

/** The thread key of the repo-wide chat — review target keys are `pr:…` / `refs:…`, so it can't collide. */
export const REPO_CHAT_THREAD_KEY = "repo";

/** How many earlier messages go back to the model as history. */
const HISTORY_MESSAGES = 12;
const READ_FILE_MAX_LINES = 250;
const CONTEXT_MAX_FILES = 80;
const CONTEXT_MAX_BODY_CHARS = 1500;

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
    name: "list_endpoints",
    args: '{"query":"<optional text in the path, handler or framework>"}',
    description: "the app's API: endpoints (HTTP routes, server actions, tRPC, GraphQL) with handler, middleware/auth and request/response shapes",
  },
  {
    name: "get_findings",
    args: '{"component":"<optional component name>"}',
    description: "the AI review's findings for this change, optionally for one component",
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
];

/** Most suggestions one answer may carry — beyond that they stop being worth reading. */
export const MAX_SUGGESTIONS_PER_ANSWER = 3;

const REPO_TOOL_NAMES = new Set(["read_file", "search_code", "get_component", "list_endpoints"]);

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
      : t
  ),
];

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
  /** suggest_finding's offers in this turn, stored on the answer. */
  suggestions: ChatSuggestionRecord[];
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
const CHANGE_TOOL_NAMES = new Set(["list_changed_files", "get_diff", "get_findings", "add_finding", "suggest_finding"]);

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
      const text = findings
        .map(
          (f) =>
            `[${findingLabels(f)}${f.resolvedAt ? ", resolved" : ""}] ${f.componentName || "whole PR"}` +
            `${f.filePath ? ` ${f.filePath}${f.lineRange ? `:${f.lineRange}` : ""}` : ""}: ${f.summary}\n  why: ${f.rationale}`
        )
        .join("\n");
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

    default:
      return { text: `Unknown tool "${name}".`, summary: `unknown tool ${name}` };
  }
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
      lines.push(`- [${findingLabels(f)}] ${f.componentName || "whole PR"}${f.filePath ? ` ${f.filePath}` : ""}: ${f.summary}`);
    }
  } else {
    lines.push("", "AI review: no findings yet.");
  }
  if (tc.api) {
    lines.push("", "What the change does to the API (static analysis of base and head; list_endpoints for the whole API):");
    for (const line of describeApiChange(tc.api, 15)) lines.push(`- ${line}`);
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
  onEvent: (event: ChatEvent) => void | Promise<void>;
  signal?: AbortSignal;
  log?: JobLogger;
}): Promise<ChatMessageRecord> {
  const { repo, target, question, focusComponentId, onEvent } = args;
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
    ...(target ? { api: readTargetGraph<TargetGraphData>(repo.id, targetKey)?.data.api } : {}),
    suggestions: [],
  };

  const userMessage = await addChatMessage({
    repoId: repo.id,
    targetKey,
    role: "user",
    content: question,
    focusComponentId,
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
