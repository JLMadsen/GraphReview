"use server";

// Server actions backing the settings page.
//
// Plaintext secrets (git server tokens, AI provider API keys) are submitted here as
// FormData from the client and encrypted (lib/crypto) before ever being
// persisted via lib/db — they are never sent back to the client in
// plaintext, and never round-tripped through anything client-persisted
// along the way.
//
// AI provider config lives as a list of saved AI providers
// (lib/db/ai-provider.ts) rather than directly on `Settings`, so a user
// can save several (e.g. a local model server alongside a hosted one) and
// flip which is active without re-entering anything. Git server tokens are
// a list too, one per server (lib/db/git-tokens.ts, DESIGN.md §6.30).

import { revalidatePath } from "next/cache";
import { pingProvider } from "@/lib/ai";
import {
  discoverLocalProviders,
  isLocalBaseUrl,
  publicCandidate,
} from "@/lib/ai/local-configs";
import { decrypt, encrypt } from "@/lib/crypto";
import { clearMcpToken, createMcpToken } from "@/lib/mcp/token";
import { probeGitServer } from "@/lib/jobs/git-server-probe";
import {
  createAiProvider,
  deleteGitToken,
  deleteAiProvider,
  getAiProvider,
  listAiProviders,
  saveGitToken,
  setActiveAiProvider,
  updateAiProvider,
} from "@/lib/db";
import type {
  DeleteAiProviderState,
  DeleteGitServerTokenState,
  ImportLocalProvidersState,
  LocalProviderSelection,
  PublicLocalProviderCandidate,
  SaveAiProviderState,
  SaveGitServerTokenState,
  SetActiveAiProviderState,
  TestConnectionState,
} from "./state";

function readField(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

// ---------------------------------------------------------------------------
// Git servers — one token per server (DESIGN.md §6.30)
// ---------------------------------------------------------------------------

/**
 * Saves a token for a server. The server is asked once what it is (GitHub,
 * GitLab or another git server) and who the token belongs to; a token a
 * GitHub/GitLab API refuses is not saved. A second token for the same
 * server replaces the first.
 */
export async function saveGitServerTokenAction(
  _prevState: SaveGitServerTokenState,
  formData: FormData
): Promise<SaveGitServerTokenState> {
  const server = readField(formData, "server");
  const token = readField(formData, "token");
  const username = readField(formData, "username");
  if (!server || !token) return { status: "error", error: "Enter the server and its token." };
  try {
    const probed = await probeGitServer(server, token);
    const saved = await saveGitToken({
      id: crypto.randomUUID(),
      origin: probed.origin,
      kind: probed.kind,
      apiUrl: probed.apiUrl,
      username: username || probed.username,
      tokenEncrypted: encrypt(token),
    });
    revalidatePath("/settings");
    return { status: "success", saved: { id: saved.id, origin: saved.origin, kind: saved.kind, username: saved.username } };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "Failed to save the token." };
  }
}

export async function deleteGitServerTokenAction(id: string): Promise<DeleteGitServerTokenState> {
  try {
    await deleteGitToken(id);
    revalidatePath("/settings");
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "Failed to remove the token." };
  }
}

// ---------------------------------------------------------------------------
// AI providers (multiple, one active)
// ---------------------------------------------------------------------------

/**
 * Creates a new saved AI provider from the "Add provider" form. Becomes the
 * active provider automatically if it's the first one ever saved
 * (lib/db/ai-provider.ts) — otherwise it's just added to the list, active
 * selection unchanged, so adding a second provider never silently switches
 * what a running review/label job is using.
 */
export async function createAiProviderAction(
  _prevState: SaveAiProviderState,
  formData: FormData
): Promise<SaveAiProviderState> {
  try {
    const name = readField(formData, "name");
    const baseUrl = readField(formData, "baseUrl");
    const apiKey = readField(formData, "apiKey");
    const model = readField(formData, "model");

    const missing = [
      name ? null : "name",
      baseUrl ? null : "base URL",
      apiKey ? null : "API key",
      model ? null : "model name",
    ].filter((field): field is string => field !== null);
    if (missing.length > 0) {
      return { status: "error", error: `Missing ${missing.join(", ")}.` };
    }

    await createAiProvider({
      name,
      baseUrl,
      apiKeyEncrypted: encrypt(apiKey),
      model,
    });
    revalidatePath("/settings");
    return { status: "success", apiKeyUpdated: true };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : "Failed to save the provider.",
    };
  }
}

