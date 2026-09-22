"use client";

// The polling half of the AI labeling feature.
//
// Owns exactly one thing: keeping a `LabelSnapshot` in sync with
// `/api/repos/[repoId]/label`. Rendering lives in `LabelsControl`.
//
// Flow — deliberately the *opposite* of `useReview`'s in one respect:
//
//   1. GET the repo's labeling state on mount, and whenever the repo changes.
//   2. Never POST on its own. Labeling is on demand (see the route's header):
//      re-analysis is frequent and a graph view that silently spent tokens
//      every time it opened would be indefensible. `generate()` is the only
//      thing that enqueues.
//   3. While a run is queued/running, poll every ~1.2s so the progress line
//      and the cost counter move.
//   4. On the transition out of a pending state, call `onCompleted` once so
//      the caller can refetch the graph and actually show the new domains.
//
// ---------------------------------------------------------------------------
// The dependency-array footgun this file is written around
// ---------------------------------------------------------------------------
// A React effect must not list, in its dependency array, state that it sets:
// it re-invokes itself the moment its own `setState` commits, and the first
// run's cleanup cancels the in-flight fetch — a successful request that
// leaves the UI loading forever. With a polling loop it is worse still,
// because the loop restarts on every tick.
//
// So the effect below depends on two things only, neither of which it sets:
// `repoId` and `runNonce` (bumped only by `generate`). Everything else it
// needs lives in refs: a monotonic run id that makes a superseded response a
// no-op, the pending timer, the "was pending last tick" flag, and the
// caller's `onCompleted` callback.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isLabelPending,
  type EnqueueLabelResponseDTO,
  type LabelErrorDTO,
  type LabelSnapshot,
  type LabelStatusResponseDTO,
  type UseLabelsResult,
} from "./label-types";

/** Poll cadence while a run is queued/active. Matches the review dock's, so the two feel like one app. */
const POLL_INTERVAL_MS = 1200;
/** Shorter first poll straight after an enqueue, so "queued" appears immediately. */
const POST_SETTLE_MS = 350;

const INITIAL_SNAPSHOT: LabelSnapshot = {
  status: "loading",
  state: "none",
  aiConfigured: false,
  domains: 0,
  describedModules: 0,
  modules: 0,
  notice: null,
  noticeCode: null,
  starting: false,
};

