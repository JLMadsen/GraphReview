// One file's content for the Files view, fetched once per path and commit.

import { useEffect, useRef, useState } from "react";
import type { FileContentResponseDTO } from "../types";

export type FileState = { status: "loading" } | { status: "ready"; data: FileContentResponseDTO } | { status: "error"; message: string };

export function useFileText(repoId: string, path: string | null, cacheKey: string): FileState | null {
  const cache = useRef(new Map<string, FileState>());
  const [, rerender] = useState(0);
  useEffect(() => cache.current.clear(), [repoId, cacheKey]);
  useEffect(() => {
    if (!path || cache.current.has(path)) return;
    cache.current.set(path, { status: "loading" });
    rerender((n) => n + 1);
    fetch(`/api/repos/${encodeURIComponent(repoId)}/file?path=${encodeURIComponent(path)}`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as FileContentResponseDTO | { error: string } | null;
        if (!res.ok || !json || "error" in json) throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        cache.current.set(path, { status: "ready", data: json });
      })
      .catch((err: unknown) => {
        cache.current.set(path, { status: "error", message: err instanceof Error ? err.message : "Couldn't read the file." });
      })
      .finally(() => rerender((n) => n + 1));
  }, [repoId, path, cacheKey]);
  return path ? (cache.current.get(path) ?? { status: "loading" }) : null;
}
