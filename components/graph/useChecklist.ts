"use client";

// Client state for the PR prerequisite checklist (DESIGN.md §6.6).
//
// - Evaluates on every target change (cheap: no AI call).
// - Runs the AI items once per head commit, automatically, as soon as the
//   AI review of that target has finished — so their answers can lean on
//   the review's findings, and so opening a PR doesn't spend tokens twice
//   while the review is still streaming in. When the target doesn't
//   auto-review (a merged PR), the AI items wait for the button.
// - Re-reads every 30 s while any CI check is still running.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChecklistEvaluationDTO } from "./checklist-types";
import { reviewTargetKeyOf, reviewTargetQuery, type ReviewStateDTO, type ReviewTargetDTO } from "./types";

const CI_POLL_MS = 30_000;

export interface UseChecklistResult {
  data: ChecklistEvaluationDTO | null;
  loading: boolean;
  error: string | null;
  runningAi: boolean;
  runAi(): Promise<void>;
  refresh(): void;
}

export function useChecklist(
  repoId: string,
  target: ReviewTargetDTO | null,
  reviewState: ReviewStateDTO | undefined,
  autoReview: boolean
): UseChecklistResult {
  const [data, setData] = useState<ChecklistEvaluationDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningAi, setRunningAi] = useState(false);
  const [nonce, setNonce] = useState(0);
  /** `<targetKey>|<headSha>` pairs the AI items were auto-run for already. */
  const autoRanRef = useRef(new Set<string>());
  const targetKey = target ? reviewTargetKeyOf(target) : null;
  const base = `/api/repos/${encodeURIComponent(repoId)}/checklist`;

  useEffect(() => {
    setData(null);
    setError(null);
  }, [targetKey]);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${base}?${reviewTargetQuery(target)}${nonce > 0 ? "&fresh=1" : ""}`)
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as (ChecklistEvaluationDTO & { error?: string }) | null;
        if (!res.ok || !json) throw new Error(json?.error ?? `Checklist request failed (${res.status}).`);
        return json;
      })
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setError(null);
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
    // `target` is identified by `targetKey`; a new object for the same target must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, targetKey, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const runAi = useCallback(async () => {
    if (!target) return;
    setRunningAi(true);
    setError(null);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, action: "run-ai" }),
      });
      const json = (await res.json().catch(() => null)) as (ChecklistEvaluationDTO & { error?: string }) | null;
      if (!res.ok || !json) throw new Error(json?.error ?? `The AI checks failed (${res.status}).`);
      setData(json);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunningAi(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, targetKey]);

  // Auto-run the AI items once the review is done.
  useEffect(() => {
    if (!data || !targetKey || runningAi || !data.aiConfigured || data.aiPending === 0) return;
    const reviewDone = reviewState === "completed" || reviewState === "failed";
    if (!autoReview || !reviewDone) return;
    const key = `${targetKey}|${data.headSha ?? ""}`;
    if (autoRanRef.current.has(key)) return;
    autoRanRef.current.add(key);
    void runAi();
  }, [data, targetKey, reviewState, autoReview, runningAi, runAi]);

  // Keep a running CI fresh.
  useEffect(() => {
    if (!data?.items.some((i) => i.kind === "ci" && i.status === "pending")) return;
    const timer = setTimeout(refresh, CI_POLL_MS);
    return () => clearTimeout(timer);
  }, [data, refresh]);

  return { data, loading, error, runningAi, runAi, refresh };
}
