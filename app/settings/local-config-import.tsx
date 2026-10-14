"use client";

// "Use local config": providers found in local harness configs (OpenCode,
// Codex, Claude Code, …), listed so the user can pick one or more and load
// them as saved providers (DESIGN.md §6.17). Keys never come to the browser:
// the list only says whether one was found, and the import action reads it
// again on the server.

import { useEffect, useState, useTransition } from "react";
import { ChevronDown, Info, KeyRound, LoaderCircle, RefreshCw, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { discoverLocalProvidersAction, importLocalProvidersAction } from "./actions";
import type { LocalProviderSelection, PublicLocalProviderCandidate } from "./state";

type Candidate = PublicLocalProviderCandidate & { savedAs?: string };

interface RowState {
  selected: boolean;
  name: string;
  model: string;
  apiKey: string;
}

const SELECT_CLASS =
  "flex h-7 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent py-0.5 pr-7 pl-2 font-mono text-[12px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export function LocalConfigImport({ onClose }: { onClose: () => void }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [scanError, setScanError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isScanning, startScan] = useTransition();
  const [isImporting, startImport] = useTransition();

  const scan = () =>
    startScan(async () => {
      setScanError(null);
      try {
        const found = await discoverLocalProvidersAction();
        setCandidates(found);
        setRows(
          Object.fromEntries(
            found.map((c) => [
              c.id,
              { selected: false, name: c.name, model: c.defaultModel ?? c.models[0] ?? "", apiKey: "" },
            ])
          )
        );
      } catch (err) {
        setScanError(err instanceof Error ? err.message : "Scanning the local configs failed.");
      }
    });

  // Scan once when the panel opens.
  useEffect(scan, []);

  const update = (id: string, patch: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const selected = (candidates ?? []).filter((c) => rows[c.id]?.selected);

  const load = () =>
    startImport(async () => {
      setImportError(null);
      const selections: LocalProviderSelection[] = selected.map((c) => ({
        candidateId: c.id,
        name: rows[c.id].name,
        model: rows[c.id].model,
        apiKey: rows[c.id].apiKey || undefined,
      }));
      const result = await importLocalProvidersAction(selections);
      if (result.status === "success") onClose();
      else setImportError(result.error ?? "Loading the providers failed.");
    });

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] text-muted-foreground">
          Providers set up for OpenCode, Codex, Claude Code, Crush, Continue, Aider, Copilot CLI or in
          the environment. Pick the ones to load; keys are read from the config on the server.
        </p>
        <Button type="button" variant="ghost" size="icon-xs" onClick={scan} disabled={isScanning} title="Scan again">
          <RefreshCw className={isScanning ? "animate-spin" : undefined} aria-hidden />
        </Button>
      </div>

      {candidates === null ? (
        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Looking through local configs…
        </p>
      ) : candidates.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No provider configs found in the usual places (~/.config/opencode, ~/.codex, ~/.claude,
          ~/.config/crush, ~/.continue, ~/.aider.conf.yml, ~/.copilot) or the environment.
        </p>
      ) : (
        <ul className="space-y-2">
          {candidates.map((c) => (
            <CandidateRow key={c.id} candidate={c} row={rows[c.id]} onChange={(patch) => update(c.id, patch)} />
          ))}
        </ul>
      )}

      {scanError && (
        <p className="flex items-start gap-1.5 text-[13px] text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {scanError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button type="button" size="sm" onClick={load} disabled={isImporting || selected.length === 0}>
          {isImporting ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden />
              Loading…
            </>
          ) : selected.length > 1 ? (
            `Load ${selected.length} providers`
          ) : (
            "Load provider"
          )}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          <X aria-hidden />
          Cancel
        </Button>
        {importError && (
          <span className="flex items-center gap-1.5 text-[13px] text-destructive">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            {importError}
          </span>
        )}
      </div>
    </div>
  );
}

function CandidateRow({
  candidate: c,
  row,
  onChange,
}: {
  candidate: Candidate;
  row: RowState | undefined;
  onChange: (patch: Partial<RowState>) => void;
}) {
  if (!row) return null;
  const checkboxId = `local-${c.id}`;
  return (
    <li
      className={`space-y-2 rounded-lg border px-3 py-2.5 transition-colors ${
        row.selected ? "border-ring/60 bg-secondary/40" : "border-border"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <input
          id={checkboxId}
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-primary"
          checked={row.selected}
          onChange={(e) => onChange({ selected: e.target.checked })}
        />
        <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-medium">{c.name}</span>
            <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {c.harness}
            </span>
            {c.savedAs && (
              <span className="text-[11px] text-muted-foreground">same URL as “{c.savedAs}”</span>
            )}
          </div>
          <div className="truncate font-mono text-[12px] text-muted-foreground">{c.baseUrl}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {c.source}
            {" · "}
            {c.hasKey ? `key from ${c.keySource}` : c.needsKey ? "no key found" : "local server, no key needed"}
          </div>
        </label>
      </div>

      {c.note && (
        <p className="flex items-start gap-1.5 pl-6.5 text-[12px] text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {c.note}
        </p>
      )}

      {row.selected && (
        <div className="grid gap-2 pl-6.5 sm:grid-cols-2">
          <Input
            aria-label="Provider name"
            className="h-7 text-[12px] md:text-[12px]"
            value={row.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
          {c.models.length > 0 ? (
            <div className="relative">
              <select
                aria-label="Model"
                className={SELECT_CLASS}
                value={row.model}
                onChange={(e) => onChange({ model: e.target.value })}
              >
                {c.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {m === c.defaultModel ? " (default)" : ""}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
            </div>
          ) : (
            <Input
              aria-label="Model"
              placeholder="Model name (none in the config)"
              className="h-7 font-mono text-[12px] md:text-[12px]"
              value={row.model}
              onChange={(e) => onChange({ model: e.target.value })}
            />
          )}
          {c.needsKey && (
            <div className="relative sm:col-span-2">
              <KeyRound
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                aria-label="API key"
                type="password"
                autoComplete="off"
                placeholder="API key"
                className="h-7 pl-7 font-mono text-[12px] md:text-[12px]"
                value={row.apiKey}
                onChange={(e) => onChange({ apiKey: e.target.value })}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}
