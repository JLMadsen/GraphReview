// The full Markdown report of a review (DESIGN.md §6.23 §2).
//
// Built from what's already stored — findings, the target graph's catalog
// diffs, the checklist (evaluated without AI) and finished previews — with
// no model call and no clone. The report is a list of sections; adding one
// (the Tests view's test plan, say) is one more entry in `REPORT_SECTIONS`.

import { getPullRequestByNumber, listFindingsByTargetKey, readTargetGraph, type FindingWithComponent, type RepoRecord } from "@/lib/db";
import { all } from "@/lib/db/client";
import { describeApiChange } from "@/lib/analysis/api/describe";
import { describeInfraChange } from "@/lib/analysis/infra/describe";
import { describeSchemaChange } from "@/lib/analysis/db/describe";
import { describeEnvChange } from "@/lib/analysis/env/describe";
import { evaluateChecklist, type ChecklistEvaluation } from "@/lib/jobs/checklist";
import { loadTestPlan, testPlanMarkdown } from "@/lib/jobs/test-plan";
import { reviewTargetKey, type ReviewTarget } from "@/lib/jobs/review-queue";
import type { TargetGraphData } from "@/lib/jobs/target-graph-queue";
import type { PreviewResult } from "@/lib/preview/types";
import {
  computeVerdict,
  impactChange,
  impactReasons,
  impactSymbol,
  isImpactFinding,
  isIntentFinding,
  mdCode,
  mdInline,
  reviewMarkdownBody,
  ASSESSMENT_VISUALS,
  effectiveAssessment,
} from "@/components/graph/review-visuals";
import type { FindingDTO } from "@/components/graph/types";

export interface ReportContext {
  repo: RepoRecord;
  target: ReviewTarget;
  targetKey: string;
  /** "PR #12" or "main → feature". */
  label: string;
  findings: FindingWithComponent[];
  /** The same findings in the shape review-visuals.ts reads. */
  dtos: FindingDTO[];
  pr?: { number: number; title: string; url?: string };
  /** The base/head comparison: call graph, API, infra, schema and env diffs. */
  graph?: { baseSha: string; headSha: string; data: TargetGraphData };
  reviewedHeadSha?: string;
  /** Checklist evaluation, loaded once on first use (it may call the git host for CI). */
  checklist: () => Promise<ChecklistEvaluation | null>;
  /** Finished before/after previews of this target. */
  previews: () => PreviewResult[];
}

export interface ReportSection {
  id: string;
  /** Rendered as `### title` above the lines; omit for a section that writes its own headings. */
  title?: string;
  /** Markdown lines, or `null` to leave the section out. May load its own data from `ctx`. */
  render: (ctx: ReportContext) => string[] | null | Promise<string[] | null>;
}

const MAX_LINES_PER_DIFF = 40;
const RATIONALE_CHARS = 600;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const header: ReportSection = {
  id: "header",
  render: (ctx) => {
    const title = ctx.pr ? `${ctx.label}: ${mdInline(ctx.pr.title)}` : mdInline(ctx.label);
    const lines = [`## Review report — ${title}`, ""];
    const facts = [
      `Repo: ${mdInline(ctx.repo.name)}`,
      ...(ctx.pr?.url ? [`Link: ${ctx.pr.url}`] : []),
      ...(ctx.target.kind === "refs" ? [`Range: ${mdCode(ctx.target.baseRef)} … ${mdCode(ctx.target.headRef)}`] : []),
      ...(ctx.graph ? [`Compared: ${mdCode(ctx.graph.baseSha.slice(0, 7))} … ${mdCode(ctx.graph.headSha.slice(0, 7))}`] : []),
    ];
    lines.push(...facts.map((f) => `- ${f}`));
    return lines;
  },
};

const intent: ReportSection = {
  id: "intent",
  title: "Intent",
  render: (ctx) => {
    const finding = ctx.dtos.find(isIntentFinding);
    if (!finding) return null;
    return [
      `**Delivers what it describes: ${ASSESSMENT_VISUALS[effectiveAssessment(finding)].label}** — ${mdInline(finding.summary)}`,
      ...(finding.rationale.trim() ? ["", ...clip(finding.rationale.trim(), 1500).split(/\r?\n/).map((l) => `> ${l}`)] : []),
    ];
  },
};

const findings: ReportSection = {
  id: "findings",
  title: "Verdict and findings",
  render: (ctx) => {
    const verdict = computeVerdict(ctx.dtos);
    if (!verdict) return ["No review findings yet."];
    // The intent line is its own section above.
    return reviewMarkdownBody(verdict, ctx.dtos.filter((f) => !isIntentFinding(f)), ctx.reviewedHeadSha, {
      rationaleChars: RATIONALE_CHARS,
      omitImpact: true,
    });
  },
};

