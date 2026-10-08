"use client";

// Data for the API view (DESIGN.md §6.11): the analysed commit's endpoint
// catalog, re-read whenever `refreshKey` changes (a finished analysis), and
// ✦ Infer for one endpoint — whose answer replaces that endpoint in place.

import { useCallback, useEffect, useState } from "react";
import type { ApiCatalogResponseDTO, ApiInferResponseDTO } from "./api-types";

export interface UseApiCatalogResult {
  catalog: ApiCatalogResponseDTO | null;
  loading: boolean;
  error: string | null;
  /** Endpoint ids being inferred right now. */
  inferring: ReadonlySet<string>;
  /** The last inference error, by endpoint id. */
  inferErrors: ReadonlyMap<string, string>;
  infer: (endpointId: string) => Promise<void>;
}

export function useApiCatalog(repoId: string, enabled: boolean, refreshKey: unknown): UseApiCatalogResult {
  const [catalog, setCatalog] = useState<ApiCatalogResponseDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inferring, setInferring] = useState<ReadonlySet<string>>(new Set());
  const [inferErrors, setInferErrors] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/repos/${encodeURIComponent(repoId)}/api-catalog`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as ApiCatalogResponseDTO | { error: string } | null;
        if (!res.ok || !json || "error" in json) throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        return json;
      })
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load the endpoints.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, enabled, refreshKey]);

  const infer = useCallback(
    async (endpointId: string) => {
      setInferring((s) => new Set(s).add(endpointId));
      setInferErrors((m) => {
        const next = new Map(m);
        next.delete(endpointId);
        return next;
      });
      try {
        const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/api-catalog/infer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpointId }),
        });
        const json = (await res.json().catch(() => null)) as ApiInferResponseDTO | { error: string } | null;
        if (!res.ok || !json || "error" in json) throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        setCatalog((c) => (c ? { ...c, endpoints: c.endpoints.map((e) => (e.id === endpointId ? json.endpoint : e)) } : c));
      } catch (err) {
        setInferErrors((m) => new Map(m).set(endpointId, err instanceof Error ? err.message : "Inference failed."));
      } finally {
        setInferring((s) => {
          const next = new Set(s);
          next.delete(endpointId);
          return next;
        });
      }
    },
    [repoId]
  );

  return { catalog, loading, error, inferring, inferErrors, infer };
}
