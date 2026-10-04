// The global settings record. Not repo-scoped — the GitHub/GitLab PATs and
// the active AI provider are shared instance-wide.
//
// This module only persists whatever strings it's given for the
// `*Encrypted` fields — encryption/decryption is lib/crypto/'s
// responsibility, not this module's. AI providers themselves live in
// lib/db/ai-provider.ts; `activeAiProviderId` here points at the one in use.

import { get, run, transaction, unpack } from "./client";

const SETTINGS_KEY = "settings";

export interface SettingsRecord {
  githubPatEncrypted?: string;
  gitlabPatEncrypted?: string;
  /** Which saved AI provider (lib/db/ai-provider.ts) is active, if any. */
  activeAiProviderId?: string;
}

function read(): SettingsRecord | null {
  const row = get<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, SETTINGS_KEY);
  return row ? unpack<SettingsRecord>(row.value) : null;
}

function write(record: SettingsRecord): void {
  run(
    `INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    SETTINGS_KEY,
    JSON.stringify(record)
  );
}

/** Returns the global settings, or `null` before anything has been saved. */
export async function getSettings(): Promise<SettingsRecord | null> {
  return read();
}

/**
 * Merges the given fields into the global settings, creating them on first
 * use. Only fields present (and non-empty) in `fields` are written — omitted
 * fields keep their stored value, so a caller can update one PAT without
 * resending the other. Use {@link clearSettingsFields} to remove one.
 */
export async function upsertSettings(fields: Partial<SettingsRecord>): Promise<void> {
  transaction(() => {
    const next: SettingsRecord = { ...(read() ?? {}) };
    for (const [key, value] of Object.entries(fields) as Array<[keyof SettingsRecord, string | undefined]>) {
      if (value !== undefined && value !== null) next[key] = value;
    }
    write(next);
  });
}

/** The fields `clearSettingsFields` will act on. */
export type SettingsField = keyof SettingsRecord;

const CLEARABLE_FIELDS: readonly SettingsField[] = ["githubPatEncrypted", "gitlabPatEncrypted"];

/**
 * Removes the given fields from the global settings outright, so a cleared
 * credential leaves nothing behind (not even an empty string a later
 * "is a secret saved?" check could misread).
 */
export async function clearSettingsFields(fields: readonly SettingsField[]): Promise<void> {
  const targets = CLEARABLE_FIELDS.filter((field) => fields.includes(field));
  if (targets.length === 0) return;
  transaction(() => {
    const current = read();
    if (!current) return;
    for (const field of targets) delete current[field];
    write(current);
  });
}

/** Sets or clears `activeAiProviderId`. For ai-provider.ts. */
export function setActiveAiProviderIdField(id: string | undefined): void {
  transaction(() => {
    const next: SettingsRecord = { ...(read() ?? {}) };
    if (id) next.activeAiProviderId = id;
    else delete next.activeAiProviderId;
    write(next);
  });
}
