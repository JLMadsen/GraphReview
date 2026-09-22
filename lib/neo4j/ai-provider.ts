// Typed repository functions for `(:AiProvider)` nodes. Originally a single
// AI provider config lived directly on the `Settings` node; now a user can
// save several (e.g. a local Ollama server alongside a hosted one) and flip
// which is active via `Settings.activeAiProviderId`, so switching providers
// is a click instead of hunting down and re-typing a base URL/key/model.
// Every provider is still the same generic OpenAI-compatible shape (no
// per-vendor fields); this only adds "more than one, with a selector".
//
// `apiKeyEncrypted` follows the same encrypt-at-rest contract as the other
// secret fields on `Settings` — this module only persists whatever
// ciphertext it's given. lib/crypto/ owns encryption; app/settings/actions.ts
// calls it before any value reaches here.

import { randomUUID } from "node:crypto";
import { runRead, runWrite } from "./client";
import { getSettings } from "./settings";

export interface AiProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEncrypted?: string;
  model: string;
  createdAt: string;
}

function toAiProviderRecord(props: Record<string, unknown>): AiProviderRecord {
  return {
    id: props.id as string,
    name: props.name as string,
    baseUrl: props.baseUrl as string,
    apiKeyEncrypted: (props.apiKeyEncrypted as string | undefined) ?? undefined,
    model: props.model as string,
    createdAt: props.createdAt as string,
  };
}

/**
 * Fixed id for the provider node created by the legacy migration below —
 * deliberately not `randomUUID()`. This module's callers routinely run
 * several of their functions concurrently (e.g. the settings page loads
 * `listAiProviders()` and `getActiveAiProviderId()` in the same
 * `Promise.all`), so more than one migration attempt can be in flight at
 * once. A fixed id lets every attempt `MERGE` onto the *same* node instead
 * of racing a read-then-write "does a provider exist yet" check — which, in
 * an earlier version of this function, let two concurrent calls each see
 * zero providers and both `CREATE` one, leaving a duplicate behind.
 */
const LEGACY_PROVIDER_ID = "legacy-default-provider";

/**
 * One-time migration from the pre-multi-provider schema, where base
 * URL/key/model lived directly as `aiBaseUrl`/`aiApiKeyEncrypted`/`aiModel`
 * on `Settings`. Runs lazily at the top of every read/write in this module
 * (cheap: one short query, and a no-op once the legacy fields are gone)
 * rather than as a startup migration in schema.ts, so it fires the moment
 * anything asks about providers regardless of whether the worker has run
 * its own migrations yet. This is what lets someone who already configured
 * a provider under the old single-provider settings keep using it — it
 * becomes their first saved provider, auto-selected active — without
 * re-entering anything.
 */
async function migrateLegacySingleProvider(): Promise<void> {
  const settings = await getSettings();
  if (!settings?.aiBaseUrl && !settings?.aiApiKeyEncrypted && !settings?.aiModel) {
    return;
  }

  await runWrite(
    `
    MERGE (s:Settings {id: "global"})
    MERGE (p:AiProvider {id: $id})
    ON CREATE SET
      p.name = $name, p.baseUrl = $baseUrl,
      p.apiKeyEncrypted = $apiKeyEncrypted, p.model = $model, p.createdAt = $createdAt
    MERGE (s)-[:HAS_AI_PROVIDER]->(p)
    SET s.activeAiProviderId = coalesce(s.activeAiProviderId, $id)
    REMOVE s.aiBaseUrl, s.aiApiKeyEncrypted, s.aiModel
    `,
    {
      id: LEGACY_PROVIDER_ID,
      name: "Default",
      baseUrl: settings.aiBaseUrl ?? "",
      apiKeyEncrypted: settings.aiApiKeyEncrypted ?? null,
      model: settings.aiModel ?? "",
      createdAt: new Date().toISOString(),
    }
  );
}

/** All saved providers, oldest first. */
export async function listAiProviders(): Promise<AiProviderRecord[]> {
  await migrateLegacySingleProvider();
  const result = await runRead(
    `MATCH (p:AiProvider) RETURN p ORDER BY p.createdAt ASC`
  );
  return result.records.map((r) => toAiProviderRecord(r.get("p").properties));
}

export async function getAiProvider(id: string): Promise<AiProviderRecord | null> {
  const result = await runRead(`MATCH (p:AiProvider {id: $id}) RETURN p`, { id });
  const record = result.records[0];
  return record ? toAiProviderRecord(record.get("p").properties) : null;
}

