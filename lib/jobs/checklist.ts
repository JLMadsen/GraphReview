// Evaluating the PR prerequisite checklist (DESIGN.md §6.6).
//
// `evaluateChecklist` answers every enabled item for one review target:
//
//   ci               the head commit's CI (GitHub checks/statuses, GitLab pipeline)
//   description      the PR has a description of at least N characters
//   linked-issue     the PR closes/links at least one issue
//   max-files        at most N changed files
//   max-lines        at most N changed lines (additions + deletions)
//   protected-paths  none of the listed paths is touched (touching one fails, as "needs care")
//   ai               a stored model answer for this head commit, if there is one
//
// Everything but `ai` is computed on each read — cheap, and always current.
// `runAiChecklist` makes the one model call that answers all `ai` items and
// stores the answers; a failing item only ever shows as a badge.
//
// Kept out of lib/jobs' barrel: it pulls in lib/ai (via ./pr-context).

import { answerChecklist, type ChecklistDiffFile } from "@/lib/ai";
import {
  getDisabledChecklistItemIds,
  listChecklistAnswers,
  listChecklistItems,
  listFindingsByTargetKey,
  saveChecklistAnswers,
} from "@/lib/neo4j";
import type { ChecklistItemRecord, ChecklistStatus, RepoRecord } from "@/lib/neo4j";
import type { JobLogger } from "./analyze";
import { loadAiConfigOrNull } from "./merge-naming";
import { loadCiStatus, loadPrContext } from "./pr-context";
import type { ResolvedTarget } from "./review";
import { reviewTargetKey, type ReviewTarget } from "./review-queue";

export interface ChecklistItemResult {
  itemId: string;
  kind: ChecklistItemRecord["kind"];
  label: string;
  status: ChecklistStatus;
  detail: string;
  /** Links from the detail, e.g. failed CI checks. */
  links?: Array<{ label: string; url: string }>;
  /** `ai` items: when the stored answer was made, and by which model. */
  checkedAt?: string;
  model?: string;
}

export interface ChecklistEvaluation {
  targetKey: string;
  headSha?: string;
  items: ChecklistItemResult[];
  /** Enabled `ai` items with no answer for the current head commit. */
  aiPending: number;
  aiConfigured: boolean;
}

/** The items that apply to a repo: enabled global items it hasn't switched off, plus its own enabled items. */
export async function effectiveChecklistItems(repoId: string): Promise<ChecklistItemRecord[]> {
  const [items, disabled] = await Promise.all([listChecklistItems(repoId), getDisabledChecklistItemIds(repoId)]);
  const off = new Set(disabled);
  return items.filter((item) => item.enabled && !(item.scope === "global" && off.has(item.id)));
}

