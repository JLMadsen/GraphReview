"use client";

// Client state for the chat (DESIGN.md §6.7): the stored thread for the
// current review target — or, with no target, the repo's own thread — and
// sending a question. The answer streams back
// as NDJSON — the question, then one line per lookup the model makes, then
// the answer — so the column can show "read app/map/page.tsx" while a slow
// model is still working. Each answer hands what it did to the view (show,
// highlight, filter_findings, switch_view, open_diff — often nothing; never
// the stops it only offers) to `onActions` as it arrives, with when the
// question was sent; never for answers loaded from the stored thread.
// `onActions` says whether it applied them — it doesn't when the reviewer
// has been using the screen since — and the answers it held back are listed
// in `held`, so the column can say so.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatActionDTO,
  ChatMessageDTO,
  ChatStepDTO,
  ChatStreamEventDTO,
  ChatSuggestionActionDTO,
  ChatThreadDTO,
  ChatTriageActionDTO,
} from "./chat-types";
import { reviewTargetKeyOf, reviewTargetQuery, type ReviewTargetDTO } from "./types";

export interface PendingTurn {
  question: string;
  steps: ChatStepDTO[];
}

/** What a question is sent with besides its text. */
export interface ChatSendContext {
  /** The component selected in the graph. */
  focusComponentId?: string;
  /** The finding asked about (a finding's Ask). */
  findingId?: string;
  /** What is on the screen, in a line or two. */
  screen?: string;
}

export interface UsePrChatResult {
  messages: ChatMessageDTO[];
  headSha?: string;
  aiConfigured: boolean;
  loading: boolean;
  /** The thread has loaded once — a question sent before would be lost to the load. */
  ready: boolean;
  error: string | null;
  pending: PendingTurn | null;
  send(question: string, context?: ChatSendContext): Promise<void>;
  stop(): void;
  clear(): Promise<void>;
  /** Adds a suggested finding to the review, or dismisses it. */
  answerSuggestion(messageId: string, suggestionId: string, action: ChatSuggestionActionDTO["action"]): Promise<void>;
  /** Applies the chat's verdict on a finding, or dismisses it. */
  answerTriage(messageId: string, triageId: string, action: ChatTriageActionDTO["action"]): Promise<void>;
  /** Answers whose view changes weren't applied because the reviewer had moved on — their chips still do them. */
  held: ReadonlySet<string>;
}

/** The query string naming a thread: the review target's, or the repo-wide one. */
function threadQuery(target: ReviewTargetDTO | null): string {
  return target ? reviewTargetQuery(target) : "scope=repo";
}

export function usePrChat(
  repoId: string,
  target: ReviewTargetDTO | null,
  onActions?: (actions: ChatActionDTO[], sentAt: number) => boolean
): UsePrChatResult {
  const onActionsRef = useRef(onActions);
  useEffect(() => {
    onActionsRef.current = onActions;
  }, [onActions]);
  const [thread, setThread] = useState<ChatThreadDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const targetKey = target ? reviewTargetKeyOf(target) : "repo";
  const base = `/api/repos/${encodeURIComponent(repoId)}/chat`;

  useEffect(() => {
    setThread(null);
    setError(null);
    setPending(null);
    setHeld(new Set());
    abortRef.current?.abort();
    let cancelled = false;
    setLoading(true);
    fetch(`${base}?${threadQuery(target)}`)
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
    async (question: string, context: ChatSendContext = {}) => {
      if (!question.trim()) return;
      const sentAt = Date.now();
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
          body: JSON.stringify({
            ...(target ? { target } : { scope: "repo" }),
            message: question,
            ...(context.focusComponentId ? { focusComponentId: context.focusComponentId } : {}),
            ...(context.findingId && target ? { findingId: context.findingId } : {}),
            ...(context.screen ? { screen: context.screen } : {}),
          }),
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
            else if (event.type === "answer") {
              append(event.message);
              const live = (event.message.actions ?? []).filter((a) => !a.offer);
              const id = event.message.id;
              if (live.length > 0 && onActionsRef.current && !onActionsRef.current(live, sentAt)) {
                setHeld((h) => new Set(h).add(id));
              }
            }
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
    try {
      const res = await fetch(`${base}?${threadQuery(target)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Could not clear the chat (${res.status}).`);
      setThread((t) => (t ? { ...t, messages: [] } : t));
    } catch (err) {
      setError((err as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, targetKey]);

  const patchMessage = useCallback(
    async (body: ChatSuggestionActionDTO | ChatTriageActionDTO) => {
      try {
        const res = await fetch(base, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => null)) as { message?: ChatMessageDTO; error?: string } | null;
        if (!res.ok || !json?.message) throw new Error(json?.error ?? `Could not update the answer (${res.status}).`);
        const updated = json.message;
        setThread((t) => (t ? { ...t, messages: t.messages.map((m) => (m.id === updated.id ? updated : m)) } : t));
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [base]
  );
  const answerSuggestion = useCallback(
    (messageId: string, suggestionId: string, action: ChatSuggestionActionDTO["action"]) => patchMessage({ messageId, suggestionId, action }),
    [patchMessage]
  );
  const answerTriage = useCallback(
    (messageId: string, triageId: string, action: ChatTriageActionDTO["action"]) => patchMessage({ messageId, triageId, action }),
    [patchMessage]
  );

  return {
    messages: thread?.messages ?? [],
    headSha: thread?.headSha,
    aiConfigured: thread?.aiConfigured ?? false,
    loading,
    ready: thread !== null,
    error,
    pending,
    send,
    stop,
    clear,
    answerSuggestion,
    answerTriage,
    held,
  };
}
