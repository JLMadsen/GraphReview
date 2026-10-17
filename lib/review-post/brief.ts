// The change brief / release notes (DESIGN.md §6.23 §3).
//
// `briefFacts` builds the four lists from stored data with no model — the
// brief when no provider is configured, and the facts the one AI call
// (lib/ai/change-brief.ts) may reword. A generated brief is cached in `kv`
// per target and head, so reopening the dialog doesn't spend a call.

import { readKv, writeKv, type RepoRecord } from "@/lib/db";
import { describeEndpointChange, endpointLabel } from "@/lib/analysis/api/describe";
import { describeInfraChangeEntry } from "@/lib/analysis/infra/describe";
import { describeSchemaChange } from "@/lib/analysis/db/describe";
import { describeEnvChangeEntry } from "@/lib/analysis/env/describe";
import { writeChangeBrief, type ChangeBriefInput } from "@/lib/ai/change-brief";
import type { chatCompletion } from "@/lib/ai/client";
import { loadAiConfigOrNull } from "@/lib/jobs/ai-config";
import { loadPrContext } from "@/lib/jobs/pr-context";
import type { ResolvedTarget } from "@/lib/jobs/review-target";
import { impactChange, impactSymbol, isImpactFinding, isIntentFinding, mdInline } from "@/components/graph/review-visuals";
import { exportFilename, loadReportContext, type ReportContext } from "./report";
import type { ChangeBrief, ChangeBriefResponse } from "./types";

const MAX_PER_LIST = 12;

function cap(items: string[]): string[] {
  return items.length <= MAX_PER_LIST ? items : [...items.slice(0, MAX_PER_LIST - 1), `… and ${items.length - MAX_PER_LIST + 1} more`];
}

function where(f: { filePath?: string; lineRange?: string }): string {
  return f.filePath ? ` (\`${f.filePath}${f.lineRange ? `:${f.lineRange}` : ""}\`)` : "";
}

/** The brief from what the review already knows — no model call. */
export function briefFacts(ctx: ReportContext, resolved: Pick<ResolvedTarget, "intent" | "files"> | null): ChangeBrief {
  const open = ctx.dtos.filter((f) => !f.resolvedAt && !f.callFailed);
  const intent = ctx.dtos.find(isIntentFinding);
  const data = ctx.graph?.data;
  const title = resolved?.intent.title ?? ctx.pr?.title;
  const files = resolved?.files ?? [];

  const userVisible: string[] = [];
  for (const f of open) {
    if (isIntentFinding(f) || isImpactFinding(f) || f.category !== "change") continue;
    if (f.scope !== "unmentioned" && (f.kind === "feature" || f.kind === "fix")) userVisible.push(`${f.kind === "fix" ? "Fix" : "New"}: ${f.summary}${where(f)}`);
  }
  for (const c of data?.api?.changes ?? []) {
    if (c.status === "added") userVisible.push(`New endpoint ${endpointLabel(c.endpoint)}`);
    if (c.status === "removed") userVisible.push(`Endpoint ${endpointLabel(c.endpoint)} removed`);
  }

  const contracts: string[] = [];
  const api = [...(data?.api?.changes ?? [])].sort((a, b) => Number(Boolean(b.breaking)) - Number(Boolean(a.breaking)));
  for (const c of api) contracts.push(`${c.breaking ? "BREAKING — " : ""}API: ${describeEndpointChange(c)}`);
  if (data?.db && (data.db.tables.length > 0 || data.db.migrations.length > 0 || data.db.enums.length > 0)) {
    for (const line of describeSchemaChange(data.db, 8).slice(1)) contracts.push(`Schema: ${line}`);
  }
  for (const c of data?.env?.changes ?? []) contracts.push(`Env: ${describeEnvChangeEntry(c, 3)}`);
  for (const c of data?.infra?.changes ?? []) contracts.push(`Infra: ${describeInfraChangeEntry(c, 3)}`);

  const risks: string[] = [];
  for (const f of open) {
    if (isIntentFinding(f) || isImpactFinding(f) || (f.assessment !== "defect" && f.assessment !== "concern")) continue;
    risks.push(`${f.assessment === "defect" ? "Defect" : "Concern"}: ${f.summary}${where(f)}`);
  }
  const impact = new Map<string, number>();
  const impactWhat = new Map<string, string>();
  for (const f of open.filter(isImpactFinding)) {
    const symbol = impactSymbol(f) ?? "a changed declaration";
    impact.set(symbol, (impact.get(symbol) ?? 0) + 1);
    if (!impactWhat.has(symbol)) impactWhat.set(symbol, impactChange(f) ?? "changed");
  }
  for (const [symbol, n] of impact) risks.push(`\`${symbol}\` ${impactWhat.get(symbol)}, but ${n} usage${n === 1 ? " was" : "s were"} not updated`);
  if (intent && (intent.assessment === "defect" || intent.assessment === "concern")) risks.push(`Doesn't fully deliver what it describes: ${intent.summary}`);

  const questions: string[] = [];
  for (const f of open) {
    if (f.scope === "unmentioned" && f.category === "change") questions.push(`Not mentioned in the description — meant to be here? ${f.summary}${where(f)}`);
  }
  if (intent?.assessment === "unknown") questions.push(`What is this change meant to do? ${intent.summary}`);
  if (ctx.target.kind === "pr" && !resolved?.intent.body?.trim()) questions.push("The PR has no description — what should a reader know about it?");
  for (const f of open) {
    if (f.assessment === "unknown" && f.category === "change") questions.push(`Couldn't be judged — worth a look: ${f.summary}${where(f)}`);
  }

  const added = files.reduce((n, f) => n + f.additions, 0);
  const removed = files.reduce((n, f) => n + f.deletions, 0);
  const size = files.length > 0 ? ` — ${files.length} file${files.length === 1 ? "" : "s"}, +${added}/-${removed}` : "";
  const summary = ctx.target.kind === "pr" ? `${title ? mdInline(title) : ctx.label}${size}.` : `Changes from ${ctx.target.baseRef} to ${ctx.target.headRef}${size}.`;
  return {
    summary,
    userVisible: cap(userVisible),
    contracts: cap(contracts),
    risks: cap(risks),
    questions: cap(questions),
  };
}

