/**
 * The diff viewer's model and source (DESIGN.md §6.24) — no network, no AI.
 *
 *   npm test -- diff-viewer
 *
 * Checks the client-side whitespace filter for API patches, the pairing of
 * removed/added lines and their word ranges, mark insertion into
 * highlighted HTML, moved-block detection, split rows, and that the viewer's
 * diff comes from a local `git diff` (renames, `-w`, blob fingerprints)
 * whenever one can run — the host's API only when it can't.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  annotateIntraline,
  ignoreWhitespaceHunks,
  markMovedLines,
  markRanges,
  pairChangedLines,
  splitRows,
  wordDiff,
} from "@/components/graph/diff-model";
import { parseUnifiedDiff } from "@/components/graph/diff-utils";
import type { PullRequestFile } from "@/lib/github";
import { listGitDiffFiles, preferLocalDiff, splitCombinedDiff, type ApiDiff } from "./diff-files";

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(
      `  FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
    );
  }
}

console.log("whitespace filter (API patches):");
{
  const patch = [
    "@@ -1,4 +1,4 @@",
    " function a() {",
    "-return 1;",
    "-  let x = 2;",
    "+  return 1;",
    "+  let x = 3;",
    " }",
    "@@ -10,2 +10,2 @@",
    "-foo(  bar )",
    "+foo(bar)",
    " end",
  ].join("\n");
  const out = ignoreWhitespaceHunks(parseUnifiedDiff(patch));
  check(
    "a hunk with only whitespace changes is dropped",
    out.length === 1,
    out.map((h) => h.header),
  );
  const lines = out[0]?.lines ?? [];
  const reindented = lines.find((l) => l.content === "  return 1;");
  check(
    "a re-indented line becomes context, showing the new text",
    reindented?.type === "context" &&
      reindented.oldLine === 2 &&
      reindented.newLine === 2,
    reindented,
  );
  check(
    "the real change stays a remove/add pair",
    lines.some((l) => l.type === "remove" && l.content === "  let x = 2;") &&
      lines.some((l) => l.type === "add" && l.content === "  let x = 3;"),
  );
  check(
    "line order is kept",
    lines.map((l) => l.type).join(",") === "context,context,remove,add,context",
    lines.map((l) => l.type),
  );
}

console.log("\nword diff pairing:");
{
  const hunks = parseUnifiedDiff(
    [
      "@@ -1,3 +1,3 @@",
      "-const total = price * count;",
      "-unrelated();",
      "+const total = price * qty;",
      "+entirely different line here",
      " x",
    ].join("\n"),
  );
  const pairs = pairChangedLines(hunks[0].lines);
  check(
    "removed and added lines pair positionally within a block",
    JSON.stringify(pairs) === "[[0,2],[1,3]]",
    pairs,
  );
  const diff = wordDiff(
    "const total = price * count;",
    "const total = price * qty;",
  );
  check(
    "only the changed word is marked",
    JSON.stringify(diff) ===
      JSON.stringify({ old: [[22, 27]], new: [[22, 25]] }),
    diff,
  );
  check(
    "lines too different get no word marks",
    wordDiff("unrelated();", "entirely different line here") === null,
  );
  const annotated = annotateIntraline(hunks)[0].lines;
  check(
    "annotation sets ranges on the similar pair only",
    Boolean(annotated[0].ranges && annotated[2].ranges) &&
      !annotated[1].ranges &&
      !annotated[3].ranges,
  );
  const html = '<span class="hljs-keyword">const</span> a = &lt;b&gt;;';
  const marked = markRanges(html, [[3, 11]]);
  check(
    "marks wrap text across a tag and count an entity as one character",
    marked === '<span class="hljs-keyword">con<mark class="diff-word">st</mark></span><mark class="diff-word"> a = &lt;</mark>b&gt;;',
    marked,
  );
}

console.log("\nmoved code and split rows:");
{
  const from = parseUnifiedDiff(
    [
      "@@ -1,5 +1,1 @@",
      " keep",
      "-function helperOne(alpha) {",
      "-  return alpha + 1;",
      "-}",
      "-  // tiny",
    ].join("\n"),
  );
  const to = parseUnifiedDiff(
    [
      "@@ -1,1 +1,4 @@",
      " other",
      "+  function helperOne(alpha) {",
      "+    return alpha + 1;",
      "+  }",
    ].join("\n"),
  );
  const [a, b] = markMovedLines([
    { path: "src/a.ts", hunks: from },
    { path: "src/b.ts", hunks: to },
  ]);
  check(
    "a block moved to another file is marked on both sides",
    a[0].lines.slice(1, 4).every((l) => l.moved) &&
      b[0].lines.slice(1).every((l) => l.moved),
  );
  check(
    "the block start names where it went / came from",
    a[0].lines[1].moved?.path === "src/b.ts" &&
      b[0].lines[1].moved?.path === "src/a.ts" &&
      b[0].lines[1].moved?.line === 2,
    [a[0].lines[1].moved, b[0].lines[1].moved],
  );
  check("a line too short to be a move isn't one", !a[0].lines[4].moved);
  const edit = markMovedLines([
    {
      path: "x",
      hunks: parseUnifiedDiff(
        [
          "@@ -1 +1 @@",
          "-const somethingLongEnough = 1;",
          "+  const somethingLongEnough = 1;",
        ].join("\n"),
      ),
    },
  ]);
  check(
    "a re-indent in place is an edit, not a move",
    !edit[0][0].lines.some((l) => l.moved),
  );
  const rows = splitRows(
    parseUnifiedDiff(
      ["@@ -1,3 +1,2 @@", " a", "-b", "-c", "+B", " d"].join("\n"),
    )[0].lines,
  );
  check(
    "split rows put a block's removes and adds side by side",
    JSON.stringify(rows) ===
      JSON.stringify([
        { left: 0, right: 0 },
        { left: 1, right: 3 },
        { left: 2, right: null },
        { left: 4, right: 4 },
      ]),
    rows,
  );
}

async function gitChecks(): Promise<void> {
console.log("\nlocal git diff preferred over the API patch:");
const root = mkdtempSync(path.join(os.tmpdir(), "graphreview-diff-viewer-"));
try {
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "core.autocrlf=false",
        ...args,
      ],
      { cwd: repo, encoding: "utf8" },
    );
  git("init", "-q");
  const body =
    Array.from(
      { length: 12 },
      (_, i) => `export const value${i} = computeSomething(${i});`,
    ).join("\n") + "\n";
  writeFileSync(path.join(repo, "src", "old name.ts"), body);
  writeFileSync(
    path.join(repo, "src", "spaces.ts"),
    "if (a) {\nreturn b;\n}\n",
  );
  writeFileSync(path.join(repo, "src", "edit.ts"), "one\ntwo\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("mv", "src/old name.ts", "src/new näme.ts");
  writeFileSync(
    path.join(repo, "src", "spaces.ts"),
    "if (a) {\n  return b;\n}\n",
  );
  writeFileSync(path.join(repo, "src", "edit.ts"), "one\nTWO\n");
  git("add", "-A");
  git("commit", "-qm", "head");
  const headSha = git("rev-parse", "HEAD").trim();

  let apiCalls = 0;
  const apiFile: PullRequestFile = {
    filename: "src/edit.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -1,2 +1,2 @@\n one\n-two\n+TWO",
  };
  const fetchApi = async (): Promise<ApiDiff> => {
    apiCalls++;
    return { files: [apiFile], headSha: "f".repeat(40) };
  };
  const spot = { dir: repo, base: "HEAD~1", head: "HEAD", headSha };

  const local = await preferLocalDiff({
    openGit: async () => spot,
    fetchApi,
    ignoreWhitespace: true,
  });
  check(
    "with the commits on disk the diff comes from git",
    local.source === "git" && local.whitespace === "git" && apiCalls === 0,
    { source: local.source, apiCalls },
  );
  const renamed = local.files.find((f) => f.path === "src/new näme.ts");
  check(
    "renames are found, non-ASCII and spaced paths kept",
    renamed?.status === "renamed" && renamed.oldPath === "src/old name.ts",
    renamed,
  );
  const spaces = local.files.find((f) => f.path === "src/spaces.ts");
  check(
    "-w leaves a whitespace-only file without a patch, flagged",
    spaces?.whitespaceOnly === true && !spaces.patch,
    spaces,
  );
  const edit = local.files.find((f) => f.path === "src/edit.ts");
  const blob = git("rev-parse", "HEAD:src/edit.ts").trim();
  check(
    "each file carries its head blob id as the viewed fingerprint",
    edit?.fingerprint === blob && Boolean(edit.patch?.includes("+TWO")),
    edit,
  );

  // Between two commit ids a diff is kept (memo-cache.ts); the kept listing is shared, never written to.
  const shaSpot = { dir: repo, base: git("rev-parse", "HEAD~1").trim(), head: headSha };
  const forEdit = await listGitDiffFiles(shaSpot, { path: "src/edit.ts" });
  const forSpaces = await listGitDiffFiles(shaSpot, { path: "src/spaces.ts" });
  const forEditAgain = await listGitDiffFiles(shaSpot, { path: "src/edit.ts" });
  check(
    "a diff between two commit ids is answered from the cache the second time",
    forEditAgain === forEdit,
  );
  check(
    "each file's answer has only its own patch (the cached listing isn't shared mutably)",
    Boolean(forEdit.find((f) => f.path === "src/edit.ts")?.patch) &&
      !forEdit.find((f) => f.path === "src/spaces.ts")?.patch &&
      Boolean(forSpaces.find((f) => f.path === "src/spaces.ts")?.patch) &&
      !forSpaces.find((f) => f.path === "src/edit.ts")?.patch,
  );

  const one = await preferLocalDiff({
    openGit: async () => spot,
    fetchApi,
    path: "src/spaces.ts",
  });
  check(
    "one file's patch can be asked for alone",
    Boolean(one.files.find((f) => f.path === "src/spaces.ts")?.patch) &&
      !one.files.find((f) => f.path === "src/edit.ts")?.patch,
  );

  const remote = await preferLocalDiff({
    openGit: async () => null,
    fetchApi,
    ignoreWhitespace: true,
  });
  check(
    "with no clone the host's API is used, whitespace left to the viewer",
    remote.source === "api" && remote.whitespace === "client" && apiCalls === 1,
    remote,
  );
  const broken = await preferLocalDiff({
    openGit: async () => ({ ...spot, head: "deadbeef" }),
    fetchApi,
  });
  check(
    "a git failure falls back to the API",
    broken.source === "api" && apiCalls === 2,
  );

  const split = splitCombinedDiff(
    execFileSync(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "-M",
        "--no-color",
        "HEAD~1...HEAD",
      ],
      { cwd: repo, encoding: "utf8" },
    ),
  );
  check(
    "a combined diff splits into one patch per new path",
    split.has("src/edit.ts") &&
      split.has("src/spaces.ts") &&
      !split.has("src/new näme.ts"),
    [...split.keys()],
  );
} finally {
  // A just-exited git can still hold the folder on Windows; leftovers in the temp folder are harmless.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* ignored */
  }
}
}

void gitChecks().then(() => {
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll diff viewer checks passed.");
});
