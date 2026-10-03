// The PR prerequisite checklist (DESIGN.md §6.6): item definitions and the
// stored answers to its AI questions.
//
// Items live in GraphReview's own settings, not in the reviewed repo:
//
// - items with `scope: "global"` — defaults that apply to every repo;
// - items with `scope: <repoId>` — items one repo adds on top;
// - `Repo.disabledChecklistItemIds` — global items one repo switches off.
//
// Deterministic items (CI, description, size, …) are evaluated on every
// read and never stored. Only AI answers cost tokens, so only those are
// stored, per (repo, target, item), stamped with the head sha they were
// answered for — a push makes them stale rather than wrong.

import { randomUUID } from "node:crypto";
import { all, get, pack, run, transaction, unpack } from "./client";
import { readRepoDocument, writeRepoDocument } from "./repo";

export type ChecklistItemKind =
  | "ci"
  | "description"
  | "linked-issue"
  | "max-files"
  | "max-lines"
  | "protected-paths"
  | "ai";

export const CHECKLIST_ITEM_KINDS: readonly ChecklistItemKind[] = [
  "ci",
  "description",
  "linked-issue",
  "max-files",
  "max-lines",
  "protected-paths",
  "ai",
];

export interface ChecklistItemRecord {
  id: string;
  /** `"global"` or the repo id the item belongs to. */
  scope: string;
  kind: ChecklistItemKind;
  label: string;
  /** `ai` items: the question put to the model about the whole PR. */
  question?: string;
  /** `description` (minimum characters), `max-files`, `max-lines`. */
  limit?: number;
  /** `protected-paths`: `dir/**`, `*.ext` or exact paths. */
  patterns?: string[];
  /** Global items: on by default for every repo (a repo can still switch it off). Repo items: on/off. */
  enabled: boolean;
  order: number;
  createdAt: string;
}

export type ChecklistStatus = "pass" | "fail" | "pending" | "unknown" | "not_applicable";