export function briefMarkdown(kind: ChangeBriefResponse["kind"], ctx: ReportContext, brief: ChangeBrief, model?: string): string {
  const heading =
    kind === "release_notes"
      ? `## Release notes — ${ctx.target.kind === "refs" ? `${ctx.target.baseRef} … ${ctx.target.headRef}` : ctx.label}`
      : `## Change brief — ${ctx.label}${ctx.pr ? `: ${mdInline(ctx.pr.title)}` : ""}`;
  const list = (title: string, items: string[]) => [`### ${title}`, "", ...(items.length ? items.map((i) => `- ${i}`) : ["_None found._"]), ""];
  return [
    heading,
    "",
    brief.summary,
    "",
    ...list("User-visible changes", brief.userVisible),
    ...list("Contract changes", brief.contracts),
    ...list("Risks", brief.risks),
    ...list("Open questions", brief.questions),
    `_Generated by GraphReview from its review data${model ? `, worded by ${model}` : ""}. Check it before you send it._`,
    "",
  ].join("\n");
}

function cacheKey(repoId: string, targetKey: string): string {
  return `change-brief:${repoId}:${targetKey}`;
}

async function resolveTargetOrNull(ctx: ReportContext): Promise<ResolvedTarget | null> {
  try {
    return await loadPrContext(ctx.repo, ctx.target);
  } catch {
    return null;
  }
}

function respond(
  ctx: ReportContext,
  brief: ChangeBrief,
  extra: Pick<ChangeBriefResponse, "source" | "model" | "note" | "headSha" | "aiConfigured">
): ChangeBriefResponse {
  const kind = ctx.target.kind === "refs" ? "release_notes" : "change_brief";
  return {
    kind,
    brief,
    markdown: briefMarkdown(kind, ctx, brief, extra.source === "ai" ? extra.model : undefined),
    filename: exportFilename(kind === "release_notes" ? "release-notes" : "change-brief", ctx.target),
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}

/** GET: the brief generated for this head, else the facts. */
export async function readChangeBrief(repo: RepoRecord, target: ReportContext["target"]): Promise<ChangeBriefResponse> {
  const ctx = await loadReportContext(repo, target);
  const resolved = await resolveTargetOrNull(ctx);
  const headSha = resolved?.reviewed.headSha ?? ctx.graph?.headSha;
  const aiConfigured = Boolean(await loadAiConfigOrNull());
  const cached = readKv<ChangeBriefResponse>(cacheKey(repo.id, ctx.targetKey));
  if (cached && cached.headSha === headSha) return { ...cached, aiConfigured };
  return respond(ctx, briefFacts(ctx, resolved), { source: "facts", ...(headSha ? { headSha } : {}), aiConfigured });
}

/** POST: one AI call over the facts; the facts with a note when no model can be used. */
export async function generateChangeBrief(
  repo: RepoRecord,
  target: ReportContext["target"],
  options: { chat?: typeof chatCompletion; signal?: AbortSignal } = {}
): Promise<ChangeBriefResponse> {
  const ctx = await loadReportContext(repo, target);
  const resolved = await resolveTargetOrNull(ctx);
  const headSha = resolved?.reviewed.headSha ?? ctx.graph?.headSha;
  const facts = briefFacts(ctx, resolved);
  const config = await loadAiConfigOrNull();
  const head = headSha ? { headSha } : {};
  if (!config) {
    return respond(ctx, facts, { source: "facts", note: "No AI provider is configured — this brief is built from the review data alone.", ...head, aiConfigured: false });
  }
  const input: ChangeBriefInput = {
    kind: ctx.target.kind === "refs" ? "release_notes" : "change_brief",
    ...(resolved?.intent.title ? { title: resolved.intent.title } : ctx.pr ? { title: ctx.pr.title } : {}),
    ...(resolved?.intent.body ? { body: resolved.intent.body } : {}),
    files: (resolved?.files ?? []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
    facts,
  };
  try {
    const result = await writeChangeBrief(config, input, options);
    if (result.parseFailed) {
      return respond(ctx, facts, { source: "facts", note: "The model's answer couldn't be read — this brief is built from the review data alone.", ...head, aiConfigured: true });
    }
    const response = respond(ctx, result.brief, { source: "ai", model: config.model, ...head, aiConfigured: true });
    writeKv(cacheKey(repo.id, ctx.targetKey), response, 30 * 24 * 3600);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return respond(ctx, facts, { source: "facts", note: `The model call failed (${message}) — this brief is built from the review data alone.`, ...head, aiConfigured: true });
  }
}
