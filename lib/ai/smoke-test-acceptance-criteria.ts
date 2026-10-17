/**
 * Smoke test for acceptance criteria (DESIGN.md §6.27).
 *
 *   npm test -- acceptance
 *
 * Part A: the deterministic parser — checkbox lists, Given/When/Then
 * blocks, lists under an "Acceptance criteria" / "AC" / "Definition of
 * done" heading or label, a description with none, dedup across the PR and
 * its linked issues, code fences and template comments skipped.
 * Part B: the per-criterion round trip through the real mock server and the
 * real client: the intent call's prompt carries the criteria, and every
 * criterion comes back with a verdict, evidence checked against the diff.
 */
import { checkPrIntent, PR_INTENT_TASK_MARKER } from "./pr-intent";
import { parseAcceptanceCriteria, parseCriteriaFromText } from "./acceptance-criteria";
import { startMockServer } from "./mock-server";
import type { chatCompletion } from "./client";
import type { AiProviderConfig } from "./types";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function partA(): void {
  console.log("Part A — parsing");

  const boxes = parseCriteriaFromText(
    ["Adds retries.", "", "- [ ] Retries 3 times", "* [x] Logs each retry", "  - [ ] with the attempt number", "- not a criterion"].join("\n"),
    "description"
  );
  check("checkbox: two criteria", boxes.length === 2, JSON.stringify(boxes));
  check("checkbox: ticked state kept", boxes[0]?.ticked === false && boxes[1]?.ticked === true);
  check("checkbox: nested item folded into its parent", boxes[1]?.text === "Logs each retry — with the attempt number", boxes[1]?.text);
  check("checkbox: format", boxes.every((c) => c.format === "checkbox"));

  const gherkin = parseCriteriaFromText(
    [
      "Scenario: wrong password",
      "**Given** a registered user",
      "When they enter a wrong password",
      "Then they see an error",
      "And the attempt is logged",
      "",
      "Given a locked account",
      "When they log in",
      "Then they are told to reset",
      "",
      "Some closing prose.",
    ].join("\n"),
    "#7"
  );
  check("gherkin: two blocks", gherkin.length === 2, JSON.stringify(gherkin));
  check(
    "gherkin: scenario title and all lines kept",
    gherkin[0]?.text === "Scenario: wrong password\nGiven a registered user\nWhen they enter a wrong password\nThen they see an error\nAnd the attempt is logged",
    gherkin[0]?.text
  );
  check("gherkin: format and source", gherkin.every((c) => c.format === "gherkin" && c.source === "#7"));

  const fenced = parseCriteriaFromText(["```gherkin", "Given a cart", "When I pay", "Then I get a receipt", "```"].join("\n"), "description");
  check("gherkin: inside a ```gherkin fence", fenced.length === 1 && fenced[0].text.startsWith("Given a cart"), JSON.stringify(fenced));

  const heading = parseCriteriaFromText(
    [
      "## Summary",
      "- Refactors the client",
      "## Acceptance Criteria",
      "1. Export button downloads a CSV",
      "2) The CSV has a header row",
      "   - with column names",
      "## Notes",
      "- unrelated note",
      "**Definition of done:**",
      "- Docs updated",
      "AC:",
      "- [x] Works offline",
    ].join("\n"),
    "description"
  );
  check("heading: four criteria", heading.length === 4, JSON.stringify(heading.map((c) => c.text)));
  check("heading: items under 'Acceptance Criteria' only", heading[0]?.text === "Export button downloads a CSV" && !heading.some((c) => /Refactors|unrelated/.test(c.text)));
  check("heading: nested item folded in", heading[1]?.text === "The CSV has a header row — with column names", heading[1]?.text);
  check("heading: bold 'Definition of done:' label", heading[2]?.text === "Docs updated");
  check("heading: 'AC:' label, checkbox under it", heading[3]?.text === "Works offline" && heading[3]?.ticked === true && heading[3]?.format === "heading");

  const none = parseCriteriaFromText(
    ["Fixes the login bug.", "", "- touched auth.ts", "", "```md", "- [ ] inside code", "```", "<!-- - [ ] template hint -->", "## Testing", "- ran it"].join("\n"),
    "description"
  );
  check("none: plain lists, code fences and comments give nothing", none.length === 0, JSON.stringify(none));
  check("none: empty body", parseCriteriaFromText(undefined, "description").length === 0);

  const all = parseAcceptanceCriteria({
    source: "pull_request",
    title: "t",
    body: "- [ ] Retries 3 times",
    linkedIssues: [{ number: 12, title: "i", body: "## AC\n- retries 3 times!\n- Shows a toast" }],
  });
  check("merged: deduped across PR and issue, numbered", all.length === 2 && all[0].id === "c1" && all[1].id === "c2" && all[1].source === "#12", JSON.stringify(all));
  check("ref comparison: no criteria", parseAcceptanceCriteria({ source: "ref_comparison", body: "- [ ] x" }).length === 0);
}

