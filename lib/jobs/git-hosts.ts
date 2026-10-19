// Which git server a URL is on, and the token saved for it (DESIGN.md §6.30).
//
// A server is known from three places, first match wins: a token saved in
// Settings → Git servers (which recorded what the server is when it was
// saved), the `GITHUB_WEB_URL` / `GITLAB_WEB_URL` overrides, and the
// public github.com / gitlab.com. Servers are matched on host name alone,
// so `git@host:path` finds the token saved for `https://host`.
//
// Server-only (decrypts tokens) — never import from a client component.

import { decrypt } from "@/lib/crypto";
import { listGitTokens, type GitServerKind, type GitTokenRecord } from "@/lib/db";
import type { GitHostAuth } from "@/lib/github/types";

export interface GitServer {
  origin: string;
  kind: GitServerKind;
  /** The REST API base for GitHub/GitLab; unset means the client's default. */
  apiUrl?: string;
}

/** A saved token, decrypted, with what it is for. */
export interface ServerToken extends GitServer {
  auth: GitHostAuth;
  username?: string;
}

/**
 * The host name of a URL in any form git or a browser takes (`https://`,
 * `ssh://`, `git@host:path`, bare `host/path`), lowercase, or `null`.
 */
export function hostOf(url: string): string | null {
  const trimmed = url.trim();
  const scp = !trimmed.includes("://") && /^(?:[\w.-]+@)?([\w.-]+):(?!\d+\/)/.exec(trimmed);
  if (scp) return scp[1].toLowerCase();
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** `https://host[:port]` for a web/API URL; for an SSH URL, `https://host` (its web side). */
export function originOf(url: string): string | null {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).origin.toLowerCase();
    } catch {
      return null;
    }
  }
  const host = hostOf(trimmed);
  return host ? `https://${host}` : null;
}

/** The servers known without any saved token: the configured overrides, then the public hosts. */
export function builtInServers(): GitServer[] {
  const servers: GitServer[] = [];
  const add = (web: string | undefined, kind: GitServerKind, apiUrl: string | undefined) => {
    const origin = web ? originOf(web) : null;
    if (origin && !servers.some((s) => s.origin === origin)) servers.push({ origin, kind, apiUrl });
  };
  add(process.env.GITHUB_WEB_URL, "github", process.env.GITHUB_API_URL || undefined);
  add(process.env.GITLAB_WEB_URL, "gitlab", process.env.GITLAB_API_URL || undefined);
  add("https://github.com", "github", "https://api.github.com");
  add("https://gitlab.com", "gitlab", "https://gitlab.com/api/v4");
  return servers;
}

function sameHost(origin: string, url: string): boolean {
  return hostOf(origin) !== null && hostOf(origin) === hostOf(url);
}

/** The saved token record for `url`'s server, if any. */
async function savedFor(url: string): Promise<GitTokenRecord | undefined> {
  return (await listGitTokens()).find((t) => sameHost(t.origin, url));
}

/** What `url`'s server is — `null` for one that is neither saved nor built in (a plain git server). */
export async function serverFor(url: string): Promise<GitServer | null> {
  const saved = await savedFor(url);
  if (saved) return { origin: saved.origin, kind: saved.kind, apiUrl: saved.apiUrl };
  return builtInServers().find((s) => sameHost(s.origin, url)) ?? null;
}

/**
 * The token saved for `url`'s server, decrypted — `null` with none (or one
 * that can't be decrypted: the secret key changed). Never logged, never
 * returned to a client.
 */
export async function tokenFor(url: string): Promise<ServerToken | null> {
  const saved = await savedFor(url);
  if (!saved) return null;
  let token: string;
  try {
    token = decrypt(saved.tokenEncrypted);
  } catch {
    console.warn(
      `[git-hosts] the token saved for ${saved.origin} could not be decrypted — has the secret key (SESSION_SECRET or secret.key in the data folder) changed? Re-enter it in Settings.`
    );
    return null;
  }
  const builtIn = builtInServers().find((s) => s.origin === saved.origin);
  const apiUrl = saved.apiUrl ?? builtIn?.apiUrl;
  return { origin: saved.origin, kind: saved.kind, apiUrl, username: saved.username, auth: { token, ...(apiUrl ? { apiUrl } : {}) } };
}
