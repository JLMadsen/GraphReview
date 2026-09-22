"use client";

// The auto-run + polling half of the AI review feature (DESIGN.md §9, §10).
//
// Owns exactly one thing: keeping a `ReviewSnapshot` in sync with
// `/api/repos/[repoId]/review` for whichever target the Graph tab currently
// has selected. Rendering lives in `ReviewPanel`.
//
// Flow, per §10 ("no confirmation dialog, no cap"):
//
//   1. GET the target's review.
//   2. `aiConfigured === false`  -> stop. Never POST into an unconfigured
//      provider; the panel shows the "AI review is off" note instead.
//   3. `state === "none"`        -> POST once (the automatic run), then poll.
//   4. `state === "completed"`   -> show the stored findings and stop. This
//      is also what a job that has aged out of its retention window looks
//      like, so *not* re-POSTing here is what stops a revisit from silently
//      re-spending tokens. `rerun()` is the deliberate way back in.
//   5. `state === "queued" | "running"` -> attach and poll until it settles.
//   6. `freshness` (completed reviews only): the server says whether the
//      branch/PR has moved since the findings were produced. It is surfaced
//      as-is for the panel's "new commits — Re-run review" banner and never
//      acted on here: a moved branch does NOT trigger a POST (no silent token
//      spend). It is re-checked when the target is (re)selected — the main
//      effect re-runs — and when the tab becomes visible again; never on a
//      timer.
//
// ---------------------------------------------------------------------------
// The dependency-array footgun this file is written around
// ---------------------------------------------------------------------------
// This codebase has twice been bitten by listing a state variable in the
// dependency array of the same effect that sets it (see DiffPanel's two
// list-fetch effects): the effect re-runs the instant its own `setState`
// commits, and the cleanup from the *first* run cancels the in-flight fetch
// before the response lands — a successful request that leaves the UI stuck
// on "loading" forever. A polling loop makes that far worse, because it
// would restart on every tick.
//
// So the effect below depends on three things only, none of which it sets:
// `repoId`, `targetKey` (a primitive, not the target object — a new object
// literal on every render would restart polling continuously), and
// `rerunNonce` (bumped only by the `rerun` callback). Everything the loop
// needs to know about itself lives in refs: a monotonic run id that makes
// stale responses from a superseded target no-ops, and the pending timer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  reviewTargetKeyOf,
  reviewTargetQuery,
  type EnqueueReviewResponseDTO,
  type FindingDTO,
  type ReviewErrorDTO,
  type ReviewFreshnessDTO,
  type ReviewProgressDTO,
  type ReviewStateDTO,
  type ReviewStatusResponseDTO,
  type ReviewTargetDTO,
} from "./types";

/** Poll cadence while a job is queued/running. Mock calls take ~900ms, so this shows every component landing without hammering Neo4j. */
const POLL_INTERVAL_MS = 1200;
/** Shorter first poll straight after an enqueue, so "queued" appears immediately rather than a second later. */
const POST_SETTLE_MS = 350;

export interface ReviewSnapshot {
  /** `idle` = no target selected. `loading` = first GET in flight. */
  status: "idle" | "loading" | "ready" | "error";
  state: ReviewStateDTO;
  progress?: ReviewProgressDTO;
  findings: FindingDTO[];
  /** Whether the reviewed code has moved since the review ran. Only set for a completed review that recorded its shas; absent otherwise (legacy findings, running, …). */
  freshness?: ReviewFreshnessDTO;
  /** Whether base URL + key + model are all set. `false` suppresses every POST. */
  aiConfigured: boolean;
  /** Inline message to show in the panel: a failed job's reason, a 503, `not_linked`, … */
  notice: string | null;
  /** `ai_not_configured` | `not_linked` | `queue_unavailable`, when the server sent one. */
  noticeCode: string | null;
  /** True between a rerun POST and the first poll that reflects it. */
  rerunning: boolean;
}

const IDLE_SNAPSHOT: ReviewSnapshot = {
  status: "idle",
  state: "none",
  findings: [],
  aiConfigured: false,
  notice: null,
  noticeCode: null,
  rerunning: false,
};

export interface UseReviewResult extends ReviewSnapshot {
  /** Deliberate re-run (§10): removes the finished job and enqueues a fresh one. */
  rerun: () => void;
  /** Whether a re-run is even possible right now. */
  canRerun: boolean;
}

