"use client";

// Fetches the PR map (DESIGN.md §6.4) for the current diff selection.
//
// `request` is the diff-impact body for whatever is selected — a PR, a ref
// pair, or pasted paths — and `refreshKey` is anything that should trigger a
// re-read of the same selection: GraphView passes the review's state, so
// the cards swap from folder names to the AI grouping the moment the review
// job that stores it finishes. The previous map stays up while a refresh is
// in flight, so the canvas doesn't flash empty on every review tick.

import { useEffect, useMemo, useState } from "react";
import type { PrMapRequestDTO, PrMapResponseDTO } from "./pr-map-types";

export interface UsePrMapResult {
  map: PrMapResponseDTO | null;
  loading: boolean;
  error: string | null;
}

export function usePrMap(
  repoId: string,
  request: PrMapRequestDTO | null,
  refreshKey: unknown
): UsePrMapResult {
  const requestKey = useMemo(() => (request ? JSON.stringify(request) : null), [request]);
  const [map, setMap] = useState<PrMapResponseDTO | null>(null);
  const [mapKey, setMapKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!requestKey) {
      setMap(null);
      setMapKey(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/repos/${repoId}/pr-map`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestKey,
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as
          | PrMapResponseDTO
          | { error: string }
          | null;
        if (!res.ok || !json || "error" in json) {
          throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        }
        return json;
      })
      .then((data) => {
        if (cancelled) return;
        setMap(data);
        setMapKey(requestKey);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load the PR map.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, requestKey, refreshKey]);

  // A map for a *different* selection is never shown, even while the new one loads.
  return {
    map: mapKey === requestKey ? map : null,
    loading,
    error,
  };
}
