// The AI test plan pass (DESIGN.md §6.22 §5): one call at the end of a
// review that turns its findings, the impact check, the change's callers,
// its API/schema/env/infra change, the UI components that look different
// and the changed code no test reaches into test items. Stored in `kv` per
// review target, shown in the Tests view, and rendered as Markdown for the
// report (`testPlanMarkdown`).
//
// Kept out of lib/jobs' barrel: it pulls in lib/analysis.

import { generateTestPlan, hasTestPlanEvidence, type AiProviderConfig, type TestPlanEvidence, type TestPlanInput, type TestPlanItem, type TestPlanSourceKind } from "@/lib/ai";
import type { CallGraph } from "@/lib/analysis";
import type { TestsChange } from "@/lib/analysis/tests/types";
import { listFindingsByTargetKey, readKv, writeKv } from "@/lib/db";
import { symbolStatus } from "@/lib/preview/compare";
import type { JobLogger } from "./analyze";
import { getPreviewJob, getPreviewScanQueue, previewScanJobId } from "./preview-queue";
import type { ReviewTarget } from "./review-queue";

/** Where an item came from, for linking it in the view and the report. */
export interface TestPlanSource {
  kind: TestPlanSourceKind;
  text: string;
  file?: string;
  line?: number;
  findingId?: string;
}

export interface StoredTestPlan {
  /** The head the plan was made for; an older one is shown as stale. */
  headSha?: string;
  createdAt: string;
  model: string;
  items: TestPlanItem[];
  /** Evidence by ref, for every item's `source.ref`. */
  sources: Record<string, TestPlanSource>;
  parseFailed?: boolean;
  /** The call failed; the items are from no call. */
  error?: string;
}

const key = (repoId: string, targetKey: string) => `test-plan:${repoId}:${targetKey}`;

export function loadTestPlan(repoId: string, targetKey: string): StoredTestPlan | null {
  return readKv<StoredTestPlan>(key(repoId, targetKey)) ?? null;
}

export function writeTestPlan(repoId: string, targetKey: string, plan: StoredTestPlan): void {
  writeKv(key(repoId, targetKey), plan);
}

const SOURCE_LABEL: Record<TestPlanSourceKind, string> = {
  finding: "Finding",
  impact: "Impact",
  caller: "Caller",
  api: "API change",
  schema: "Schema change",
  env: "Env change",
  infra: "Infra change",
  preview: "UI component",
  untested: "Untested code",
};

