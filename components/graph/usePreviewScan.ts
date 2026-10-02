"use client";

// The target's changed UI components and how their previews came out
// (DESIGN.md §6.9), for the "Looks different" section. Reading the scan is
// what starts it; it is polled while the scan or any file's preview is
// pending. `previewAll` starts a preview run for every scanned file.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PreviewScanDTO } from "@/lib/preview/types";
import type { ReviewTargetDTO } from "./types";

const POLL_MS = 2500;

function targetParams(target: ReviewTargetDTO): Record<string, string> {
  return "prNumber" in target
    ? { prNumber: String(target.prNumber) }
    : { baseRef: target.baseRef, headRef: target.headRef };
}

function isPending(scan: PreviewScanDTO): boolean {
  if (scan.state === "queued" || scan.state === "running") return true;
  return scan.files.some((f) => f.preview === "queued" || f.preview === "running");
}

export interface UsePreviewScanResult {
  scan: PreviewScanDTO | null;
  error: string | null;
  previewAll: () => Promise<void>;
  starting: boolean;
}

export function usePreviewScan(repoId: string, target: ReviewTargetDTO | null): UsePreviewScanResult {
  const [scan, setScan] = useState<PreviewScanDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const targetKey = target ? JSON.stringify(target) : null;

  const load = useCallback(
    async (gen: number) => {
      if (!targetKey) return;
      if (timer.current) clearTimeout(timer.current);
      const params = new URLSearchParams(targetParams(JSON.parse(targetKey)));
      try {
        const res = await fetch(`/api/repos/${repoId}/preview/scan?${params.toString()}`);
        const json = (await res.json().catch(() => null)) as (PreviewScanDTO & { error?: string }) | null;
        if (gen !== generation.current) return;
        if (!res.ok || !json) throw new Error(json?.error ?? `Request failed (${res.status}).`);
        setScan(json);
        setError(null);
        if (isPending(json)) timer.current = setTimeout(() => void load(gen), POLL_MS);
      } catch (err) {
        if (gen === generation.current) setError(err instanceof Error ? err.message : "Failed to read the scan.");
      }
    },
    [repoId, targetKey]
  );

  useEffect(() => {
    setScan(null);
    setError(null);
    if (!targetKey) return;
    const gen = ++generation.current;
    void load(gen);
    return () => {
      // A counter, not a DOM node: bumping it is how in-flight polls learn they are stale.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [targetKey, load]);

  const previewAll = useCallback(async () => {
    if (!targetKey) return;
    setStarting(true);
    try {
      const res = await fetch(`/api/repos/${repoId}/preview/scan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: targetKey,
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status}).`);
      await load(generation.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the previews.");
    } finally {
      setStarting(false);
    }
  }, [repoId, targetKey, load]);

  return { scan, error, previewAll, starting };
}
