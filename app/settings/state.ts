// Shared client/server type + initial value for the settings form's
// `useActionState`. Split out from actions.ts because a "use server" file
// may only export async functions — an object literal export like
// `initialSaveSettingsState` there breaks the Next.js build/runtime with
// "A 'use server' file can only export async functions, found object."

export interface SaveSettingsState {
  status: "idle" | "success" | "error";
  error?: string;
  /** Whether this submission actually included a new GitHub PAT. */
  githubPatUpdated?: boolean;
  /** Whether this submission actually included a new AI API key. */
  aiApiKeyUpdated?: boolean;
}

export const initialSaveSettingsState: SaveSettingsState = { status: "idle" };

// ---------------------------------------------------------------------------
// Test connection (DESIGN.md §8) — `pingProvider` from lib/ai, run server-side
// ---------------------------------------------------------------------------

/**
 * Result of a provider ping. Note what is *not* here: no API key, and no
 * base URL echo. The action runs on the server precisely so the key — which
 * may be the decrypted stored one the browser has never seen (§11) — stays
 * there; only a verdict, a latency and the provider's own error text come
 * back.
 */
export interface TestConnectionState {
  status: "idle" | "ok" | "error";
  /** Round-trip time of the ping call, in ms. */
  latencyMs?: number;
  /** The model name that was actually pinged, so "ok" is unambiguous about what it tested. */
  model?: string;
  error?: string;
  /** Whether the ping used the saved (decrypted) key rather than one typed into the form. */
  usedSavedKey?: boolean;
}

export const initialTestConnectionState: TestConnectionState = {
  status: "idle",
};

// ---------------------------------------------------------------------------
// Clearing a saved credential
// ---------------------------------------------------------------------------

/** Which saved credential a clear action targeted. Submitted as the clear button's own `name`/`value`. */
export type ClearableCredential = "githubPat" | "aiApiKey";

export interface ClearCredentialState {
  status: "idle" | "success" | "error";
  field?: ClearableCredential;
  error?: string;
}

export const initialClearCredentialState: ClearCredentialState = {
  status: "idle",
};
