"use server";

// Server action backing the settings form (DESIGN.md §4, §11).
//
// Plaintext secrets (GitHub PAT, AI provider API key) are submitted here as
// FormData from the client and encrypted (lib/crypto) before ever being
// persisted via lib/neo4j's Settings module — they are never sent back to
// the client in plaintext, and never round-tripped through anything
// client-persisted along the way.

import { revalidatePath } from "next/cache";
import { pingProvider } from "@/lib/ai";
import { decrypt, encrypt } from "@/lib/crypto";
import { clearSettingsFields, getSettings, upsertSettings } from "@/lib/neo4j";
import type { SettingsField, SettingsRecord } from "@/lib/neo4j";
import type {
  ClearableCredential,
  ClearCredentialState,
  SaveSettingsState,
  TestConnectionState,
} from "./state";

function readField(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function saveSettingsAction(
  _prevState: SaveSettingsState,
  formData: FormData
): Promise<SaveSettingsState> {
  try {
    const githubPat = readField(formData, "githubPat");
    const aiApiKey = readField(formData, "aiApiKey");
    const aiBaseUrl = readField(formData, "aiBaseUrl");
    const aiModel = readField(formData, "aiModel");

    const fields: Partial<SettingsRecord> = {};

    // The client only renders the GitHub PAT / API key inputs once the user
    // clicks "Replace" (see settings-form.tsx) — otherwise those fields are
    // shown masked and are not part of the submitted form at all. So a
    // blank value here means "leave the currently-saved secret alone",
    // never "clear it".
    if (githubPat) fields.githubPatEncrypted = encrypt(githubPat);
    if (aiApiKey) fields.aiApiKeyEncrypted = encrypt(aiApiKey);

    // Base URL / model name are always shown plainly and editable, so
    // whatever the user submits — including an empty string, to clear a
    // previously-saved value — is written through as-is. (Unlike the
    // secret fields above, `upsertSettings` only preserves a field when it
    // is entirely omitted/undefined; an explicit "" is a real value.)
    fields.aiBaseUrl = aiBaseUrl;
    fields.aiModel = aiModel;

    await upsertSettings(fields);
    revalidatePath("/settings");

    return {
      status: "success",
      githubPatUpdated: Boolean(githubPat),
      aiApiKeyUpdated: Boolean(aiApiKey),
    };
  } catch (err) {
    return {
      status: "error",
      error:
        err instanceof Error ? err.message : "Failed to save settings.",
    };
  }
}

/**
 * "Test connection" for the AI provider card (DESIGN.md §8).
 *
 * Submitted from the same form as the save action, so it sees whatever is
 * currently *typed* — the point being that you can verify a base URL/model
 * before committing them. Resolution order per field is "typed, else
 * saved", which makes the common case work: base URL and model are typed
 * (they're plain, always-visible inputs) while the API key input isn't even
 * rendered when one is already stored, so the stored ciphertext is
 * decrypted here, server-side, and used.
 *
 * The decrypted key never leaves this function — `TestConnectionState`
 * carries a verdict, a latency and the provider's error text, nothing else.
 * Nothing is persisted either: a test is a test, not a save.
 */
export async function testAiConnectionAction(
  _prevState: TestConnectionState,
  formData: FormData
): Promise<TestConnectionState> {
  try {
    const typedBaseUrl = readField(formData, "aiBaseUrl");
    const typedModel = readField(formData, "aiModel");
    const typedApiKey = readField(formData, "aiApiKey");

    const settings = await getSettings();

    const baseUrl = typedBaseUrl || settings?.aiBaseUrl || "";
    const model = typedModel || settings?.aiModel || "";

    let apiKey = typedApiKey;
    let usedSavedKey = false;
    if (!apiKey && settings?.aiApiKeyEncrypted) {
      try {
        apiKey = decrypt(settings.aiApiKeyEncrypted);
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

/** The two clearable credentials, mapped onto the Settings node properties they live in (§7, §11). */
const CREDENTIAL_FIELDS: Record<ClearableCredential, SettingsField> = {
  githubPat: "githubPatEncrypted",
  aiApiKey: "aiApiKeyEncrypted",
};

/**
 * Deletes one saved credential outright.
 *
 * The form's save path can never do this: an empty secret input means
 * "leave the stored one alone" (see `saveSettingsAction`), which is what
 * makes the masked "PAT saved · Replace" UI possible in the first place. So
 * removing a credential needs its own verb — `clearSettingsFields` in
 * lib/neo4j, which `REMOVE`s the property rather than blanking it.
 *
 * `field` is a *bound* first argument (`clearCredentialAction.bind(null,
 * "aiApiKey")` in the form), not something read out of `formData`. The
 * obvious-looking alternative — one action serving both buttons, each
 * carrying its own `name`/`value` — does not work: React 19 builds the
 * FormData for a server action itself and does not include the submitter
 * button's name/value pair the way a native form submission would, so the
 * field always arrived empty and every clear failed with "Unknown
 * credential." Binding sidesteps the question entirely, and also makes the
 * argument impossible to forge from the client, since a bound value is
 * carried in the action's own encrypted reference rather than in the
 * request body.
 *
 * There is nothing else to read, so the usual `(prevState, formData)` tail
 * is simply not declared — `useActionState` still passes both, and JS drops
 * the extra arguments.
 */
export async function clearCredentialAction(
  field: ClearableCredential
): Promise<ClearCredentialState> {
  if (field !== "githubPat" && field !== "aiApiKey") {
    return { status: "error", error: "Unknown credential." };
  }

  try {
    await clearSettingsFields([CREDENTIAL_FIELDS[field]]);
    revalidatePath("/settings");
    return { status: "success", field };
  } catch (err) {
    return {
      status: "error",
      field,
      error:
        err instanceof Error ? err.message : "Failed to clear the credential.",
    };
  }
}
