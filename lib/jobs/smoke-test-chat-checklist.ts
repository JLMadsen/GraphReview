/**
 * Checks for the PR chat's agent loop and the checklist's AI answer parsing
 * (DESIGN.md §6.6, §6.7) against a fake model — no network, no Neo4j.
 *
 *   npx tsx lib/jobs/smoke-test-chat-checklist.ts
 */
import { answerChecklist, parsePrChatReply, runPrChat, PR_CHAT_MAX_STEPS } from "@/lib/ai";
import type { ChatMessage, ChatCompletionResult } from "@/lib/ai";
import { matchesPathPattern } from "./checklist";

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const config = { baseUrl: "http://fake", apiKey: "x", model: "fake-model" };
const fence = (obj: unknown) => ["```json", JSON.stringify(obj), "```"].join("\n");

/** A fake chat that replays scripted replies and records what it was sent. */
function fakeChat(replies: string[]) {
  const sent: ChatMessage[][] = [];
  const chat = async (_c: unknown, messages: ChatMessage[]): Promise<ChatCompletionResult> => {
    sent.push(messages);
    const content = replies[Math.min(sent.length - 1, replies.length - 1)];
    return { content, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
  };
  return { chat: chat as never, sent };
}

async function main(): Promise<void> {
  console.log("reply parsing");
  check("tool call", parsePrChatReply(fence({ tool: "get_diff", args: { path: "a.ts" } })).kind === "tool");
  const answer = parsePrChatReply(fence({ answer: "It adds `x`." }));
  check("answer", answer.kind === "answer" && answer.answer === "It adds `x`.");
  const flat = parsePrChatReply(fence({ tool: "get_diff", path: "a.ts" }));
  check("args next to tool", flat.kind === "tool" && flat.args.path === "a.ts", JSON.stringify(flat));
  const named = parsePrChatReply(fence({ tool: "search_code", arguments: { query: "foo" } }));
  check("args under 'arguments'", named.kind === "tool" && named.args.query === "foo");
  const asString = parsePrChatReply(fence({ tool: "read_file", args: '{"path":"b.ts"}' }));
  check("args as a JSON string", asString.kind === "tool" && asString.args.path === "b.ts", JSON.stringify(asString));
  const plain = parsePrChatReply("Just a plain sentence.");
  check("plain text is the answer", plain.kind === "answer" && plain.answer === "Just a plain sentence.");

  console.log("agent loop");
  {
    const { chat, sent } = fakeChat([
      fence({ tool: "get_diff", args: { path: "app/map/page.tsx" } }),
      fence({ answer: "It renders the map." }),
    ]);
    const ran: string[] = [];
    const result = await runPrChat(
      config,
      { context: "Title: Map", history: [], question: "What does it do?", tools: [{ name: "get_diff", args: "{}", description: "" }] },
      async (name, args) => {
        ran.push(`${name}:${String(args.path)}`);
        return { text: "+ <Map />", summary: "read the diff", files: ["app/map/page.tsx"], componentIds: ["c1"] };
      },
      { chat }
    );
    check("runs the requested tool", ran.join() === "get_diff:app/map/page.tsx", ran.join());
    check("returns the answer", result.answer === "It renders the map.");
    check("records the step", result.steps.length === 1 && result.steps[0].summary === "read the diff");
    check("collects files and components", result.files[0] === "app/map/page.tsx" && result.componentIds[0] === "c1");
    check("feeds the tool result back", sent[1].some((m) => m.role === "user" && m.content.includes("+ <Map />")));
    check("PR context in the system message", sent[0][0].role === "system" && sent[0][0].content.includes("Title: Map"));
  }
  {
    const { chat, sent } = fakeChat([fence({ tool: "nope", args: {} })]);
    const result = await runPrChat(
      config,
      { context: "", history: [], question: "q", tools: [{ name: "get_diff", args: "{}", description: "" }] },
      async () => ({ text: "", summary: "" }),
      { chat }
    );
    check(`stops after ${PR_CHAT_MAX_STEPS} lookups`, sent.length === PR_CHAT_MAX_STEPS + 1, String(sent.length));
    check("unknown tool is reported, not run", result.steps.every((s) => s.summary === "unknown tool nope"));
    check("still answers", result.answer.length > 0);
  }

  console.log("checklist answers");
  {
    const { chat, sent } = fakeChat([
      fence({
        answers: [
          { id: "q1", status: "pass", rationale: "The description says why." },
          { id: "q2", status: "maybe", rationale: "?" },
          { id: "q9", status: "fail", rationale: "not asked" },
        ],
      }),
    ]);
    const result = await answerChecklist(
      config,
      {
        intent: { source: "pull_request", title: "Add map", body: "Because users asked." },
        files: [{ path: "app/map/page.tsx", additions: 3, deletions: 1, patch: "+ map" }],
        findings: [],
        questions: [
          { id: "q1", question: "Explains why?" },
          { id: "q2", question: "No unrelated changes?" },
        ],
      },
      { chat }
    );
    check("keeps known ids only", result.answers.map((a) => a.id).join() === "q1,q2");
    check("pass stays pass", result.answers[0].status === "pass");
    check("unrecognised status becomes unknown", result.answers[1].status === "unknown");
    check("diff is in the prompt", sent[0][1].content.includes("+ map"));
  }

  console.log("protected path patterns");
  check("dir/** matches inside", matchesPathPattern("db/migrations/001.sql", "db/migrations/**"));
  check("dir/** not a sibling", !matchesPathPattern("db/migrations-old/x.sql", "db/migrations/**"));
  check("*.ext", matchesPathPattern("app/schema.prisma", "*.prisma"));
  check("exact", matchesPathPattern("package.json", "package.json") && !matchesPathPattern("a/package.json", "package.json"));

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