function isPending(state: ReviewStateDTO): boolean {
  return state === "queued" || state === "running";
}

export function useReview(
  repoId: string,
  target: ReviewTargetDTO | null
): UseReviewResult {
  const targetKey = target ? reviewTargetKeyOf(target) : null;
  const [snapshot, setSnapshot] = useState<ReviewSnapshot>(IDLE_SNAPSHOT);
  const [rerunNonce, setRerunNonce] = useState(0);

  // Set by `rerun()` and consumed once by the effect run it triggers, so a
  // re-run POSTs even when the target is already `completed`. A ref rather
  // than state because reading it must not itself be a render input.
  const forceRunRef = useRef(false);
  // Monotonic: every effect run claims an id, and any async continuation
  // whose id is no longer current silently returns. This is what makes a
  // target switch mid-poll safe without cancelling via AbortController
  // (which would also abort the request we still want the *answer* to when
  // React 18 StrictMode double-invokes the effect in development).
  const runIdRef = useRef(0);

  // `target` is re-created by the caller on every render; the effect keys off
  // the string instead, and re-parses the object from this ref. Assigned
  // during render so it is never stale by the time the effect reads it.
  const targetRef = useRef<ReviewTargetDTO | null>(target);
  targetRef.current = target;

  // Read-only mirror of the snapshot for the visibility listener below, which
  // must know "is a run in flight / is there a completed review on screen"
  // without listing `snapshot` as a dependency (it sets it — §17).
  const snapshotRef = useRef<ReviewSnapshot>(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    const runId = ++runIdRef.current;
    const force = forceRunRef.current;
    forceRunRef.current = false;

    const currentTarget = targetRef.current;
    if (!targetKey || !currentTarget) {
      setSnapshot(IDLE_SNAPSHOT);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const live = () => runIdRef.current === runId;

    const query = reviewTargetQuery(currentTarget);
    const statusUrl = `/api/repos/${encodeURIComponent(repoId)}/review?${query}`;
    const enqueueUrl = `/api/repos/${encodeURIComponent(repoId)}/review`;

    // Only ever one automatic POST per effect run, whatever the polling does.
    let postAttempted = false;

    function schedule(delay: number, canPost: boolean) {
      if (!live()) return;
      timer = setTimeout(() => {
        void tick(canPost);
      }, delay);
    }

    /** POSTs the review. Returns true when polling should continue. */
    async function enqueue(): Promise<boolean> {
      try {
        const res = await fetch(enqueueUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(currentTarget),
        });
        const json = (await res.json().catch(() => null)) as unknown;
        if (!live()) return false;

        if (!res.ok || !json) {
          // 400 `ai_not_configured` / 400 `not_linked` / 404 / 503
          // `queue_unavailable` all land here and become one inline note in
          // the dock — none of them is worth an error boundary or a toast.
          const failure = (json ?? {}) as ReviewErrorDTO;
          setSnapshot((prev) => ({
            ...prev,
            status: "ready",
            notice:
              failure.error ?? `Could not start the review (${res.status}).`,
            noticeCode: failure.code ?? null,
            rerunning: false,
          }));
          return false;
        }
        // `enqueued: false` is not an error — it means a run of this exact
        // target was already pending, and polling below will attach to it.
        void (json as EnqueueReviewResponseDTO);
        return true;
      } catch (err) {
        if (!live()) return false;
        setSnapshot((prev) => ({
          ...prev,
          status: "ready",
          notice:
            err instanceof Error
              ? err.message
              : "Could not start the review.",
          noticeCode: null,
          rerunning: false,
        }));
        return false;
      }
    }

    async function tick(canPost: boolean) {
      if (!live()) return;

      let data: ReviewStatusResponseDTO;
      try {
        const res = await fetch(statusUrl, { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as unknown;
        if (!live()) return;
        // Success is decided by the HTTP status, never by "does the body
        // have an `error` field" — a 200 status response legitimately
        // carries one (the endpoint degrades to "findings without live job
        // state" when Redis is down and says so in `error`). Treating that
        // as a failed request would throw away findings that are sitting
        // right there in the same payload.
        if (!res.ok || !json) {
          const failure = (json ?? {}) as ReviewErrorDTO;
          setSnapshot({
            ...IDLE_SNAPSHOT,
            status: "error",
            notice:
              failure.error ?? `Could not read the review (${res.status}).`,
            noticeCode: failure.code ?? null,
          });
          return;
        }
        data = json as ReviewStatusResponseDTO;
      } catch (err) {
        if (!live()) return;
        setSnapshot({
          ...IDLE_SNAPSHOT,
          status: "error",
          notice:
            err instanceof Error ? err.message : "Could not read the review.",
        });
        return;
      }

      // A POST error already surfaced (e.g. `not_linked`) must survive the
      // next poll, which carries no `error` of its own — so the incoming
      // `data.error` only *replaces* a previous notice when it has one.
      setSnapshot((prev) => ({
        status: "ready",
        state: data.state,
        progress: data.progress,
        findings: data.findings,
        freshness: data.freshness,
        aiConfigured: data.aiConfigured,
        notice: data.error ?? (isPending(data.state) ? null : prev.notice),
        noticeCode: data.error ? null : prev.noticeCode,
        rerunning: prev.rerunning && !isPending(data.state),
      }));

      // §10: automatic, no confirm — but never into an unconfigured provider,
      // and never a second time over findings that already exist.
      const shouldPost =
        data.aiConfigured &&
        !postAttempted &&
        (force || (canPost && data.state === "none"));

      if (shouldPost) {
        postAttempted = true;
        const ok = await enqueue();
        if (!live()) return;
        if (ok) schedule(POST_SETTLE_MS, false);
        return;
      }

      if (isPending(data.state)) schedule(POLL_INTERVAL_MS, false);
    }

    setSnapshot((prev) => ({
      // A re-run keeps the previous findings on screen while the new job
      // warms up (stale-while-revalidate), rather than blanking the panel.
      ...(force ? prev : IDLE_SNAPSHOT),
      status: force ? "ready" : "loading",
      notice: null,
      noticeCode: null,
      rerunning: force,
    }));
    void tick(true);

    return () => {
      // Bumping the id is what actually stops the loop: any fetch already in
      // flight resolves into a `live()` check that now fails.
      runIdRef.current += 1;
      if (timer) clearTimeout(timer);
    };
    // Exactly three dependencies, none of which this effect writes.
    // `snapshot` is deliberately absent — this effect *sets* it, and listing
    // it here is the exact self-retrigger this file's header warns about.
    // (The lint rule agrees: everything else the effect reads is either a
    // ref or module scope, so no disable comment is needed to keep it out.)
  }, [repoId, targetKey, rerunNonce]);

  // Re-check freshness when the tab comes back into view: the usual way a
  // branch moves is that the user pushed from a terminal in another window.
  // One plain GET, applied only to a completed review that is on screen — it
  // never POSTs, never interrupts a run in flight, and is dropped if the
  // target/run changed while it was travelling. Deps are the two primitives
  // that identify the review; the state it writes is reached via functional
  // update and read via `snapshotRef`.
  useEffect(() => {
    if (!targetKey) return;

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const current = snapshotRef.current;
      const currentTarget = targetRef.current;
      if (!currentTarget || current.status !== "ready" || current.state !== "completed") {
        return;
      }
      const runId = runIdRef.current;
      const url = `/api/repos/${encodeURIComponent(repoId)}/review?${reviewTargetQuery(currentTarget)}`;
      void (async () => {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) return;
          const data = (await res.json().catch(() => null)) as ReviewStatusResponseDTO | null;
          if (!data || runIdRef.current !== runId) return;
          // Only fold in a still-completed review; a run started elsewhere in
          // the meantime is picked up by the next explicit load, not here.
          if (data.state !== "completed") return;
          setSnapshot((prev) =>
            prev.status === "ready" && prev.state === "completed"
              ? { ...prev, findings: data.findings, freshness: data.freshness }
              : prev
          );
        } catch {
          /* advisory — a failed re-check just leaves the last answer up */
        }
      })();
    };

    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [repoId, targetKey]);

  const rerun = useCallback(() => {
    forceRunRef.current = true;
    setRerunNonce((n) => n + 1);
  }, []);

  const canRerun =
    snapshot.status === "ready" &&
    snapshot.aiConfigured &&
    !isPending(snapshot.state) &&
    !snapshot.rerunning;

  return useMemo(
    () => ({ ...snapshot, rerun, canRerun }),
    [snapshot, rerun, canRerun]
  );
}
