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

export async function clearChatMessages(repoId: string, targetKey: string): Promise<number> {
  return run(`DELETE FROM chat_messages WHERE repo_id = ? AND target_key = ?`, repoId, targetKey);
}
