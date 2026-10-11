"use client";

// Choosing the repo's schema source file (DESIGN.md §6.13, pinned source):
// the files of the analysed commit that hold schema statements, best first
// (non-test, then by CREATE TABLE count), each with "Use this file", and a
// search over every file of that commit to pick any other. Pinning replaces
// auto-detection; "Use auto-detect" clears it. Either re-runs the analysis —
// `onChanged` is told, and waits for it.

import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, Search, X } from "lucide-react";
import { cn } from "cn";
import type { DbSourceCandidatesDTO } from "./db-types";

const KIND_LABEL: Record<string, string> = { sql: "SQL", prisma: "Prisma", code: "code" };
const MAX_MATCHES = 30;

export interface DbSourcePickerProps {
  repoId: string;
  /** The pin as chosen now. */
  pin: string | null;
  /** Pinned or cleared — the analysis is re-running. */
  onChanged: (file: string | null) => void;
  onClose?: () => void;
  className?: string;
}

export function DbSourcePicker({ repoId, pin, onChanged, onClose, className }: DbSourcePickerProps) {
  const [data, setData] = useState<DbSourceCandidatesDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/repos/${encodeURIComponent(repoId)}/db-schema/candidates`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as DbSourceCandidatesDTO | { error: string } | null;
        if (!res.ok || !json || "error" in json) throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        return json;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't list the files.");
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !data) return [];
    return data.files.filter((f) => f.toLowerCase().includes(q)).slice(0, MAX_MATCHES);
  }, [query, data]);

  const choose = async (file: string | null) => {
    setBusy(file ?? "");
    setError(null);
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/db-schema/source`, {
        method: file ? "PUT" : "DELETE",
        headers: { "Content-Type": "application/json" },
        ...(file ? { body: JSON.stringify({ file }) } : {}),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status}).`);
      onChanged(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the source.");
    } finally {
      setBusy(null);
    }
  };

  const row = (file: string, detail: React.ReactNode) => (
    <li key={file} className="flex min-w-0 items-baseline gap-2 border-b border-border/60 py-1 last:border-0">
      <span className={cn("min-w-0 flex-1 truncate font-mono text-xs", file === pin && "text-brand")} title={file}>
        {file}
      </span>
      {detail}
      <button
        type="button"
        disabled={busy !== null || file === pin}
        onClick={() => void choose(file)}
        className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-secondary disabled:opacity-50"
      >
        {busy === file ? <LoaderCircle className="size-3 animate-spin" aria-label="Pinning" /> : file === pin ? "In use" : "Use this file"}
      </button>
    </li>
  );

  return (
    <div className={cn("text-sm", className)}>
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 text-foreground">Choose the schema source file</p>
        {pin && (
          <button type="button" disabled={busy !== null} onClick={() => void choose(null)} className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground hover:underline">
            Use auto-detect
          </button>
        )}
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 self-center text-muted-foreground hover:text-foreground">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        One file becomes the repo&apos;s only database, for the analysed commit and every pull request: <span className="font-mono">.sql</span> replayed in line order,
        <span className="font-mono"> .prisma</span>, or a code file&apos;s CREATE / ALTER strings. It replaces auto-detection until you change it.
      </p>
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
      {!data && !error && (
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" aria-hidden /> Looking for files with schema statements…
        </p>
      )}
      {data && (
        <>
          <p className="mt-3 mb-1 text-[11px] font-medium text-muted-foreground">Files with schema statements</p>
          {data.candidates.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">None found — search for the file below.</p>
          ) : (
            <ul>
              {data.candidates.map((c) =>
                row(
                  c.file,
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {c.tables} table{c.tables === 1 ? "" : "s"}
                    {c.statements ? ` · ${c.statements} other` : ""} · {KIND_LABEL[c.kind] ?? c.kind}
                    {c.test ? " · test" : ""}
                  </span>,
                ),
              )}
            </ul>
          )}
          <label className="mt-3 flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs focus-within:border-foreground/30">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${data.files.length.toLocaleString("en-US")} files…`}
              aria-label="Search the repo's files"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </label>
          {query.trim() && (
            <ul className="mt-1">
              {matches.length === 0 ? <li className="py-1 text-[11px] text-muted-foreground">No file matches.</li> : matches.map((f) => row(f, null))}
            </ul>
          )}
          {data.truncated && <p className="mt-1 text-[11px] text-muted-foreground">The search covers the first 100,000 files.</p>}
        </>
      )}
    </div>
  );
}
