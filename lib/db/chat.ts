// PR chat messages (DESIGN.md §6.7): one thread per (repo, review target),
// stored so a conversation survives a reload and can be picked up later.
// Each message records the head commit it was about, so the UI can say when
// the PR has moved on since.

import { randomUUID } from "node:crypto";
import { all, get, pack, run, transaction, unpack } from "./client";

export interface ChatStepRecord {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

/**
 * A finding the model noticed on its own and offered instead of recording
 * (`suggest_finding`). It only enters the review when the reviewer adds it;
 * everything the finding needs is kept here, so adding it needs no model call.
 */
export interface ChatSuggestionRecord {
  id: string;
  assessment: "defect" | "concern" | "unknown" | "ok";
  summary: string;
  rationale: string;
  filePath?: string;
  line?: number;
  componentId: string;
  prId?: string;
  reviewedBaseSha?: string;
  reviewedHeadSha?: string;
  status: "pending" | "added" | "dismissed";
  /** Set once added: the finding it became. */
  findingId?: string;
}

/** Where `show` can take the reviewer. */
export type ChatShowKind = "component" | "file" | "endpoint" | "table" | "env" | "infra" | "area" | "function" | "finding";

/** The Graph tab's views, as `switch_view` names them. */
export type ChatViewName = "pr" | "app" | "api" | "infra" | "data" | "env" | "files";

/** The file viewer's tabs `open_diff` can open: the diff, the new file, the old file, the Before / after preview. */
export type ChatFileTab = "diff" | "file" | "base" | "preview";

/**
 * Something an answer does to the reviewer's view (`show`, `highlight`,
 * `filter_findings`, `switch_view`, `open_diff`) — or only offers to do
 * (`offer`: the answer's `point_to` / `next` stops, and a Before / after
 * preview, which starts a sandbox). Ids are resolved when the tool runs (or
 * the answer arrives), so the UI only applies them: an action once when the
 * answer arrives, every one again from its chip.
 */
export type ChatActionRecord = (
  | { kind: "show"; target: ChatShowKind; id: string; label: string; line?: number }
  | { kind: "highlight"; componentIds: string[]; label: string }
  | {
      kind: "filter";
      /** Verdict buckets to list; `fine` is resolved and OK findings. Absent: leave as is. */
      buckets?: Array<"defect" | "concern" | "unknown" | "fine">;
      /** Only this static-analysis category (structure, infra, schema). */
      category?: string;
      /** Scope the dock to this component (and the PR map area holding it). */
      componentId?: string;
      label: string;
    }
  | {
      kind: "view";
      view: ChatViewName;
      /** App map: architecture, features or modules. */
      level?: "architecture" | "features" | "modules";
      /** PR map files/functions, Infra diagram/files/requests/list, Data canvas/list. */
      mode?: string;
      /** The catalog views' "changed only" toggle. */
      changedOnly?: boolean;
      label: string;
    }
  | { kind: "file"; path: string; tab: ChatFileTab; lines?: string; symbol?: string; label: string }
) & {
  /** Only offered: a chip the reviewer clicks, never applied on arrival. */
  offer?: boolean;
  /** The answer's suggested next stop: why go there, in a few words. */
  next?: string;
};

/**
 * The chat's verdict on a finding already in the review (`triage_finding`):
 * offered, like a suggested finding — nothing changes until the reviewer
 * applies it. `holds` adds a confirming reply; `wrong` answers and resolves
 * it; `rerate` changes its verdict to `assessment`.
 */
export interface ChatTriageRecord {
  id: string;
  findingId: string;
  /** The finding's summary when triaged, for the card. */
  findingSummary: string;
  /** Its verdict when triaged. */
  from: "defect" | "concern" | "unknown" | "ok";
  verdict: "holds" | "wrong" | "rerate";
  /** `rerate`'s new verdict. */
  assessment?: "defect" | "concern" | "unknown" | "ok";
  reason: string;
  status: "pending" | "applied" | "dismissed";
}

export interface ChatMessageRecord {
  id: string;
  repoId: string;
  targetKey: string;
  role: "user" | "assistant";
  content: string;
  /** Assistant messages: the lookups made before answering. */
  steps: ChatStepRecord[];
  /** Graph components the answer's lookups touched. */
  componentIds: string[];
  /** Files the answer's lookups touched. */
  files: string[];
  /** The component selected in the graph when the question was asked. */
  focusComponentId?: string;
  headSha?: string;
  model?: string;
  /** The turn failed; `content` is the error. Left out of the history sent to the model. */
  error?: boolean;
  /** Assistant messages: findings the model offered, for the reviewer to add or dismiss. */
  suggestions?: ChatSuggestionRecord[];
  /** Assistant messages: what the answer did to the reviewer's view, and the stops it offered. */
  actions?: ChatActionRecord[];
  /** Assistant messages: verdicts on existing findings, for the reviewer to apply or dismiss. */
  triage?: ChatTriageRecord[];
  /** User messages: the finding the question was asked about (a finding's Ask chat). */
  findingId?: string;
  /** User messages: what was on the reviewer's screen, as sent to the model. */
  screen?: string;
  createdAt: string;
}

function toMessage(props: Record<string, unknown>): ChatMessageRecord {
  let steps: ChatStepRecord[] = [];
  try {
    steps = props.steps ? (JSON.parse(props.steps as string) as ChatStepRecord[]) : [];
  } catch {
    steps = [];
  }
  return {
    id: props.id as string,
    repoId: props.repoId as string,
    targetKey: props.targetKey as string,
    role: props.role as ChatMessageRecord["role"],
    content: (props.content as string) ?? "",
    steps,
    componentIds: (props.componentIds as string[] | null) ?? [],
    files: (props.files as string[] | null) ?? [],
    focusComponentId: (props.focusComponentId as string | null) ?? undefined,
    headSha: (props.headSha as string | null) ?? undefined,
    model: (props.model as string | null) ?? undefined,
    error: props.error === true ? true : undefined,
    suggestions: Array.isArray(props.suggestions) && props.suggestions.length > 0 ? (props.suggestions as ChatSuggestionRecord[]) : undefined,
    actions: Array.isArray(props.actions) && props.actions.length > 0 ? (props.actions as ChatActionRecord[]) : undefined,
    triage: Array.isArray(props.triage) && props.triage.length > 0 ? (props.triage as ChatTriageRecord[]) : undefined,
    findingId: (props.findingId as string | null) ?? undefined,
    screen: (props.screen as string | null) ?? undefined,
    createdAt: props.createdAt as string,
  };
}

export async function listChatMessages(repoId: string, targetKey: string): Promise<ChatMessageRecord[]> {
  return all<{ data: string }>(
    `SELECT data FROM chat_messages WHERE repo_id = ? AND target_key = ? ORDER BY created_at, seq`,
    repoId,
    targetKey
  ).map((row) => toMessage(unpack(row.data)));
}

export async function addChatMessage(
  input: Omit<ChatMessageRecord, "id" | "createdAt" | "steps" | "componentIds" | "files"> &
    Partial<Pick<ChatMessageRecord, "steps" | "componentIds" | "files">>
): Promise<ChatMessageRecord> {
  return transaction(() => {
    const last = get<{ seq: number | null }>(
      `SELECT MAX(seq) AS seq FROM chat_messages WHERE repo_id = ? AND target_key = ?`,
      input.repoId,
      input.targetKey
    );
    const seq = Number(last?.seq ?? 0) + 1;
    const props = {
      id: randomUUID(),
      repoId: input.repoId,
      targetKey: input.targetKey,
      role: input.role,
      content: input.content,
      steps: JSON.stringify(input.steps ?? []),
      componentIds: input.componentIds ?? [],
      files: input.files ?? [],
      focusComponentId: input.focusComponentId,
      headSha: input.headSha,
      model: input.model,
      error: input.error,
      suggestions: input.suggestions?.length ? input.suggestions : undefined,
      actions: input.actions?.length ? input.actions : undefined,
      triage: input.triage?.length ? input.triage : undefined,
      findingId: input.findingId,
      screen: input.screen,
      createdAt: new Date().toISOString(),
      seq,
    };
    run(
      `INSERT INTO chat_messages (id, repo_id, target_key, seq, created_at, data) VALUES (?, ?, ?, ?, ?, ?)`,
      props.id,
      props.repoId,
      props.targetKey,
      seq,
      props.createdAt,
      pack(props)
    );
    return toMessage(JSON.parse(pack(props)));
  });
}

export async function getChatMessage(repoId: string, id: string): Promise<ChatMessageRecord | undefined> {
  const row = get<{ data: string }>(`SELECT data FROM chat_messages WHERE repo_id = ? AND id = ?`, repoId, id);
  return row ? toMessage(unpack(row.data)) : undefined;
}

/** Changes one item of a stored message's `suggestions` or `triage` list; undefined when either is gone. */
function updateMessageItem<T extends { id: string }>(
  field: "suggestions" | "triage",
  repoId: string,
  messageId: string,
  itemId: string,
  patch: Partial<T>
): ChatMessageRecord | undefined {
  return transaction(() => {
    const row = get<{ data: string }>(`SELECT data FROM chat_messages WHERE repo_id = ? AND id = ?`, repoId, messageId);
    if (!row) return undefined;
    const props = unpack(row.data);
    const items = Array.isArray(props[field]) ? (props[field] as T[]) : [];
    const index = items.findIndex((s) => s.id === itemId);
    if (index < 0) return undefined;
    items[index] = { ...items[index], ...patch };
    const next = { ...props, [field]: items };
    run(`UPDATE chat_messages SET data = ? WHERE repo_id = ? AND id = ?`, pack(next), repoId, messageId);
    return toMessage(next);
  });
}

/** Changes one suggestion on a stored message; returns the updated message, or undefined when either is gone. */
export async function updateChatSuggestion(
  repoId: string,
  messageId: string,
  suggestionId: string,
  patch: Partial<Pick<ChatSuggestionRecord, "status" | "findingId">>
): Promise<ChatMessageRecord | undefined> {
  return updateMessageItem<ChatSuggestionRecord>("suggestions", repoId, messageId, suggestionId, patch);
}

/** Changes one triage verdict's status on a stored message, likewise. */
export async function updateChatTriage(
  repoId: string,
  messageId: string,
  triageId: string,
  status: ChatTriageRecord["status"]
): Promise<ChatMessageRecord | undefined> {
  return updateMessageItem<ChatTriageRecord>("triage", repoId, messageId, triageId, { status });
}

export async function clearChatMessages(repoId: string, targetKey: string): Promise<number> {
  return run(`DELETE FROM chat_messages WHERE repo_id = ? AND target_key = ?`, repoId, targetKey);
}
