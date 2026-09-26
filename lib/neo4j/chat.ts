// PR chat messages (DESIGN.md §6.7): one thread per (repo, review target),
// stored so a conversation survives a reload and can be picked up later.
// Each message records the head commit it was about, so the UI can say when
// the PR has moved on since.

import { randomUUID } from "node:crypto";
import { runRead, runWrite } from "./client";

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
  const result = await runRead(
    `MATCH (m:ChatMessage {repoId: $repoId, targetKey: $targetKey}) RETURN m ORDER BY m.createdAt, m.seq`,
    { repoId, targetKey }
  );
  return result.records.map((r) => toMessage(r.get("m").properties));
}

export async function addChatMessage(
  input: Omit<ChatMessageRecord, "id" | "createdAt" | "steps" | "componentIds" | "files"> &
    Partial<Pick<ChatMessageRecord, "steps" | "componentIds" | "files">>
): Promise<ChatMessageRecord> {
  const result = await runWrite(
    `
    OPTIONAL MATCH (prev:ChatMessage {repoId: $repoId, targetKey: $targetKey})
    WITH coalesce(max(prev.seq), 0) + 1 AS seq
    CREATE (m:ChatMessage {
      id: $id, repoId: $repoId, targetKey: $targetKey, role: $role, content: $content,
      steps: $steps, componentIds: $componentIds, files: $files, focusComponentId: $focusComponentId,
      headSha: $headSha, model: $model, error: $error, createdAt: $now, seq: seq
    })
    RETURN m
    `,
    {
      id: randomUUID(),
      repoId: input.repoId,
      targetKey: input.targetKey,
      role: input.role,
      content: input.content,
      steps: JSON.stringify(input.steps ?? []),
      componentIds: input.componentIds ?? [],
      files: input.files ?? [],
      focusComponentId: input.focusComponentId ?? null,
      headSha: input.headSha ?? null,
      model: input.model ?? null,
      error: input.error ?? null,
      now: new Date().toISOString(),
    }
  );
  return toMessage(result.records[0].get("m").properties);
}

export async function clearChatMessages(repoId: string, targetKey: string): Promise<number> {
  const result = await runWrite(
    `
    MATCH (m:ChatMessage {repoId: $repoId, targetKey: $targetKey})
    WITH m, count(*) AS ignored
    DELETE m
    RETURN count(ignored) AS deleted
    `,
    { repoId, targetKey }
  );
  return Number(result.records[0]?.get("deleted") ?? 0);
}
