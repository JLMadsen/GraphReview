/**
 * Checks for names across files (lib/analysis/symbols.ts and the extractors
 * in lib/analysis/syntax/), and for analysing a commit from git
 * (lib/analysis/source-tree.ts) with the parse cache.
 *
 *   npx tsx lib/analysis/smoke-test-symbols.ts
 *
 * Writes small fixture repos into a temp folder; the git part needs `git`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeCommit, analyzeRepo, type CachedParse, type ParseCache } from "./graph-builder";
import type { SymbolGraph } from "./symbols";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

const hasCall = (g: SymbolGraph, from: string, to: string) => g.calls.some((c) => c.from === from && c.to === to);
const findUse = (g: SymbolGraph, file: string, target: string) => g.uses.find((u) => u.file === file && u.target === target);
const callList = (g: SymbolGraph) => g.calls.map((c) => `${c.from} -> ${c.to}`).join("\n    ");

async function main(): Promise<void> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "graphreview-symbols-"));
  try {
    // --- TypeScript / JavaScript ------------------------------------------
    console.log("typescript");
    const ts = path.join(tmp, "ts");
    writeTree(ts, {
      "src/a.ts": [
        "export function foo(x: number): string {",
        "  return helper(x);",
        "}",
        "function helper(n: number) { return String(n); }",
        "export class Svc {",
        "  static make() { return new Svc(); }",
        "  run() { return this.step(); }",
        "  step() { return 1; }",
        "}",
        "export const LIMIT = 5;",
        "export type Shape = { a: string };",
      ].join("\n"),
      "src/b.ts": "export const bar = () => 1;\nexport default function Def() { return 2; }\n",
      "src/index.ts": 'export { foo as renamed } from "./a";\nexport * from "./b";\n',
      "src/c.ts": [
        'import { renamed, bar } from "./index";',
        'import Def from "./b";',
        'import * as A from "./a";',
        'import type { Shape } from "./a";',
        'import { gone } from "./a";',
        'import { x } from "./legacy";',
        "",
        "export function main(s: Shape) {",
        "  renamed(1);",
        "  bar();",
        "  A.foo(2);",
        "  Def();",
        "  return A.LIMIT + x + gone;",
        "}",
      ].join("\n"),
      "src/types-only.ts": 'import type { Shape } from "./a";\nexport const s: Shape | null = null;\n',
      "src/legacy.js": "module.exports = { x: 1 };\n",
      "src/view.tsx": 'import { foo } from "./a";\nexport function View() { return <Panel label={foo(1)} />; }\nfunction Panel(p: { label: string }) { return <b>{p.label}</b>; }\n',
    });
    const tsResult = await analyzeRepo(ts);
    const tg = tsResult.symbols;
    check("declarations: foo, helper, Svc + methods, LIMIT, Shape", ["src/a.ts#foo", "src/a.ts#helper", "src/a.ts#Svc", "src/a.ts#Svc.run", "src/a.ts#Svc.step", "src/a.ts#LIMIT", "src/a.ts#Shape"].every((id) => tg.decls.some((d) => d.id === id)));
    const foo = tg.decls.find((d) => d.id === "src/a.ts#foo");
    check("function signature stops at the body", foo?.signature === "function foo(x: number): string", foo?.signature);
    check("renamed re-export resolves to foo", findUse(tg, "src/c.ts", "src/a.ts#foo")?.lines.includes(9) === true, JSON.stringify(tg.uses.filter((u) => u.file === "src/c.ts")));
    check("export * re-export resolves to bar", findUse(tg, "src/c.ts", "src/b.ts#bar") !== undefined);
    check("default import resolves to the named default function", findUse(tg, "src/c.ts", "src/b.ts#Def") !== undefined);
    check("namespace member use A.LIMIT", findUse(tg, "src/c.ts", "src/a.ts#LIMIT")?.lines.includes(13) === true);
    check("type-only use is marked", findUse(tg, "src/c.ts", "src/a.ts#Shape")?.typeOnly === true);
    check("import lines are not usage lines", !(findUse(tg, "src/c.ts", "src/a.ts#foo")?.lines.includes(1) ?? true));
    check("calls: foo -> helper", hasCall(tg, "src/a.ts#foo", "src/a.ts#helper"), callList(tg));
    check("calls: this.step()", hasCall(tg, "src/a.ts#Svc.run", "src/a.ts#Svc.step"));
    check("calls: renamed() through the barrel", hasCall(tg, "src/c.ts#main", "src/a.ts#foo"));
    check("calls: namespace A.foo()", tg.calls.filter((c) => c.from === "src/c.ts#main" && c.to === "src/a.ts#foo").length === 2);
    check("calls: JSX <Panel/> is a call", hasCall(tg, "src/view.tsx#View", "src/view.tsx#Panel"));
    check("dead import: gone", tg.deadImports.some((d) => d.file === "src/c.ts" && d.imported === "gone" && d.target === "src/a.ts"), JSON.stringify(tg.deadImports));
    check("CommonJS module is not called dead", !tg.deadImports.some((d) => d.imported === "x"));
    check("type-only file edge", tsResult.edges.some((e) => e.from === "src/types-only.ts" && e.to === "src/a.ts" && e.typeOnly === true));
    check("runtime edge c -> a is not type-only", tsResult.edges.some((e) => e.from === "src/c.ts" && e.to === "src/a.ts" && !e.typeOnly));
    check("edge weight counts use lines", (tsResult.edges.find((e) => e.from === "src/c.ts" && e.to === "src/a.ts")?.weight ?? 0) >= 3);

    // --- Python -------------------------------------------------------------
    console.log("python");
    const py = path.join(tmp, "py");
    writeTree(py, {
      "pkg/__init__.py": "from .core import run as start\nfrom . import util\n",
      "pkg/core.py": [
        "def run(x):",
        "    return helper(x)",
        "",
        "def helper(y):",
        "    return y",
        "",
        "class K:",
        "    def m(self):",
        "        return self.n()",
        "    def n(self):",
        "        return 1",
      ].join("\n"),
      "pkg/util.py": "def tool():\n    return 0\n",
      "main.py": [
        "from pkg import start, util",
        "import pkg.core as core",
        "from pkg.core import missing",
        "",
        "def go():",
        "    start(1)",
        "    util.tool()",
        "    return core.K()",
      ].join("\n"),
    });
    const pg = (await analyzeRepo(py)).symbols;
    check("package re-export: start -> core.run", findUse(pg, "main.py", "pkg/core.py#run") !== undefined, JSON.stringify(pg.uses));
    check("submodule binding: util.tool", findUse(pg, "main.py", "pkg/util.py#tool") !== undefined);
    check("calls: go -> run", hasCall(pg, "main.py#go", "pkg/core.py#run"), callList(pg));
    check("calls: go -> util.tool", hasCall(pg, "main.py#go", "pkg/util.py#tool"));
    check("calls: run -> helper", hasCall(pg, "pkg/core.py#run", "pkg/core.py#helper"));
    check("calls: self.n()", hasCall(pg, "pkg/core.py#K.m", "pkg/core.py#K.n"));
    check("dead import: missing", pg.deadImports.some((d) => d.imported === "missing"));

    // --- Java + Kotlin --------------------------------------------------------
    console.log("java / kotlin");
    const jvm = path.join(tmp, "jvm");
    writeTree(jvm, {
      "core/src/main/java/com/acme/a/Util.java": [
        "package com.acme.a;",
        "public class Util {",
        "  public static String fmt(int x) { return helper(x); }",
        "  private static String helper(int y) { return \"\" + y; }",
        "}",
      ].join("\n"),
      "core/src/main/java/com/acme/b/User.java": [
        "package com.acme.b;",
        "import com.acme.a.Util;",
        "public class User {",
        "  String name() { return Util.fmt(1); }",
        "  void touch() { name(); this.name(); }",
        "}",
      ].join("\n"),
      "core/src/main/kotlin/com/acme/k/Strings.kt": [
        "package com.acme.k",
        "",
        "fun shout(s: String): String = s.uppercase()",
        "",
        "class Box {",
        "    fun open() = close()",
        "    fun close() {}",
        "}",
      ].join("\n"),
      "core/src/main/kotlin/com/acme/k/App.kt": [
        "package com.acme.k",
        "",
        "import com.acme.a.Util",
        "",
        "fun main() {",
        "    shout(Util.fmt(2))",
        "    Box().open()",
        "}",
      ].join("\n"),
    });
    const jg = (await analyzeRepo(jvm)).symbols;
    const userJava = "core/src/main/java/com/acme/b/User.java";
    const utilJava = "core/src/main/java/com/acme/a/Util.java";
    const appKt = "core/src/main/kotlin/com/acme/k/App.kt";
    const stringsKt = "core/src/main/kotlin/com/acme/k/Strings.kt";
    check("java static call Util.fmt()", hasCall(jg, `${userJava}#User.name`, `${utilJava}#Util.fmt`), callList(jg));
    check("java implicit-this call name()", hasCall(jg, `${userJava}#User.touch`, `${userJava}#User.name`));
    check("java private static helper()", hasCall(jg, `${utilJava}#Util.fmt`, `${utilJava}#Util.helper`));
    check("java type use through an import", findUse(jg, userJava, `${utilJava}#Util`) !== undefined);
    check("kotlin same-package top-level call", hasCall(jg, `${appKt}#main`, `${stringsKt}#shout`));
    check("kotlin -> java static call", hasCall(jg, `${appKt}#main`, `${utilJava}#Util.fmt`));
    check("kotlin method calls its sibling", hasCall(jg, `${stringsKt}#Box.open`, `${stringsKt}#Box.close`));
    const shout = jg.decls.find((d) => d.id === `${stringsKt}#shout`);
    check("kotlin signature stops at '='", shout?.signature === "fun shout(s: String): String", shout?.signature);

    // --- A commit, from git -------------------------------------------------
    console.log("git commit + cache");
    const repo = path.join(tmp, "git");
    writeTree(repo, {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": 'import { a } from "./a";\nexport const b = a;\n',
      "media/clip.ts": Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 0, 0]),
      ".gitignore": "generated/\n",
    });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, stdio: "pipe" }).toString().trim();
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    const sha = git("rev-parse", "HEAD");
    writeTree(repo, {
      "src/uncommitted.ts": 'import { b } from "./b";\n',
      "generated/big.ts": "export const g = 1;\n",
    });
    const entries = new Map<string, CachedParse>();
    let sets = 0;
    const cache: ParseCache = {
      async getMany(keys) {
        return new Map(keys.filter((k) => entries.has(k)).map((k) => [k, entries.get(k)!]));
      },
      async setMany(items) {
        for (const [key, value] of items) entries.set(key, value);
        sets += items.length;
      },
    };
    const first = await analyzeCommit(repo, sha, { cache });
    check("only committed files", first.files.map((f) => f.file).join(",") === "src/a.ts,src/b.ts", first.files.map((f) => f.file).join(","));
    check("binary .ts skipped", first.skipped.binary === 1, JSON.stringify(first.skipped));
    check("edge b -> a from the commit", first.edges.some((e) => e.from === "src/b.ts" && e.to === "src/a.ts"));
    check("parses were cached", sets === 2 && first.cached === 0, `sets=${sets} cached=${first.cached}`);
    const second = await analyzeCommit(repo, sha, { cache });
    check("second run reads the cache", second.cached === 2, String(second.cached));
    check("cached result resolves the same", second.symbols.uses.some((u) => u.file === "src/b.ts" && u.target === "src/a.ts#a"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
