"use client";

// Data for the Data view (DESIGN.md §6.13): the analysed commit's schema
// catalog, re-read whenever `refreshKey` changes (a finished analysis).

import { useEffect, useState } from "react";
import type { DbSchemaResponseDTO } from "./db-types";

export interface UseDbSchemaResult {
  schema: DbSchemaResponseDTO | null;
  loading: boolean;
  error: string | null;
}

export function useDbSchema(repoId: string, enabled: boolean, refreshKey: unknown): UseDbSchemaResult {
  const [schema, setSchema] = useState<DbSchemaResponseDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/repos/${encodeURIComponent(repoId)}/db-schema`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as DbSchemaResponseDTO | { error: string } | null;
        if (!res.ok || !json || "error" in json) throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        return json;
      })
      .then((data) => {
        if (cancelled) return;
        setSchema(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load the schema.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, enabled, refreshKey]);

  return { schema, loading, error };
}
