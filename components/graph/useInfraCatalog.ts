"use client";

// Data for the Infra view (DESIGN.md §6.12): the analysed commit's infra
// catalog, re-read whenever `refreshKey` changes (a finished analysis).

import { useEffect, useState } from "react";
import type { InfraCatalogResponseDTO } from "./infra-types";

export interface UseInfraCatalogResult {
  catalog: InfraCatalogResponseDTO | null;
  loading: boolean;
  error: string | null;
}

export function useInfraCatalog(repoId: string, enabled: boolean, refreshKey: unknown): UseInfraCatalogResult {
  const [catalog, setCatalog] = useState<InfraCatalogResponseDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/repos/${encodeURIComponent(repoId)}/infra-catalog`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as InfraCatalogResponseDTO | { error: string } | null;
        if (!res.ok || !json || "error" in json) throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        return json;
      })
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load the infrastructure.");
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