export function useLabels(
  repoId: string,
  onCompleted?: () => void
): UseLabelsResult {
  const [snapshot, setSnapshot] = useState<LabelSnapshot>(INITIAL_SNAPSHOT);
  const [runNonce, setRunNonce] = useState(0);

  // Set by `generate()` and consumed once by the effect run it triggers.
  // A ref rather than state because reading it must not be a render input.
  const pendingPostRef = useRef<{ force: boolean } | null>(null);
  // Monotonic: every effect run claims an id, and any async continuation
  // whose id is no longer current silently returns.
  const runIdRef = useRef(0);
  // Whether the previous tick saw a pending run, so `onCompleted` fires on
  // the edge rather than on every poll of a finished job.
  const wasPendingRef = useRef(false);
  // Assigned during render so the effect never reads a stale callback, and
  // so a caller passing an inline arrow can't restart the poll loop.
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  useEffect(() => {
    const runId = ++runIdRef.current;
    const post = pendingPostRef.current;
    pendingPostRef.current = null;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const live = () => runIdRef.current === runId;

    const statusUrl = `/api/repos/${encodeURIComponent(repoId)}/label`;

    function schedule(delay: number) {
      if (!live()) return;
      timer = setTimeout(() => {
        void tick();
      }, delay);
    }

    /** POSTs the run. Returns true when polling should continue. */
    async function enqueue(force: boolean): Promise<boolean> {
      try {
        const res = await fetch(statusUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        });
        const json = (await res.json().catch(() => null)) as unknown;
        if (!live()) return false;

        if (!res.ok || !json) {
          // 400 `ai_not_configured`, 404, 503 `queue_unavailable` all land
          // here and become one inline note next to the button.
          const failure = (json ?? {}) as LabelErrorDTO;
          setSnapshot((prev) => ({
            ...prev,
            status: "ready",
            notice: failure.error ?? `Could not start labeling (${res.status}).`,
            noticeCode: failure.code ?? null,
            starting: false,
          }));
          return false;
        }
        // `enqueued: false` is not an error — a run of this repo was already
        // pending, and polling below attaches to it.
        void (json as EnqueueLabelResponseDTO);
        return true;
      } catch (err) {
        if (!live()) return false;
        setSnapshot((prev) => ({
          ...prev,
          status: "ready",
          notice: err instanceof Error ? err.message : "Could not start labeling.",
          noticeCode: null,
          starting: false,
        }));
        return false;
      }
    }

    async function tick() {
      if (!live()) return;

      let data: LabelStatusResponseDTO;
      try {
        const res = await fetch(statusUrl, { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as unknown;
        if (!live()) return;
        // Success is decided by the HTTP status, never by "does the body
        // have an `error` field" — a 200 legitimately carries one when the
        // endpoint degrades to "counts without live job state".
        if (!res.ok || !json) {
          const failure = (json ?? {}) as LabelErrorDTO;
          setSnapshot((prev) => ({
            ...prev,
            status: "error",
            notice: failure.error ?? `Could not read the labeling state (${res.status}).`,
            noticeCode: failure.code ?? null,
            starting: false,
          }));
          return;
        }
        data = json as LabelStatusResponseDTO;
      } catch (err) {
        if (!live()) return;
        setSnapshot((prev) => ({
          ...prev,
          status: "error",
          notice: err instanceof Error ? err.message : "Could not read the labeling state.",
          starting: false,
        }));
        return;
      }

      const pending = isLabelPending(data.state);

      setSnapshot((prev) => ({
        status: "ready",
        state: data.state,
        progress: data.progress,
        aiConfigured: data.aiConfigured,
        domains: data.domains,
        describedModules: data.describedModules,
        modules: data.modules,
        // A POST error already surfaced (e.g. `ai_not_configured`) must
        // survive the next poll, which carries no `error` of its own.
        notice: data.error ?? (pending ? null : prev.notice),
        noticeCode: data.error ? null : prev.noticeCode,
        starting: prev.starting && !pending,
      }));

      // The run just finished (or failed): tell the caller once, so it can
      // refetch the graph and pick up the new domain nodes.
      if (wasPendingRef.current && !pending) {
        wasPendingRef.current = false;
        onCompletedRef.current?.();
      } else if (pending) {
        wasPendingRef.current = true;
      }

      if (pending) schedule(POLL_INTERVAL_MS);
    }

    async function start() {
      if (post) {
        setSnapshot((prev) => ({
          ...prev,
          notice: null,
          noticeCode: null,
          starting: true,
        }));
        // Treat the run as pending from the moment it is accepted, so the
        // completion edge fires even for a job that finishes between polls.
        const ok = await enqueue(post.force);
        if (!live()) return;
        if (ok) {
          wasPendingRef.current = true;
          schedule(POST_SETTLE_MS);
        }
        return;
      }
      await tick();
    }

    void start();

    return () => {
      // Bumping the id is what actually stops the loop: any fetch already in
      // flight resolves into a `live()` check that now fails.
      runIdRef.current += 1;
      if (timer) clearTimeout(timer);
    };
    // Exactly two dependencies, neither of which this effect writes.
    // `snapshot` is deliberately absent — this effect *sets* it.
  }, [repoId, runNonce]);

  const generate = useCallback((options: { force?: boolean } = {}) => {
    pendingPostRef.current = { force: options.force === true };
    setRunNonce((n) => n + 1);
  }, []);

  const running = isLabelPending(snapshot.state) || snapshot.starting;
  const canGenerate = snapshot.status !== "loading" && snapshot.aiConfigured && !running;
  const hasLabels = snapshot.domains > 0 || snapshot.describedModules > 0;
  const logsUrl = useMemo(
    () => `/api/repos/${encodeURIComponent(repoId)}/label?logs=1`,
    [repoId]
  );

  return useMemo(
    () => ({ ...snapshot, generate, canGenerate, hasLabels, running, logsUrl }),
    [snapshot, generate, canGenerate, hasLabels, running, logsUrl]
  );
}
