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
// Nothing here writes to the repo, runs code, or reaches outside the repo's
// own host (GitHub/GitLab/local checkout).
//
// Kept out of lib/jobs' barrel: it pulls in lib/ai.

import { runPrChat, type PrChatStep, type PrChatTool, type PrChatToolOutput } from "@/lib/ai";
import {
  addChatMessage,
  getFileOwnerMap,
  listChatMessages,
  listComponentsByRepoId,
  listFindingsByTargetKey,
  runRead,
} from "@/lib/neo4j";
import type { ChatMessageRecord, ComponentRecord, FindingWithComponent, RepoRecord } from "@/lib/neo4j";
import type { JobLogger } from "./analyze";
import { loadAiConfigOrNull } from "./merge-naming";
import { loadPrContext, readFileAtCommit, searchCode } from "./pr-context";
import type { ResolvedTarget } from "./review";
import { reviewTargetKey, type ReviewTarget } from "./review-queue";

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
    name: "get_findings",
    args: '{"component":"<optional component name>"}',
    description: "the AI review's findings for this change, optionally for one component",
  },
];

interface ToolContext {
  repo: RepoRecord;
  ctx: ResolvedTarget;
  components: ComponentRecord[];
  ownerByFile: Map<string, string>;
  findings: FindingWithComponent[];
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

async function runTool(tc: ToolContext, name: string, args: Record<string, unknown>): Promise<PrChatToolOutput> {
  switch (name) {
    case "list_changed_files": {
      const lines = tc.ctx.files.map((f) => {
        const owner = tc.ownerByFile.get(f.path);
        return `${f.path} (${f.status}, +${f.additions}/-${f.deletions}) — ${owner ? componentName(tc, owner) : "new/unanalyzed"}`;
      });
      return {
        text: lines.join("\n") || "(no changed files)",
        summary: `listed ${tc.ctx.files.length} changed file(s)`,
        componentIds: [...new Set(tc.ctx.files.map((f) => tc.ownerByFile.get(f.path)).filter((id): id is string => !!id))],
      };
    }

    case "get_diff": {
      const path = arg(args, ...PATH_KEYS).replace(/^\/+/, "");
      if (!path) return missing(name);
      const file = tc.ctx.files.find((f) => f.path === path) ?? tc.ctx.files.find((f) => f.path.endsWith(`/${path}`));
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
      const ref = str(args.ref) === "base" ? "base" : "head";
      const sha = ref === "base" ? tc.ctx.reviewed.baseSha : tc.ctx.reviewed.headSha;
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
        found.source === "default-branch" ? " (from the default branch — the PR head could not be read)" : "";
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
      const { hits, source } = await searchCode(tc.repo, tc.ctx.reviewed.headSha, query);
      const ids = new Set<string>();
      const lines = hits.map((h) => {
        const owner = tc.ownerByFile.get(h.path);
        if (owner) ids.add(owner);
        return `${h.path}:${h.line} [${componentName(tc, owner)}] ${h.text}`;
      });
      const where = source === "commit" ? "at the PR's head" : "in the default branch (the PR's own changes are in the diffs)";
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
      const result = await runRead(
        `
        MATCH (c:Component {id: $id})
        OPTIONAL MATCH (f:File)-[:BELONGS_TO]->(c)
        OPTIONAL MATCH (c)-[:DEPENDS_ON]->(dep:Component)
        OPTIONAL MATCH (user:Component)-[:DEPENDS_ON]->(c)
        RETURN collect(DISTINCT f.path) AS files, collect(DISTINCT dep.name) AS deps, collect(DISTINCT user.name) AS users
        `,
        { id: component.id }
      );
      const row = result.records[0];
      const files = ((row?.get("files") as string[]) ?? []).sort();
      const deps = (row?.get("deps") as string[]) ?? [];
      const users = (row?.get("users") as string[]) ?? [];
      const changed = files.filter((f) => tc.ctx.files.some((c) => c.path === f));
      return {
        text: [
          `Component: ${component.name}${component.origin === "merge" ? " (merged feature)" : ""}`,
          `Description: ${component.description ?? "(none)"}`,
          `Files (${files.length}): ${files.slice(0, 40).join(", ")}${files.length > 40 ? ", …" : ""}`,
          `Changed in this PR: ${changed.join(", ") || "(none)"}`,
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
            `[${f.intentMatch}${f.resolvedAt ? ", resolved" : ""}] ${f.componentName}` +
            `${f.filePath ? ` ${f.filePath}${f.lineRange ? `:${f.lineRange}` : ""}` : ""}: ${f.summary}\n  why: ${f.rationale}`
        )
        .join("\n");
      return {
        text: text || (tc.findings.length ? "No findings for that component." : "The review has no findings (it may not have run)."),
        summary: `read ${findings.length} finding(s)${component ? ` for ${component.name}` : ""}`,
        componentIds: [...new Set(findings.map((f) => f.componentId))],
      };
    }

    default:
      return { text: `Unknown tool "${name}".`, summary: `unknown tool ${name}` };
  }
}

/** The system-message summary of the change: intent, files, the review's verdicts. */
function renderContext(tc: ToolContext): string {
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
    for (const f of tc.findings) counts.set(f.intentMatch, (counts.get(f.intentMatch) ?? 0) + 1);
    lines.push("", `AI review: ${tc.findings.length} finding(s) — ${[...counts].map(([k, v]) => `${v} ${k}`).join(", ")}.`);
    for (const f of tc.findings.filter((f) => f.intentMatch === "mismatch" || f.intentMatch === "partial").slice(0, 12)) {
      lines.push(`- [${f.intentMatch}] ${f.componentName}${f.filePath ? ` ${f.filePath}` : ""}: ${f.summary}`);
    }
  } else {
    lines.push("", "AI review: no findings yet.");
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
  target: ReviewTarget;
  question: string;
  focusComponentId?: string;
  onEvent: (event: ChatEvent) => void | Promise<void>;
  signal?: AbortSignal;
  log?: JobLogger;
}): Promise<ChatMessageRecord> {
  const { repo, target, question, focusComponentId, onEvent } = args;
  const targetKey = reviewTargetKey(target);
  const config = await loadAiConfigOrNull();
  if (!config) throw new Error("No AI provider is configured — set one in Settings.");

  const [ctx, components, ownerByFile, findings, previous] = await Promise.all([
    loadPrContext(repo, target, args.log),
    listComponentsByRepoId(repo.id),
    getFileOwnerMap(repo.id),
    listFindingsByTargetKey(repo.id, targetKey),
    listChatMessages(repo.id, targetKey),
  ]);
  const headSha = ctx.reviewed.headSha;
  const tc: ToolContext = { repo, ctx, components, ownerByFile, findings };

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
        tools: PR_CHAT_TOOLS,
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
