"use client";

// Data for the Files view: the analysed commit's file tree, re-read whenever
// `refreshKey` changes (a finished analysis).

import { useEffect, useState } from "react";
import type { RepoTreeResponseDTO } from "./files-types";

export interface UseRepoTreeResult {
  tree: RepoTreeResponseDTO | null;
  loading: boolean;
  error: string | null;
}

export function useRepoTree(repoId: string, enabled: boolean, refreshKey: unknown): UseRepoTreeResult {
  const [tree, setTree] = useState<RepoTreeResponseDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/repos/${encodeURIComponent(repoId)}/tree`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as RepoTreeResponseDTO | { error: string } | null;
        if (!res.ok || !json || "error" in json) throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        return json;
      })
      .then((data) => {
        if (cancelled) return;
        setTree(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load the files.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, enabled, refreshKey]);

  return { tree, loading, error };
}
