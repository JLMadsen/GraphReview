"use client";

// Client state for feature merges (DESIGN.md §6.3): the suggestions list
// from `GET /api/repos/[repoId]/merges`, and the actions on it.
//
// Nothing here polls — suggestions only change after an analysis, a
// regroup (which every action below triggers server-side) or a labeling
// run, so the list is fetched on mount, after each action, and whenever
// the caller bumps `refreshKey` (GraphView does on every graph refetch).
//
// Accept is two steps: the accept itself (fast, no AI — the merged module
// appears with its heuristic name) and then, if an AI provider is set up,
// naming it (one model call, can take a while on a local model). The graph
// is refetched after each, so the node shows up first and gets its real
// name when the model answers.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AcceptAllResponseDTO,
  AcceptSuggestionResponseDTO,
  MergedModuleActionDTO,
  MergesResponseDTO,
  NameWithAiResponseDTO,
  SuggestionActionDTO,
} from "./merge-types";

export type MergeBusy =
  | { action: "accept-all"; id: "*" }
  | { action: "accept" | "reject" | "reopen"; id: string }
  | { action: "unmerge" | "rename" | "naming"; id: string }
  | null;

export interface UseMergesResult {
  data: MergesResponseDTO | null;
  loading: boolean;
  busy: MergeBusy;
  notice: string | null;
  openCount: number;
  /** While new modules from "Accept all" are being named one by one. */
  namingProgress: { done: number; total: number } | null;
  accept(suggestionId: string): Promise<string | null>;
  acceptAll(): Promise<void>;
  reject(suggestionId: string): Promise<void>;
  reopen(suggestionId: string): Promise<void>;
  unmerge(componentId: string): Promise<boolean>;
  rename(componentId: string, name: string): Promise<boolean>;
  nameWithAi(componentId: string): Promise<void>;
  dismissNotice(): void;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !json) {
    throw new Error(json?.error ?? `Request failed (${res.status}).`);
  }
  return json;
}

export function useMerges(
  repoId: string,
  refreshKey: number,
  onGraphChanged: () => void
): UseMergesResult {
  const [data, setData] = useState<MergesResponseDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<MergeBusy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [namingProgress, setNamingProgress] = useState<{ done: number; total: number } | null>(null);

  // Read through a ref so the callbacks below stay stable.
  const onGraphChangedRef = useRef(onGraphChanged);
  onGraphChangedRef.current = onGraphChanged;
  const aiConfiguredRef = useRef(false);
  aiConfiguredRef.current = data?.aiConfigured ?? false;

  const base = `/api/repos/${encodeURIComponent(repoId)}/merges`;

  useEffect(() => {
    let cancelled = false;
    fetch(base)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Merge suggestions request failed (${res.status}).`);
        return (await res.json()) as MergesResponseDTO;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        // Degrade quietly: no suggestions button beats an error banner for
        // an optional feature (e.g. a repo that was never analyzed).
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, refreshKey, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const suggestionAction = useCallback(
    async (suggestionId: string, body: SuggestionActionDTO) =>
      post<AcceptSuggestionResponseDTO>(`${base}/suggestions/${encodeURIComponent(suggestionId)}`, body),
    [base]
  );

  const moduleAction = useCallback(
    async <T,>(componentId: string, body: MergedModuleActionDTO) =>
      post<T>(`${base}/modules/${encodeURIComponent(componentId)}`, body),
    [base]
  );

  const nameWithAi = useCallback(
    async (componentId: string) => {
      setBusy({ action: "naming", id: componentId });
      try {
        const result = await moduleAction<NameWithAiResponseDTO>(componentId, { action: "name-with-ai" });
        if (!result.named) setNotice("The AI reply had no usable name — kept the suggested one.");
        onGraphChangedRef.current();
        refresh();
      } catch (error) {
        setNotice(`AI naming failed: ${(error as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [moduleAction, refresh]
  );

  const accept = useCallback(
    async (suggestionId: string) => {
      setBusy({ action: "accept", id: suggestionId });
      setNotice(null);
      let componentId: string;
      try {
        componentId = (await suggestionAction(suggestionId, { action: "accept" })).componentId;
      } catch (error) {
        setNotice((error as Error).message);
        setBusy(null);
        refresh();
        return null;
      }
      onGraphChangedRef.current();
      refresh();
      setBusy(null);
      if (aiConfiguredRef.current) void nameWithAi(componentId);
      return componentId;
    },
    [suggestionAction, refresh, nameWithAi]
  );

  // One POST applies every open suggestion with a single regroup; the new
  // modules then get AI names one at a time (sequential, so a single local
  // model server isn't flooded), refetching the graph as each lands.
  const acceptAll = useCallback(async () => {
    setBusy({ action: "accept-all", id: "*" });
    setNotice(null);
    let result: AcceptAllResponseDTO;
    try {
      result = await post<AcceptAllResponseDTO>(base, { action: "accept-all" });
    } catch (error) {
      setNotice((error as Error).message);
      setBusy(null);
      refresh();
      return;
    }
    onGraphChangedRef.current();
    refresh();
    setBusy(null);
    if (result.skipped > 0) {
      setNotice(
        `Accepted ${result.accepted}; ${result.skipped} overlapped a stronger suggestion and ${
          result.skipped === 1 ? "was" : "were"
        } recomputed — check the list again.`
      );
    }

    if (!aiConfiguredRef.current || result.createdComponentIds.length === 0) return;
    const total = result.createdComponentIds.length;
    let failed = 0;
    setNamingProgress({ done: 0, total });
    for (const [index, componentId] of result.createdComponentIds.entries()) {
      try {
        await moduleAction<NameWithAiResponseDTO>(componentId, { action: "name-with-ai" });
      } catch {
        failed++;
      }
      setNamingProgress({ done: index + 1, total });
      onGraphChangedRef.current();
    }
    setNamingProgress(null);
    refresh();
    if (failed > 0) setNotice(`AI naming failed for ${failed} of ${total} new module(s) — they keep their suggested names.`);
  }, [base, moduleAction, refresh]);

  const setStatus = useCallback(
    async (suggestionId: string, action: "reject" | "reopen") => {
      setBusy({ action, id: suggestionId });
      try {
        await suggestionAction(suggestionId, { action });
      } catch (error) {
        setNotice((error as Error).message);
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [suggestionAction, refresh]
  );

  const unmerge = useCallback(
    async (componentId: string) => {
      setBusy({ action: "unmerge", id: componentId });
      try {
        await moduleAction(componentId, { action: "unmerge" });
        onGraphChangedRef.current();
        return true;
      } catch (error) {
        setNotice((error as Error).message);
        return false;
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [moduleAction, refresh]
  );

  const rename = useCallback(
    async (componentId: string, name: string) => {
      setBusy({ action: "rename", id: componentId });
      try {
        await moduleAction(componentId, { action: "rename", name });
        onGraphChangedRef.current();
        return true;
      } catch (error) {
        setNotice((error as Error).message);
        return false;
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [moduleAction, refresh]
  );

  return {
    data,
    loading,
    busy,
    notice,
    openCount: data?.suggestions.filter((s) => s.status === "open").length ?? 0,
    namingProgress,
    accept,
    acceptAll,
    reject: (id) => setStatus(id, "reject"),
    reopen: (id) => setStatus(id, "reopen"),
    unmerge,
    rename,
    nameWithAi,
    dismissNotice: () => setNotice(null),
  };
}
