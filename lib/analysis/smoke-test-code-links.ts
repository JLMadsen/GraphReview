/**
 * Code links (DESIGN.md §6.28): which import specifiers and names a code
 * view makes clickable, where they lead, and where each declaration is used
 * (its usages button and dialog snippets) — built from a small TS + Python
 * + Go repo — and how the viewer finds them on a line (components/graph/
 * code-links.ts: specifier and name boundaries, comments and strings left
 * alone, the highlighter's spans kept intact).
 *
 *   npm test -- code-links
 */
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzeRepo } from "./graph-builder";
import { buildCodeLinks, buildCodeUsages, type CodeLink } from "./code-links";
import { usageBlocks } from "../jobs/code-usages";
import { indexLinks, linkLine } from "../../components/graph/code-links";

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

const FILES: Record<string, string> = {
  "src/db/client.ts": ["export function connect(url: string) {", "  return url;", "}", "", "export class Pool {", "  constructor() {}", "}", ""].join("\n"),
  "src/util/index.ts": ['export * from "./format";', ""].join("\n"),
  "src/util/format.ts": ["export const format = (s: string) => s.trim();", ""].join("\n"),
  "src/app.ts": [
    'import { connect, Pool } from "./db/client";',
    'import * as util from "./util";',
    'import React from "react";',
    "",
    "// connect is called below",
    "export function main() {",
    '  const pool = new Pool();',
    '  const label = "connect";',
    "  helper();",
    '  return connect(util.format(" x "));',
    "}",
    "",
    "function helper() {}",
    "",
  ].join("\n"),
  "py/pkg/__init__.py": "",
  "py/pkg/models.py": ["class User:", "    pass", ""].join("\n"),
  "py/main.py": ["from .pkg.models import User", "", "def run():", "    return User()", ""].join("\n"),
  "go.mod": ["module example.com/app", "", "go 1.22", ""].join("\n"),
  "store/store.go": ["package store", "", "func Open() {}", ""].join("\n"),
  "cmd/main.go": ["package main", "", "import (", '\t"fmt"', '\t"example.com/app/store"', ")", "", "func main() { store.Open(); fmt.Println() }", ""].join("\n"),
};

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphreview-code-links-"));
  try {
    for (const [file, text] of Object.entries(FILES)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), text);
    }
    const result = await analyzeRepo(dir);
    const index = buildCodeLinks(result);
    const linksOf = (file: string) => index.get(file) ?? [];
    const find = (file: string, text: string, kind: CodeLink["kind"]) => linksOf(file).find((l) => l.text === text && l.kind === kind);

    console.log("building");
    const spec = find("src/app.ts", "./db/client", "import");
    check("a relative specifier links to its file, on its import line", spec?.to === "src/db/client.ts" && spec.lines?.join() === "1", JSON.stringify(spec));
    check("a barrel specifier links to the barrel", find("src/app.ts", "./util", "import")?.to === "src/util/index.ts");
    check("a package specifier is not a link", !find("src/app.ts", "react", "import"));
    const connect = find("src/app.ts", "connect", "name");
    check("an imported name leads to its declaration", connect?.to === "src/db/client.ts" && connect.toLine === 1, JSON.stringify(connect));
    check("…on its import line and every use", JSON.stringify(connect?.lines) === JSON.stringify([1, 10]), JSON.stringify(connect?.lines));
    const member = find("src/app.ts", "util.format", "name");
    check("a namespace member goes through the barrel's re-export", member?.to === "src/util/format.ts" && member.toLine === 1, JSON.stringify(member));
    const pool = find("src/app.ts", "Pool", "name");
    check("a constructed class leads to the class (by its name)", pool?.to === "src/db/client.ts" && pool.toLine === 5 && Boolean(pool.lines?.includes(7)), JSON.stringify(pool));
    const helper = find("src/app.ts", "helper", "name");
    check("a call to a function in the same file leads to it", helper?.to === "src/app.ts" && helper.toLine === 13 && Boolean(helper.lines?.includes(9)), JSON.stringify(helper));
    check("a Python relative import links its module", find("py/main.py", ".pkg.models", "import")?.to === "py/pkg/models.py", JSON.stringify(linksOf("py/main.py")));
    const user = find("py/main.py", "User", "name");
    check("a Python imported class leads to it", user?.to === "py/pkg/models.py" && user.toLine === 1, JSON.stringify(user));
    const goImport = linksOf("cmd/main.go").find((l) => l.kind === "import");
    check("a Go import links its package file, with no line facts", goImport?.to === "store/store.go" && goImport.lines === undefined, JSON.stringify(linksOf("cmd/main.go")));

    console.log("usages");
    const usages = buildCodeUsages(result);
    const sitesOf = (id: string) => (usages.usages.get(id) ?? []).map((f) => `${f.file}:${f.lines.join(",")}`);
    const declsOf = (file: string) => (usages.decls.get(file) ?? []).map((d) => `${d.qualified}=${d.usages}`);
    check("an imported function is used where it's called, the import line not counted", JSON.stringify(sitesOf("src/db/client.ts#connect")) === JSON.stringify(["src/app.ts:10"]), JSON.stringify(sitesOf("src/db/client.ts#connect")));
    check("a class's construction counts once for the class", JSON.stringify(sitesOf("src/db/client.ts#Pool")) === JSON.stringify(["src/app.ts:7"]), JSON.stringify(sitesOf("src/db/client.ts#Pool")));
    check("a namespace member's use is named as written", usages.usages.get("src/util/format.ts#format")?.[0]?.names[0] === "util.format", JSON.stringify(usages.usages.get("src/util/format.ts#format")));
    check("a same-file function is used on its call line, not its own", JSON.stringify(sitesOf("src/app.ts#helper")) === JSON.stringify(["src/app.ts:9"]), JSON.stringify(sitesOf("src/app.ts#helper")));
    check("a Python class is used where it's constructed", JSON.stringify(sitesOf("py/pkg/models.py#User")) === JSON.stringify(["py/main.py:4"]), JSON.stringify(sitesOf("py/pkg/models.py#User")));
    check("a file's declarations carry their counts (no constructor of its own)", JSON.stringify(declsOf("src/db/client.ts")) === JSON.stringify(["connect=1", "Pool=1"]), JSON.stringify(declsOf("src/db/client.ts")));
    check("an unused function counts 0", declsOf("src/app.ts").includes("main=0"), JSON.stringify(declsOf("src/app.ts")));
    const twenty = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const blocks = usageBlocks(twenty, [5, 8, 15, 19]);
    check(
      "snippets: 2 lines around each use, close windows merged, cut at the file's end",
      JSON.stringify(blocks.map((b) => [b.from, b.lines.length, b.uses])) === JSON.stringify([[3, 8, [5, 8]], [13, 8, [15, 19]]]),
      JSON.stringify(blocks.map((b) => [b.from, b.lines.length, b.uses]))
    );

    console.log("linking a line");
    const links = indexLinks(linksOf("src/app.ts"));
    const lines = FILES["src/app.ts"].split("\n");
    const on = (n: number, html: string | null = null) => linkLine(lines[n - 1], html, n, links) ?? "";
    const spans = (out: string) => [...out.matchAll(/<span class="code-link" data-link="(\d+)"[^>]*>([^<]*)<\/span>/g)].map((m) => m[2]);
    check("the import line links the names and the specifier", JSON.stringify(spans(on(1))) === JSON.stringify(["connect", "Pool", "./db/client"]), on(1));
    check("a use is linked, the namespace member as one link", JSON.stringify(spans(on(10))) === JSON.stringify(["connect", "util.format"]), on(10));
    check("a line with no link comes back null", linkLine(lines[3], null, 4, links) === null);
    const stringLine = '  const label = "connect";';
    const fake = indexLinks([{ kind: "name", text: "connect", to: "src/db/client.ts", toLine: 1, lines: [8] }]);
    check(
      "a name inside a highlighted string is not a link",
      linkLine(stringLine, '  <span class="hljs-keyword">const</span> label = <span class="hljs-string">&quot;connect&quot;</span>;', 8, fake) === null
    );
    const highlighted = linkLine(
      'import { connect } from "./db/client";',
      '<span class="hljs-keyword">import</span> { connect } <span class="hljs-keyword">from</span> <span class="hljs-string">&quot;./db/client&quot;</span>;',
      1,
      indexLinks([
        { kind: "import", text: "./db/client", to: "src/db/client.ts", lines: [1] },
        { kind: "name", text: "connect", to: "src/db/client.ts", toLine: 1, lines: [1] },
      ])
    );
    check(
      "links go inside the highlighter's spans, which stay balanced",
      Boolean(highlighted?.includes('&quot;<span class="code-link" data-link="0"')) &&
        (highlighted?.match(/<span/g) ?? []).length === (highlighted?.match(/<\/span>/g) ?? []).length,
      highlighted ?? ""
    );
    const goLinks = indexLinks([{ kind: "import", text: "example.com/app/store", to: "store/store.go" }]);
    check("a line-less specifier links when quoted", spans(linkLine('\t"example.com/app/store"', null, 5, goLinks) ?? "").length === 1);
    check("…but not as part of a longer path", linkLine('\t"example.com/app/store/sub"', null, 5, goLinks) === null);
    const partial = indexLinks([{ kind: "name", text: "connect", to: "x.ts", toLine: 1, lines: [1] }]);
    check("a name is not linked inside a longer identifier", linkLine("reconnect(connector)", null, 1, partial) === null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall code-link checks passed");
}

void main();