const impact: ReportSection = {
  id: "impact",
  title: "Callers left behind",
  render: (ctx) => {
    const usages = ctx.dtos.filter((f) => isImpactFinding(f) && !f.resolvedAt);
    if (usages.length === 0) return null;
    const bySymbol = new Map<string, FindingDTO[]>();
    for (const f of usages) {
      const symbol = impactSymbol(f) ?? "(a changed declaration)";
      bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), f]);
    }
    const lines: string[] = [];
    for (const [symbol, group] of bySymbol) {
      const change = impactChange(group[0]);
      lines.push(`- ${mdCode(symbol)}${change ? ` ${mdInline(change)}` : ""} — ${group.length} usage${group.length === 1 ? "" : "s"} not updated:`);
      for (const f of group) {
        const where = f.filePath ? mdCode(f.lineRange ? `${f.filePath}:${f.lineRange}` : f.filePath) : "";
        lines.push(`  - ${where} — ${mdInline(impactReasons(f).join("; "))}`);
      }
    }
    return lines;
  },
};

const CHECK_GLYPH: Record<string, string> = { pass: "✓", fail: "✕", pending: "…", unknown: "?", not_applicable: "–" };

const checklist: ReportSection = {
  id: "checklist",
  title: "Checklist",
  render: async (ctx) => {
    const evaluation = await ctx.checklist();
    if (!evaluation || evaluation.items.length === 0) return null;
    return evaluation.items.flatMap((item) => [
      `- ${CHECK_GLYPH[item.status] ?? "?"} **${mdInline(item.label)}** — ${item.status.replace("_", " ")}${item.detail ? `: ${mdInline(clip(item.detail, 300))}` : ""}`,
      // Acceptance criteria (DESIGN.md §6.27): one sub-item per criterion.
      ...(item.criteria ?? []).map((c) => `  - ${CRITERION_MARK[c.verdict] ?? "?"} ${mdInline(clip(c.text.replace(/\s*\n\s*/g, " / "), 300))}${c.reason ? ` — ${mdInline(clip(c.reason, 300))}` : ""}`),
    ]);
  },
};

const CRITERION_MARK: Record<string, string> = { pass: "✓ Met", fail: "✕ Not met", unknown: "? Can't tell", pending: "… Not judged yet" };

/** The Tests view's AI test plan (DESIGN.md §6.22), when one was made. */
const testPlan: ReportSection = {
  id: "test-plan",
  render: (ctx) => {
    const markdown = testPlanMarkdown(loadTestPlan(ctx.repo.id, ctx.targetKey), { heading: "### Test plan" });
    return markdown ? markdown.split("\n") : null;
  },
};

function bullets(lines: string[]): string[] {
  const [summary, ...rest] = lines;
  const shown = rest.slice(0, MAX_LINES_PER_DIFF);
  return [
    mdInline(summary),
    ...(shown.length ? ["", ...shown.map((l) => `- ${mdInline(l)}`)] : []),
    ...(rest.length > shown.length ? [`- … ${rest.length - shown.length} more`] : []),
  ];
}

const api: ReportSection = {
  id: "api",
  title: "API changes",
  render: (ctx) => {
    const change = ctx.graph?.data.api;
    if (!change || (change.changes.length === 0 && (change.logic ?? []).length === 0)) return null;
    return bullets(describeApiChange(change, MAX_LINES_PER_DIFF, 10));
  },
};

const infra: ReportSection = {
  id: "infra",
  title: "Infrastructure changes",
  render: (ctx) => {
    const change = ctx.graph?.data.infra;
    if (!change || (change.changes.length === 0 && change.links.length === 0)) return null;
    return bullets(describeInfraChange(change, MAX_LINES_PER_DIFF));
  },
};

const schema: ReportSection = {
  id: "schema",
  title: "Database schema changes",
  render: (ctx) => {
    const change = ctx.graph?.data.db;
    if (!change || (change.tables.length === 0 && change.migrations.length === 0 && change.enums.length === 0)) return null;
    return bullets(describeSchemaChange(change, MAX_LINES_PER_DIFF));
  },
};

const env: ReportSection = {
  id: "env",
  title: "Env variable changes",
  render: (ctx) => {
    const change = ctx.graph?.data.env;
    if (!change || change.changes.length === 0) return null;
    return bullets(describeEnvChange(change, MAX_LINES_PER_DIFF));
  },
};

