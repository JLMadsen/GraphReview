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
import { impactChange, impactReasons, impactSymbol } from "@/components/graph/review-visuals";
import type { GrepHit } from "./head-source";
import { impactFindings, untouchedReachableUsages } from "./impact";

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

  console.log("\nremoved vs moved:");
  {
    const removed = (name: string, filePath: string): ChangedContract => ({ name, filePath, kind: "callable", change: "removed", before: `export function ${name}()` });
    const keep = (contract: ChangedContract, hits: GrepHit[], imports: Record<string, string[]>, contents: Record<string, string | null>) =>
      untouchedReachableUsages(
        contract,
        hits,
        new Map(),
        new Map(Object.entries(imports).map(([k, v]) => [k, new Set(v)])),
        new Map(Object.entries(contents))
      ).map((h) => `${h.path}:${h.line}`);

    // Moved to runner.ts; queue.ts imports it back and re-exports it.
    const pending = removed("isPendingJobState", "lib/jobs/queue.ts");
    const pendingHits: GrepHit[] = [
      { path: "lib/jobs/queue.ts", line: 1, text: 'import { isPendingJobState } from "./runner";' },
      { path: "lib/jobs/queue.ts", line: 2, text: "export { isPendingJobState };" },
      { path: "lib/jobs/runner.ts", line: 4, text: "export function isPendingJobState(state: string): boolean {" },
      { path: "app/api/jobs/route.ts", line: 1, text: 'import { isPendingJobState } from "@/lib/jobs/queue";' },
      { path: "app/api/jobs/route.ts", line: 9, text: "  if (isPendingJobState(job.state)) return;" },
      { path: "lib/jobs/watch.ts", line: 6, text: "  return queue.isPendingJobState(s);" }, // namespace import
    ];
    const pendingContents = {
      "lib/jobs/queue.ts": 'import { isPendingJobState } from "./runner";\nexport { isPendingJobState };\n',
      "lib/jobs/runner.ts": "export const X = 1;\n\nexport function isPendingJobState(state: string): boolean {\n  return true;\n}\n",
      "app/api/jobs/route.ts": 'import { isPendingJobState } from "@/lib/jobs/queue";\n',
      "lib/jobs/watch.ts": 'import * as queue from "./queue";\n',
    };
    const pendingImports = { "app/api/jobs/route.ts": ["lib/jobs/queue.ts"], "lib/jobs/watch.ts": ["lib/jobs/queue.ts"] };
    check(
      "moved + re-exported from the old module -> no usage reported",
      keep(pending, pendingHits, pendingImports, pendingContents).length === 0,
      keep(pending, pendingHits, pendingImports, pendingContents).join(" ")
    );
    const dropped = { ...pendingContents, "lib/jobs/queue.ts": 'import { isPendingJobState } from "./runner";\n' };
    check(
      "moved but the old module no longer re-exports -> its importers are reported",
      keep(pending, pendingHits, pendingImports, dropped).join(" ") === "app/api/jobs/route.ts:1 app/api/jobs/route.ts:9 lib/jobs/watch.ts:6",
      keep(pending, pendingHits, pendingImports, dropped).join(" ")
    );

    // A file-local function moved to its own module and imported back.
    const latest = removed("latestReviewedRevision", "app/api/repos/[repoId]/review/route.ts");
    const latestHits: GrepHit[] = [
      { path: "app/api/repos/[repoId]/review/route.ts", line: 3, text: "  latestReviewedRevision," },
      { path: "app/api/repos/[repoId]/review/route.ts", line: 40, text: "  const rev = latestReviewedRevision(findings);" },
      { path: "lib/jobs/review-freshness.ts", line: 2, text: "export function latestReviewedRevision(findings: Finding[]) {" },
    ];
    const latestContents = {
      "app/api/repos/[repoId]/review/route.ts": 'import {\n  isFresh,\n  latestReviewedRevision,\n} from "@/lib/jobs/review-freshness";\n',
      "lib/jobs/review-freshness.ts": "\nexport function latestReviewedRevision(findings: Finding[]) {\n}\n",
    };
    check("file-local function moved and imported back (multi-line import) -> nothing", keep(latest, latestHits, {}, latestContents).length === 0);

    // Moved to another module; callers' imports updated, call sites untouched (graph still has the old edge).
    const provider = removed("getActiveAiProvider", "lib/neo4j/ai-provider.ts");
    const providerHits: GrepHit[] = [
      { path: "lib/db/ai-provider.ts", line: 5, text: "export async function getActiveAiProvider() {" },
      { path: "lib/jobs/review.ts", line: 120, text: "  const ai = await getActiveAiProvider();" },
      { path: "lib/jobs/stale.ts", line: 30, text: "  const ai = await getActiveAiProvider();" },
    ];
    const providerContents = {
      "lib/neo4j/ai-provider.ts": null,
      "lib/db/ai-provider.ts": "import x from 'y';\n\n\n\nexport async function getActiveAiProvider() {\n}\n",
      "lib/jobs/review.ts": 'import { getActiveAiProvider } from "@/lib/db/ai-provider";\n',
      "lib/jobs/stale.ts": 'import { getActiveAiProvider } from "../neo4j/ai-provider";\n',
    };
    const providerImports = { "lib/jobs/review.ts": ["lib/neo4j/ai-provider.ts"], "lib/jobs/stale.ts": ["lib/neo4j/ai-provider.ts"] };
    const providerKept = keep(provider, providerHits, providerImports, providerContents);
    check("moved with updated imports -> only the caller still importing the old path", providerKept.join(" ") === "lib/jobs/stale.ts:30", providerKept.join(" "));

    // A function replaced by a local alias.
    const status = removed("statusOf", "components/graph/PreviewPanel.tsx");
    const statusHits: GrepHit[] = [
      { path: "components/graph/PreviewPanel.tsx", line: 12, text: "const statusOf = symbolStatus;" },
      { path: "components/graph/PreviewPanel.tsx", line: 80, text: "  const s = statusOf(symbol);" },
    ];
    check(
      "function -> const alias -> nothing",
      keep(status, statusHits, {}, { "components/graph/PreviewPanel.tsx": 'import { symbolStatus } from "./status";\n\nconst statusOf = symbolStatus;\n' }).length === 0
    );

    // A real removal is still reported, at its local and imported usages.
    const legacy = removed("legacyHelper", "lib/util.ts");
    const legacyHits: GrepHit[] = [
      { path: "lib/util.ts", line: 20, text: "  return legacyHelper(a);" },
      { path: "lib/b.ts", line: 4, text: "  legacyHelper(x);" },
    ];
    const legacyKept = keep(legacy, legacyHits, { "lib/b.ts": ["lib/util.ts"] }, {
      "lib/util.ts": "export const A = 1;\n",
      "lib/b.ts": 'import { legacyHelper } from "./util";\n',
    });
    check("genuine removal -> local and importing usages still reported", legacyKept.join(" ") === "lib/util.ts:20 lib/b.ts:4", legacyKept.join(" "));
  }

  console.log("\nmoved and changed:");
  {
    const oldPatch = ["@@ -1,4 +1,1 @@", " export const A = 1;", "-export function loadConfig(path: string) {", "-  return read(path);", "-}"].join("\n");
    const oldHead = "export const A = 1;\n";
    const newHead = "export function loadConfig(path: string, env: Env) {\n  return read(path, env);\n}\n";
    const newPatch = "@@ -0,0 +1,3 @@\n+export function loadConfig(path: string, env: Env) {\n+  return read(path, env);\n+}";
    const found = detectChangedContracts([
      { path: "lib/old.ts", status: "modified", patch: oldPatch, headContent: oldHead },
      { path: "lib/config/load.ts", status: "added", patch: newPatch, headContent: newHead },
    ]);
    const removedOld = found.find((c) => c.filePath === "lib/old.ts");
    const moved = found.find((c) => c.filePath === "lib/config/load.ts");
    check("removed from the old file is still reported as removed", removedOld?.change === "removed");
    check(
      "and the new file gets a changed contract with movedFrom",
      moved?.change === "changed" && moved.movedFrom === "lib/old.ts" && moved.before.includes("(path: string)") && Boolean(moved.after?.includes("env: Env")),
      JSON.stringify(moved)
    );

    const sameHead = "export function loadConfig(path: string) {\n  return read(path);\n}\n";
    const unchanged = detectChangedContracts([
      { path: "lib/old.ts", status: "modified", patch: oldPatch, headContent: oldHead },
      { path: "lib/config/load.ts", status: "added", patch: "@@ -0,0 +1,3 @@\n+x", headContent: sameHead },
    ]);
    check("moved unchanged -> only the removal", unchanged.length === 1 && unchanged[0].change === "removed");

    // A same-named declaration the diff didn't write (an unrelated old one) is not the moved one.
    const other = detectChangedContracts([
      { path: "lib/old.ts", status: "modified", patch: oldPatch, headContent: oldHead },
      { path: "lib/other.ts", status: "modified", patch: "@@ -10,1 +10,1 @@\n-x\n+y", headContent: newHead },
    ]);
    check("pre-existing same-named declaration elsewhere -> not paired", other.length === 1 && other[0].change === "removed");

    // Usages: the caller importing the new path is checked against the changed contract, not the removal.
    const hits: GrepHit[] = [
      { path: "lib/config/load.ts", line: 1, text: "export function loadConfig(path: string, env: Env) {" },
      { path: "app/start.ts", line: 8, text: "  const cfg = loadConfig(file);" },
      { path: "app/legacy.ts", line: 3, text: "  loadConfig(file);" },
    ];
    const contents = new Map<string, string | null>([
      ["lib/old.ts", oldHead],
      ["lib/config/load.ts", newHead],
      ["app/start.ts", 'import { loadConfig } from "@/lib/config/load";\n'],
      ["app/legacy.ts", 'import { loadConfig } from "../lib/old";\n'],
    ]);
    // The analysed graph predates the PR: both callers still point at the old file, the new one isn't in it.
    const graph = new Map([["app/start.ts", new Set(["lib/old.ts"])], ["app/legacy.ts", new Set(["lib/old.ts"])]]);
    const keptMoved = untouchedReachableUsages(moved!, hits, new Map(), graph, contents).map((h) => h.path);
    const keptRemoved = untouchedReachableUsages(removedOld!, hits, new Map(), graph, contents).map((h) => h.path);
    check("changed contract: the caller importing the new file is kept", keptMoved.join(" ") === "app/start.ts", keptMoved.join(" "));
    check("removal: only the caller still importing the old file is kept", keptRemoved.join(" ") === "app/legacy.ts", keptRemoved.join(" "));
  }

  console.log("\nchanged contracts resolve through imports:");
  {
    const contract: ChangedContract = { name: "formatDate", filePath: "lib/report/format.ts", kind: "callable", change: "changed", before: "a", after: "b" };
    const hits: GrepHit[] = [
      { path: "lib/report/format.ts", line: 2, text: "export function formatDate(d: Date, tz: string) {" },
      { path: "lib/dates.ts", line: 1, text: "export function formatDate(d: Date) {" },
      { path: "lib/report/index.ts", line: 1, text: 'export { formatDate } from "./format";' },
      { path: "app/a.ts", line: 5, text: "  formatDate(now);" }, // imports the unrelated lib/dates.ts
      { path: "app/b.ts", line: 6, text: "  formatDate(now);" }, // through the report barrel
      { path: "app/c.ts", line: 7, text: "  formatDate(now);" }, // a package — the graph decides
      { path: "app/d.go", line: 4, text: "\tformatDate(now)" }, // no import parsing — the graph decides
    ];
    const contents = new Map<string, string | null>([
      ["lib/report/format.ts", "\nexport function formatDate(d: Date, tz: string) {\n}\n"],
      ["lib/dates.ts", "export function formatDate(d: Date) {\n}\n"],
      ["lib/report/index.ts", 'export { formatDate } from "./format";\n'],
      ["app/a.ts", 'import { formatDate } from "@/lib/dates";\n'],
      ["app/b.ts", 'import { formatDate } from "@/lib/report";\n'],
      ["app/c.ts", 'import { formatDate } from "date-utils";\n'],
      ["app/d.go", "package app\n"],
    ]);
    // The graph links app/a.ts to lib/dates.ts, which mentions the name — it used to count as a provider.
    const graph = new Map([
      ["app/a.ts", new Set(["lib/dates.ts"])],
      ["app/c.ts", new Set<string>()],
      ["app/d.go", new Set(["lib/report/format.ts"])],
    ]);
    const kept = untouchedReachableUsages(contract, hits, new Map(), graph, contents).map((h) => h.path);
    check(
      "drops the caller of a same-named declaration elsewhere; keeps barrel callers without a graph edge; falls back to the graph",
      kept.join(" ") === "app/b.ts app/d.go",
      kept.join(" ")
    );
  }

  console.log("\nfindings per caller file:");
  {
    const contract: ChangedContract = { name: "isPendingJobState", filePath: "lib/jobs/queue.ts", kind: "callable", change: "removed", before: "x" };
    const other: ChangedContract = { ...contract, name: "loadConfig", filePath: "lib/config/load.ts", change: "changed", before: "loadConfig(a)", after: "loadConfig(a, b)", movedFrom: "lib/old.ts" };
    const base = { prId: "p", model: "m", createdAt: "t", reviewedBaseSha: "b", reviewedHeadSha: "h", reviewedAt: "t" };
    const findings = impactFindings(
      [
        { contract, path: "app/route.ts", line: 9, reason: "Still calls the removed helper." },
        { contract, path: "app/route.ts", line: 1, reason: "Imports it from queue." },
        { contract, path: "app/route.ts", line: 9, reason: "Duplicate." },
        { contract, path: "app/other.ts", line: 4, reason: "Calls it." },
        { contract: other, path: "app/route.ts", line: 20, reason: "Missing b." },
      ],
      new Map([["app/route.ts", "comp-1"]]),
      base
    );
    check("one finding per contract per caller file", findings.length === 3, String(findings.length));
    const route = findings.find((f) => f.filePath === "app/route.ts" && f.summary.includes("isPendingJobState"))!;
    check("anchored at the first line, summary counts the rest", route.lineRange === "1" && route.summary.endsWith("(and 1 more place in this file)") && route.componentId === "comp-1", route.summary);
    const asDto = (f: typeof route) => ({ category: "impact" as const, summary: f.summary, rationale: f.rationale });
    check("UI still reads the symbol and the change", impactSymbol(asDto(route)) === "isPendingJobState" && impactChange(asDto(route)) === "was removed from lib/jobs/queue.ts", impactChange(asDto(route)) ?? "null");
    check("UI reads one reason per line", impactReasons(asDto(route)).join(" | ") === "Imports it from queue. | Still calls the removed helper.");
    const single = findings.find((f) => f.filePath === "app/other.ts")!;
    check("single line keeps the old wording", single.rationale.includes("but this line was not edited") && impactReasons(asDto(single)).join() === "Calls it.");
    const movedFinding = findings.find((f) => f.summary.includes("loadConfig"))!;
    check("moved + changed is worded as a move", impactChange(asDto(movedFinding))?.startsWith("moved from lib/old.ts to lib/config/load.ts and changed from") === true, movedFinding.rationale);
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
