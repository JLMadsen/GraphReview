/**
 * Checks for the review's name-based impact pass (lib/jobs/symbol-context.ts):
 * contracts compared declaration by declaration, usages through imports and
 * re-exports, and imports of names that are gone.
 *
 * The fixture replays the three moves behind the impact pass's first false
 * positives (a reviewed PR, 2026-10-06): a function moved to another module
 * and re-exported from the old one (`isPendingJobState`), a file-local
 * function replaced by an alias of an imported one (`statusOf`), and a module
 * moved to another folder with its importers updated (`getActiveAiProvider`).
 * None of them may produce a contract usage or a dead import. A real signature
 * change and a real removal must.
 *
 *   npx tsx lib/jobs/smoke-test-symbol-impact.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeCommit } from "@/lib/analysis";
import {
  blockDiff,
  movedBodyContracts,
  movedCodeChanges,
  newDeadImports,
  symbolContracts,
  symbolCoveredPaths,
  symbolRelatedFiles,
  symbolUsages,
  type TargetAnalyses,
} from "./symbol-context";
import { buildCallGraph } from "@/lib/analysis";
import { changedLinesBetween } from "./target-graph";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

async function main(): Promise<void> {
  const repo = mkdtempSync(path.join(os.tmpdir(), "graphreview-symimpact-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd: repo, stdio: "pipe" }).toString();
  try {
    write(repo, {
      "lib/jobs/queue.ts": "export function isPendingJobState(state: string): boolean {\n  return state === \"waiting\";\n}\n",
      "lib/jobs/review-queue.ts": 'import { isPendingJobState } from "./queue";\nexport const pending = (s: string) => isPendingJobState(s);\n',
      "components/PreviewPanel.tsx": "function statusOf(x: number) {\n  return x > 0;\n}\nexport function Panel() {\n  return statusOf(1);\n}\n",
      "lib/neo4j/ai-provider.ts": "export async function getActiveAiProvider() {\n  return null;\n}\n",
      "lib/jobs/merge-naming.ts": 'import { getActiveAiProvider } from "../neo4j/ai-provider";\nexport async function name() {\n  return getActiveAiProvider();\n}\n',
      "lib/api.ts": "export function fetchUser(id: string) {\n  return id;\n}\nexport function legacy() {\n  return 1;\n}\n",
      "app/page.ts": 'import { fetchUser } from "../lib/api";\nexport function page() {\n  return fetchUser("1");\n}\n',
      "app/old.ts": 'import { legacy } from "../lib/api";\nexport const x = legacy();\n',
      // moved to lib/geo_distance.ts below — and the * 6371 is dropped on the way
      "components/map/map_utils.ts":
        "export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {\n  const a = Math.sin(lat2 - lat1) ** 2 + Math.cos(lng1) * Math.cos(lng2);\n  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));\n}\nexport const keep = 1;\n",
      "app/timeline/page.ts":
        'import { haversineKm } from "../../components/map/map_utils";\nexport function distance() {\n  return haversineKm(1, 2, 3, 4).toFixed(1) + " km";\n}\n',
      // moved unchanged
      "lib/format.ts": "export function title(s: string) {\n  return s.toUpperCase();\n}\n",
      "app/header.ts": 'import { title } from "../lib/format";\nexport const h = () => title("x");\n',
    });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD").trim();

    write(repo, {
      // moved to runner.ts, imported back and re-exported
      "lib/jobs/runner.ts": "export function isPendingJobState(state: string): boolean {\n  return state === \"waiting\";\n}\n",
      "lib/jobs/queue.ts": 'import { isPendingJobState } from "./runner";\nexport { isPendingJobState };\n',
      // local function replaced by an alias of an import
      "lib/preview/compare.ts": "export function symbolStatus(x: number) {\n  return x > 0;\n}\n",
      "components/PreviewPanel.tsx": 'import { symbolStatus } from "../lib/preview/compare";\nconst statusOf = symbolStatus;\nexport function Panel() {\n  return statusOf(1);\n}\n',
      // moved folder, importer updated
      "lib/db/ai-provider.ts": "export async function getActiveAiProvider() {\n  return null;\n}\n",
      "lib/jobs/merge-naming.ts": 'import { getActiveAiProvider } from "../db/ai-provider";\nexport async function name() {\n  return getActiveAiProvider();\n}\n',
      // a real signature change (page.ts not updated) and a real removal (old.ts not updated)
      "lib/api.ts": "export function fetchUser(id: string, withPosts: boolean) {\n  return withPosts ? id : id;\n}\n",
      "components/map/map_utils.ts": "export const keep = 1;\n",
      "lib/geo_distance.ts":
        "export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {\n  const a = Math.sin(lat2 - lat1) ** 2 + Math.cos(lng1) * Math.cos(lng2);\n  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));\n}\n",
      "app/timeline/page.ts":
        'import { haversineKm } from "../../lib/geo_distance";\nexport function distance() {\n  return haversineKm(1, 2, 3, 4).toFixed(1) + " km";\n}\n',
      "lib/format.ts": "export const unrelated = 2;\n",
      "lib/text.ts": "export function title(s: string) {\n  return s.toUpperCase();\n}\n",
      "app/header.ts": 'import { title } from "./../lib/text";\nexport const h = () => title("x");\n',
    });
    unlinkSync(path.join(repo, "lib", "neo4j", "ai-provider.ts"));
    git("add", "-A");
    git("commit", "-q", "-m", "head");
    const headSha = git("rev-parse", "HEAD").trim();

    const [base, head, changed] = await Promise.all([
      analyzeCommit(repo, baseSha),
      analyzeCommit(repo, headSha),
      changedLinesBetween(repo, baseSha, headSha),
    ]);
    const analyses: TargetAnalyses = { base, head, baseSha, headSha, changed, dir: repo };
    const covered = symbolCoveredPaths(analyses, [...changed.keys()]);
    const contracts = symbolContracts(analyses, covered);
    const names = contracts.map((c) => `${c.name}:${c.change}@${c.filePath}`);
    console.log(`  contracts: ${names.join(", ")}`);

    const usagesOf = (name: string, change: "changed" | "removed") =>
      contracts.filter((c) => c.name === name && c.change === change).flatMap((c) => symbolUsages(analyses, c));
    check("isPendingJobState moved + re-exported: no usages", usagesOf("isPendingJobState", "removed").length === 0, JSON.stringify(usagesOf("isPendingJobState", "removed")));
    check("statusOf is file-local: not a contract", !names.some((n) => n.startsWith("statusOf")));
    check("getActiveAiProvider moved, importers updated: no usages", usagesOf("getActiveAiProvider", "removed").length === 0);
    const dead = newDeadImports(analyses);
    check("no dead imports from the three moves", !dead.some((d) => ["isPendingJobState", "getActiveAiProvider", "statusOf"].includes(d.imported)), JSON.stringify(dead));

    const fetchUser = usagesOf("fetchUser", "changed");
    check("fetchUser signature change: page.ts line 3 is an untouched usage", fetchUser.some((u) => u.path === "app/page.ts" && u.line === 3), JSON.stringify(fetchUser));
    check("legacy removed: old.ts imports a name that is gone", dead.some((d) => d.file === "app/old.ts" && d.imported === "legacy" && d.target === "lib/api.ts"), JSON.stringify(dead));

    const related = await symbolRelatedFiles(analyses, ["components/PreviewPanel.tsx"], () => "graph", async (p) => (p === "lib/preview/compare.ts" ? "export function symbolStatus(x: number) {\n  return x > 0;\n}\n" : null), { signatures: true, source: true });
    check("related code: the definition the changed lines use", related.some((f) => f.relation === "defines" && f.path === "lib/preview/compare.ts" && f.snippets.some((s) => s.code.includes("symbolStatus"))), JSON.stringify(related));
    const callers = await symbolRelatedFiles(analyses, ["lib/api.ts"], () => "api", async (p) => (p === "app/page.ts" ? 'import { fetchUser } from "../lib/api";\nexport function page() {\n  return fetchUser("1");\n}\n' : null), { signatures: true, source: true });
    check("related code: callers of what changed", callers.some((f) => f.relation === "caller" && f.path === "app/page.ts"), JSON.stringify(callers));

    // --- moved, and changed on the way --------------------------------------
    const readHead = async (path: string) => {
      try {
        return execFileSync("git", ["show", `${headSha}:${path}`], { cwd: repo, stdio: "pipe" }).toString();
      } catch {
        return null;
      }
    };
    const moved = await movedCodeChanges(analyses, readHead);
    const haversine = moved.find((m) => m.name === "haversineKm");
    check("haversineKm: moved with its body changed", haversine?.changed === "body" && haversine.from === "components/map/map_utils.ts" && haversine.to === "lib/geo_distance.ts", JSON.stringify(moved.map((m) => [m.name, m.changed])));
    check("a move with the same code is not reported", !moved.some((m) => m.name === "title"));
    check("the move diff shows the dropped multiplier", Boolean(haversine && blockDiff(haversine.before, haversine.after).split("\n").some((l) => l.startsWith("-") && l.includes("6371"))));
    const bodyContracts = movedBodyContracts(moved);
    const usages = bodyContracts.filter((c) => c.name === "haversineKm").flatMap((c) => symbolUsages(analyses, c));
    check("the untouched caller is a usage to judge (timeline line 3)", usages.some((u) => u.path === "app/timeline/page.ts" && u.line === 3), JSON.stringify(usages));
    const graph = buildCallGraph(base, head, changed);
    const fn = graph.functions.find((f) => f.id === "lib/geo_distance.ts#haversineKm");
    check("call graph: moved + body, not removed + new", fn?.status === "body" && fn.movedFrom === "components/map/map_utils.ts" && !graph.functions.some((f) => f.id === "components/map/map_utils.ts#haversineKm"), JSON.stringify(fn));
    check("call graph: the caller's call is an existing call", graph.edges.some((e) => e.from === "app/timeline/page.ts#distance" && e.to === "lib/geo_distance.ts#haversineKm" && e.status === "existing"));
    const title = graph.functions.find((f) => f.id === "lib/text.ts#title");
    check("call graph: moved unchanged", title?.status === "moved", JSON.stringify(title));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
