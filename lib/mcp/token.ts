// The optional MCP bearer token (DESIGN.md §6.26 §3). Off by default: the
// endpoint is loopback-only (middleware.ts), which is enough for one person
// on their own machine. Turned on in Settings, every POST /api/mcp must send
// `Authorization: Bearer <token>` — for a machine where other local users or
// processes shouldn't read reviews. Stored encrypted like the PATs; unlike
// them it is shown back in Settings, since agents' config needs it.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { decrypt, encrypt } from "@/lib/crypto";
import { clearSettingsFields, getSettings, upsertSettings } from "@/lib/db";

/** The token, or `null` when none is required. */
export async function getMcpToken(): Promise<string | null> {
  const stored = (await getSettings())?.mcpTokenEncrypted;
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch {
    // Unreadable (the key changed): fail closed with a token nobody has.
    return randomBytes(32).toString("base64url");
  }
}

/** Generates and stores a new token (replacing any old one) and returns it. */
export async function createMcpToken(): Promise<string> {
  const token = `grmcp_${randomBytes(32).toString("base64url")}`;
  await upsertSettings({ mcpTokenEncrypted: encrypt(token) });
  return token;
}

export async function clearMcpToken(): Promise<void> {
  await clearSettingsFields(["mcpTokenEncrypted"]);
}

/** Whether a request may use the MCP endpoint: always with no token set, else only with a matching bearer header. */
export function mcpRequestAllowed(authorization: string | null, token: string | null): boolean {
  if (!token) return true;
  const sent = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "")?.[1]?.trim();
  if (!sent) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
