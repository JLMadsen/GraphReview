/**
 * Checks for the review loop (DESIGN.md §6.21): stable finding ids across
 * re-runs, the reviewer's triage carried over (resolved, re-rated, replies,
 * chat triage records), an incremental re-review after a push that skips
 * unchanged components without a model call, and the per-repo suppression
 * memory (matching, the dock's flags, the prompt, un-suppressing).
 *
 * Real review jobs against a throwaway git repo and the mock AI server
 * (lib/ai/mock-server.ts), whose one log line per request is how calls are
 * counted; a small proxy in front of it records the prompts.
 *
 *   npm test -- review-loop
 *
 * Run with GRAPHREVIEW_HOME pointing at a scratch folder (`npm test` does).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { startMockServer } from "@/lib/ai/mock-server";
import { buildUserMessage } from "@/lib/ai/prompts";
import type { ReviewStatusResponse } from "@/app/api/repos/[repoId]/review/route";
import type { ReviewProgress } from "./review-queue";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "graphreview-loop-"));
  process.env.LOCAL_REPOS_ROOT = root;
  const db = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { runAnalysisJob } = await import("./analyze");
  const { runReviewJob } = await import("./review");
  const { applyChatTriage } = await import("./pr-chat");
  const reviewRoute = await import("@/app/api/repos/[repoId]/review/route");
  const findingRoute = await import("@/app/api/repos/[repoId]/review/findings/[findingId]/route");
  const suppressionsRoute = await import("@/app/api/repos/[repoId]/review/suppressions/route");

  // --- Matching, no database -------------------------------------------------
  console.log("matching:");
  check(
    "normalizing drops case, punctuation, line numbers and stopwords",
    db.normalizeFindingSummary("Changes `km()` on line 12 — the radius is DROPPED.") === db.normalizeFindingSummary("changes km() on line 40: radius dropped")
  );
  check("identifiers survive normalizing", db.normalizeFindingSummary("Calls get_user and a.b") === "calls get_user a.b");
  check(
    "ids are stable and keyed on what the finding is about",
    db.changeFindingId("r", "t", "c", "a.ts", "Drops the radius.") === db.changeFindingId("r", "t", "c", "a.ts", "drops the RADIUS") &&
      db.changeFindingId("r", "t", "c", "a.ts", "Drops the radius.") !== db.changeFindingId("r", "t", "c", "b.ts", "Drops the radius.")
  );
  const suppression = {
    id: "s1",
    repoId: "r",
    filePath: "lib/geo.ts",
    summary: "km() no longer multiplies by the Earth's radius",
    normalized: db.normalizeFindingSummary("km() no longer multiplies by the Earth's radius"),
    createdAt: "",
  };
  check("a near-identical summary on the same file is suppressed", db.matchSuppression({ filePath: "lib/geo.ts", summary: "km() no longer multiplies by the Earth radius." }, [suppression])?.id === "s1");
  check("the same summary on another file is not", db.matchSuppression({ filePath: "lib/other.ts", summary: suppression.summary }, [suppression]) === undefined);
  check("a different point on the same file is not", db.matchSuppression({ filePath: "lib/geo.ts", summary: "km() now throws on negative input" }, [suppression]) === undefined);
  check("the intent verdict and failed calls are never suppressed", db.matchSuppression({ filePath: "lib/geo.ts", summary: suppression.summary, category: "intent" }, [suppression]) === undefined && db.matchSuppression({ filePath: "lib/geo.ts", summary: suppression.summary, callFailed: true }, [suppression]) === undefined);
  const prompt = buildUserMessage({
    intent: { source: "ref_comparison" },
    component: { id: "c", name: "Geo", description: "", dependsOn: [], dependents: [] },
    files: [{ path: "lib/geo.ts", patch: "@@ -1 +1 @@\n-a\n+b" }],
    related: { knownNonIssues: [{ filePath: "lib/geo.ts", summary: suppression.summary, reason: "radians on purpose" }] },
  });
  check("the prompt lists known non-issues with their reason", /## Known non-issues[\s\S]*lib\/geo\.ts: km\(\) no longer multiplies[\s\S]*reason: radians on purpose/.test(prompt));

  // --- Carry-over in the slot writer ------------------------------------------
  console.log("\ncarry-over:");
  const base = { assessment: "concern" as const, confidence: 0.7, rationale: "r", model: "m" };
  const [first] = await db.syncFindingsForTargetComponent("r0", "t", "c", [{ id: "ignored", filePath: "a.ts", summary: "Drops the null check in parse()", ...base }]);
  await db.setFindingResolved("r0", first.id, true);
  await db.addFindingResponse("r0", first.id, { kind: "comment", author: "reviewer", body: "seen" });
  const [same] = await db.syncFindingsForTargetComponent("r0", "t", "c", [{ id: "x", filePath: "a.ts", summary: "Drops the null check in parse().", ...base }]);
  check("the same finding again keeps its id, resolved state and replies", same.id === first.id && Boolean(same.resolvedAt) && same.responses?.length === 1);
  const [reworded] = await db.syncFindingsForTargetComponent("r0", "t", "c", [{ id: "x", filePath: "a.ts", summary: "parse() drops its null check entirely", ...base }]);
  check("a re-worded finding on the same file adopts the id", reworded.id === first.id && Boolean(reworded.resolvedAt), JSON.stringify(reworded));
  const [other] = await db.syncFindingsForTargetComponent("r0", "t", "c", [{ id: "x", filePath: "a.ts", summary: "Adds a retry loop to fetchAll()", ...base }]);
  check("a different finding is new, and the old one is gone", other.id !== first.id && !other.resolvedAt && (await db.getFindingById(first.id)) === null);

  // --- Real review jobs ---------------------------------------------------------
  console.log("\nreview jobs:");
  const repoDir = path.join(root, "repo");
  mkdirSync(repoDir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repoDir, stdio: "pipe" })
      .toString()
      .trim();
  const changed = ["alpha", "beta", "gamma", "delta"];
  const writeModule = (name: string, body: string) => {
    mkdirSync(path.join(repoDir, "src", name), { recursive: true });
    writeFileSync(path.join(repoDir, "src", name, "index.ts"), `export function ${name}(x: number): number {\n  return ${body};\n}\n`);
  };
  git("init", "-q", "-b", "main");
  for (const name of [...changed, "legacy"]) writeModule(name, "x + 1");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  for (const name of changed) writeModule(name, "x + 2");
  git("commit", "-q", "-am", "change");
  git("checkout", "-q", "main");

  const mockLines: string[] = [];
  const mock = await startMockServer({ port: 0, host: "127.0.0.1", delayMs: 0, log: (line) => mockLines.push(line) });
  // Records each prompt on its way to the mock.
  const prompts: string[] = [];
  const proxy = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      prompts.push(body);
      void fetch(`${mock.url}${req.url}`, { method: req.method, headers: { "content-type": "application/json", authorization: req.headers.authorization ?? "" }, body: body || undefined })
        .then(async (upstream) => {
          res.writeHead(upstream.status, { "content-type": "application/json" });
          res.end(await upstream.text());
        })
        .catch(() => {
          res.writeHead(502);
          res.end();
        });
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  try {
    const repoId = "loop-smoke";
    await db.upsertRepo({ id: repoId, name: repoId, provider: "local", localPath: repoDir, defaultBranch: "main" });
    await runAnalysisJob(repoId, () => undefined);
    await db.createAiProvider({ name: "mock", baseUrl: `${proxyUrl}/v1`, apiKeyEncrypted: encrypt("test-key"), model: "mock-review-1" });

    const target = { kind: "refs", baseRef: "main", headRef: "feature" } as const;
    const targetKey = "refs:main...feature";
    const componentCalls = () => mockLines.filter((line) => line.includes("component=")).length;
    const review = async () => {
      const before = componentCalls();
      let progress: ReviewProgress | undefined;
      const result = await runReviewJob({ repoId, target }, { updateProgress: async (p) => void (progress = p as ReviewProgress) }, () => undefined);
      return { result, progress, calls: componentCalls() - before };
    };
    const changeFindings = async () => (await db.listFindingsByTargetKey(repoId, targetKey)).filter((f) => f.category === "change");
    const url = `http://localhost/api/repos/${repoId}/review?baseRef=main&headRef=feature`;
    const ctx = { params: Promise.resolve({ repoId }) };
    const status = async () => (await (await reviewRoute.GET(new Request(url), ctx)).json()) as ReviewStatusResponse;

    // Run 1: every touched component is called.
    const run1 = await review();
    const found1 = await changeFindings();
    check(`the first run calls each of the ${changed.length} components`, run1.calls === changed.length && run1.progress?.reused === 0, `calls ${run1.calls}`);
    check("change findings have derived ids", found1.length >= changed.length && found1.every((f) => f.id.startsWith("chg-")), found1.map((f) => f.id).join(","));

    // Triage: X resolved with a reply, Z re-rated, a chat triage record on Z.
    const componentOf = (name: string) => `${repoId}:module:${name}`;
    const x = found1.find((f) => f.componentId === componentOf("alpha"))!;
    const z = found1.find((f) => f.componentId === componentOf("beta"))!;
    check("the mock produced findings for alpha and beta", Boolean(x && z), found1.map((f) => f.componentId).join(","));
    if (x.assessment === "ok") await db.rateFinding(repoId, x.id, "concern", { author: "reviewer", body: "look again" });
    await db.setFindingResolved(repoId, x.id, true);
    await db.addFindingResponse(repoId, x.id, { kind: "comment", author: "reviewer", body: "checked" });
    const zTo = z.assessment === "defect" ? "unknown" : "defect";
    await db.rateFinding(repoId, z.id, zTo, { author: "reviewer", body: "re-rated" });
    const chat = await db.addChatMessage({
      repoId,
      targetKey,
      role: "assistant",
      content: "Checked.",
      triage: [{ id: "t1", findingId: z.id, findingSummary: z.summary, from: zTo, verdict: "holds", reason: "the diff does it", status: "pending" }],
    });

    // Run 2, same head: a deliberate re-run asks every component again.
    const run2 = await review();
    const found2 = await changeFindings();
    const x2 = found2.find((f) => f.id === x.id);
    const z2 = found2.find((f) => f.id === z.id);
    check("a re-run at the same head calls every component again", run2.calls === changed.length && !run2.progress?.reused, `calls ${run2.calls}`);
    check("finding ids are the same across re-runs", found2.map((f) => f.id).sort().join() === found1.map((f) => f.id).sort().join());
    check("a resolved finding stays resolved, with its reply", Boolean(x2?.resolvedAt) && x2?.responses?.some((r) => r.body === "checked") === true, JSON.stringify(x2));
    check("a re-rated finding keeps the reviewer's verdict", z2?.assessment === zTo && z2.reratedTo === zTo, JSON.stringify(z2));
    const applied = await applyChatTriage(chat, "t1");
    check("the chat's triage record still points at its finding", applied?.triage?.[0]?.status === "applied" && (await db.getFindingById(z.id))?.responses?.some((r) => r.body.includes("the diff does it")) === true);

    // Dismiss X as not a problem through the dock's route.
    const xUrl = `http://localhost/api/repos/${repoId}/review/findings/${x.id}`;
    const xCtx = { params: Promise.resolve({ repoId, findingId: x.id }) };
    const dismissed = await findingRoute.PATCH(
      new Request(xUrl, { method: "PATCH", body: JSON.stringify({ resolved: true, dismiss: { reason: "alpha is meant to add two" } }) }),
      xCtx
    );
    const dismissedBody = (await dismissed.json()) as { suppressionId?: string; resolvedAt?: string };
    check("dismissing resolves it and makes a suppression", dismissed.status === 200 && Boolean(dismissedBody.suppressionId && dismissedBody.resolvedAt), JSON.stringify(dismissedBody));
    const afterDismiss = await status();
    check(
      "the review GET flags it suppressed, with the reason, and nothing else",
      afterDismiss.findings.find((f) => f.id === x.id)?.suppressed?.reason === "alpha is meant to add two" &&
        afterDismiss.findings.filter((f) => f.suppressed).length === 1
    );

    // A push that changes only alpha: the rest are reused, no call.
    git("checkout", "-q", "feature");
    writeModule("alpha", "x + 3");
    git("commit", "-q", "-am", "alpha again");
    const newHead = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    prompts.length = 0;
    const run3 = await review();
    const found3 = await changeFindings();
    check("after a push only the changed component is called", run3.calls === 1, `calls ${run3.calls}`);
    check(`the other ${changed.length - 1} are reported reused`, run3.progress?.reused === changed.length - 1 && run3.result.reusedComponents === changed.length - 1, JSON.stringify(run3.progress));
    check("reused findings are stamped with the new head", found3.every((f) => f.reviewedHeadSha === newHead), found3.map((f) => f.reviewedHeadSha?.slice(0, 7)).join(","));
    check("reused findings keep their triage", found3.find((f) => f.id === z.id)?.assessment === zTo);
    const x3 = found3.find((f) => f.componentId === componentOf("alpha"));
    check("the re-called component's finding keeps its id and resolved state", x3?.id === x.id && Boolean(x3.resolvedAt));
    const reviewPrompt = prompts.find((p) => p.includes("Known non-issues"));
    check("its prompt lists the dismissed finding with the reason", Boolean(reviewPrompt?.includes("alpha is meant to add two")));
    check("still suppressed after the re-review", (await status()).findings.find((f) => f.id === x.id)?.suppressed !== undefined);

    // Un-suppress, then reopen-forgets.
    const sid = dismissedBody.suppressionId!;
    const listed = (await (await suppressionsRoute.GET(new Request(`http://localhost/api/repos/${repoId}/review/suppressions`), ctx)).json()) as { suppressions: Array<{ id: string }> };
    check("the suppressions route lists it", listed.suppressions.some((s) => s.id === sid));
    const del = await suppressionsRoute.DELETE(new Request(`http://localhost/api/repos/${repoId}/review/suppressions?id=${sid}`, { method: "DELETE" }), ctx);
    check("un-suppressing shows it again", del.status === 200 && (await status()).findings.every((f) => !f.suppressed));
    await findingRoute.PATCH(new Request(xUrl, { method: "PATCH", body: JSON.stringify({ resolved: true, dismiss: {} }) }), xCtx);
    check("dismissing without a reason works too", (await status()).findings.some((f) => f.id === x.id && f.suppressed && !f.suppressed.reason));
    await findingRoute.PATCH(new Request(xUrl, { method: "PATCH", body: JSON.stringify({ resolved: false }) }), xCtx);
    check("reopening a dismissed finding forgets the suppression", db.listFindingSuppressions(repoId).length === 0);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await mock.close();
    db.closeDb();
    rmSync(root, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nreview loop: all checks passed" : `\nreview loop: ${failures} check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
