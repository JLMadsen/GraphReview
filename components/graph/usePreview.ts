"use client";

// State for one file's before/after preview (DESIGN.md §6.9): reads the last
// run on open, starts a run on demand, and polls while one is pending.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PreviewInputs, PreviewMocks, PreviewResult, PreviewStatusDTO } from "@/lib/preview/types";
import type { ReviewTargetDTO } from "./types";

const POLL_MS = 1500;

function targetParams(target: ReviewTargetDTO): Record<string, string> {
  return "prNumber" in target
    ? { prNumber: String(target.prNumber) }
    : { baseRef: target.baseRef, headRef: target.headRef };
}

export interface UsePreviewResult {
  status: PreviewStatusDTO | null;
  /** The latest finished run, kept on screen while a new one is pending. */
  result: PreviewResult | null;
  /** A request (GET or POST) failed outright. */
  error: string | null;
  pending: boolean;
  run: (inputs?: PreviewInputs, mocks?: PreviewMocks) => Promise<void>;
  logs: string[];
}

export function usePreview(repoId: string, target: ReviewTargetDTO, filePath: string, enabled: boolean): UsePreviewResult {
  const [status, setStatus] = useState<PreviewStatusDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const targetKey = JSON.stringify(target);

  const load = useCallback(
    async (gen: number) => {
      const params = new URLSearchParams({ path: filePath, logs: "1", ...targetParams(JSON.parse(targetKey)) });
      try {
        const res = await fetch(`/api/repos/${repoId}/preview?${params.toString()}`);
        const json = (await res.json().catch(() => null)) as (PreviewStatusDTO & { error?: string }) | null;
        if (gen !== generation.current) return;
        if (!res.ok || !json) throw new Error(json?.error ?? `Request failed (${res.status}).`);
        setStatus(json);
        if (json.result) setResult(json.result);
        setLogs(json.logs ?? []);
        setError(null);
        if (json.state === "queued" || json.state === "running") {
          timer.current = setTimeout(() => void load(gen), POLL_MS);
        }
      } catch (err) {
        if (gen === generation.current) setError(err instanceof Error ? err.message : "Failed to load the preview.");
      }
    },
    [repoId, filePath, targetKey]
  );

  useEffect(() => {
    if (!enabled) return;
    const gen = ++generation.current;
    void load(gen);
    return () => {
      // A counter, not a DOM node: bumping it is how in-flight polls learn they are stale.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, load]);

  const run = useCallback(
    async (inputs?: PreviewInputs, mocks?: PreviewMocks) => {
      if (timer.current) clearTimeout(timer.current);
      const gen = ++generation.current;
      setError(null);
      setStatus((prev) => ({ ...(prev ?? {}), state: "queued", progress: { stage: "resolving", message: "queued" } }));
      setLogs([]);
      try {
        const res = await fetch(`/api/repos/${repoId}/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: filePath, ...JSON.parse(targetKey), inputs, mocks }),
        });
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status}).`);
        await load(gen);
      } catch (err) {
        if (gen !== generation.current) return;
        setError(err instanceof Error ? err.message : "Failed to start the preview.");
        setStatus((prev) => (prev ? { ...prev, state: prev.result ? "completed" : "none" } : null));
      }
    },
    [repoId, filePath, targetKey, load]
  );

  const pending = status?.state === "queued" || status?.state === "running";
  return { status, result, error, pending, run, logs };
}
