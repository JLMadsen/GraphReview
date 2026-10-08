"use client";

// The selected target's base-vs-head comparison (DESIGN.md §6.10): the
// structure change and the call graph. Reading it is what starts it; it is
// polled while the comparison runs. The last stored result shows while a
// newer one is computed.

import { useEffect, useRef, useState } from "react";
import type { TargetGraphResponseDTO } from "./target-graph-types";
import { reviewTargetKeyOf, reviewTargetQuery, type ReviewTargetDTO } from "./types";

const POLL_MS = 2000;

export interface UseTargetGraphResult {
  graph: TargetGraphResponseDTO | null;
  error: string | null;
  /** The comparison is queued or running. */
  pending: boolean;
}

export function useTargetGraph(repoId: string, target: ReviewTargetDTO | null): UseTargetGraphResult {
  const [graph, setGraph] = useState<TargetGraphResponseDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const targetKey = target ? reviewTargetKeyOf(target) : null;
  const query = target ? reviewTargetQuery(target) : null;

  useEffect(() => {
    setGraph(null);
    setError(null);
    if (!query) return;
    const gen = ++generation.current;
    const counter = generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/target-graph?${query}`, { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as (TargetGraphResponseDTO & { error?: string }) | null;
        if (gen !== generation.current) return;
        if (!res.ok || !json) throw new Error(json?.error ?? `Request failed (${res.status}).`);
        setGraph(json);
        setError(json.state === "failed" ? (json.error ?? "The comparison failed.") : null);
        if (json.state === "queued" || json.state === "running") timer = setTimeout(() => void load(), POLL_MS);
      } catch (err) {
        if (gen === generation.current) setError(err instanceof Error ? err.message : "Could not compare the base and head.");
      }
    };
    void load();
    return () => {
      counter.current++;
      if (timer) clearTimeout(timer);
    };
  }, [repoId, targetKey, query]);

  const pending = graph?.state === "queued" || graph?.state === "running" || (graph === null && error === null && query !== null);
  return { graph, error, pending };
}