/**
 * The `id` of the currently active provider, or `null` if none is set yet
 * (fresh install, or the active one was deleted). Cheap enough to call
 * alongside `listAiProviders()` for rendering the toggle without fetching
 * the whole active record.
 */
export async function getActiveAiProviderId(): Promise<string | null> {
  await migrateLegacySingleProvider();
  const settings = await getSettings();
  return settings?.activeAiProviderId ?? null;
}

/** The currently active provider's full record, or `null` if none is active. */
export async function getActiveAiProvider(): Promise<AiProviderRecord | null> {
  await migrateLegacySingleProvider();
  const result = await runRead(
    `
    MATCH (s:Settings {id: "global"})
    WHERE s.activeAiProviderId IS NOT NULL
    MATCH (p:AiProvider {id: s.activeAiProviderId})
    RETURN p
    `
  );
  const record = result.records[0];
  return record ? toAiProviderRecord(record.get("p").properties) : null;
}

export interface CreateAiProviderInput {
  name: string;
  baseUrl: string;
  apiKeyEncrypted: string;
  model: string;
}

/**
 * Creates a new provider and links it to the `Settings` singleton (created
 * on first use). If it's the first provider ever saved, it also becomes the
 * active one — otherwise a freshly-configured local model would silently
 * sit unused until the user found the toggle.
 */
export async function createAiProvider(
  input: CreateAiProviderInput
): Promise<AiProviderRecord> {
  await migrateLegacySingleProvider();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const result = await runWrite(
    `
    MERGE (s:Settings {id: "global"})
    CREATE (p:AiProvider {
      id: $id, name: $name, baseUrl: $baseUrl,
      apiKeyEncrypted: $apiKeyEncrypted, model: $model, createdAt: $createdAt
    })
    MERGE (s)-[:HAS_AI_PROVIDER]->(p)
    SET s.activeAiProviderId = coalesce(s.activeAiProviderId, $id)
    RETURN p
    `,
    { id, createdAt, ...input }
  );
  return toAiProviderRecord(result.records[0].get("p").properties);
}

export type UpdateAiProviderInput = Partial<
  Pick<AiProviderRecord, "name" | "baseUrl" | "model" | "apiKeyEncrypted">
>;

/**
 * Merges the given fields into an existing provider. As with
 * `upsertSettings`, an omitted field keeps its stored value — this is what
 * lets a caller rename a provider or repoint its base URL without resending
 * an unrelated, already-saved API key.
 */
export async function updateAiProvider(
  id: string,
  fields: UpdateAiProviderInput
): Promise<void> {
  await runWrite(
    `
    MATCH (p:AiProvider {id: $id})
    SET p.name = coalesce($name, p.name),
        p.baseUrl = coalesce($baseUrl, p.baseUrl),
        p.model = coalesce($model, p.model),
        p.apiKeyEncrypted = coalesce($apiKeyEncrypted, p.apiKeyEncrypted)
    `,
    {
      id,
      name: fields.name ?? null,
      baseUrl: fields.baseUrl ?? null,
      model: fields.model ?? null,
      apiKeyEncrypted: fields.apiKeyEncrypted ?? null,
    }
  );
}

/**
 * Deletes a provider outright. If it was the active one,
 * `Settings.activeAiProviderId` is cleared rather than left pointing at a
 * now-nonexistent node — `getActiveAiProvider` then correctly reports
 * "nothing active" instead of silently resolving to nothing every call.
 */
export async function deleteAiProvider(id: string): Promise<void> {
  await runWrite(`MATCH (p:AiProvider {id: $id}) DETACH DELETE p`, { id });
  await runWrite(
    `
    MATCH (s:Settings {id: "global"})
    WHERE s.activeAiProviderId = $id
    REMOVE s.activeAiProviderId
    `,
    { id }
  );
}

/**
 * Sets which saved provider is active. Throws if `id` doesn't name an
 * existing provider, so the active pointer can never end up dangling.
 */
export async function setActiveAiProvider(id: string): Promise<void> {
  const result = await runWrite(
    `
    MATCH (p:AiProvider {id: $id})
    MATCH (s:Settings {id: "global"})
    SET s.activeAiProviderId = $id
    RETURN p
    `,
    { id }
  );
  if (result.records.length === 0) {
    throw new Error(`No saved AI provider with id ${id}.`);
  }
}
