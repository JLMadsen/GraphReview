"use client";

// Client state for the PR chat (DESIGN.md §6.7): the stored thread for the
// current review target, and sending a question. The answer streams back
// as NDJSON — the question, then one line per lookup the model makes, then
// the answer — so the column can show "read app/map/page.tsx" while a slow
// model is still working.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessageDTO, ChatStepDTO, ChatStreamEventDTO, ChatThreadDTO } from "./chat-types";
import { reviewTargetKeyOf, reviewTargetQuery, type ReviewTargetDTO } from "./types";

export interface PendingTurn {
  question: string;
  steps: ChatStepDTO[];
}

export interface UsePrChatResult {
  messages: ChatMessageDTO[];
  headSha?: string;
  aiConfigured: boolean;
  loading: boolean;
  error: string | null;
  pending: PendingTurn | null;
  send(question: string, focusComponentId?: string): Promise<void>;
  stop(): void;
  clear(): Promise<void>;
}

export function usePrChat(repoId: string, target: ReviewTargetDTO | null): UsePrChatResult {
  const [thread, setThread] = useState<ChatThreadDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const targetKey = target ? reviewTargetKeyOf(target) : null;
  const base = `/api/repos/${encodeURIComponent(repoId)}/chat`;

  useEffect(() => {
    setThread(null);
    setError(null);
    setPending(null);
    abortRef.current?.abort();
    if (!target) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${base}?${reviewTargetQuery(target)}`)
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as (ChatThreadDTO & { error?: string }) | null;
        if (!res.ok || !json) throw new Error(json?.error ?? `Chat request failed (${res.status}).`);
        return json;
      })
      .then((json) => {
        if (!cancelled) setThread(json);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, targetKey]);

  const send = useCallback(
    async (question: string, focusComponentId?: string) => {
      if (!target || !question.trim()) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setPending({ question, steps: [] });
      setError(null);
      const append = (message: ChatMessageDTO) =>
        setThread((t) => (t ? { ...t, messages: [...t.messages, message] } : t));
      try {
        const res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target, message: question, focusComponentId }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const json = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(json?.error ?? `Chat request failed (${res.status}).`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const event = JSON.parse(line) as ChatStreamEventDTO;
            if (event.type === "user") append(event.message);
            else if (event.type === "step") setPending((p) => (p ? { ...p, steps: [...p.steps, event.step] } : p));
            else if (event.type === "answer") append(event.message);
            else if (event.type === "error") setError(event.error);
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") setError((err as Error).message);
      } finally {
        setPending(null);
        abortRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, targetKey]
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const clear = useCallback(async () => {
    if (!target) return;
    try {
      const res = await fetch(`${base}?${reviewTargetQuery(target)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Could not clear the chat (${res.status}).`);
      setThread((t) => (t ? { ...t, messages: [] } : t));
    } catch (err) {
      setError((err as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, targetKey]);

  return {
    messages: thread?.messages ?? [],
    headSha: thread?.headSha,
    aiConfigured: thread?.aiConfigured ?? false,
    loading,
    error,
    pending,
    send,
    stop,
    clear,
  };
}
