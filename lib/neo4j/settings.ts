// Typed repository functions for the singleton `(:Settings {id: "global"})`
// node (DESIGN.md §7, §11). Not repoId-scoped — GitHub PAT and AI provider
// config are shared instance-wide under decision #6.
//
// This module only persists whatever strings it's given for the two
// `*Encrypted` fields — encryption/decryption is lib/crypto/'s
// responsibility (§11), not this module's.
//
// AI provider config no longer lives directly on this node — it moved to
// `(:AiProvider)` nodes (lib/neo4j/ai-provider.ts) so more than one can be
// saved at once, with `activeAiProviderId` here pointing at whichever is
// in use. `aiBaseUrl`/`aiApiKeyEncrypted`/`aiModel` below are kept only as
// the read side of ai-provider.ts's one-time migration off the old
// single-provider shape; nothing writes them anymore.

import { runRead, runWrite } from "./client";

const SETTINGS_ID = "global";

export interface SettingsRecord {
  githubPatEncrypted?: string;
  /** Which saved `(:AiProvider)` node (lib/neo4j/ai-provider.ts) is active, if any. */
  activeAiProviderId?: string;
  /**
   * @deprecated Pre-multi-provider fields. Only ever read by
   * ai-provider.ts's one-time migration into `AiProvider` nodes — new code
   * should go through lib/neo4j/ai-provider.ts instead.
   */
  aiBaseUrl?: string;
  /** @deprecated See `aiBaseUrl`. */
  aiApiKeyEncrypted?: string;
  /** @deprecated See `aiBaseUrl`. */
  aiModel?: string;
}

function toSettingsRecord(props: Record<string, unknown>): SettingsRecord {
  return {
    githubPatEncrypted:
      (props.githubPatEncrypted as string | undefined) ?? undefined,
    activeAiProviderId:
      (props.activeAiProviderId as string | undefined) ?? undefined,
    aiBaseUrl: (props.aiBaseUrl as string | undefined) ?? undefined,
    aiApiKeyEncrypted:
      (props.aiApiKeyEncrypted as string | undefined) ?? undefined,
    aiModel: (props.aiModel as string | undefined) ?? undefined,
  };
}

/** Returns the global settings singleton, or `null` if it hasn't been created yet (e.g. on first run before any settings have been saved). */
export async function getSettings(): Promise<SettingsRecord | null> {
  const result = await runRead(
    `MATCH (s:Settings {id: $id}) RETURN s`,
    { id: SETTINGS_ID }
  );
  const record = result.records[0];
  return record ? toSettingsRecord(record.get("s").properties) : null;
}

/**
 * Merges the given fields into the global settings singleton, creating it
 * on first use. Only the fields present in `fields` are written — omitted
 * fields keep their existing stored value, so a caller can update e.g.
 * just `aiModel` without resending the encrypted PAT.
 */
export async function upsertSettings(
  fields: Partial<SettingsRecord>
): Promise<void> {
  await runWrite(
    `
    MERGE (s:Settings {id: $id})
    SET s.githubPatEncrypted = coalesce($githubPatEncrypted, s.githubPatEncrypted),
        s.aiBaseUrl = coalesce($aiBaseUrl, s.aiBaseUrl),
        s.aiApiKeyEncrypted = coalesce($aiApiKeyEncrypted, s.aiApiKeyEncrypted),
        s.aiModel = coalesce($aiModel, s.aiModel)
    `,
    {
      id: SETTINGS_ID,
      githubPatEncrypted: fields.githubPatEncrypted ?? null,
      aiBaseUrl: fields.aiBaseUrl ?? null,
      aiApiKeyEncrypted: fields.aiApiKeyEncrypted ?? null,
      aiModel: fields.aiModel ?? null,
    }
  );
}

/** The fields `clearSettingsFields` will act on. */
export type SettingsField = keyof SettingsRecord;

const CLEARABLE_FIELDS: readonly SettingsField[] = [
  "githubPatEncrypted",
  "aiBaseUrl",
  "aiApiKeyEncrypted",
  "aiModel",
];

/**
 * Removes the given properties from the global settings singleton.
 *
 * `upsertSettings` above deliberately cannot do this: its `coalesce($x, s.x)`
 * treats "absent" as "keep", which is exactly what lets a caller update the
 * model name without resending the encrypted PAT — but it also means there
 * is no value a caller can pass that *unsets* a field. Writing `""` would
 * leave a stored empty string behind, which `getSettings` would hand back as
 * `""` rather than `undefined`, so every "is a secret saved?" check
 * (`Boolean(settings.aiApiKeyEncrypted)`) would be subtly right by accident
 * while the ciphertext slot still existed in the database. `REMOVE` deletes
 * the property outright, which is what "clear my saved credential" should
 * actually mean (§11).
 *
 * Cypher cannot parameterize a property *name*, so the removal list is
 * spliced into the query text — hence the strict allow-list, which makes
 * that splice provably closed over four literal identifiers regardless of
 * what a caller passes.
 */
export async function clearSettingsFields(
  fields: readonly SettingsField[]
): Promise<void> {
  const targets = CLEARABLE_FIELDS.filter((field) => fields.includes(field));
  if (targets.length === 0) return;

  const removals = targets.map((field) => `s.${field}`).join(", ");
  await runWrite(
    `MATCH (s:Settings {id: $id}) REMOVE ${removals}`,
    { id: SETTINGS_ID }
  );
}