const previews: ReportSection = {
  id: "previews",
  title: "Before/after previews",
  render: (ctx) => {
    const results = ctx.previews();
    if (results.length === 0) return null;
    return results.map((r) => {
      const cases = r.symbols.flatMap((s) => s.cases);
      const differs = cases.filter((c) => c.differs).length;
      const errors = [r.before.fatal && `before: ${r.before.fatal}`, r.after.fatal && `after: ${r.after.fatal}`].filter(Boolean) as string[];
      const verdict =
        errors.length > 0
          ? `could not run (${mdInline(clip(errors.join("; "), 200))})`
          : cases.length === 0
            ? "nothing to run"
            : differs === 0
              ? `same output in all ${cases.length} case${cases.length === 1 ? "" : "s"}`
              : `**${differs} of ${cases.length} case${cases.length === 1 ? "" : "s"} differ**`;
      const changed = r.symbols.filter((s) => s.cases.some((c) => c.differs)).map((s) => mdCode(s.name));
      return `- ${mdCode(r.filePath)} — ${verdict}${changed.length ? ` (${changed.join(", ")})` : ""}`;
    });
  },
};

const footer: ReportSection = {
  id: "footer",
  render: () => ["---", "_Generated by GraphReview. Advisory only — AI can be wrong._"],
};

/**
 * The report's sections, in order. Each renders from the context or leaves
 * itself out; add one here (before `footer`) and it appears in the report,
 * the copy and the download.
 */
export const REPORT_SECTIONS: ReportSection[] = [header, intent, findings, impact, checklist, testPlan, api, infra, schema, env, previews, footer];

/** Finished preview runs of this target, newest per file. */
function readPreviews(repoId: string, targetKey: string): PreviewResult[] {
  const rows = all<{ data: string; returnvalue: string | null }>(
    `SELECT data, returnvalue FROM jobs WHERE queue = 'preview' AND state = 'completed' ORDER BY finished_on DESC`
  );
  const byFile = new Map<string, PreviewResult>();
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data) as { repoId?: string; target?: ReviewTarget; filePath?: string };
      if (data.repoId !== repoId || !data.target || reviewTargetKey(data.target) !== targetKey || !row.returnvalue) continue;
      const result = JSON.parse(row.returnvalue) as PreviewResult;
      if (result?.filePath && !byFile.has(result.filePath)) byFile.set(result.filePath, result);
    } catch {
      // A row this code can't read is left out of the report.
    }
  }
  return [...byFile.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
}

export function targetLabel(target: ReviewTarget, repo: Pick<RepoRecord, "provider">): string {
  if (target.kind === "pr") return `${repo.provider === "gitlab" ? "MR !" : "PR #"}${target.prNumber}`;
  const short = (ref: string) => (/^[0-9a-f]{12,64}$/i.test(ref) ? ref.slice(0, 7) : ref);
  return `${short(target.baseRef)} → ${short(target.headRef)}`;
}

export async function loadReportContext(repo: RepoRecord, target: ReviewTarget): Promise<ReportContext> {
  const targetKey = reviewTargetKey(target);
  const [findingRows, pr] = await Promise.all([
    listFindingsByTargetKey(repo.id, targetKey),
    target.kind === "pr" ? getPullRequestByNumber(repo.id, target.prNumber).catch(() => null) : Promise.resolve(null),
  ]);
  const stored = readTargetGraph<TargetGraphData>(repo.id, targetKey);
  let checklistResult: Promise<ChecklistEvaluation | null> | undefined;
  return {
    repo,
    target,
    targetKey,
    label: targetLabel(target, repo),
    findings: findingRows,
    dtos: findingRows as unknown as FindingDTO[],
    ...(pr ? { pr: { number: pr.number, title: pr.title, ...(pr.url ? { url: pr.url } : {}) } } : {}),
    ...(stored ? { graph: { baseSha: stored.baseSha, headSha: stored.headSha, data: stored.data } } : {}),
    reviewedHeadSha: findingRows.find((f) => f.reviewedHeadSha)?.reviewedHeadSha,
    checklist: () =>
      (checklistResult ??= evaluateChecklist(repo, target).catch((error: unknown) => {
        console.warn(`[report] checklist for ${targetKey} could not be evaluated: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      })),
    previews: () => readPreviews(repo.id, targetKey),
  };
}

export async function renderReport(ctx: ReportContext, sections: readonly ReportSection[] = REPORT_SECTIONS): Promise<{ markdown: string; sections: string[] }> {
  const parts: string[] = [];
  const rendered: string[] = [];
  for (const section of sections) {
    let lines: string[] | null;
    try {
      lines = await section.render(ctx);
    } catch (error) {
      lines = [`_This section could not be built: ${mdInline(error instanceof Error ? error.message : String(error))}_`];
    }
    if (!lines || lines.length === 0) continue;
    rendered.push(section.id);
    parts.push([...(section.title ? [`### ${section.title}`, ""] : []), ...lines].join("\n"));
  }
  return { markdown: `${parts.join("\n\n")}\n`, sections: rendered };
}

/** `graphreview-pr-12.md`, `graphreview-main..feature.md` */
export function exportFilename(prefix: string, target: ReviewTarget): string {
  const slug = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return target.kind === "pr" ? `${prefix}-pr-${target.prNumber}.md` : `${prefix}-${slug(target.baseRef)}..${slug(target.headRef)}.md`;
}
