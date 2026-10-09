/**
 * Checks for the PR chat's one write: `add_finding` (lib/jobs/pr-chat.ts).
 * A real chat turn — repo, target, database, provider — against a scripted
 * OpenAI-compatible server that asks to record a finding, then answers.
 *
 *   npx tsx lib/jobs/smoke-test-chat-finding.ts
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
import { createAiProvider, getChatMessage, listFindingsByTargetKey, replaceFindingsForTargetComponent, upsertRepo } from "@/lib/db";
import { addSuggestedFinding, runChatTurn } from "./pr-chat";

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

async function main(): Promise<void> {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "graphreview-chatfinding-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repoDir, stdio: "pipe" }).toString().trim();
  mkdirSync(path.join(repoDir, "lib"), { recursive: true });
  writeFileSync(path.join(repoDir, "lib", "geo.ts"), "export const km = (r: number) => 6371 * r;\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(path.join(repoDir, "lib", "geo.ts"), "export const km = (r: number) => r;\n");
  git("commit", "-q", "-am", "drop the radius");

  // A model that records a finding, then answers.
  const scripted = [
    reply({
      tool: "add_finding",
      args: {
        path: "lib/geo.ts",
        line: 1,
        assessment: "defect",
        summary: "km() no longer multiplies by the Earth's radius",
        rationale: "6371 was dropped, so it returns radians.",
      },
    }),
    reply({ answer: "Added it to the findings." }),
  ];
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
    await upsertRepo({ id: "chat-repo", name: "chat-repo", provider: "local", localPath: repoDir, defaultBranch: "main" });
    const target = { kind: "refs" as const, baseRef: "main", headRef: "feature" };
    const targetKey = "refs:main...feature";

    const answer = await runChatTurn({
      repo: { id: "chat-repo", name: "chat-repo", provider: "local", localPath: repoDir, defaultBranch: "main", createdAt: "" },
      target,
      question: "can you update the findings with this?",
      onEvent: () => undefined,
    });
    check("the turn answers", answer.content === "Added it to the findings.", answer.content);
    check("the step says what was added", answer.steps?.some((s) => s.summary.startsWith("added a defect finding")) === true, JSON.stringify(answer.steps));
    check("the prompt explains when to use add_finding", prompts[0]?.includes("add_finding is the only tool that changes anything") === true);

    const findings = await listFindingsByTargetKey("chat-repo", targetKey);
    const added = findings.find((f) => f.category === "chat");
    check("a chat finding is stored", added?.summary === "km() no longer multiplies by the Earth's radius" && added.assessment === "defect", JSON.stringify(findings));
    check("it points at the file and line", added?.filePath === "lib/geo.ts" && added.lineRange === "1");
    check("it is stamped with the reviewed head", Boolean(added?.reviewedHeadSha && /^[0-9a-f]{40}$/.test(added.reviewedHeadSha)));

    // A re-review replaces `change` findings per component — never `chat` ones.
    await replaceFindingsForTargetComponent("chat-repo", targetKey, added?.componentId ?? "", []);
    const after = await listFindingsByTargetKey("chat-repo", targetKey);
    check("a re-review leaves it alone", after.some((f) => f.id === added?.id));

    // Asking again doesn't duplicate it.
    scripted.push(
      reply({ tool: "add_finding", args: { path: "lib/geo.ts", summary: "km() no longer multiplies by the Earth's radius", rationale: "again" } }),
      reply({ answer: "It was already there." })
    );
    await runChatTurn({
      repo: { id: "chat-repo", name: "chat-repo", provider: "local", localPath: repoDir, defaultBranch: "main", createdAt: "" },
      target,
      question: "add it again",
      onEvent: () => undefined,
    });
    const again = (await listFindingsByTargetKey("chat-repo", targetKey)).filter((f) => f.category === "chat");
    check("the same finding isn't added twice", again.length === 1, String(again.length));

    // Unasked, the model offers a finding: stored on the answer, not in the review.
    const offer = {
      path: "lib/geo.ts",
      line: 1,
      assessment: "concern",
      summary: "km() has no test for the radius",
      rationale: "Nothing would have caught the dropped 6371.",
    };
    scripted.push(
      reply({ tool: "suggest_finding", args: offer }),
      reply({ tool: "suggest_finding", args: offer }),
      reply({ tool: "suggest_finding", args: { path: "lib/geo.ts", summary: "km() no longer multiplies by the Earth's radius" } }),
      reply({ answer: "It converts radians to km. I also noticed it has no test." })
    );
    const promptsBefore = prompts.length;
    const explained = await runChatTurn({
      repo: { id: "chat-repo", name: "chat-repo", provider: "local", localPath: repoDir, defaultBranch: "main", createdAt: "" },
      target,
      question: "what does km do?",
      onEvent: () => undefined,
    });
    check("the prompt allows suggesting unasked", prompts[promptsBefore]?.includes("suggest_finding needs no request") === true);
    check("the answer carries one suggestion", explained.suggestions?.length === 1, JSON.stringify(explained.suggestions));
    const suggestion = explained.suggestions?.[0];
    check(
      "the suggestion keeps the file, line and head",
      suggestion?.filePath === "lib/geo.ts" && suggestion.line === 1 && suggestion.status === "pending" && Boolean(suggestion.reviewedHeadSha)
    );
    const unchanged = (await listFindingsByTargetKey("chat-repo", targetKey)).filter((f) => f.category === "chat");
    check("suggesting doesn't touch the review", unchanged.length === 1, String(unchanged.length));
    const stored = await getChatMessage("chat-repo", explained.id);
    check("the suggestion survives a reload", stored?.suggestions?.[0]?.id === suggestion?.id);

    const added2 = stored && suggestion ? await addSuggestedFinding(stored, suggestion.id) : undefined;
    const withSuggestion = (await listFindingsByTargetKey("chat-repo", targetKey)).filter((f) => f.category === "chat");
    check("Add puts it in the review", withSuggestion.some((f) => f.id === added2?.findingId && f.summary === offer.summary));
    check("the suggestion is marked added", added2?.message.suggestions?.[0]?.status === "added");
    const addedAgain = added2 ? await addSuggestedFinding(added2.message, suggestion!.id) : undefined;
    const afterTwice = (await listFindingsByTargetKey("chat-repo", targetKey)).filter((f) => f.category === "chat");
    check("adding twice adds once", addedAgain?.findingId === added2?.findingId && afterTwice.length === 2, String(afterTwice.length));
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
