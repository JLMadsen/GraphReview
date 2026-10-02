/**
 * Smoke test for the review's impact check and PR-level intent check.
 *
 *   npx tsx lib/jobs/smoke-test-impact.ts
 *
 * Part A: changed-contract detection (./impact-contracts.ts) and the usage
 * filter (./impact.ts) — pure, no database. Part B: the model calls
 * (lib/ai/impact.ts, lib/ai/pr-intent.ts) against an injected fake chat, then
 * against the real mock server through the real client.
 */
import { checkImpact, checkPrIntent, MAX_IMPACT_CALLS, type ImpactContract } from "@/lib/ai";
import type { chatCompletion } from "@/lib/ai/client";
import { startMockServer } from "@/lib/ai/mock-server";
import type { AiProviderConfig, ChatMessage } from "@/lib/ai";
import { addedLineNumbers, detectChangedContracts, type ChangedContract } from "./impact-contracts";
import { untouchedReachableUsages } from "./impact";

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const config: AiProviderConfig = { baseUrl: "http://fake.invalid/v1", apiKey: "k", model: "fake-model" };
type Chat = typeof chatCompletion;

function fakeChat(content: string | ((messages: ChatMessage[]) => string)) {
  const calls: ChatMessage[][] = [];
  const chat: Chat = async (_config, messages) => {
    calls.push(messages);
    const text = typeof content === "function" ? content(messages) : content;
    return { content: text, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
  };
  return { chat, calls };
}

const fenced = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";

async function main(): Promise<void> {
  console.log("contract detection:");

  // --- a changed signature ------------------------------------------------
  {
    const patch = [
      "@@ -10,6 +10,6 @@ import x from 'y';",
      " ",
      "-export function buildPrompt(intent: Intent): string {",
      "+export function buildPrompt(intent: Intent, files: File[]): string {",
      "   return render(intent);",
      " }",
    ].join("\n");
    const head = "import x from 'y';\n\nexport function buildPrompt(intent: Intent, files: File[]): string {\n  return render(intent);\n}\n";
    const [c, ...rest] = detectChangedContracts([{ path: "lib/p.ts", status: "modified", patch, headContent: head }]);
    check("signature change -> one changed callable", Boolean(c) && rest.length === 0 && c.name === "buildPrompt" && c.kind === "callable" && c.change === "changed");
    check("before/after carry the two signatures", c?.before.includes("intent: Intent)") && Boolean(c?.after?.includes("files: File[]")));
  }

  // --- body-only change ----------------------------------------------------
  {
    const patch = ["@@ -1,3 +1,3 @@", " export function square(n: number): number {", "-  return n * n;", "+  return n * 2;", " }"].join("\n");
    const head = "export function square(n: number): number {\n  return n * 2;\n}\n";
    check("body-only change is not a contract change", detectChangedContracts([{ path: "a.ts", status: "modified", patch, headContent: head }]).length === 0);
  }

  // --- removed declaration -------------------------------------------------
  {
    const patch = ["@@ -1,6 +1,2 @@", " export const A = 1;", "-export function legacyHelper(a: string) {", "-  return a;", "-}", " export const B = 2;"].join("\n");
    const head = "export const A = 1;\nexport const B = 2;\n";
    const found = detectChangedContracts([{ path: "util.ts", status: "modified", patch, headContent: head }]);
    check("removed function -> change: removed", found.length === 1 && found[0].name === "legacyHelper" && found[0].change === "removed" && found[0].after === undefined);
    const unreadable = detectChangedContracts([{ path: "util.ts", status: "modified", patch, headContent: undefined }]);
    check("unreadable head: a vanished name is not called removed", unreadable.length === 0);
    const deleted = detectChangedContracts([{ path: "util.ts", status: "removed", patch, headContent: null }]);
    check("deleted file: its declarations are removed", deleted.some((c) => c.name === "legacyHelper" && c.change === "removed"));
  }

  // --- moved within the file, unchanged -------------------------------------
  {
    const patch = ["@@ -1,3 +1,0 @@", "-export function stays(a: number) {", "-  return a;", "-}"].join("\n");
    const head = "const pad = 1;\n\nexport function stays(a: number) {\n  return a;\n}\n";
    check("declaration moved elsewhere in the file, same signature -> nothing", detectChangedContracts([{ path: "m.ts", status: "modified", patch, headContent: head }]).length === 0);
  }

  // --- a type's member changed mid-body (hunk heading names it) ------------
  {
    const patch = ["@@ -20,4 +20,4 @@ export interface ReviewOptions {", "   tokenBudget?: number;", "-  temperature?: number;", "+  temperature: number;", "   chat?: Chat;"].join("\n");
    const found = detectChangedContracts([{ path: "opts.ts", status: "modified", patch }]);
    check("interface member change via hunk heading -> changed type", found.length === 1 && found[0].name === "ReviewOptions" && found[0].kind === "type");
  }

  // --- multi-line signature: only a parameter line changed ------------------
  {
    const patch = [
      "@@ -1,7 +1,7 @@",
      " export async function runPass(",
      "   repoId: string,",
      "-  files: string[]",
      "+  files: string[],",
      "+  log: Logger",
      " ): Promise<void> {",
      "   return;",
    ].join("\n");
    const found = detectChangedContracts([{ path: "pass.ts", status: "modified", patch }]);
    check("parameter added on a continuation line -> changed callable", found.length === 1 && found[0].name === "runPass" && Boolean(found[0].after?.includes("log: Logger")));
  }

  // --- exported constant ---------------------------------------------------
  {
    const patch = ["@@ -1,2 +1,2 @@", "-export const MAX_CHUNKS = 6;", "+export const MAX_CHUNKS = 4;", " export const X = 1;"].join("\n");
    const found = detectChangedContracts([{ path: "k.ts", status: "modified", patch }]);
    check("exported constant change -> changed value", found.length === 1 && found[0].kind === "value" && found[0].name === "MAX_CHUNKS");
  }

  // --- python ----------------------------------------------------------------
  {
    const patch = ["@@ -1,3 +1,3 @@", "-def load(path):", "+def load(path, encoding):", "     return open(path).read()"].join("\n");
    const found = detectChangedContracts([{ path: "io.py", status: "modified", patch }]);
    check("python def signature change detected", found.length === 1 && found[0].name === "load");
  }

  // --- added files have no old contract ------------------------------------
  check("added file -> nothing", detectChangedContracts([{ path: "n.ts", status: "added", patch: "@@ -0,0 +1 @@\n+export function fresh(a: number) {}" }]).length === 0);

  // --- addedLineNumbers --------------------------------------------------------
  {
    const added = addedLineNumbers(["@@ -1,3 +1,4 @@", " a", "-b", "+B", "+C", " d", "@@ -20,2 +21,2 @@", " x", "+y"].join("\n"));
    check("addedLineNumbers: new-file numbers of + lines across hunks", [...added].join(",") === "2,3,22");
  }

  console.log("\nusage filter:");
  {
    const contract: ChangedContract = { name: "buildPrompt", filePath: "lib/ai/prompts.ts", kind: "callable", change: "changed", before: "a", after: "b" };
    const hits = [
      { path: "lib/ai/prompts.ts", line: 3, text: "export function buildPrompt(intent: Intent, files: File[]) {" }, // its own declaration
      { path: "lib/ai/prompts.ts", line: 40, text: "  return buildPrompt(intent);" }, // same file
      { path: "lib/ai/index.ts", line: 2, text: 'export { buildPrompt } from "./prompts";' }, // barrel
      { path: "lib/jobs/a.ts", line: 9, text: "  const p = buildPrompt(intent);" }, // imports the barrel
      { path: "lib/jobs/b.ts", line: 5, text: "  const p = buildPrompt(intent, files);" }, // the PR wrote this line
      { path: "lib/jobs/c.ts", line: 7, text: "  const p = buildPrompt(intent);" }, // imports nothing relevant
      { path: "docs/x.ts", line: 1, text: 'import { buildPrompt } from "@/lib/ai";' }, // import-only line
    ];
    const added = new Map([["lib/jobs/b.ts", new Set([5])]]);
    const imports = new Map<string, Set<string>>([
      ["lib/jobs/a.ts", new Set(["lib/ai/index.ts"])],
      ["lib/jobs/b.ts", new Set(["lib/ai/index.ts"])],
      ["lib/jobs/c.ts", new Set(["lib/other.ts"])],
      ["docs/x.ts", new Set(["lib/ai/index.ts"])],
    ]);
    const kept = untouchedReachableUsages(contract, hits, added, imports).map((h) => `${h.path}:${h.line}`);
    check("keeps same-file and barrel-importing usages only", kept.join(" ") === "lib/ai/prompts.ts:40 lib/jobs/a.ts:9", kept.join(" "));
    const removed = untouchedReachableUsages({ ...contract, change: "removed", after: undefined }, hits, added, imports).map((h) => `${h.path}:${h.line}`);
    check("for a removed declaration, import lines count as usages", removed.includes("docs/x.ts:1"));
    const goContract: ChangedContract = { ...contract, name: "Parse", filePath: "pkg/p/parse.go" };
    const goHits = [{ path: "pkg/p/use.go", line: 4, text: "\tv := Parse(s)" }];
    check("Go: same package directory counts without an import edge", untouchedReachableUsages(goContract, goHits, new Map(), new Map()).length === 1);
  }

  console.log("\nimpact model call (fake chat):");
  const contracts: ImpactContract[] = [
    {
      name: "buildPrompt",
      filePath: "lib/ai/prompts.ts",
      kind: "callable",
      change: "changed",
      before: "export function buildPrompt(intent: Intent)",
      after: "export function buildPrompt(intent: Intent, files: File[])",
      usages: [
        { id: "u1", path: "lib/jobs/a.ts", line: 9, snippet: " 9> const p = buildPrompt(intent);" },
        { id: "u2", path: "lib/jobs/d.ts", line: 3, snippet: " 3> const p = buildPrompt(intent, []);" },
      ],
    },
  ];
  {
    const fake = fakeChat(
      fenced({
        results: [
          { usage: "u1", verdict: "incompatible", reason: "Missing the new files argument." },
          { usage: "u2", verdict: "compatible", reason: "Passes both." },
          { usage: "u99", verdict: "incompatible", reason: "Not a real id." },
          { usage: "u1", verdict: "incompatible", reason: "Duplicate." },
        ],
      })
    );
    const r = await checkImpact(config, contracts, { chat: fake.chat, tokenBudget: 7000 });
    check("one call, both usages checked", r.calls === 1 && r.checked === 2 && r.unchecked === 0);
    check("only incompatible + known ids, deduplicated", r.incompatible.length === 1 && r.incompatible[0].usageId === "u1");
    const user = fake.calls[0][1].content;
    check("prompt carries before/after and numbered usages", user.includes("Before:") && user.includes("files: File[]") && user.includes("Usage u1: lib/jobs/a.ts:9"));
    const unsure = await checkImpact(config, contracts, { chat: fakeChat(fenced({ results: [{ usage: "u1", verdict: "unsure", reason: "?" }] })).chat, tokenBudget: 7000 });
    check("unsure verdicts are dropped", unsure.incompatible.length === 0);
    const garbage = await checkImpact(config, contracts, { chat: fakeChat("no json here").chat, tokenBudget: 7000 });
    check("unparseable answer -> parseFailures counted, nothing reported", garbage.parseFailures === 1 && garbage.incompatible.length === 0);
  }
  {
    const many: ImpactContract[] = Array.from({ length: 8 }, (_, i) => ({
      ...contracts[0],
      name: `fn${i}`,
      usages: Array.from({ length: 40 }, (_, j) => ({ id: `u${i}_${j}`, path: `f${j}.ts`, line: j + 1, snippet: `${"x".repeat(300)} fn${i}()` })),
    }));
    const fake = fakeChat(fenced({ results: [] }));
    const r = await checkImpact(config, many, { chat: fake.chat, tokenBudget: 3000 });
    check(`at most ${MAX_IMPACT_CALLS} calls; the rest counted as unchecked`, r.calls <= MAX_IMPACT_CALLS && r.unchecked > 0 && r.checked + r.unchecked === 320, `calls=${r.calls} checked=${r.checked} unchecked=${r.unchecked}`);
  }

  console.log("\nPR intent call (fake chat):");
  {
    const input = {
      intent: { source: "pull_request" as const, title: "Add retries", body: "Retries failed uploads three times." },
      files: [{ path: "up.ts", status: "modified", additions: 4, deletions: 1, patch: "@@ -1 +1,4 @@\n+retry()" }],
      findings: ["up.ts: adds a retry loop (feature, described, ok)"],
    };
    const fake = fakeChat(fenced({ verdict: "Incomplete", summary: "Retries exist but only once.", rationale: "retry() runs a single time." }));
    const r = await checkPrIntent(config, input, { chat: fake.chat, tokenBudget: 7000 });
    check("alias 'Incomplete' -> partial, summary/rationale kept", r.verdict === "partial" && r.summary.startsWith("Retries") && !r.parseFailed);
    const user = fake.calls[0][1].content;
    check("prompt carries intent, files, findings and diff", user.includes("Title: Add retries") && user.includes("- up.ts (modified, +4/-1)") && user.includes("adds a retry loop") && user.includes("+retry()"));
    const bad = await checkPrIntent(config, input, { chat: fakeChat("sure, looks good").chat, tokenBudget: 7000 });
    check("unparseable -> unknown + parseFailed", bad.verdict === "unknown" && bad.parseFailed);
  }

  console.log("\nmock server + real client:");
  const server = await startMockServer({ port: 0, host: "127.0.0.1", delayMs: 0, log: () => {} });
  try {
    const real: AiProviderConfig = { baseUrl: `${server.url}/v1`, apiKey: "k", model: "mock" };
    const r = await checkImpact(real, [{ ...contracts[0], change: "removed", after: undefined }], { tokenBudget: 7000 });
    check("mock: removed declaration -> every usage incompatible", r.calls === 1 && r.incompatible.length === 2);
    const intent = await checkPrIntent(
      real,
      { intent: { source: "pull_request", title: "Do a thing" }, files: [], findings: [] },
      { tokenBudget: 7000 }
    );
    check("mock: intent check answers delivers", intent.verdict === "delivers" && !intent.parseFailed);
    const partial = await checkPrIntent(
      real,
      { intent: { source: "pull_request", title: "Do a thing MOCK_PARTIAL" }, files: [], findings: [] },
      { tokenBudget: 7000 }
    );
    check("mock: MOCK_PARTIAL -> partial", partial.verdict === "partial");
  } finally {
    await server.close();
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