/** The plan as a Markdown section — for the Markdown report. Empty string for no items. */
export function testPlanMarkdown(plan: StoredTestPlan | null, options: { heading?: string } = {}): string {
  if (!plan || plan.items.length === 0) return "";
  const lines = [`${options.heading ?? "## Test plan"}`, ""];
  for (const [type, title] of [["regression", "Regression"], ["new-behaviour", "New behaviour"]] as const) {
    const items = plan.items.filter((i) => i.type === type);
    if (items.length === 0) continue;
    lines.push(`### ${title}`, "");
    for (const item of items) {
      const source = plan.sources[item.source.ref];
      const where = source?.file ? ` (\`${source.file}${source.line ? `:${source.line}` : ""}\`)` : "";
      lines.push(`- [ ] ${item.title} — _${SOURCE_LABEL[item.source.kind]}${source ? `: ${source.text.slice(0, 120)}` : ""}_${where}`);
      for (const step of item.steps) lines.push(`  - ${step}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** The UI components the change touches, from the preview scan (never started here) and each file's last preview. */
async function previewEvidence(repoId: string, target: ReviewTarget): Promise<Array<Omit<TestPlanSource, "kind">>> {
  const job = await getPreviewScanQueue().getJob(previewScanJobId(repoId, target)).catch(() => undefined);
  if (!job || (await job.getState()) !== "completed" || !job.returnvalue) return [];
  const out: Array<Omit<TestPlanSource, "kind">> = [];
  for (const file of job.returnvalue.files) {
    const preview = await getPreviewJob(repoId, target, file.filePath).catch(() => undefined);
    const result = preview?.returnvalue ?? undefined;
    for (const c of file.components) {
      const symbol = result?.symbols.find((s) => s.name === c.name);
      const status = symbol ? symbolStatus(symbol) : undefined;
      if (status === "same") continue;
      const looks = !symbol ? "changed, not previewed" : status === "failed" || status === "breaks" || status === "recovers" ? `preview ${status}` : "renders differently";
      out.push({ text: `<${c.name}> in ${file.filePath} (${c.change}, ${looks})`, file: file.filePath, line: c.line });
    }
  }
  return out;
}

const CALLER_STATUSES = new Set(["signature", "body", "removed", "moved"]);

export async function runTestPlanPass(args: {
  repoId: string;
  targetKey: string;
  target: ReviewTarget;
  title?: string;
  headSha?: string;
  apiLines?: string[];
  schemaLines?: string[];
  envLines?: string[];
  infraLines?: string[];
  tests?: TestsChange | null;
  callGraph?: CallGraph;
  aiConfig: AiProviderConfig;
  tokenBudget: number;
  log: JobLogger;
  signal?: AbortSignal;
}): Promise<{ calls: number; promptTokens: number; completionTokens: number }> {
  const sources: Record<string, TestPlanSource> = {};
  const input: TestPlanInput = { title: args.title, findings: [], impact: [], callers: [], api: [], schema: [], env: [], infra: [], preview: [], untested: [], tests: [] };
  const add = (bucket: keyof Omit<TestPlanInput, "title" | "tests">, kind: TestPlanSourceKind, prefix: string, source: Omit<TestPlanSource, "kind">) => {
    const ref = `${prefix}${input[bucket].length + 1}`;
    sources[ref] = { kind, ...source };
    (input[bucket] as TestPlanEvidence[]).push({ ref, text: source.text });
  };

  const findings = await listFindingsByTargetKey(args.repoId, args.targetKey);
  for (const f of findings) {
    if (f.assessment === "ok" || f.resolvedAt || f.callFailed || f.category === "intent") continue;
    const line = f.lineRange ? Number.parseInt(f.lineRange, 10) || undefined : undefined;
    const text = `${f.filePath ?? f.componentName ?? "whole change"}${f.lineRange ? `:${f.lineRange}` : ""}: ${f.summary} (${f.category}, ${f.assessment})`;
    const source = { text, ...(f.filePath ? { file: f.filePath } : {}), ...(line ? { line } : {}), findingId: f.id };
    if (f.category === "impact") add("impact", "impact", "I", source);
    else add("findings", "finding", "F", source);
  }
  if (args.callGraph) {
    const fns = new Map(args.callGraph.functions.map((fn) => [fn.id, fn]));
    for (const e of args.callGraph.edges) {
      const to = fns.get(e.to);
      const from = fns.get(e.from);
      if (e.status !== "existing" || !to || !from || from.status !== "unchanged" || !CALLER_STATUSES.has(to.status)) continue;
      add("callers", "caller", "C", { text: `${from.qualified}() in ${e.file}:${e.line} calls ${to.qualified}() (${to.status} changed)`, file: e.file, line: e.line });
    }
  }
  for (const text of args.apiLines ?? []) add("api", "api", "A", { text });
  for (const text of args.schemaLines ?? []) add("schema", "schema", "S", { text });
  for (const text of args.envLines ?? []) add("env", "env", "E", { text });
  for (const text of args.infraLines ?? []) add("infra", "infra", "N", { text });
  for (const p of await previewEvidence(args.repoId, args.target).catch(() => [])) add("preview", "preview", "P", p);
  for (const c of args.tests?.changedCode ?? []) {
    if (c.testCount === 0) add("untested", "untested", "U", { text: `${c.file} (${c.status}, ${c.changedLines} changed line(s)) — no test reaches it`, file: c.file });
    else input.tests.push(`${c.file}: reached by ${c.testCount} test(s), e.g. ${[...c.changedTests, ...c.tests].slice(0, 2).join(", ")}`);
  }
  for (const d of args.tests?.deletedTests ?? []) input.tests.push(`deleted test ${d.file}`);

  const base = { headSha: args.headSha, createdAt: new Date().toISOString(), model: args.aiConfig.model, sources };
  if (!hasTestPlanEvidence(input)) {
    writeTestPlan(args.repoId, args.targetKey, { ...base, items: [] });
    args.log("test plan: nothing to plan from");
    return { calls: 0, promptTokens: 0, completionTokens: 0 };
  }
  try {
    const result = await generateTestPlan(args.aiConfig, input, { tokenBudget: args.tokenBudget, signal: args.signal });
    if (args.signal?.aborted) return { calls: 1, promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens };
    writeTestPlan(args.repoId, args.targetKey, { ...base, items: result.items, ...(result.parseFailed ? { parseFailed: true } : {}) });
    args.log(`test plan: ${result.items.length} item(s)${result.parseFailed ? " (model output could not be parsed)" : ""}`);
    return { calls: 1, promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.log(args.signal?.aborted ? "test plan: stopped — the review was cancelled" : `test plan: model call failed — ${message}`);
    if (!args.signal?.aborted) writeTestPlan(args.repoId, args.targetKey, { ...base, items: [], error: message });
    return { calls: 1, promptTokens: 0, completionTokens: 0 };
  }
}