/**
 * Updates an existing provider's name/base URL/model, and its API key only
 * if a new one was typed (blank means "keep the saved key" — same
 * masked-secret convention as the git server tokens).
 *
 * `providerId` is a *bound* first argument
 * (`updateAiProviderAction.bind(null, provider.id)` in the form), for the
 * same reason `clearCredentialAction` used to bind its field: React 19
 * builds the FormData for a server action itself and does not include a
 * submitter button's own name/value, so a hidden `providerId` input would
 * work but a bound argument is simpler and can't be forged from the client.
 */
export async function updateAiProviderAction(
  providerId: string,
  _prevState: SaveAiProviderState,
  formData: FormData
): Promise<SaveAiProviderState> {
  try {
    const name = readField(formData, "name");
    const baseUrl = readField(formData, "baseUrl");
    const apiKey = readField(formData, "apiKey");
    const model = readField(formData, "model");

    const missing = [
      name ? null : "name",
      baseUrl ? null : "base URL",
      model ? null : "model name",
    ].filter((field): field is string => field !== null);
    if (missing.length > 0) {
      return { status: "error", error: `Missing ${missing.join(", ")}.` };
    }

    await updateAiProvider(providerId, {
      name,
      baseUrl,
      model,
      apiKeyEncrypted: apiKey ? encrypt(apiKey) : undefined,
    });
    revalidatePath("/settings");
    return { status: "success", apiKeyUpdated: Boolean(apiKey) };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : "Failed to update the provider.",
    };
  }
}

/** Deletes a saved provider outright. `providerId` is bound, same as `updateAiProviderAction`. */
export async function deleteAiProviderAction(
  providerId: string
): Promise<DeleteAiProviderState> {
  try {
    await deleteAiProvider(providerId);
    revalidatePath("/settings");
    return { status: "success" };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : "Failed to delete the provider.",
    };
  }
}

/**
 * Flips which saved provider is active — the toggle. `providerId` is bound,
 * same as `updateAiProviderAction`.
 */
export async function setActiveAiProviderAction(
  providerId: string
): Promise<SetActiveAiProviderState> {
  try {
    await setActiveAiProvider(providerId);
    revalidatePath("/settings");
    return { status: "success" };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : "Failed to switch the active provider.",
    };
  }
}

/**
 * "Test connection" for a provider card.
 *
 * Works for both a saved provider (`providerId` present — resolves
 * typed-else-saved base URL/model, and decrypts the stored key unless a new
 * one was typed) and the "Add provider" form before it's ever been saved
 * (`providerId` absent — everything must come from the form). Nothing is
 * persisted either way: a test is a test, not a save. The decrypted key
 * never leaves this function — `TestConnectionState` carries a verdict, a
 * latency and the provider's error text, nothing else.
 */