async function partB(): Promise<void> {
  console.log("Part B — mock round trip");
  const mock = await startMockServer({ port: 0, host: "127.0.0.1", delayMs: 0, log: () => undefined });
  try {
    const config: AiProviderConfig = { baseUrl: `${mock.url}/v1`, apiKey: "test-key", model: "mock-model" };
    const intent = {
      source: "pull_request" as const,
      title: "Add retries",
      body: "## Acceptance criteria\n- Retries 3 times\n- Shows a toast MOCK_CRITERION_FAIL\n- Works on Mars MOCK_CRITERION_UNKNOWN",
    };
    const criteria = parseAcceptanceCriteria(intent);
    let prompt = "";
    const spy: typeof chatCompletion = async (cfg, messages, options) => {
      prompt = messages.map((m) => m.content).join("\n");
      const { chatCompletion: real } = await import("./client");
      return real(cfg, messages, options);
    };
    const result = await checkPrIntent(
      config,
      {
        intent,
        criteria,
        files: [{ path: "src/retry.ts", status: "modified", additions: 4, deletions: 0, patch: "@@ -1,2 +1,6 @@\n a\n+b\n+c\n+d\n+e" }],
        findings: [],
      },
      { tokenBudget: 8000, chat: spy }
    );
    check("prompt: intent marker and criteria section", prompt.includes(PR_INTENT_TASK_MARKER) && prompt.includes("## Acceptance criteria") && prompt.includes("c1: Retries 3 times"));
    check("intent verdict still answered", result.verdict === "delivers" && !result.parseFailed);
    const byId = new Map((result.criteria ?? []).map((c) => [c.id, c]));
    check("every criterion answered", byId.size === 3, JSON.stringify(result.criteria));
    check("c1 pass with evidence in the diff", byId.get("c1")?.verdict === "pass" && byId.get("c1")?.evidence[0]?.path === "src/retry.ts" && byId.get("c1")?.evidence[0]?.lines === "1-6", JSON.stringify(byId.get("c1")));
    check("c2 fail", byId.get("c2")?.verdict === "fail");
    check("c3 unknown, says the evidence is missing", byId.get("c3")?.verdict === "unknown" && /no evidence/i.test(byId.get("c3")?.reason ?? ""), byId.get("c3")?.reason);

    // A pass that cites nothing real becomes unknown.
    const bogus: typeof chatCompletion = async () => ({
      content:
        '```json\n{"verdict":"delivers","summary":"s","rationale":"r","criteria":[{"id":"c1","verdict":"pass","reason":"looks fine","evidence":["nope/missing.ts:3"]}]}\n```',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const downgraded = await checkPrIntent(config, { intent, criteria, files: [{ path: "src/retry.ts", additions: 1, deletions: 0 }], findings: [] }, { tokenBudget: 8000, chat: bogus });
    const c1 = downgraded.criteria?.find((c) => c.id === "c1");
    check("pass with no valid evidence becomes unknown", c1?.verdict === "unknown" && c1.evidence.length === 0 && /no evidence/i.test(c1.reason), JSON.stringify(c1));
    check("skipped criteria come back unknown", downgraded.criteria?.find((c) => c.id === "c3")?.verdict === "unknown");

    const noCriteria = await checkPrIntent(config, { intent: { source: "pull_request", title: "x" }, files: [], findings: [] }, { tokenBudget: 8000, chat: spy });
    check("no criteria: no criteria section, no criteria result", !prompt.includes("## Acceptance criteria") && noCriteria.criteria === undefined);
  } finally {
    await mock.close();
  }
}

async function main(): Promise<void> {
  partA();
  await partB();
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall acceptance-criteria checks passed");
}

void main();
