// The PR prerequisite checklist (DESIGN.md §6.6): item definitions and the
// stored answers to its AI questions.
//
// Items live in GraphReview's own settings, not in the reviewed repo:
//
// - `(:ChecklistItem {scope: "global"})` — defaults that apply to every repo;
// - `(:ChecklistItem {scope: <repoId>})` — items one repo adds on top;
// - `Repo.disabledChecklistItemIds` — global items one repo switches off.
//
// Deterministic items (CI, description, size, …) are evaluated on every
// read and never stored. Only AI answers cost tokens, so only those are
// stored, per (repo, target, item), stamped with the head sha they were
// answered for — a push makes them stale rather than wrong.

import { randomUUID } from "node:crypto";
import { runRead, runWrite } from "./client";

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
  const result = await runRead(`MATCH (m:ChecklistMeta {id: "global"}) RETURN m.seeded AS seeded`);
  if (result.records[0]?.get("seeded") === true) return;
  const now = new Date().toISOString();
  await runWrite(
    `
    MERGE (m:ChecklistMeta {id: "global"})
    ON CREATE SET m.seeded = false
    WITH m WHERE m.seeded = false
    SET m.seeded = true
    WITH m
    UNWIND $items AS item
    CREATE (c:ChecklistItem)
    SET c = item
    `,
    {
      items: DEFAULT_ITEMS.map((item, index) => ({
        id: randomUUID(),
        scope: "global",
        kind: item.kind,
        label: item.label,
        question: item.question ?? null,
        threshold: item.limit ?? null,
        patterns: item.patterns ?? null,
        enabled: true,
        order: index,
        createdAt: now,
      })),
    }
  );
}

/** Global items plus the repo's own (when `repoId` is given), in display order. */
export async function listChecklistItems(repoId?: string): Promise<ChecklistItemRecord[]> {
  await ensureDefaultChecklist();
  const result = await runRead(
    `
    MATCH (c:ChecklistItem)
    WHERE c.scope = "global" OR c.scope = $repoId
    RETURN c
    ORDER BY CASE WHEN c.scope = "global" THEN 0 ELSE 1 END, c.order, c.createdAt
    `,
    { repoId: repoId ?? null }
  );
  return result.records.map((r) => toItem(r.get("c").properties));
}

export async function getChecklistItem(id: string): Promise<ChecklistItemRecord | null> {
  const result = await runRead(`MATCH (c:ChecklistItem {id: $id}) RETURN c`, { id });
  const record = result.records[0];
  return record ? toItem(record.get("c").properties) : null;
}

export type ChecklistItemInput = Pick<ChecklistItemRecord, "scope" | "kind" | "label"> &
  Partial<Pick<ChecklistItemRecord, "question" | "limit" | "patterns" | "enabled">>;

export async function createChecklistItem(input: ChecklistItemInput): Promise<ChecklistItemRecord> {
  const result = await runWrite(
    `
    OPTIONAL MATCH (existing:ChecklistItem {scope: $scope})
    WITH coalesce(max(existing.order), -1) + 1 AS nextOrder
    CREATE (c:ChecklistItem {
      id: $id, scope: $scope, kind: $kind, label: $label, question: $question,
      threshold: $limit, patterns: $patterns, enabled: $enabled, order: nextOrder, createdAt: $now
    })
    RETURN c
    `,
    {
      id: randomUUID(),
      scope: input.scope,
      kind: input.kind,
      label: input.label,
      question: input.question ?? null,
      limit: input.limit ?? null,
      patterns: input.patterns ?? null,
      enabled: input.enabled ?? true,
      now: new Date().toISOString(),
    }
  );
  return toItem(result.records[0].get("c").properties);
}

export async function updateChecklistItem(
  id: string,
  patch: Partial<Pick<ChecklistItemRecord, "label" | "question" | "limit" | "patterns" | "enabled">>
): Promise<ChecklistItemRecord | null> {
  const result = await runWrite(
    `
    MATCH (c:ChecklistItem {id: $id})
    SET c.label = coalesce($label, c.label),
        c.question = CASE WHEN $hasQuestion THEN $question ELSE c.question END,
        c.threshold = CASE WHEN $hasLimit THEN $limit ELSE c.threshold END,
        c.patterns = CASE WHEN $hasPatterns THEN $patterns ELSE c.patterns END,
        c.enabled = coalesce($enabled, c.enabled)
    RETURN c
    `,
    {
      id,
      label: patch.label ?? null,
      hasQuestion: "question" in patch,
      question: patch.question ?? null,
      hasLimit: "limit" in patch,
      limit: patch.limit ?? null,
      hasPatterns: "patterns" in patch,
      patterns: patch.patterns ?? null,
      enabled: patch.enabled ?? null,
    }
  );
  const record = result.records[0];
  return record ? toItem(record.get("c").properties) : null;
}

/** Deletes an item and its stored answers. */
export async function deleteChecklistItem(id: string): Promise<void> {
  await runWrite(`MATCH (a:ChecklistAnswer {itemId: $id}) DELETE a`, { id });
  await runWrite(`MATCH (c:ChecklistItem {id: $id}) DETACH DELETE c`, { id });
}

/** Global items this repo has switched off. */
export async function getDisabledChecklistItemIds(repoId: string): Promise<string[]> {
  const result = await runRead(`MATCH (r:Repo {id: $repoId}) RETURN r.disabledChecklistItemIds AS ids`, { repoId });
  return (result.records[0]?.get("ids") as string[] | null) ?? [];
}

export async function setChecklistItemDisabledForRepo(
  repoId: string,
  itemId: string,
  disabled: boolean
): Promise<void> {
  await runWrite(
    `
    MATCH (r:Repo {id: $repoId})
    WITH r, [x IN coalesce(r.disabledChecklistItemIds, []) WHERE x <> $itemId] AS rest
    SET r.disabledChecklistItemIds = CASE WHEN $disabled THEN rest + $itemId ELSE rest END
    `,
    { repoId, itemId, disabled }
  );
}

// ---------------------------------------------------------------------------
// Stored AI answers
// ---------------------------------------------------------------------------

function answerId(repoId: string, targetKey: string, itemId: string): string {
  return `${repoId}|${targetKey}|${itemId}`;
}

export async function listChecklistAnswers(repoId: string, targetKey: string): Promise<ChecklistAnswerRecord[]> {
  const result = await runRead(
    `MATCH (a:ChecklistAnswer {repoId: $repoId, targetKey: $targetKey}) RETURN a`,
    { repoId, targetKey }
  );
  return result.records.map((r) => {
    const p = r.get("a").properties as Record<string, unknown>;
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
  await runWrite(
    `
    UNWIND $rows AS row
    MERGE (a:ChecklistAnswer {id: row.id})
    SET a.repoId = row.repoId, a.targetKey = row.targetKey, a.itemId = row.itemId,
        a.status = row.status, a.detail = row.detail, a.headSha = row.headSha,
        a.model = row.model, a.checkedAt = row.checkedAt
    `,
    {
      rows: answers.map((a) => ({
        id: answerId(a.repoId, a.targetKey, a.itemId),
        repoId: a.repoId,
        targetKey: a.targetKey,
        itemId: a.itemId,
        status: a.status,
        detail: a.detail,
        headSha: a.headSha ?? null,
        model: a.model ?? null,
        checkedAt: a.checkedAt,
      })),
    }
  );
}
