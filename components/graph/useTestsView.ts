"use client";

// The Tests view's data (DESIGN.md §6.22): the repo's test catalog, and for
// a selected diff its AI test plan. The change itself rides on the target graph.

import { useEffect, useState } from "react";
import type { ReviewTargetDTO } from "./types";
import type { StoredTestPlan, TestPlanResponseDTO, TestsResponseDTO } from "./tests-types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json().catch(() => null)) as T | { error: string } | null;
  if (!res.ok || !json || (typeof json === "object" && "error" in (json as object))) {
    throw new Error(json && typeof json === "object" && "error" in (json as object) ? (json as { error: string }).error : `Request failed (${res.status}).`);
  }
  return json as T;
}

function targetQuery(target: ReviewTargetDTO): string {
  return "prNumber" in target
    ? `prNumber=${target.prNumber}`
    : `baseRef=${encodeURIComponent(target.baseRef)}&headRef=${encodeURIComponent(target.headRef)}`;
}

export function useTestsView(repoId: string, enabled: boolean, refreshKey: unknown, target: ReviewTargetDTO | null, planKey: unknown) {
  const [catalog, setCatalog] = useState<TestsResponseDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<StoredTestPlan | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    getJson<TestsResponseDTO>(`/api/repos/${encodeURIComponent(repoId)}/tests`)
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load the tests.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, enabled, refreshKey]);

  useEffect(() => {
    setPlan(null);
    if (!enabled || !target) return;
    let cancelled = false;
    getJson<TestPlanResponseDTO>(`/api/repos/${encodeURIComponent(repoId)}/tests/plan?${targetQuery(target)}`)
      .then((data) => {
        if (!cancelled) setPlan(data.plan);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repoId, enabled, target, planKey]);

  return { catalog, loading, error, plan };
}
