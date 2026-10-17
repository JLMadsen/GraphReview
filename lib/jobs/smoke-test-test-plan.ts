/**
 * Checks for the AI test plan (DESIGN.md §6.22 §5): the prompt carries the
 * TASK marker and the evidence refs, the mock server answers it, items that
 * cite missing evidence are dropped, and the stored plan renders as the
 * Markdown section the report includes.
 *
 *   npm test -- test-plan
 */
import { generateTestPlan, normalizeTestPlan, renderTestPlanUserMessage, buildTestPlanSystemPrompt, TEST_PLAN_TASK_MARKER, type AiProviderConfig, type TestPlanInput } from "@/lib/ai";
import { startMockServer } from "@/lib/ai/mock-server";
import { loadTestPlan, testPlanMarkdown, writeTestPlan, type StoredTestPlan } from "./test-plan";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const INPUT: TestPlanInput = {
  title: "Retry failed uploads",
  findings: [{ ref: "F1", text: "src/upload.ts:12: retries forever on 4xx (change, concern)" }],
  impact: [],
  callers: [{ ref: "C1", text: "saveDraft() in src/draft.ts:40 calls upload() (signature changed)" }],
  api: [{ ref: "A1", text: "POST /api/upload: body gains retries?: number" }],
  schema: [],
  env: [],
  infra: [],
  preview: [{ ref: "P1", text: "<UploadButton> in src/UploadButton.tsx (changed, renders differently)" }],
  untested: [],
  tests: ["src/upload.ts: reached by 1 test(s), e.g. src/upload.test.ts"],
};

async function main(): Promise<void> {
  console.log("prompt");
  check("system prompt carries the TASK marker", buildTestPlanSystemPrompt().startsWith(TEST_PLAN_TASK_MARKER));
  const user = renderTestPlanUserMessage(INPUT);
  check("user message lists evidence with refs and kinds", user.includes("[F1] src/upload.ts:12") && user.includes("— kind caller") && user.includes("[P1]"), user);

  console.log("normalize");
  const items = normalizeTestPlan(
    { items: [
      { title: "Upload stops retrying on 404", type: "regression", source: { kind: "finding", ref: "F1" } },
      { title: "Invented", type: "regression", source: { kind: "finding", ref: "F9" } },
      { title: "Retries field accepted", type: "new behavior", steps: ["POST with retries: 2", "", 3], source: { ref: "[A1]" } },
      { type: "regression", source: { ref: "C1" } },
    ] },
    INPUT
  );
  check("unknown ref with a valid kind kept without a ref", items.some((i) => i.title === "Invented" && i.source.ref === ""));
  check("type alias and bracketed ref read", items.some((i) => i.title === "Retries field accepted" && i.type === "new-behaviour" && i.source.kind === "api" && i.steps.length === 1));
  check("an item without a title dropped", items.length === 3, JSON.stringify(items));

  console.log("mock server");
  const mock = await startMockServer({ port: 0, host: "127.0.0.1", delayMs: 0, log: () => undefined });
  try {
    const config: AiProviderConfig = { baseUrl: `${mock.url}/v1`, apiKey: "test-key", model: "mock-review-1" };
    const result = await generateTestPlan(config, INPUT, { tokenBudget: 20_000 });
    check("mock answers one item per evidence line", result.items.length === 4 && !result.parseFailed, JSON.stringify(result));
    check("finding and caller are regressions, API and UI new behaviour", result.items.filter((i) => i.type === "regression").map((i) => i.source.ref).join(",") === "F1,C1" && result.items.filter((i) => i.type === "new-behaviour").length === 2);

    console.log("storage and Markdown");
    const plan: StoredTestPlan = {
      headSha: "abc1234",
      createdAt: new Date().toISOString(),
      model: config.model,
      items: result.items,
      sources: { F1: { kind: "finding", text: INPUT.findings[0].text, file: "src/upload.ts", line: 12, findingId: "x" }, C1: { kind: "caller", text: INPUT.callers[0].text, file: "src/draft.ts", line: 40 }, A1: { kind: "api", text: INPUT.api[0].text }, P1: { kind: "preview", text: INPUT.preview[0].text, file: "src/UploadButton.tsx" } },
    };
    writeTestPlan("repo-1", "pr:7", plan);
    const loaded = loadTestPlan("repo-1", "pr:7");
    check("plan round-trips through kv", loaded?.items.length === 4 && loaded.headSha === "abc1234");
    const md = testPlanMarkdown(loaded);
    check("markdown has both groups as checkboxes with sources", md.startsWith("## Test plan") && md.includes("### Regression") && md.includes("### New behaviour") && md.includes("- [ ] ") && md.includes("`src/upload.ts:12`"), md);
    check("markdown of no plan is empty", testPlanMarkdown(null) === "" && testPlanMarkdown({ ...plan, items: [] }) === "");
  } finally {
    await mock.close();
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall test-plan checks passed");
}

void main();