/** `dir/**`, `*.ext`, `prefix*` or an exact path. */
export function matchesPathPattern(path: string, pattern: string): boolean {
  const p = pattern.trim().replace(/^\/+/, "");
  if (!p) return false;
  if (p.endsWith("/**")) return path.startsWith(p.slice(0, -2));
  if (p.startsWith("*.")) return path.endsWith(p.slice(1));
  if (p.endsWith("*")) return path.startsWith(p.slice(0, -1));
  return path === p;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function evaluateStatic(item: ChecklistItemRecord, ctx: ResolvedTarget): ChecklistItemResult | null {
  const base = { itemId: item.id, kind: item.kind, label: item.label };
  const isPr = ctx.intent.source === "pull_request";
  switch (item.kind) {
    case "description": {
      if (!isPr) return { ...base, status: "not_applicable", detail: "A ref comparison has no description." };
      const length = (ctx.intent.body ?? "").trim().length;
      const min = item.limit ?? 1;
      return length >= min
        ? { ...base, status: "pass", detail: `${plural(length, "character")} of description.` }
        : { ...base, status: "fail", detail: length === 0 ? "The description is empty." : `Only ${plural(length, "character")} (want ${min}+).` };
    }
    case "linked-issue": {
      if (!isPr) return { ...base, status: "not_applicable", detail: "A ref comparison has no linked issues." };
      const issues = ctx.intent.linkedIssues ?? [];
      return issues.length > 0
        ? { ...base, status: "pass", detail: issues.map((i) => `#${i.number} ${i.title}`).join(" · ") }
        : { ...base, status: "fail", detail: "No linked issue found." };
    }
    case "max-files": {
      const max = item.limit ?? 30;
      const n = ctx.files.length;
      return { ...base, status: n <= max ? "pass" : "fail", detail: `${plural(n, "file")} changed (limit ${max}).` };
    }
    case "max-lines": {
      const max = item.limit ?? 500;
      const n = ctx.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
      return { ...base, status: n <= max ? "pass" : "fail", detail: `${plural(n, "line")} changed (limit ${max}).` };
    }
    case "protected-paths": {
      const patterns = item.patterns ?? [];
      if (patterns.length === 0) return { ...base, status: "unknown", detail: "No paths configured for this check." };
      const touched = ctx.files.map((f) => f.path).filter((path) => patterns.some((p) => matchesPathPattern(path, p)));
      return touched.length === 0
        ? { ...base, status: "pass", detail: `None of ${patterns.join(", ")} is touched.` }
        : { ...base, status: "fail", detail: `Touches ${touched.slice(0, 5).join(", ")}${touched.length > 5 ? ` and ${touched.length - 5} more` : ""} — needs extra care.` };
    }
    default:
      return null;
  }
}

export async function evaluateChecklist(
  repo: RepoRecord,
  target: ReviewTarget,
  log: JobLogger = () => undefined,
  options: { fresh?: boolean } = {}
): Promise<ChecklistEvaluation> {
  const targetKey = reviewTargetKey(target);
  const [items, ctx, answers, aiConfig] = await Promise.all([
    effectiveChecklistItems(repo.id),
    loadPrContext(repo, target, log, options),
    listChecklistAnswers(repo.id, targetKey),
    loadAiConfigOrNull(),
  ]);
  const headSha = ctx.reviewed.headSha;
  const needsCi = items.some((i) => i.kind === "ci");
  const ci = needsCi ? await loadCiStatus(repo, headSha) : null;
  const answerByItem = new Map(answers.map((a) => [a.itemId, a]));

  let aiPending = 0;
  const results: ChecklistItemResult[] = items.map((item) => {
    const base = { itemId: item.id, kind: item.kind, label: item.label };
    if (item.kind === "ci") {
      if (!ci || !ci.available) return { ...base, status: "not_applicable" as const, detail: ci?.reason ?? "" };
      const { status } = ci;
      const failed = status.checks.filter((c) => c.state === "failure");
      const pending = status.checks.filter((c) => c.state === "pending");
      const links = [...failed, ...pending].filter((c) => c.url).slice(0, 6).map((c) => ({ label: c.name, url: c.url! }));
      switch (status.state) {
        case "success":
          return { ...base, status: "pass" as const, detail: `${plural(status.checks.length, "check")} passed.` };
        case "failure":
          return { ...base, status: "fail" as const, detail: `Failing: ${failed.map((c) => c.name).join(", ") || "the pipeline"}.`, links };
        case "pending":
          return { ...base, status: "pending" as const, detail: `Still running: ${pending.map((c) => c.name).join(", ") || "the pipeline"}.`, links };
        default:
          return { ...base, status: "unknown" as const, detail: "No CI checks are reported for this commit." };
      }
    }
    if (item.kind === "ai") {
      const answer = answerByItem.get(item.id);
      if (answer && answer.headSha && answer.headSha === headSha) {
        return { ...base, status: answer.status, detail: answer.detail, checkedAt: answer.checkedAt, model: answer.model };
      }
      aiPending++;
      return {
        ...base,
        status: "pending" as const,
        detail: answer
          ? "Answered for an older commit — run the AI checks again."
          : aiConfig
            ? "Not answered yet."
            : "Needs an AI provider (Settings).",
      };
    }
    return evaluateStatic(item, ctx) ?? { ...base, status: "unknown" as const, detail: "Unknown check." };
  });

  return { targetKey, headSha, items: results, aiPending, aiConfigured: aiConfig !== null };
}

/** One model call answering every enabled `ai` item for the target's current head; stores the answers. */
export async function runAiChecklist(
  repo: RepoRecord,
  target: ReviewTarget,
  log: JobLogger = () => undefined
): Promise<{ answered: number; promptTokens: number; completionTokens: number }> {
  const config = await loadAiConfigOrNull();
  if (!config) throw new Error("No AI provider is configured — set one in Settings.");

  const targetKey = reviewTargetKey(target);
  const [items, ctx, findings] = await Promise.all([
    effectiveChecklistItems(repo.id),
    loadPrContext(repo, target, log, { fresh: true }),
    listFindingsByTargetKey(repo.id, reviewTargetKey(target)),
  ]);
  const aiItems = items.filter((i) => i.kind === "ai" && i.question?.trim());
  if (aiItems.length === 0) return { answered: 0, promptTokens: 0, completionTokens: 0 };

  // Short ids on the wire (q1, q2, …) — real ids are UUIDs a model copies badly.
  const idByRef = new Map(aiItems.map((item, index) => [`q${index + 1}`, item.id]));
  const files: ChecklistDiffFile[] = ctx.files.map((f) => ({
    path: f.path,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));
  const result = await answerChecklist(config, {
    intent: ctx.intent,
    files,
    findings: findings.map(
      (f) => `${f.filePath ?? f.componentName}: ${f.summary} (${f.intentMatch}${f.resolvedAt ? ", resolved" : ""})`
    ),
    questions: [...idByRef].map(([ref, itemId]) => ({
      id: ref,
      question: aiItems.find((i) => i.id === itemId)!.question!,
    })),
  });
  log(
    `checklist: ${result.answers.length}/${aiItems.length} answered, ` +
      `${result.usage.promptTokens}+${result.usage.completionTokens} token(s)`
  );

  const now = new Date().toISOString();
  const answered = new Set(result.answers.map((a) => a.id));
  await saveChecklistAnswers([
    ...result.answers.map((a) => ({
      repoId: repo.id,
      targetKey,
      itemId: idByRef.get(a.id)!,
      status: a.status,
      detail: a.rationale || "(no rationale given)",
      headSha: ctx.reviewed.headSha,
      model: config.model,
      checkedAt: now,
    })),
    // A question the model skipped is recorded as unknown, so it doesn't stay "pending" forever.
    ...[...idByRef]
      .filter(([ref]) => !answered.has(ref))
      .map(([, itemId]) => ({
        repoId: repo.id,
        targetKey,
        itemId,
        status: "unknown" as const,
        detail: result.parseFailed ? "The model's reply could not be read." : "The model did not answer this one.",
        headSha: ctx.reviewed.headSha,
        model: config.model,
        checkedAt: now,
      })),
  ]);
  return {
    answered: result.answers.length,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
  };
}
