"use client";

// Data for the App map view (DESIGN.md §6.5):
//
//   useAppMap     — the map for one level, re-read whenever `refreshKey`
//                   changes (a finished AI run, a merge, a labeling run). The
//                   previous map of the same level stays up during a refresh.
//   useAppMapJob  — the on-demand AI run: status on mount, POST only from
//                   `generate`, polling while queued/running, `onCompleted`
//                   once on the way out of pending. Same shape (and the same
//                   "the effect never depends on state it sets" rule) as
//                   useLabels.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isAppMapJobPending,
  type AppMapJobStatusDTO,
  type AppMapLevel,
  type AppMapResponseDTO,
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
  generate: (level: AppMapLevel) => void;
  cancel: () => void;
}

export function useAppMapJob(repoId: string, enabled: boolean, onCompleted: () => void): UseAppMapJobResult {
  const [status, setStatus] = useState<AppMapJobStatusDTO | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [nonce, setNonce] = useState(0);
  const pendingPost = useRef<AppMapLevel | null>(null);
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
            body: JSON.stringify({ level: post }),
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

  const generate = useCallback((level: AppMapLevel) => {
    pendingPost.current = level;
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
