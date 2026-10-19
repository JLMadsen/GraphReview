// Saved access tokens, one per git server (Settings → Git servers,
// DESIGN.md §6.30). A token belongs to a server, not to a provider: each
// record says which server (`origin`), what that server turned out to be
// when the token was saved (`kind`) and, for GitHub/GitLab, its API.
//
// Stores ciphertext only — lib/crypto encrypts and decrypts, as for the
// other secrets. Before this list existed there was one GitHub and one
// GitLab token in the settings record; the first read moves them here.

import { transaction } from "./client";
import { readKv, writeKv } from "./kv";
import { clearSettingsFields, getSettings } from "./settings";

const KEY = "git-tokens";

/** What a server is: GitHub (or Enterprise), GitLab, or another git server whose token only clones. */
export type GitServerKind = "github" | "gitlab" | "git";

export interface GitTokenRecord {
  id: string;
  /** `https://host[:port]`, lowercase — what repo URLs are matched on. */
  origin: string;
  kind: GitServerKind;
  /** The REST API base for `github`/`gitlab` (`https://api.github.com`, `https://host/api/v4`, …). */
  apiUrl?: string;
  /** The account the token belongs to, when the server said. Also the HTTPS clone username for a plain git server. */
  username?: string;
  tokenEncrypted: string;
  addedAt: string;
}

/** Where the two pre-list tokens belonged: the configured hosts, else the public ones. */
function legacyOrigins(): Record<"github" | "gitlab", { origin: string; apiUrl?: string }> {
  const origin = (url: string) => new URL(url).origin.toLowerCase();
  return {
    github: { origin: origin(process.env.GITHUB_WEB_URL || "https://github.com"), apiUrl: process.env.GITHUB_API_URL || undefined },
    gitlab: { origin: origin(process.env.GITLAB_WEB_URL || "https://gitlab.com"), apiUrl: process.env.GITLAB_API_URL || undefined },
  };
}

/** Moves the old `githubPatEncrypted` / `gitlabPatEncrypted` settings into the list, once. */
async function migrateLegacy(): Promise<void> {
  const settings = await getSettings();
  if (!settings?.githubPatEncrypted && !settings?.gitlabPatEncrypted) return;
  const where = legacyOrigins();
  transaction(() => {
    const list = readKv<GitTokenRecord[]>(KEY) ?? [];
    for (const kind of ["github", "gitlab"] as const) {
      const encrypted = kind === "github" ? settings.githubPatEncrypted : settings.gitlabPatEncrypted;
      if (!encrypted || list.some((t) => t.origin === where[kind].origin)) continue;
      list.push({ id: `legacy-${kind}`, origin: where[kind].origin, kind, apiUrl: where[kind].apiUrl, tokenEncrypted: encrypted, addedAt: new Date().toISOString() });
    }
    writeKv(KEY, list);
  });
  await clearSettingsFields(["githubPatEncrypted", "gitlabPatEncrypted"]);
}

export async function listGitTokens(): Promise<GitTokenRecord[]> {
  await migrateLegacy();
  return readKv<GitTokenRecord[]>(KEY) ?? [];
}

/** Saves `token`, replacing any token already saved for the same origin. */
export async function saveGitToken(token: Omit<GitTokenRecord, "addedAt">): Promise<GitTokenRecord> {
  await migrateLegacy();
  const saved: GitTokenRecord = { ...token, addedAt: new Date().toISOString() };
  transaction(() => {
    const list = (readKv<GitTokenRecord[]>(KEY) ?? []).filter((t) => t.origin !== token.origin && t.id !== token.id);
    writeKv(KEY, [...list, saved]);
  });
  return saved;
}

export async function deleteGitToken(id: string): Promise<void> {
  await migrateLegacy();
  transaction(() => {
    writeKv(KEY, (readKv<GitTokenRecord[]>(KEY) ?? []).filter((t) => t.id !== id));
  });
}
