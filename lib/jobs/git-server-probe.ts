// What a git server is, asked once when a token is saved for it
// (Settings → Git servers, DESIGN.md §6.30).
//
// The token's own prefix says which API to try first (`ghp_`/`github_pat_`
// → GitHub, `glpat-` → GitLab); the server's answer decides. A server
// whose GitHub (`/api/v3`, api.github.com) and GitLab (`/api/v4`) user
// endpoints both don't exist is a plain git server: the token is then only
// used for HTTPS clones. A 401 from a real API means the token is wrong,
// and nothing is saved.

import type { GitServerKind } from "@/lib/db";
import { builtInServers, originOf } from "./git-hosts";

const PROBE_TIMEOUT_MS = 10_000;

export interface ProbedServer {
  origin: string;
  kind: GitServerKind;
  apiUrl?: string;
  /** The token's account, when the API said. */
  username?: string;
}

/** A token the server answered with 401/403 for — wrong, expired or revoked. */
export class TokenRejectedError extends Error {
  override readonly name = "TokenRejectedError";
}

type Attempt = { kind: "github" | "gitlab"; apiUrl: string };

/** The API base to try for each kind: a built-in server's own, else the conventional path on the server. */
function attempts(origin: string, token: string): Attempt[] {
  const builtIn = builtInServers().find((s) => s.origin === origin);
  const github: Attempt = { kind: "github", apiUrl: builtIn?.kind === "github" && builtIn.apiUrl ? builtIn.apiUrl : `${origin}/api/v3` };
  const gitlab: Attempt = { kind: "gitlab", apiUrl: builtIn?.kind === "gitlab" && builtIn.apiUrl ? builtIn.apiUrl : `${origin}/api/v4` };
  if (builtIn?.kind === "gitlab" || /^glpat-/.test(token)) return [gitlab, github];
  return [github, gitlab];
}

/** `GET <api>/user` as the token: its login, `"rejected"` on 401/403, `null` when this isn't that kind of API. */
async function askUser(attempt: Attempt, token: string): Promise<string | "rejected" | null> {
  const headers: Record<string, string> =
    attempt.kind === "github"
      ? { Authorization: `token ${token}`, Accept: "application/vnd.github+json" }
      : { "PRIVATE-TOKEN": token, Accept: "application/json" };
  let response: Response;
  try {
    response = await fetch(`${attempt.apiUrl.replace(/\/+$/, "")}/user`, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "manual" });
  } catch {
    return null;
  }
  const json = response.headers.get("content-type")?.includes("json") ?? false;
  if ((response.status === 401 || response.status === 403) && json) return "rejected";
  if (!response.ok || !json) return null;
  const body = (await response.json().catch(() => null)) as { login?: unknown; username?: unknown } | null;
  const name = attempt.kind === "github" ? body?.login : body?.username;
  return typeof name === "string" ? name : null;
}

/**
 * Works out what `serverUrl` (a server or any repo URL on it) is, using
 * `token`. Throws {@link TokenRejectedError} when a GitHub/GitLab API
 * refuses the token, and a plain `Error` when the URL names no server.
 */
export async function probeGitServer(serverUrl: string, token: string): Promise<ProbedServer> {
  const origin = originOf(serverUrl);
  if (!origin) throw new Error(`"${serverUrl}" isn't a server address — expected something like https://git.example.com.`);
  for (const attempt of attempts(origin, token)) {
    const user = await askUser(attempt, token);
    if (user === "rejected") {
      throw new TokenRejectedError(
        `${origin} is a ${attempt.kind === "github" ? "GitHub" : "GitLab"} server and rejected this token — check that it is current and copied whole.`
      );
    }
    if (user !== null) return { origin, kind: attempt.kind, apiUrl: attempt.apiUrl, username: user };
  }
  return { origin, kind: "git" };
}