export async function testAiConnectionAction(
  _prevState: TestConnectionState,
  formData: FormData
): Promise<TestConnectionState> {
  try {
    const providerId = readField(formData, "providerId");
    const typedBaseUrl = readField(formData, "baseUrl");
    const typedModel = readField(formData, "model");
    const typedApiKey = readField(formData, "apiKey");

    const saved = providerId ? await getAiProvider(providerId) : null;

    const baseUrl = typedBaseUrl || saved?.baseUrl || "";
    const model = typedModel || saved?.model || "";

    let apiKey = typedApiKey;
    let usedSavedKey = false;
    if (!apiKey && saved?.apiKeyEncrypted) {
      try {
        apiKey = decrypt(saved.apiKeyEncrypted);
        usedSavedKey = true;
      } catch {
        return {
          status: "error",
          error:
            "The saved API key could not be decrypted — SESSION_SECRET has probably changed since it was stored. Enter the key again.",
        };
      }
    }

    const missing = [
      baseUrl ? null : "base URL",
      apiKey ? null : "API key",
      model ? null : "model name",
    ].filter((field): field is string => field !== null);
    if (missing.length > 0) {
      return {
        status: "error",
        error: `Missing ${missing.join(", ")} — fill those in first (they don't have to be saved yet).`,
      };
    }

    const result = await pingProvider({ baseUrl, apiKey, model });
    if (!result.ok) {
      return {
        status: "error",
        // Provider error bodies can be long (a whole HTML error page, for
        // one misconfigured base URL); one line is enough to diagnose.
        error: (result.error ?? "The provider did not respond.").slice(0, 300),
        latencyMs: result.latencyMs,
        model,
        usedSavedKey,
      };
    }

    return {
      status: "ok",
      latencyMs: result.latencyMs,
      model,
      usedSavedKey,
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : "The connection test failed.",
    };
  }
}


// ---------------------------------------------------------------------------
// "Use local config" — providers found in local harness configs (DESIGN.md §6.17)
// ---------------------------------------------------------------------------

/** Base URLs compare equal regardless of a trailing slash. */
function sameBaseUrl(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
}

/**
 * Scans the usual harness config locations. What comes back has no keys —
 * only whether one was found and where — plus the saved provider each
 * candidate already matches (same base URL), so the list can say so.
 */
export async function discoverLocalProvidersAction(): Promise<
  Array<PublicLocalProviderCandidate & { savedAs?: string }>
> {
  const saved = await listAiProviders();
  return discoverLocalProviders().map((candidate) => ({
    ...publicCandidate(candidate),
    savedAs: saved.find((p) => sameBaseUrl(p.baseUrl, candidate.baseUrl))?.name,
  }));
}

/**
 * Saves the selected candidates as providers. The configs are read again
 * here, by candidate id, so the key goes straight from the user's config
 * file to `encrypt` without passing through the browser. A local server
 * with no key gets a placeholder (any key works there); anything else
 * without one needs a key typed into the list.
 */
export async function importLocalProvidersAction(
  selections: LocalProviderSelection[]
): Promise<ImportLocalProvidersState> {
  try {
    if (selections.length === 0) return { status: "error", error: "Select at least one provider." };
    const found = new Map(discoverLocalProviders().map((c) => [c.id, c]));

    const toSave: Array<{ name: string; baseUrl: string; apiKey: string; model: string }> = [];
    for (const selection of selections) {
      const candidate = found.get(selection.candidateId);
      if (!candidate) {
        return { status: "error", error: `${selection.name} is no longer in the local config — scan again.` };
      }
      const model = selection.model.trim();
      if (!model) return { status: "error", error: `Pick a model for ${selection.name}.` };
      const apiKey =
        selection.apiKey?.trim() || candidate.apiKey || (isLocalBaseUrl(candidate.baseUrl) ? "local" : "");
      if (!apiKey) return { status: "error", error: `${selection.name} needs an API key.` };
      toSave.push({ name: selection.name.trim() || candidate.name, baseUrl: candidate.baseUrl, apiKey, model });
    }

    for (const provider of toSave) {
      await createAiProvider({
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKeyEncrypted: encrypt(provider.apiKey),
        model: provider.model,
      });
    }
    revalidatePath("/settings");
    return { status: "success", imported: toSave.length };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : "Failed to load the providers.",
    };
  }
}

// ---------------------------------------------------------------------------
// MCP bearer token (DESIGN.md §6.26 §3) — off by default
// ---------------------------------------------------------------------------

/** Turns the token on, or replaces it; agents set up with the old one stop working. */
export async function createMcpTokenAction(): Promise<{ status: "success" | "error"; error?: string }> {
  try {
    await createMcpToken();
    revalidatePath("/settings");
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "Failed to create the MCP token." };
  }
}

export async function clearMcpTokenAction(): Promise<{ status: "success" | "error"; error?: string }> {
  try {
    await clearMcpToken();
    revalidatePath("/settings");
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "Failed to turn the MCP token off." };
  }
}
