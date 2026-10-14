/**
 * The command palette's search (DESIGN.md §6.18): fuzzy matching, the
 * symbol index's tip/head bookkeeping, history and the ranked search over a
 * small repo in a throwaway database.
 *
 *   npx tsx lib/search/smoke-test-search.ts   (npm test sets GRAPHREVIEW_HOME)
 */
import {
  hasSymbolIndex,
  readPaletteHistory,
  recordPalettePick,
  rememberRemote,
  upsertComponent,
  upsertFile,
  upsertRepo,
  linkFileToComponent,
  writeSymbolIndex,
  type RepoRecord,
} from "@/lib/db";
import { fuzzyMatch, fuzzyMatchPath, subsequenceLike } from "./fuzzy";
import { search } from "./server";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  // --- fuzzy -----------------------------------------------------------------
  check("subsequence matches", fuzzyMatch("gvw", "GraphView") !== null);
  check("out of order doesn't", fuzzyMatch("wvg", "GraphView") === null);
  check("substring beats scattered", fuzzyMatch("view", "GraphView")!.score > fuzzyMatch("gvw", "GraphView")!.score);
  check("word start beats mid-word", fuzzyMatch("view", "GraphView")!.score > fuzzyMatch("raph", "GraphView")!.score);
  check("boundary jump falls back when it strands a char", fuzzyMatch("ac", "xaxCxA") !== null);
  const path = fuzzyMatchPath("route", "app/api/search/route.ts");
  check("a path's base name wins", path !== null && path.indexes[0] === "app/api/search/".length, JSON.stringify(path));
  check("LIKE pattern escapes", subsequenceLike("a_%") === "%a%\\_%\\%%");

  // --- a repo --------------------------------------------------------------------
  const repo: RepoRecord = await upsertRepo({
    id: "r1",
    name: "demo",
    provider: "github",
    url: "https://github.com/o/demo",
    defaultBranch: "main",
    lastAnalyzedSha: "tip1",
  } as Parameters<typeof upsertRepo>[0]);
  await upsertComponent({ id: "c-auth", repoId: "r1", name: "Auth", description: "sessions and login", createdBy: "auto", pathPatterns: ["lib/auth/**"], tier: "module" });
  await upsertComponent({ id: "c-ui", repoId: "r1", name: "UI kit", createdBy: "auto", pathPatterns: ["components/ui/**"], tier: "module" });
  for (const p of ["lib/auth/session.ts", "lib/auth/login.ts", "components/ui/button.tsx"]) {
    await upsertFile({ id: `f:${p}`, repoId: "r1", path: p, language: "typescript", loc: 10, lastSeenCommit: "tip1" });
    await linkFileToComponent(`f:${p}`, p.startsWith("lib/auth") ? "c-auth" : "c-ui");
  }
  writeSymbolIndex("r1", "tip1", "tip", [
    { name: "createSession", qualified: "createSession", kind: "function", file: "lib/auth/session.ts", line: 4, exported: true },
    { name: "render", qualified: "Button.render", kind: "method", file: "components/ui/button.tsx", line: 9, exported: false },
  ]);

  // --- index bookkeeping -----------------------------------------------------------
  for (let i = 0; i < 7; i++) writeSymbolIndex("r1", `head${i}`, "head", []);
  check("the tip survives head pruning", hasSymbolIndex("r1", "tip1"));
  check("old heads are pruned", !hasSymbolIndex("r1", "head0") && !hasSymbolIndex("r1", "head1"));
  check("recent heads are kept", hasSymbolIndex("r1", "head6") && hasSymbolIndex("r1", "head2"));
  writeSymbolIndex("r1", "tip2", "tip", []);
  writeSymbolIndex("r1", "tip1", "tip", [
    { name: "createSession", qualified: "createSession", kind: "function", file: "lib/auth/session.ts", line: 4, exported: true },
    { name: "render", qualified: "Button.render", kind: "method", file: "components/ui/button.tsx", line: 9, exported: false },
  ]);

  // --- search ----------------------------------------------------------------------
  const files = await search({ repoId: "r1", q: "sess", scope: "files" }, repo);
  check("files: finds by base name", files.items[0]?.id === "lib/auth/session.ts", JSON.stringify(files.items.map((i) => i.id)));
  check("files: carries the owner", files.items[0]?.componentId === "c-auth");

  const touched = await search({ repoId: "r1", q: "", scope: "files", touched: ["lib/auth/new-file.ts"] }, repo);
  check("files: an added file of the change is searchable", touched.items.some((i) => i.id === "lib/auth/new-file.ts" && i.touched));

  const symbols = await search({ repoId: "r1", q: "crses", scope: "symbols" }, repo);
  check("symbols: fuzzy on the name", symbols.items[0]?.title === "createSession" && symbols.items[0]?.line === 4, JSON.stringify(symbols));
  const method = await search({ repoId: "r1", q: "render", scope: "symbols" }, repo);
  check("symbols: methods by name, qualified title", method.items[0]?.title === "Button.render");
  const head = await search({ repoId: "r1", q: "x", scope: "symbols", targetKey: "pr:7" }, repo);
  check("symbols: an unanalysed head says so", head.notices.some((n) => n.action === "analyse-head"));

  const all = await search({ repoId: "r1", q: "auth", scope: "all", touched: ["lib/auth/login.ts"] }, repo);
  check("all: the component ranks first", all.items[0]?.kind === "component" && all.items[0]?.id === "c-auth", JSON.stringify(all.items.map((i) => i.key)));
  check("all: a touched component is marked", all.items[0]?.touched === true);
  const desc = await search({ repoId: "r1", q: "login", scope: "all" }, repo);
  check("all: components match their description", desc.items.some((i) => i.key === "component:c-auth"));

  rememberRemote("r1", {
    prs: [
      { number: 42, title: "Fix session expiry", state: "open", author: "me", headRef: "fix", baseRef: "main", url: "https://github.com/o/demo/pull/42", updatedAt: "2026-10-01" },
      { number: 7, title: "Old thing", state: "merged", author: "me", headRef: "old", baseRef: "main", url: "https://github.com/o/demo/pull/7", updatedAt: "2026-01-01" },
    ],
    branches: [{ name: "feature/login", commitSha: "abc" }],
  });
  rememberRemote("r1", { prs: [{ number: 43, title: "Another", state: "open", author: null, headRef: "a", baseRef: "main", url: "u", updatedAt: "2026-10-02" }] });
  const refs = await search({ repoId: "r1", q: "", scope: "refs" }, repo);
  check("refs: empty query lists open PRs, merged by number", refs.items.map((i) => i.prNumber).sort().join() === "42,43", JSON.stringify(refs.items.map((i) => i.key)));
  const byNumber = await search({ repoId: "r1", q: "#42", scope: "refs" }, repo);
  check("refs: a number finds its PR", byNumber.items[0]?.prNumber === 42);
  const branch = await search({ repoId: "r1", q: "login", scope: "refs" }, repo);
  check("refs: branches by name", branch.items.some((i) => i.kind === "branch" && i.ref === "feature/login"));

  // --- history -----------------------------------------------------------------------
  recordPalettePick("r1", "file:components/ui/button.tsx", { key: "file:components/ui/button.tsx", kind: "file", id: "components/ui/button.tsx", title: "components/ui/button.tsx", score: 0 });
  recordPalettePick("r1", "file:components/ui/button.tsx", { key: "file:components/ui/button.tsx", kind: "file", id: "components/ui/button.tsx", title: "components/ui/button.tsx", score: 0 });
  check("history counts uses", readPaletteHistory("r1")[0]?.uses === 2);
  const recents = await search({ repoId: "r1", q: "", scope: "all" }, repo);
  check("empty query: recents", recents.recents?.[0]?.key === "file:components/ui/button.tsx");

  const repos = await search({ q: "dem", scope: "all" }, null);
  check("outside a repo: repos", repos.items[0]?.kind === "repo" && repos.items[0]?.id === "r1");

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
