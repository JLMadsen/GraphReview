/**
 * Checks for the chat's structure, history and view tools (lib/jobs/pr-chat.ts,
 * ./chat-lookups.ts): get_callers / get_callees / get_imports from the commit
 * analysis, git_log / blame, the PR map, checklist and CI lookups, and
 * show / highlight / filter_findings, which are resolved to ids and stored on
 * the answer as actions. Real chat turns against a scripted
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
import { createAiProvider, getChatMessage, upsertRepo, writeEnvCatalog, type RepoRecord } from "@/lib/db";
import { EMPTY_ENV_CATALOG, type EnvVar } from "@/lib/analysis/env/types";
import { runChatTurn } from "./pr-chat";

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
    check("the prompt explains the view tools", prompts[start]?.includes("show, highlight and filter_findings change only what is on the reviewer's screen") === true);
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
