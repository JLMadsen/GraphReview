// Typed repository functions for saved AI providers. A user can save several
// (e.g. a local Ollama server alongside a hosted one) and flip which is
// active via `Settings.activeAiProviderId`, so switching providers is a click
// instead of re-typing a base URL/key/model. Every provider is the same
// generic OpenAI-compatible shape (no per-vendor fields).
//
// `apiKeyEncrypted` follows the same encrypt-at-rest contract as the other
// secret fields in settings — this module only persists whatever ciphertext
// it's given. lib/crypto/ owns encryption; app/settings/actions.ts calls it
// before any value reaches here.

import { randomUUID } from "node:crypto";
import { all, get, pack, run, transaction, unpack } from "./client";
import { getSettings, setActiveAiProviderIdField } from "./settings";

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
    apiKeyEncrypted: (props.apiKeyEncrypted as string | undefined) || undefined,
    model: props.model as string,
    createdAt: props.createdAt as string,
  };
}

function writeProvider(record: AiProviderRecord): void {
  run(
    `INSERT INTO ai_providers (id, created_at, data) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
    record.id,
    record.createdAt,
    pack(record)
  );
}

function readProvider(id: string): AiProviderRecord | null {
  const row = get<{ data: string }>(`SELECT data FROM ai_providers WHERE id = ?`, id);
  return row ? toAiProviderRecord(unpack(row.data)) : null;
}

/** All saved providers, oldest first. */
export async function listAiProviders(): Promise<AiProviderRecord[]> {
  return all<{ data: string }>(`SELECT data FROM ai_providers ORDER BY created_at ASC`).map((row) =>
    toAiProviderRecord(unpack(row.data))
  );
}

export async function getAiProvider(id: string): Promise<AiProviderRecord | null> {
  return readProvider(id);
}

/** The `id` of the currently active provider, or `null` if none is set (fresh install, or the active one was deleted). */
export async function getActiveAiProviderId(): Promise<string | null> {
  return (await getSettings())?.activeAiProviderId ?? null;
}

/** The currently active provider's full record, or `null` if none is active. */
export async function getActiveAiProvider(): Promise<AiProviderRecord | null> {
  const id = await getActiveAiProviderId();
  return id ? readProvider(id) : null;
}

export interface CreateAiProviderInput {
  name: string;
  baseUrl: string;
  apiKeyEncrypted: string;
  model: string;
}

/**
 * Saves a new provider. If no provider is active yet, it becomes the active
 * one — otherwise a freshly-configured local model would silently sit unused
 * until the user found the toggle.
 */
export async function createAiProvider(input: CreateAiProviderInput): Promise<AiProviderRecord> {
  const record = toAiProviderRecord({ id: randomUUID(), createdAt: new Date().toISOString(), ...input });
  const active = await getActiveAiProviderId();
  transaction(() => {
    writeProvider(record);
    if (!active) setActiveAiProviderIdField(record.id);
  });
  return record;
}

export type UpdateAiProviderInput = Partial<Pick<AiProviderRecord, "name" | "baseUrl" | "model" | "apiKeyEncrypted">>;

/**
 * Merges the given fields into an existing provider. An omitted (or empty)
 * field keeps its stored value — this is what lets a caller rename a
 * provider without resending an unrelated, already-saved API key.
 */
export async function updateAiProvider(id: string, fields: UpdateAiProviderInput): Promise<void> {
  transaction(() => {
    const existing = readProvider(id);
    if (!existing) return;
    const next = { ...existing };
    for (const key of ["name", "baseUrl", "model", "apiKeyEncrypted"] as const) {
      const value = fields[key];
      if (value !== undefined && value !== null) next[key] = value;
    }
    writeProvider(next);
  });
}

/**
 * Deletes a provider outright. If it was the active one,
 * `activeAiProviderId` is cleared rather than left dangling.
 */
export async function deleteAiProvider(id: string): Promise<void> {
  const active = await getActiveAiProviderId();
  transaction(() => {
    run(`DELETE FROM ai_providers WHERE id = ?`, id);
    if (active === id) setActiveAiProviderIdField(undefined);
  });
}

/** Sets which saved provider is active. Throws if `id` doesn't name an existing provider. */
export async function setActiveAiProvider(id: string): Promise<void> {
  if (!readProvider(id)) throw new Error(`No saved AI provider with id ${id}.`);
  setActiveAiProviderIdField(id);
}