export interface ChecklistAnswerRecord {
  repoId: string;
  targetKey: string;
  itemId: string;
  status: ChecklistStatus;
  detail: string;
  headSha?: string;
  model?: string;
  checkedAt: string;
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toItem(props: Record<string, unknown>): ChecklistItemRecord {
  return {
    id: props.id as string,
    scope: props.scope as string,
    kind: props.kind as ChecklistItemKind,
    label: props.label as string,
    question: (props.question as string | null) ?? undefined,
    limit: toNumber(props.threshold),
    patterns: (props.patterns as string[] | null) ?? undefined,
    enabled: props.enabled !== false,
    order: toNumber(props.order) ?? 0,
    createdAt: props.createdAt as string,
  };
}

/** What a fresh install starts with. Written once; editing or deleting them afterwards sticks. */
const DEFAULT_ITEMS: Array<Omit<ChecklistItemRecord, "id" | "scope" | "enabled" | "order" | "createdAt">> = [
  { kind: "ci", label: "CI checks pass" },
  { kind: "description", label: "Has a description", limit: 30 },
  { kind: "linked-issue", label: "Links an issue" },
  { kind: "max-lines", label: "Stays reviewable (≤ 500 changed lines)", limit: 500 },
  {
    kind: "ai",
    label: "Explains why",
    question: "Does the description explain why this change is needed, not only what it does?",
  },
  {
    kind: "ai",
    label: "No unrelated changes",
    question: "Is every change in the diff related to the stated purpose of the PR (no unrelated refactors or leftovers)?",
  },
];

/** Seeds the global defaults the first time the checklist is used. */
export async function ensureDefaultChecklist(): Promise<void> {
  if (get(`SELECT 1 FROM kv WHERE key = 'checklist.seeded'`)) return;
  const now = new Date().toISOString();
  transaction(() => {
    if (get(`SELECT 1 FROM kv WHERE key = 'checklist.seeded'`)) return;
    run(`INSERT INTO kv (key, value) VALUES ('checklist.seeded', 'true')`);
    DEFAULT_ITEMS.forEach((item, index) =>
      writeItem({
        id: randomUUID(),
        scope: "global",
        kind: item.kind,
        label: item.label,
        question: item.question,
        threshold: item.limit,
        patterns: item.patterns,
        enabled: true,
        order: index,
        createdAt: now,
      })
    );
  });
}

/** Stored shape: `limit` is kept as `threshold`. */
function writeItem(props: Record<string, unknown>): void {
  run(
    `INSERT INTO checklist_items (id, scope, data) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET scope = excluded.scope, data = excluded.data`,
    props.id as string,
    props.scope as string,
    pack(props)
  );
}

function readItemProps(id: string): Record<string, unknown> | undefined {
  const row = get<{ data: string }>(`SELECT data FROM checklist_items WHERE id = ?`, id);
  return row ? unpack(row.data) : undefined;
}

/** Global items plus the repo's own (when `repoId` is given), in display order. */
export async function listChecklistItems(repoId?: string): Promise<ChecklistItemRecord[]> {
  await ensureDefaultChecklist();
  const rows = all<{ data: string }>(
    `SELECT data FROM checklist_items WHERE scope = 'global' OR scope = ?`,
    repoId ?? null
  );
  return rows
    .map((row) => toItem(unpack(row.data)))
    .sort(
      (a, b) =>
        (a.scope === "global" ? 0 : 1) - (b.scope === "global" ? 0 : 1) ||
        a.order - b.order ||
        (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
    );
}

export async function getChecklistItem(id: string): Promise<ChecklistItemRecord | null> {
  const props = readItemProps(id);
  return props ? toItem(props) : null;
}

export type ChecklistItemInput = Pick<ChecklistItemRecord, "scope" | "kind" | "label"> &
  Partial<Pick<ChecklistItemRecord, "question" | "limit" | "patterns" | "enabled">>;

export async function createChecklistItem(input: ChecklistItemInput): Promise<ChecklistItemRecord> {
  return transaction(() => {
    const orders = all<{ data: string }>(`SELECT data FROM checklist_items WHERE scope = ?`, input.scope).map(
      (row) => toItem(unpack(row.data)).order
    );
    const props = {
      id: randomUUID(),
      scope: input.scope,
      kind: input.kind,
      label: input.label,
      question: input.question,
      threshold: input.limit,
      patterns: input.patterns,
      enabled: input.enabled ?? true,
      order: orders.length ? Math.max(...orders) + 1 : 0,
      createdAt: new Date().toISOString(),
    };
    writeItem(props);
    return toItem(JSON.parse(pack(props)));
  });
}

export async function updateChecklistItem(
  id: string,
  patch: Partial<Pick<ChecklistItemRecord, "label" | "question" | "limit" | "patterns" | "enabled">>
): Promise<ChecklistItemRecord | null> {
  return transaction(() => {
    const props = readItemProps(id);
    if (!props) return null;
    const next: Record<string, unknown> = { ...props };
    if (patch.label != null) next.label = patch.label;
    if ("question" in patch) next.question = patch.question ?? undefined;
    if ("limit" in patch) next.threshold = patch.limit ?? undefined;
    if ("patterns" in patch) next.patterns = patch.patterns ?? undefined;
    if (patch.enabled != null) next.enabled = patch.enabled;
    writeItem(next);
    return toItem(JSON.parse(pack(next)));
  });
}

/** Deletes an item and its stored answers. */
export async function deleteChecklistItem(id: string): Promise<void> {
  transaction(() => {
    run(`DELETE FROM checklist_answers WHERE item_id = ?`, id);
    run(`DELETE FROM checklist_items WHERE id = ?`, id);
  });
}

/** Global items this repo has switched off. */
export async function getDisabledChecklistItemIds(repoId: string): Promise<string[]> {
  return (readRepoDocument(repoId)?.disabledChecklistItemIds as string[] | undefined) ?? [];
}

export async function setChecklistItemDisabledForRepo(
  repoId: string,
  itemId: string,
  disabled: boolean
): Promise<void> {
  transaction(() => {
    const doc = readRepoDocument(repoId);
    if (!doc) return;
    const rest = ((doc.disabledChecklistItemIds as string[] | undefined) ?? []).filter((x) => x !== itemId);
    writeRepoDocument({ ...doc, disabledChecklistItemIds: disabled ? [...rest, itemId] : rest });
  });
}

// ---------------------------------------------------------------------------
// Stored AI answers
// ---------------------------------------------------------------------------

function answerId(repoId: string, targetKey: string, itemId: string): string {
  return `${repoId}|${targetKey}|${itemId}`;
}

export async function listChecklistAnswers(repoId: string, targetKey: string): Promise<ChecklistAnswerRecord[]> {
  return all<{ data: string }>(
    `SELECT data FROM checklist_answers WHERE repo_id = ? AND target_key = ?`,
    repoId,
    targetKey
  ).map((row) => {
    const p = unpack(row.data);
    return {
      repoId: p.repoId as string,
      targetKey: p.targetKey as string,
      itemId: p.itemId as string,
      status: p.status as ChecklistStatus,
      detail: (p.detail as string) ?? "",
      headSha: (p.headSha as string | null) ?? undefined,
      model: (p.model as string | null) ?? undefined,
      checkedAt: p.checkedAt as string,
    };
  });
}

export async function saveChecklistAnswers(answers: readonly ChecklistAnswerRecord[]): Promise<void> {
  if (answers.length === 0) return;
  transaction(() => {
    for (const a of answers) {
      run(
        `INSERT INTO checklist_answers (id, repo_id, target_key, item_id, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
        answerId(a.repoId, a.targetKey, a.itemId),
        a.repoId,
        a.targetKey,
        a.itemId,
        pack(a)
      );
    }
  });
}
