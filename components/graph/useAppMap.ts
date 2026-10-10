"use client";

// Data for the App map view (DESIGN.md §6.5):
//
//   useAppMap     — the map for one level, re-read whenever `refreshKey`
//                   changes (a finished AI run, a merge, a labeling run). The
//                   previous map of the same level stays up during a refresh.
//   useAppMapJob  — the on-demand AI run: status on mount, POST only from
//                   `generate`, polling while queued/running, `onCompleted`
//                   once on the way out of pending. The effect never
//                   depends on state it sets.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  featureKeyOf,
  isAppMapJobPending,
  type AppMapJobStatusDTO,
  type AppMapLevel,
  type AppMapResponseDTO,
  type AppMapRunMode,
} from "./app-map-types";

export interface UseAppMapResult {
  map: AppMapResponseDTO | null;
  loading: boolean;
  error: string | null;
}

export function useAppMap(
  repoId: string,
  level: AppMapLevel,
  enabled: boolean,
  refreshKey: unknown
): UseAppMapResult {
  const [map, setMap] = useState<AppMapResponseDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/repos/${encodeURIComponent(repoId)}/app-map?level=${level}`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as AppMapResponseDTO | { error: string } | null;
        if (!res.ok || !json || "error" in json) {
          throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        }
        return json;
      })
      .then((data) => {
        if (cancelled) return;
        setMap(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load the app map.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, level, enabled, refreshKey]);

  // A map of another level is never shown while the new one loads.
  return { map: map?.level === level ? map : null, loading, error };
}

const POLL_INTERVAL_MS = 1200;

export interface UseAppMapJobResult {
  status: AppMapJobStatusDTO | null;
  /** Inline message: a POST refusal, a failed run, a fetch error. */
  notice: string | null;
  running: boolean;
  /**
   * `place` (features only) keeps the stored grouping and just places the files it doesn't cover;
   * `split` (features only) cuts the card `card` (its key) into smaller features.
   */
  generate: (level: AppMapLevel, mode?: AppMapRunMode, card?: string) => void;
  cancel: () => void;
}

export function useAppMapJob(repoId: string, enabled: boolean, onCompleted: () => void): UseAppMapJobResult {
  const [status, setStatus] = useState<AppMapJobStatusDTO | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [nonce, setNonce] = useState(0);
  const pendingPost = useRef<{ level: AppMapLevel; mode: AppMapRunMode; card?: string } | null>(null);
  const wasPending = useRef(false);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const url = `/api/repos/${encodeURIComponent(repoId)}/app-map/job`;
    const post = pendingPost.current;
    pendingPost.current = null;

    async function tick() {
      try {
        const res = await fetch(url, { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as (AppMapJobStatusDTO & { error?: string }) | null;
        if (!alive) return;
        if (!res.ok || !json) throw new Error(json?.error ?? `Could not read the app map run (${res.status}).`);
        setStatus(json);
        const pending = isAppMapJobPending(json.state);
        if (json.state === "failed") setNotice(json.error ?? "The app map run failed.");
        else if (pending) setNotice(null);
        setStarting(false);
        if (wasPending.current && !pending) {
          wasPending.current = false;
          onCompletedRef.current();
        } else if (pending) {
          wasPending.current = true;
        }
        if (pending) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      } catch (err) {
        if (!alive) return;
        setStarting(false);
        setNotice(err instanceof Error ? err.message : "Could not read the app map run.");
      }
    }

    async function start() {
      if (post) {
        setStarting(true);
        setNotice(null);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(post),
          });
          const json = (await res.json().catch(() => null)) as { error?: string } | null;
          if (!alive) return;
          if (!res.ok) {
            setStarting(false);
            setNotice(json?.error ?? `Could not start the app map run (${res.status}).`);
            return;
          }
          wasPending.current = true;
        } catch (err) {
          if (!alive) return;
          setStarting(false);
          setNotice(err instanceof Error ? err.message : "Could not start the app map run.");
          return;
        }
      }
      await tick();
    }
    void start();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [repoId, enabled, nonce]);

  const generate = useCallback((level: AppMapLevel, mode: AppMapRunMode = "full", card?: string) => {
    pendingPost.current = { level, mode, ...(card ? { card } : {}) };
    setNonce((n) => n + 1);
  }, []);

  const cancel = useCallback(() => {
    void fetch(`/api/repos/${encodeURIComponent(repoId)}/app-map/job`, { method: "DELETE" })
      .then(() => setNonce((n) => n + 1))
      .catch(() => undefined);
  }, [repoId]);

  const running = starting || (status ? isAppMapJobPending(status.state) : false);
  return { status, notice, running, generate, cancel };
}

export interface UseAppMapCardActionsResult {
  /** "Split up": the model chooses the parts when an AI provider is set up, else module and folder do. */
  split: (cardId: string) => void;
  /** "Merge back": a split card's parts become the card they came from again. */
  merge: (cardId: string) => void;
  /** The card being split or merged right now (a model split runs as the app-map job). */
  busyCard: string | null;
  notice: string | null;
}

/** Split / merge one features card. `onChanged` re-reads the map after a change made without the job. */
export function useAppMapCardActions(repoId: string, job: UseAppMapJobResult, onChanged: () => void): UseAppMapCardActionsResult {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const post = useCallback(
    async (cardId: string, action: "split" | "merge") => {
      const card = featureKeyOf(cardId);
      if (!card) return;
      setBusy(cardId);
      setNotice(null);
      try {
        const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/app-map/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, card }),
        });
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) setNotice(json?.error ?? `Could not ${action} the card (${res.status}).`);
        else onChanged();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : `Could not ${action} the card.`);
      } finally {
        setBusy(null);
      }
    },
    [repoId, onChanged]
  );

  const split = useCallback(
    (cardId: string) => {
      const card = featureKeyOf(cardId);
      if (!card) return;
      if (job.status?.aiConfigured) job.generate("features", "split", card);
      else void post(cardId, "split");
    },
    [job, post]
  );
  const merge = useCallback((cardId: string) => void post(cardId, "merge"), [post]);

  const jobCard = job.running && job.status?.mode === "split" && job.status.card ? `feat:${job.status.card}` : null;
  return { split, merge, busyCard: busy ?? jobCard, notice };
}
