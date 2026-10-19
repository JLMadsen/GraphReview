// Shared client/server type + initial value for the settings form's
// `useActionState`. Split out from actions.ts because a "use server" file
// may only export async functions — an object literal export like
// `initialSaveSettingsState` there breaks the Next.js build/runtime with
// "A 'use server' file can only export async functions, found object."

// ---------------------------------------------------------------------------
// Git servers — one token per server (DESIGN.md §6.30)
// ---------------------------------------------------------------------------

/** A saved server token as the browser sees it: never the token itself. */
export interface GitServerTokenSummary {
  id: string;
  origin: string;
  kind: "github" | "gitlab" | "git";
  username?: string;
}

export interface SaveGitServerTokenState {
  status: "idle" | "success" | "error";
  error?: string;
  saved?: GitServerTokenSummary;
}

export const initialSaveGitServerTokenState: SaveGitServerTokenState = { status: "idle" };

export interface DeleteGitServerTokenState {
  status: "idle" | "success" | "error";
  error?: string;
}

// ---------------------------------------------------------------------------
// Test connection — `pingProvider` from lib/ai, run server-side
// ---------------------------------------------------------------------------

/**
 * Result of a provider ping. Note what is *not* here: no API key, and no
 * base URL echo. The action runs on the server precisely so the key — which
 * may be the decrypted stored one the browser has never seen — stays
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
// AI providers (multiple, one active) — extended
// ---------------------------------------------------------------------------

export interface SaveAiProviderState {
  status: "idle" | "success" | "error";
  error?: string;
  /** Whether this submission actually included a new API key (create, or a replace on edit). */
  apiKeyUpdated?: boolean;
}

export const initialSaveAiProviderState: SaveAiProviderState = { status: "idle" };

export interface DeleteAiProviderState {
  status: "idle" | "success" | "error";
  error?: string;
}

export const initialDeleteAiProviderState: DeleteAiProviderState = {
  status: "idle",
};

export interface SetActiveAiProviderState {
  status: "idle" | "success" | "error";
  error?: string;
}

export const initialSetActiveAiProviderState: SetActiveAiProviderState = {
  status: "idle",
};

// ---------------------------------------------------------------------------
// "Use local config" — providers found in local harness configs
// ---------------------------------------------------------------------------

export type { PublicLocalProviderCandidate } from "@/lib/ai/local-configs";

export interface LocalProviderSelection {
  candidateId: string;
  name: string;
  model: string;
  /** Typed in the import list, for a candidate whose config had no usable key. */
  apiKey?: string;
}

export interface ImportLocalProvidersState {
  status: "idle" | "success" | "error";
  imported?: number;
  error?: string;
}
