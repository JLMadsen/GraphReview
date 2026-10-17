/**
 * Checks for DESIGN.md §6.23: posting a review to a stubbed GitHub and
 * GitLab (payload shape, scope check, double-post guard), the full report's
 * sections, and the change brief — data-only and through the mock AI.
 *
 *   npm test -- review-post
 *
 * Run with GRAPHREVIEW_HOME pointing at a scratch folder (`npm test` does).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
// Lines 1–4 at the head: 1 context, 2 added, 3 added, 4 context. Line 30 is outside every hunk.
const PATCH = "@@ -1,3 +1,4 @@\n ctx\n+one\n+two\n ctx2\n";

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

async function main(): Promise<void> {
  const requests: Recorded[] = [];
  let githubScopes = "read:org";
  let gitlabScopes = ["api"];

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const p = decodeURIComponent(url.pathname);
      const body = raw ? (JSON.parse(raw) as unknown) : null;
      requests.push({ method: req.method ?? "", path: p, body });

      // ---- GitHub ----
      if (p === "/gh/user") return send(res, 200, { login: "me" }, { "x-oauth-scopes": githubScopes });
      if (p === "/gh/repos/o/r/pulls/7" && req.method === "GET")
        return send(res, 200, {
          number: 7, title: "Add geo helper", body: "Adds km().", state: "open", draft: false, merged_at: null,
          user: { login: "dev" }, base: { ref: "main", sha: BASE }, head: { ref: "feature", sha: HEAD },
          html_url: "https://github.test/o/r/pull/7", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
        });
      if (p === "/gh/repos/o/r/pulls/7/files")
        return send(res, 200, [{ filename: "lib/geo.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: PATCH }]);
      if (p === "/gh/graphql") return send(res, 200, { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } } });
      if (p === "/gh/repos/o/r/pulls/7/reviews" && req.method === "POST")
        return send(res, 200, { id: 99, html_url: "https://github.test/o/r/pull/7#pullrequestreview-99" });
      if (p === "/gh/repos/o/r/pulls/7/reviews/99/comments") {
        const sent = [...requests].reverse().find((r) => r.path.endsWith("/reviews") && r.method === "POST")?.body as { comments?: Array<{ path: string; body: string }> };
        return send(res, 200, (sent?.comments ?? []).map((c, n) => ({ path: c.path, body: c.body, html_url: `https://github.test/o/r/pull/7#discussion_r${n + 1}` })));
      }

      // ---- GitLab ----
      if (p === "/gl/api/v4/personal_access_tokens/self") return send(res, 200, { scopes: gitlabScopes });
      if (p === "/gl/api/v4/projects/g/p/merge_requests/3" && req.method === "GET")
        return send(res, 200, {
          iid: 3, title: "Add geo helper", description: "Adds km().", state: "opened", draft: false, author: { username: "dev" },
          source_branch: "feature", target_branch: "main", web_url: "https://gitlab.test/g/p/-/merge_requests/3",
          created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
          diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: HEAD },
        });
      if (p === "/gl/api/v4/projects/g/p/merge_requests/3/changes")
        return send(res, 200, { changes: [{ old_path: "lib/geo.ts", new_path: "lib/geo.ts", new_file: false, renamed_file: false, deleted_file: false, diff: PATCH }] });
      if (p === "/gl/api/v4/projects/g/p/merge_requests/3/closes_issues") return send(res, 200, []);
      if (p === "/gl/api/v4/projects/g/p/merge_requests/3/discussions") return send(res, 201, { id: "d1", notes: [{ id: 501 }] });
      if (p === "/gl/api/v4/projects/g/p/merge_requests/3/notes") return send(res, 201, { id: 502 });
      if (p === "/gl/api/v4/projects/g/p/merge_requests/3/approve") return send(res, 201, {});
      if (p === "/gl/api/v4/projects/g/p/merge_requests/3/unapprove") return send(res, 404, { message: "404 Not Found" });

      send(res, 404, { message: `no stub for ${req.method} ${p}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  // Read at module load by lib/github and lib/gitlab, so set before importing them.
  process.env.GITHUB_API_URL = `http://127.0.0.1:${port}/gh`;
  process.env.GITLAB_API_URL = `http://127.0.0.1:${port}/gl/api/v4`;

  const { encrypt } = await import("@/lib/crypto");
  const db = await import("@/lib/db");
  const { buildPostDraft, postReview, PostReviewError } = await import("./post");
  const { REPORT_SECTIONS, loadReportContext, renderReport } = await import("./report");
  const { generateChangeBrief, readChangeBrief } = await import("./brief");
  const { startMockServer } = await import("@/lib/ai/mock-server");

  const repoDir = mkdtempSync(path.join(os.tmpdir(), "graphreview-post-"));
  let mock: Awaited<ReturnType<typeof startMockServer>> | undefined;
  try {
    await db.upsertSettings({ githubPatEncrypted: encrypt("gh-token"), gitlabPatEncrypted: encrypt("gl-token") });
    const gh = { id: "gh-repo", name: "r", provider: "github" as const, url: "https://github.com/o/r", defaultBranch: "main", createdAt: "" };
    const gl = { id: "gl-repo", name: "p", provider: "gitlab" as const, url: "https://gitlab.com/g/p", defaultBranch: "main", createdAt: "" };
    await db.upsertRepo(gh);
    await db.upsertRepo(gl);

    const findingsFor = (suffix: string) => [
      {
        id: `f-added-${suffix}`, filePath: "lib/geo.ts", lineRange: "2-3", summary: "km() drops the radius", assessment: "defect" as const,
        kind: "fix" as const, scope: "described" as const, confidence: 0.9, rationale: "6371 was removed.", model: "m", reviewedHeadSha: HEAD,
      },
      {
        id: `f-outside-${suffix}`, filePath: "lib/geo.ts", lineRange: "30", summary: "unrelated helper is risky", assessment: "concern" as const,
        scope: "unmentioned" as const, kind: "refactor" as const, confidence: 0.6, rationale: "Far from the diff.", model: "m", reviewedHeadSha: HEAD,
      },
      { id: `f-ok-${suffix}`, filePath: "lib/geo.ts", lineRange: "1", summary: "fine", assessment: "ok" as const, confidence: 0.9, rationale: "", model: "m" },
    ];
    await db.replaceFindingsForTargetComponent("gh-repo", "pr:7", "c1", findingsFor("1"));
    await db.replaceFindingsForTargetCategory("gh-repo", "pr:7", "impact", [
      {
        id: "f-impact", filePath: "lib/use.ts", lineRange: "8", summary: "Not updated for the change to km: still passes radians",
        assessment: "defect", confidence: 0.8, model: "m", componentId: "",
        rationale: "`km` in lib/geo.ts changed from `(r) => 6371 * r` to `(r) => r`, but this line was not edited by the change.",
      },
    ]);

    // ---- Draft -------------------------------------------------------------
    const draft = await buildPostDraft(gh, 7);
    const added = draft.items.find((i) => i.findingId === "f-added-1");
    const outside = draft.items.find((i) => i.findingId === "f-outside-1");
    check("draft: no unavailable reason", !draft.unavailable, draft.unavailable);
    check("draft: an added-line range goes inline as a span", added?.inline?.line === 3 && added.inline.startLine === 2, JSON.stringify(added?.inline));
    check("draft: a line outside the hunks goes into the summary", outside?.inline === null && /isn't in the diff/.test(outside.notInlineReason ?? ""), JSON.stringify(outside));
    check("draft: OK findings aren't offered", !draft.items.some((i) => i.findingId === "f-ok-1"));
    check("draft: open defects and concerns start picked", added?.picked === true && outside?.picked === true);
    check("draft: the impact usage in an unchanged file is not inline", draft.items.find((i) => i.findingId === "f-impact")?.inline === null);
    check("draft: the head sha comes from the PR", draft.headSha === HEAD);

    // ---- Missing scope -----------------------------------------------------
    const postsBefore = requests.filter((r) => r.path.endsWith("/reviews") && r.method === "POST").length;
    const request = { prNumber: 7, findingIds: ["f-added-1", "f-outside-1"], summary: "My summary", verdict: "request_changes" as const, headSha: HEAD };
    let scopeError: unknown;
    try {
      await postReview(gh, request);
    } catch (error) {
      scopeError = error;
    }
    check(
      "github: a token without repo scope is refused before posting",
      scopeError instanceof PostReviewError && scopeError.code === "missing_scope" && /"repo"/.test(scopeError.message),
      String(scopeError)
    );
    check("github: nothing was sent", requests.filter((r) => r.path.endsWith("/reviews") && r.method === "POST").length === postsBefore);

    // ---- Post --------------------------------------------------------------
    githubScopes = "repo, read:org";
    const posted = await postReview(gh, request);
    const sent = requests.filter((r) => r.path === "/gh/repos/o/r/pulls/7/reviews" && r.method === "POST").at(-1)?.body as {
      event: string; commit_id: string; body: string; comments: Array<{ path: string; line: number; start_line?: number; side: string; body: string }>;
    };
    check("github: one review with the verdict", sent?.event === "REQUEST_CHANGES", sent?.event);
    check("github: pinned to the head", sent?.commit_id === HEAD);
    check(
      "github: the inline comment's shape",
      sent?.comments.length === 1 && sent.comments[0].path === "lib/geo.ts" && sent.comments[0].line === 3 && sent.comments[0].start_line === 2 && sent.comments[0].side === "RIGHT",
      JSON.stringify(sent?.comments)
    );
    check("github: the comment carries verdict and reasoning", /\*\*Defect\*\* · Fix — km\(\) drops the radius/.test(sent?.comments[0].body ?? "") && sent!.comments[0].body.includes("6371 was removed."));
    check("github: summary keeps the user's text and lists the off-diff finding", sent?.body.startsWith("My summary") && sent.body.includes("### Not on a diff line") && sent.body.includes("unrelated helper is risky"), sent?.body);
    check("github: the result counts inline and summary", posted.inline === 1 && posted.inSummary === 1 && posted.url.endsWith("pullrequestreview-99"));

    // ---- Double post -------------------------------------------------------
    let again: unknown;
    try {
      await postReview(gh, request);
    } catch (error) {
      again = error;
    }
    check("guard: posting the same findings again is refused", again instanceof PostReviewError && again.status === 409 && again.code === "already_posted", String(again));
    const draft2 = await buildPostDraft(gh, 7);
    check("guard: the draft shows them posted, with the comment link", draft2.items.find((i) => i.findingId === "f-added-1")?.posted?.url === "https://github.test/o/r/pull/7#discussion_r1");
    check("guard: posted findings aren't picked again", draft2.items.find((i) => i.findingId === "f-added-1")?.picked === false);
    check("guard: the review is in the history", draft2.reviews.length === 1 && draft2.reviews[0].verdict === "request_changes");
    // A re-run writes new ids for the same findings: still posted, by fingerprint.
    await db.replaceFindingsForTargetComponent("gh-repo", "pr:7", "c1", findingsFor("2"));
    const draft3 = await buildPostDraft(gh, 7);
    check("guard: a re-run's same finding is still posted (fingerprint)", Boolean(draft3.items.find((i) => i.findingId === "f-added-2")?.posted));
    let moved: unknown;
    try {
      await postReview(gh, { ...request, findingIds: [], summary: "x", verdict: "comment", headSha: "c".repeat(40) });
    } catch (error) {
      moved = error;
    }
    check("guard: a draft from an older head is refused", moved instanceof PostReviewError && moved.code === "head_moved", String(moved));

    // ---- GitLab ------------------------------------------------------------
    await db.replaceFindingsForTargetComponent("gl-repo", "pr:3", "c1", findingsFor("gl"));
    gitlabScopes = ["read_api"];
    let glScope: unknown;
    try {
      await postReview(gl, { prNumber: 3, findingIds: ["f-added-gl"], summary: "s", verdict: "approve" });
    } catch (error) {
      glScope = error;
    }
    check("gitlab: a read_api token is refused", glScope instanceof PostReviewError && glScope.code === "missing_scope" && /"api"/.test(glScope.message), String(glScope));
    gitlabScopes = ["api"];
    const glPosted = await postReview(gl, { prNumber: 3, findingIds: ["f-added-gl", "f-outside-gl"], summary: "GL summary", verdict: "request_changes" });
    const discussion = requests.filter((r) => r.path.endsWith("/merge_requests/3/discussions")).at(-1)?.body as { body: string; position: Record<string, unknown> };
    check(
      "gitlab: the inline discussion has a text position on the head line",
      discussion?.position.position_type === "text" && discussion.position.new_line === 3 && discussion.position.head_sha === HEAD && discussion.position.start_sha === BASE,
      JSON.stringify(discussion?.position)
    );
    const note = requests.filter((r) => r.path.endsWith("/merge_requests/3/notes")).at(-1)?.body as { body: string };
    check("gitlab: request changes heads the summary note", note?.body.startsWith("**Changes requested**") && note.body.includes("unrelated helper is risky"), note?.body);
    check("gitlab: request changes revokes approval (a 404 is fine)", requests.some((r) => r.path.endsWith("/unapprove")));
    check("gitlab: the note's URL", glPosted.url === "https://gitlab.test/g/p/-/merge_requests/3#note_502", glPosted.url);
    await db.replaceFindingsForTargetComponent("gl-repo", "pr:3", "c2", [
      { id: "f-new-gl", filePath: "lib/geo.ts", lineRange: "4", summary: "context line", assessment: "concern", confidence: 0.5, rationale: "", model: "m" },
    ]);
    await postReview(gl, { prNumber: 3, findingIds: ["f-new-gl"], summary: "", verdict: "approve" });
    const ctxDiscussion = requests.filter((r) => r.path.endsWith("/merge_requests/3/discussions")).at(-1)?.body as { position: Record<string, unknown> };
    check("gitlab: a context line also sends old_line", ctxDiscussion?.position.new_line === 4 && ctxDiscussion.position.old_line === 2, JSON.stringify(ctxDiscussion?.position));
    check("gitlab: approve calls approve", requests.some((r) => r.path.endsWith("/merge_requests/3/approve")));

    // ---- Report ------------------------------------------------------------
    const ctx = await loadReportContext(gh, { kind: "pr", prNumber: 7 });
    const report = await renderReport(ctx);
    check("report: sections in order", ["header", "findings", "impact", "checklist", "footer"].every((s) => report.sections.includes(s)), report.sections.join(","));
    check("report: the header names the PR", report.markdown.startsWith("## Review report — PR #7: Add geo helper"), report.markdown.slice(0, 80));
    check("report: open findings quote their reasoning", report.markdown.includes("  > 6371 was removed."));
    check("report: impact callers grouped by declaration", /`km` .*1 usage not updated/.test(report.markdown) && report.markdown.includes("`lib/use.ts:8`"));
    check("report: impact isn't repeated in the findings list", !/### Open findings[\s\S]*Caller not updated[\s\S]*### Callers left behind/.test(report.markdown));
    const extended = await renderReport(ctx, [
      ...REPORT_SECTIONS.slice(0, -1),
      { id: "test-plan", title: "Test plan", render: async () => ["- run it"] },
      ...REPORT_SECTIONS.slice(-1),
    ]);
    check("report: an added section renders before the footer", /### Test plan\n\n- run it\n\n---/.test(extended.markdown));

    // ---- Change brief ------------------------------------------------------
    const factsOnly = await generateChangeBrief(gh, { kind: "pr", prNumber: 7 });
    check("brief: without a provider it's the data-only brief", factsOnly.source === "facts" && /No AI provider/.test(factsOnly.note ?? ""));
    check("brief: risks carry the open defect and the caller left behind", factsOnly.brief.risks.some((r) => r.includes("km() drops the radius")) && factsOnly.brief.risks.some((r) => r.includes("`km`")), JSON.stringify(factsOnly.brief.risks));
    check("brief: the unmentioned change becomes a question", factsOnly.brief.questions.some((q) => q.includes("unrelated helper is risky")));
    check("brief: titled Change brief", factsOnly.markdown.startsWith("## Change brief — PR #7: Add geo helper"));

    mock = await startMockServer({ host: "127.0.0.1", port: 0, log: () => undefined });
    await db.createAiProvider({ name: "mock", baseUrl: `${mock.url}/v1`, apiKeyEncrypted: encrypt("x"), model: "mock-review-1" });
    const ai = await generateChangeBrief(gh, { kind: "pr", prNumber: 7 });
    check("brief: one AI call words it", ai.source === "ai" && ai.model === "mock-review-1", JSON.stringify({ source: ai.source, note: ai.note }));
    check("brief: the model saw the facts", ai.brief.risks.some((r) => r.startsWith("[mock] ") && r.includes("km() drops the radius")), JSON.stringify(ai.brief.risks));
    check("brief: the summary is the model's", ai.brief.summary.startsWith("[mock] A change across 1 file"), ai.brief.summary);
    const cached = await readChangeBrief(gh, { kind: "pr", prNumber: 7 });
    check("brief: GET serves the generated brief for the same head", cached.source === "ai" && cached.generatedAt === ai.generatedAt);

    // A ref range on a local repo: release notes.
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repoDir, stdio: "pipe" }).toString();
    writeFileSync(path.join(repoDir, "a.ts"), "export const a = 1;\n");
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "v2");
    writeFileSync(path.join(repoDir, "a.ts"), "export const a = 2;\n");
    git("commit", "-q", "-am", "bump");
    const local = { id: "local-repo", name: "local", provider: "local" as const, localPath: repoDir, defaultBranch: "main", createdAt: "" };
    await db.upsertRepo(local);
    const notes = await readChangeBrief(local, { kind: "refs", baseRef: "main", headRef: "v2" });
    check("brief: a ref range is release notes", notes.kind === "release_notes" && notes.markdown.startsWith("## Release notes — main … v2") && notes.filename === "release-notes-main..v2.md", notes.markdown.slice(0, 60));
    check("brief: release notes count the files", notes.brief.summary.includes("1 file, +1/-1"), notes.brief.summary);
  } finally {
    await mock?.close();
    server.close();
    rmSync(repoDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll post/report/brief checks passed.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
