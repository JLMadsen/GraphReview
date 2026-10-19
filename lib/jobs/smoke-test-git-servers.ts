/**
 * Checks per-server git tokens (DESIGN.md §6.30) — no network beyond a
 * local mock server, no AI.
 *
 *   npm test -- git-servers
 *
 * The two old settings tokens migrate into the list; a token is found by
 * the host of any URL form; GitHub/GitLab access carries the token's own
 * API; a saved GitLab token makes its host a GitLab server; and the probe
 * on save tells GitHub, GitLab and plain git servers apart and refuses a
 * token an API rejects. Run through `npm test`: it writes a temp
 * GRAPHREVIEW_HOME's database, never the real one.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { encrypt } from "@/lib/crypto";
import { closeDb, getSettings, listGitTokens, saveGitToken, upsertSettings } from "@/lib/db";
import { serverFor, tokenFor } from "./git-hosts";
import { probeGitServer, TokenRejectedError } from "./git-server-probe";
import { resolveGitHubAccess } from "./github-access";
import { parseGitLabUrl, resolveGitLabAccess } from "./gitlab-access";
import { providerForUrl } from "./source";

delete process.env.GITHUB_WEB_URL;
delete process.env.GITLAB_WEB_URL;
delete process.env.GITHUB_API_URL;
delete process.env.GITLAB_API_URL;

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A fake server: `/api/v3/user` or `/api/v4/user` answers per `mode`, everything else 404 HTML. */
function mockServer(mode: "github" | "gitlab" | "plain" | "rejects"): Promise<{ origin: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (mode === "github" && req.url === "/api/v3/user") return json(200, { login: "octo" });
    if (mode === "gitlab" && req.url === "/api/v4/user") return json(200, { username: "tanuki" });
    if (mode === "rejects" && req.url === "/api/v4/user") return json(401, { message: "401 Unauthorized" });
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<h1>not found</h1>");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    })
  );
}

async function main(): Promise<void> {
  // --- Migration -----------------------------------------------------------------
  await upsertSettings({ githubPatEncrypted: encrypt("gh-token"), gitlabPatEncrypted: encrypt("gl-token") });
  const migrated = await listGitTokens();
  check(
    "the two old tokens move into the list",
    migrated.map((t) => `${t.origin}:${t.kind}`).sort().join(",") === "https://github.com:github,https://gitlab.com:gitlab",
    JSON.stringify(migrated.map((t) => t.origin))
  );
  const settings = await getSettings();
  check("… and leave the settings record", !settings?.githubPatEncrypted && !settings?.gitlabPatEncrypted);
  check("migrating twice adds nothing", (await listGitTokens()).length === 2);

  // --- Lookup by host --------------------------------------------------------------
  check("an SSH URL finds the HTTPS server's token", (await tokenFor("git@github.com:owner/repo.git"))?.auth.token === "gh-token");
  const gh = await resolveGitHubAccess({ provider: "github", url: "https://github.com/owner/repo" });
  check("GitHub access carries github.com's token", gh.ok && gh.token.token === "gh-token" && gh.ref.origin === "https://github.com");

  await saveGitToken({
    id: "corp",
    origin: "https://git.corp.example",
    kind: "gitlab",
    apiUrl: "https://git.corp.example/api/v4",
    tokenEncrypted: encrypt("corp-token"),
  });
  check("a saved GitLab token makes its host GitLab", (await providerForUrl("git@git.corp.example:team/app.git")) === "gitlab");
  check("an unknown host is plain git", (await providerForUrl("https://other.example/team/app.git")) === "git");
  check("the GitLab ref keeps its own server", parseGitLabUrl("https://git.corp.example/team/sub/app")?.origin === "https://git.corp.example");
  const gl = await resolveGitLabAccess({ provider: "gitlab", url: "https://git.corp.example/team/app" });
  check(
    "GitLab access uses that server's token and API",
    gl.ok && gl.token.token === "corp-token" && gl.token.apiUrl === "https://git.corp.example/api/v4",
    JSON.stringify(gl.ok ? { ...gl.token, token: "…" } : gl)
  );
  const glcom = await resolveGitLabAccess({ provider: "gitlab", url: "https://gitlab.com/group/project" });
  check("gitlab.com keeps its own token", glcom.ok && glcom.token.token === "gl-token");
  check("built-in hosts are known without a token", (await serverFor("https://gitlab.com/x/y"))?.kind === "gitlab");

  // --- Probe on save ---------------------------------------------------------------
  for (const [mode, expected] of [
    ["github", "github:octo"],
    ["gitlab", "gitlab:tanuki"],
    ["plain", "git:"],
  ] as const) {
    const mock = await mockServer(mode);
    try {
      const probed = await probeGitServer(`${mock.origin}/team/app.git`, "some-token");
      check(`a ${mode} server is recognised`, `${probed.kind}:${probed.username ?? ""}` === expected, JSON.stringify(probed));
      check(`… keyed by its origin`, probed.origin === mock.origin, probed.origin);
    } finally {
      mock.close();
    }
  }
  const rejecting = await mockServer("rejects");
  try {
    await probeGitServer(rejecting.origin, "glpat-wrong");
    check("a token the API rejects is refused", false);
  } catch (error) {
    check("a token the API rejects is refused", error instanceof TokenRejectedError, String(error));
  } finally {
    rejecting.close();
  }

  closeDb();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
