/**
 * Checks for the chat's structure, history and view tools (lib/jobs/pr-chat.ts,
 * ./chat-lookups.ts): get_callers / get_callees / get_imports from the commit
 * analysis, git_log / blame, the PR map, checklist and CI lookups, and
 * show / highlight / filter_findings / switch_view / open_diff, which are
 * resolved to ids and stored on the answer as actions, the answer's
 * point_to / next stops (offered, never applied), the screen note, and
 * triage_finding with its Apply. Real chat turns against a scripted
 * OpenAI-compatible server; each tool's result is read back from the next
 * request the model gets.
 *
 *   npx tsx lib/jobs/smoke-test-chat-tools.ts
 *
 * Run with GRAPHREVIEW_HOME pointing at a scratch folder (`npm test` does).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { encrypt } from "@/lib/crypto";
import { createAiProvider, getChatMessage, getFindingById, listChatMessages, upsertFinding, upsertRepo, writeEnvCatalog, type RepoRecord } from "@/lib/db";
import { EMPTY_ENV_CATALOG, type EnvVar } from "@/lib/analysis/env/types";
import { applyChatTriage, runChatTurn } from "./pr-chat";
import { reviewTargetKey } from "./review-queue";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const FENCE = "```";
const reply = (value: unknown) => `${FENCE}json\n${JSON.stringify(value)}\n${FENCE}`;

/** The tool result the model was handed in one request: the last user message. */
function lastResult(body: string | undefined): string {
  if (!body) return "";
  const messages = (JSON.parse(body) as { messages: Array<{ role: string; content: string }> }).messages;
  return messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
}

