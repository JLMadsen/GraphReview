"use client";

// Data for the Env view (DESIGN.md §6.15): the analysed commit's env
// catalog, re-read whenever `refreshKey` changes (a finished analysis).

import { useEffect, useState } from "react";
import type { EnvCatalogResponseDTO } from "./env-types";

export interface UseEnvCatalogResult {
  catalog: EnvCatalogResponseDTO | null;
  loading: boolean;
  error: string | null;
}

export function useEnvCatalog(repoId: string, enabled: boolean, refreshKey: unknown): UseEnvCatalogResult {
  const [catalog, setCatalog] = useState<EnvCatalogResponseDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/repos/${encodeURIComponent(repoId)}/env-catalog`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as EnvCatalogResponseDTO | { error: string } | null;
        if (!res.ok || !json || "error" in json) throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        return json;
      })
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load the env vars.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, enabled, refreshKey]);

  return { catalog, loading, error };
}
