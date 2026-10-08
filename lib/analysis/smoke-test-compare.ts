/**
 * Checks for comparing a change's base and head (lib/analysis/compare.ts):
 * new import cycles, orphaned files, dependents, and the call graph's
 * function/call statuses — on a two-commit git fixture.
 *
 *   npx tsx lib/analysis/smoke-test-compare.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCallGraph, compareStructure, parseChangedLines } from "./compare";
import { analyzeCommit } from "./graph-builder";

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
  const repo = mkdtempSync(path.join(os.tmpdir(), "graphreview-compare-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd: repo, stdio: "pipe" }).toString();
  try {
    // --- base -----------------------------------------------------------------
    write(repo, {
      "src/a.ts": 'import { b } from "./b";\nexport function a(x: number) {\n  return b(x);\n}\n',
      "src/b.ts": "export function b(x: number) {\n  return x + 1;\n}\n",
      "src/c.ts": 'import { a } from "./a";\nexport function c() {\n  return a(1);\n}\n',
      "src/d.ts": 'import type { T } from "./e";\nexport const d = 1;\nexport type U = T;\n',
      "src/e.ts": "export type T = number;\n",
      "src/old.ts": "export function oldThing() {\n  return 1;\n}\n",
      "src/user-of-old.ts": 'import { oldThing } from "./old";\nexport function useOld() {\n  return oldThing();\n}\n',
      "src/p.ts": 'import { q } from "./q";\nexport const p = () => q();\n',
      "src/q.ts": 'import { p } from "./p";\nexport const q = () => 1;\nexport const pq = () => p();\n',
      "src/caller.ts": 'import { b } from "./b";\nexport function caller() {\n  return b(2);\n}\n',
    });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD").trim();

    // --- head -----------------------------------------------------------------
    write(repo, {
      // b now imports a: a -> b -> a (a runtime cycle)
      "src/b.ts": 'import { a } from "./a";\nexport function b(x: number, y = 0) {\n  return x + y;\n}\nexport function viaA() {\n  return a(0);\n}\n',
      // c's body changes and it calls a new helper
      "src/c.ts": 'import { a } from "./a";\nexport function c() {\n  return a(2) + extra();\n}\nfunction extra() {\n  return 3;\n}\n',
      // e now imports d only for a type: d <-> e is type-only, not a runtime cycle
      "src/e.ts": 'import type { U } from "./d";\nexport type T = number;\nexport type V = U;\n',
      // user-of-old stops importing old: old is orphaned
      "src/user-of-old.ts": "export function useOld() {\n  return 2;\n}\n",
      // p and q already looped at the base; a new import between them isn't a new cycle
      "src/p.ts": 'import { q, pq } from "./q";\nexport const p = () => q() + pq();\n',
    });
    unlinkSync(path.join(repo, "src", "caller.ts"));
    write(repo, { "src/caller2.ts": 'import { b } from "./b";\nexport function caller2() {\n  return b(3);\n}\n' });
    git("add", "-A");
    git("commit", "-q", "-m", "head");
    const headSha = git("rev-parse", "HEAD").trim();

    const [base, head] = await Promise.all([analyzeCommit(repo, baseSha), analyzeCommit(repo, headSha)]);
    const changed = parseChangedLines(git("diff", "-U0", "--no-renames", baseSha, headSha));

    console.log("changed lines");
    check("modified file has added and removed lines", (changed.get("src/b.ts")?.added.size ?? 0) > 0 && (changed.get("src/b.ts")?.removed.size ?? 0) > 0);
    check("deleted file keeps its removed lines", (changed.get("src/caller.ts")?.removed.size ?? 0) === 4, JSON.stringify([...(changed.get("src/caller.ts")?.removed ?? [])]));
    check("added file has only added lines", (changed.get("src/caller2.ts")?.added.size ?? 0) === 4);

    console.log("structure");
    const structure = compareStructure(base, head, [...changed.keys()]);
    check("a <-> b is a new cycle", structure.newCycles.some((c) => c.id === "src/a.ts|src/b.ts"), JSON.stringify(structure.newCycles));
    check("the type-only loop d <-> e is not", !structure.newCycles.some((c) => c.id.includes("src/e.ts")));
    check("p <-> q looped already at the base", !structure.newCycles.some((c) => c.id.includes("src/p.ts")));
    check("closing edge is the new import", structure.newCycles.find((c) => c.id === "src/a.ts|src/b.ts")?.closingEdge.from === "src/b.ts");
    check("old.ts is orphaned", structure.orphaned.includes("src/old.ts"), JSON.stringify(structure.orphaned));
    check("added edge b -> a", structure.addedEdges.some((e) => e.from === "src/b.ts" && e.to === "src/a.ts"));
    check("removed edge user-of-old -> old", structure.removedEdges.some((e) => e.from === "src/user-of-old.ts" && e.to === "src/old.ts"));
    check("dependents of the change counted", structure.dependents.count >= 1, String(structure.dependents.count));

    console.log("call graph");
    const graph = buildCallGraph(base, head, changed);
    const fn = (id: string) => graph.functions.find((f) => f.id === id);
    check("b: signature changed", fn("src/b.ts#b")?.status === "signature", JSON.stringify(fn("src/b.ts#b")));
    check("b: both signatures kept", fn("src/b.ts#b")?.signatureBefore === "function b(x: number)" && fn("src/b.ts#b")?.signatureAfter === "function b(x: number, y = 0)");
    check("c: body changed", fn("src/c.ts#c")?.status === "body");
    check("extra, viaA, caller2: added", ["src/c.ts#extra", "src/b.ts#viaA", "src/caller2.ts#caller2"].every((id) => fn(id)?.status === "added"));
    check("caller: removed", fn("src/caller.ts#caller")?.status === "removed");
    check("a: unchanged neighbour, included", fn("src/a.ts#a")?.status === "unchanged");
    const edge = (from: string, to: string) => graph.edges.find((e) => e.from === from && e.to === to);
    check("c -> extra is a new call", edge("src/c.ts#c", "src/c.ts#extra")?.status === "new");
    check("caller -> b is a removed call", edge("src/caller.ts#caller", "src/b.ts#b")?.status === "removed");
    check("a -> b calls the changed signature, line untouched: not updated", edge("src/a.ts#a", "src/b.ts#b")?.notUpdated === true, JSON.stringify(edge("src/a.ts#a", "src/b.ts#b")));
    check("caller2 -> b was written by the change: not flagged", edge("src/caller2.ts#caller2", "src/b.ts#b")?.notUpdated === undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