async function main(): Promise<void> {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "graphreview-chattools-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=Tess", ...args], { cwd: repoDir, stdio: "pipe" }).toString().trim();
  mkdirSync(path.join(repoDir, "lib"), { recursive: true });
  mkdirSync(path.join(repoDir, "app"), { recursive: true });
  writeFileSync(
    path.join(repoDir, "lib", "geo.ts"),
    "export function toKm(r: number) {\n  return 6371 * r;\n}\n\nexport function km(r: number) {\n  return toKm(r);\n}\n"
  );
  writeFileSync(path.join(repoDir, "app", "page.ts"), 'import { km } from "../lib/geo";\n\nexport function Page() {\n  return km(2);\n}\n');
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(
    path.join(repoDir, "lib", "geo.ts"),
    "export function toKm(r: number) {\n  return r;\n}\n\nexport function km(r: number) {\n  return toKm(r);\n}\n"
  );
  git("commit", "-q", "-am", "drop the radius");

  const scripted: string[] = [];
  const prompts: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      prompts.push(body);
      const content = scripted.shift() ?? reply({ answer: "done" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    await createAiProvider({ name: "scripted", baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEncrypted: encrypt("x"), model: "scripted-model" });
    const repo: RepoRecord = { id: "tools-repo", name: "tools-repo", provider: "local", localPath: repoDir, defaultBranch: "main", createdAt: "" };
    await upsertRepo(repo);
    const target = { kind: "refs" as const, baseRef: "main", headRef: "feature" };

    // Turn 1: the read tools.
    scripted.push(
      reply({ tool: "get_callers", args: { name: "km" } }),
      reply({ tool: "get_callees", args: { name: "km", path: "lib/geo.ts" } }),
      reply({ tool: "get_imports", args: { path: "lib/geo.ts" } }),
      reply({ tool: "git_log", args: { path: "lib/geo.ts" } }),
      reply({ tool: "blame", args: { path: "lib/geo.ts", start: 1, end: 3 } }),
      reply({ tool: "get_pr_map", args: {} }),
      reply({ tool: "get_ci_status", args: {} }),
      reply({ answer: "Looked." })
    );
    let start = prompts.length;
    const first = await runChatTurn({ repo, target, question: "who uses km?", onEvent: () => undefined });
    check("the read turn answers", first.content === "Looked.", first.content);
    check("the prompt prefers the structure tools", prompts[start]?.includes("prefer get_callers and get_imports") === true);
    const callers = lastResult(prompts[start + 1]);
    check("get_callers finds the call in Page", callers.includes("app/page.ts:4 in Page"), callers);
    const callees = lastResult(prompts[start + 2]);
    check("get_callees finds toKm", callees.includes("line 6: toKm (function, lib/geo.ts:1-3)"), callees);
    const imports = lastResult(prompts[start + 3]);
    check("get_imports lists the importer", /Imported by \(1\):\n- app\/page\.ts/.test(imports), imports);
    const log = lastResult(prompts[start + 4]);
    check("git_log lists the file's commits, newest first", /drop the radius[\s\S]*base/.test(log) && log.includes("Tess"), log);
    const blame = lastResult(prompts[start + 5]);
    check("blame puts line 2 on the feature commit", /drop the radius — lines 2\b/.test(blame) && /base — lines 1, 3/.test(blame), blame);
    const map = lastResult(prompts[start + 6]);
    check("get_pr_map lists the changed file in an area", map.includes("lib/geo.ts (") && map.includes("Areas"), map);
    const ci = lastResult(prompts[start + 7]);
    check("get_ci_status explains a local repo has none", ci.includes("Local repos have no CI"), ci);
    check("the steps say what each lookup did", first.steps.some((s) => s.summary.startsWith("found the callers of km")), JSON.stringify(first.steps.map((s) => s.summary)));
    check("a read-only turn has no actions", !first.actions, JSON.stringify(first.actions));

    // A path lookup: a URL-like query, its {id} segment skipped.
    scripted.push(reply({ tool: "find_files", args: { query: "/lib/{id}/geo" } }), reply({ answer: "Found." }));
    start = prompts.length;
    await runChatTurn({ repo, target, question: "where is /lib/{id}/geo?", onEvent: () => undefined });
    const found = lastResult(prompts[start + 1]);
    check("find_files skips the {id} segment and finds lib/geo.ts", /1 file\(s\)[^\n]*\n- lib\/geo\.ts/.test(found), found);

    // Turn 2: the view tools.
    scripted.push(
      reply({ tool: "show", args: { kind: "file", name: "lib/geo.ts", line: 2 } }),
      reply({ tool: "show", args: { kind: "component", name: "no-such-thing" } }),
      reply({ tool: "highlight", args: { components: ["nope"] } }),
      reply({ tool: "filter_findings", args: { assessment: ["defect", "ok"] } }),
      reply({ tool: "show", args: { kind: "function", name: "Page" } }),
      reply({ tool: "get_checklist", args: {} }),
      reply({ answer: "On screen." })
    );
    start = prompts.length;
    const second = await runChatTurn({ repo, target, question: "show me", onEvent: () => undefined });
    check("the prompt says which tools move the screen", prompts[start]?.includes("show, switch_view, open_diff, highlight, filter_findings MOVE the reviewer's screen") === true);
    check("the prompt asks for point_to and next", prompts[start]?.includes("point_to") === true && prompts[start]?.includes("next when there is one obvious place") === true);
    check("a bad component is refused with a hint", lastResult(prompts[start + 2]).includes('No component matches "no-such-thing"'));
    check("a highlight with nothing known is refused", lastResult(prompts[start + 3]).includes("None of nope is a component"));
    const actions = second.actions ?? [];
    check("three actions are stored on the answer", actions.length === 3, JSON.stringify(actions));
    check(
      "show file keeps the line",
      actions[0]?.kind === "show" && actions[0].target === "file" && actions[0].id === "lib/geo.ts" && actions[0].line === 2,
      JSON.stringify(actions[0])
    );
    check(
      "filter maps ok onto the fine bucket",
      actions[1]?.kind === "filter" && JSON.stringify(actions[1].buckets) === '["defect","fine"]',
      JSON.stringify(actions[1])
    );
    check(
      "a function the change doesn't touch opens its file at the declaration",
      actions[2]?.kind === "show" && actions[2].target === "file" && actions[2].id === "app/page.ts" && actions[2].line === 3,
      JSON.stringify(actions[2])
    );
    const checklist = lastResult(prompts[start + 6]);
    check("get_checklist reports each item's status", /\[(pass|fail|unknown|pending|not_applicable)\]/.test(checklist) || checklist.includes("no items"), checklist);
    const stored = await getChatMessage(repo.id, second.id);
    check("the actions survive a reload", stored?.actions?.length === 3);

    // Turn 3: views, the file viewer, offered stops, the screen note.
    scripted.push(
      reply({ tool: "switch_view", args: { view: "infra", mode: "diagram", changed_only: true } }),
      reply({ tool: "switch_view", args: { view: "app", mode: "diagram" } }),
      reply({ tool: "open_diff", args: { path: "lib/geo.ts:2-3" } }),
      reply({ tool: "open_diff", args: { path: "lib/geo.ts", tab: "preview", symbol: "toKm" } }),
      reply({
        answer: "Here.",
        point_to: [{ kind: "file", name: "lib/geo.ts", line: 2 }, { kind: "component", name: "nothing-like-it" }, { kind: "file", name: "lib/geo.ts:2" }],
        next: { kind: "function", name: "km", why: "the only caller of toKm" },
      })
    );
    start = prompts.length;
    const third = await runChatTurn({ repo, target, question: "and the infra?", screen: "App map by modules; card \"lib\" selected", onEvent: () => undefined });
    check("the screen note reaches the model", lastResult(prompts[start]).includes('On the reviewer\'s screen: App map by modules; card "lib" selected'), lastResult(prompts[start]));
    check("a mode the view hasn't is refused", lastResult(prompts[start + 2]).includes("App map has no modes"), lastResult(prompts[start + 2]));
    const views = third.actions ?? [];
    check(
      "switch_view keeps the mode and the toggle",
      views[0]?.kind === "view" && views[0].view === "infra" && views[0].mode === "diagram" && views[0].changedOnly === true && !views[0].offer,
      JSON.stringify(views[0])
    );
    check(
      "open_diff reads the lines off the path",
      views[1]?.kind === "file" && views[1].tab === "diff" && views[1].lines === "2-3" && views[1].path === "lib/geo.ts",
      JSON.stringify(views[1])
    );
    check(
      "a Before / after preview is only offered",
      views[2]?.kind === "file" && views[2].tab === "preview" && views[2].symbol === "toKm" && views[2].offer === true,
      JSON.stringify(views[2])
    );
    const offers = views.filter((a) => a.offer && a.kind === "show");
    check(
      "point_to becomes offered stops; an unknown one and a repeat are dropped",
      offers.length === 2 && offers[0].kind === "show" && offers[0].id === "lib/geo.ts" && offers[0].line === 2 && offers[0].next === undefined,
      JSON.stringify(offers)
    );
    const next = views.find((a) => a.next !== undefined);
    check(
      "next is an offered stop with its reason (a function without a call graph opens at its declaration)",
      next?.kind === "show" && next.target === "file" && next.line === 5 && next.next === "the only caller of toKm" && next.offer === true,
      JSON.stringify(next)
    );
    const asked = await listChatMessages(repo.id, reviewTargetKey(target));
    check("the screen note is stored on the question", asked.some((m) => m.role === "user" && m.screen?.startsWith("App map by modules")) === true);

    // Turn 4: triage — an Ask about a finding, verdicts, Apply.
    const key = reviewTargetKey(target);
    const finding = await upsertFinding({
      id: "f0e1d2c3-0000-4000-8000-000000000001",
      repoId: repo.id,
      targetKey: key,
      componentId: "",
      category: "change",
      filePath: "lib/geo.ts",
      lineRange: "2",
      summary: "toKm no longer converts to km",
      assessment: "concern",
      confidence: 0.8,
      rationale: "The radius is gone.",
      model: "m",
    });
    const other = await upsertFinding({
      id: "a9b8c7d6-0000-4000-8000-000000000002",
      repoId: repo.id,
      targetKey: key,
      componentId: "",
      category: "change",
      filePath: "app/page.ts",
      summary: "Page renders km",
      assessment: "unknown",
      confidence: 0.5,
      rationale: "Unclear.",
      model: "m",
    });
    scripted.push(
      reply({ tool: "get_findings", args: {} }),
      reply({ tool: "triage_finding", args: { id: "#f0e1d2c3", verdict: "rerate", assessment: "defect", reason: "Every caller gets radians now." } }),
      reply({ tool: "triage_finding", args: { id: "#a9b8c7d6", verdict: "wrong", reason: "Page only passes a number through." } }),
      reply({ tool: "triage_finding", args: { id: "#a9b8c7d6", verdict: "holds", reason: "again" } }),
      reply({ tool: "triage_finding", args: { id: "#zzzz", verdict: "holds", reason: "x" } }),
      reply({ tool: "show", args: { kind: "finding", name: "#f0e1d2c3" } }),
      reply({ answer: "It's worse than the review says." })
    );
    start = prompts.length;
    const fourth = await runChatTurn({ repo, target, question: "Does this finding hold up?", findingId: finding.id, onEvent: () => undefined });
    check("the asked-about finding reaches the model", lastResult(prompts[start]).includes("The question is about this finding of the review:\n#f0e1d2c3"), lastResult(prompts[start]));
    check("get_findings shows each finding's #id", lastResult(prompts[start + 1]).includes("#a9b8c7d6 [unknown"), lastResult(prompts[start + 1]));
    check("a second verdict on the same finding is refused", lastResult(prompts[start + 4]).includes("already gave a verdict"), lastResult(prompts[start + 4]));
    check("an unknown #id is refused with a hint", lastResult(prompts[start + 5]).includes("No finding #zzzz"), lastResult(prompts[start + 5]));
    const triage = fourth.triage ?? [];
    check("two verdicts are stored", triage.length === 2 && triage[0].verdict === "rerate" && triage[0].assessment === "defect" && triage[1].verdict === "wrong", JSON.stringify(triage));
    check(
      "show finding resolves the #id",
      fourth.actions?.[0]?.kind === "show" && fourth.actions[0].target === "finding" && fourth.actions[0].id === finding.id,
      JSON.stringify(fourth.actions)
    );
    const userTurn = (await listChatMessages(repo.id, key)).find((m) => m.role === "user" && m.findingId);
    check("the question keeps the finding it was about", userTurn?.findingId === finding.id);
    const afterRate = await applyChatTriage(fourth, triage[0].id);
    const rated = await getFindingById(finding.id);
    check(
      "Apply re-rates the finding and says why",
      rated?.assessment === "defect" && rated.responses?.at(-1)?.author === "chat" && rated.responses.at(-1)?.body.startsWith("Re-rated concern → defect") === true,
      JSON.stringify(rated)
    );
    check("…and marks the verdict applied", afterRate?.triage?.[0]?.status === "applied");
    await applyChatTriage(afterRate!, triage[1].id);
    const resolved = await getFindingById(other.id);
    check("Apply on wrong answers and resolves the finding", Boolean(resolved?.resolvedAt) && resolved?.responses?.at(-1)?.kind === "answered", JSON.stringify(resolved));

    // The repo chat: no change, so the change-only tools say so.
    scripted.push(reply({ tool: "filter_findings", args: { assessment: "defect" } }), reply({ answer: "ok" }));
    start = prompts.length;
    const repoTurn = await runChatTurn({ repo, target: null, question: "filter", onEvent: () => undefined });
    check("the repo chat has no filter_findings", lastResult(prompts[start + 1]).includes('Unknown tool "filter_findings"'), lastResult(prompts[start + 1]));
    check("…and stores no actions", !repoTurn.actions);

    // show env: the Env view at a name, matched like the other kinds.
    writeEnvCatalog(repo.id, "0".repeat(40), { ...EMPTY_ENV_CATALOG, vars: [{ name: "DATABASE_URL", reads: [], decls: [], sets: [], tags: [] } as unknown as EnvVar] });
    scripted.push(reply({ tool: "show", args: { kind: "env var", name: "${database_url}" } }), reply({ tool: "show", args: { kind: "env", name: "NOPE" } }), reply({ answer: "ok" }));
    start = prompts.length;
    const envTurn = await runChatTurn({ repo, target: null, question: "where is the db url", onEvent: () => undefined });
    check(
      "show env opens the variable",
      envTurn.actions?.[0]?.kind === "show" && envTurn.actions[0].target === "env" && envTurn.actions[0].id === "DATABASE_URL",
      JSON.stringify(envTurn.actions)
    );
    check("an unknown env var is refused with a hint", lastResult(prompts[start + 2]).includes('No env var matches "NOPE"'), lastResult(prompts[start + 2]));
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(repoDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  // exitCode, not exit(): exiting while sockets close trips a libuv assertion on Windows.
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
