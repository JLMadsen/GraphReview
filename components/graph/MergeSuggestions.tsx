"use client";

// Feature merges in the Graph tab (DESIGN.md §6.3):
//
// - `MergesControl` — the toolbar button with the open-suggestion count,
//   and a "Groups out of date" chip when a merge moved modules between
//   domains since the last labeling run.
// - `MergeSuggestionsPanel` — the list itself, in the right-hand sidebar.
//   Hovering a card rings the nodes it would combine on the canvas; Accept
//   applies it straight away (then names it with AI when configured),
//   Reject remembers the rejection.
//
// Presentational only; state and requests live in `useMerges`.

import { useEffect, useState } from "react";
import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  GitMerge,
  LoaderCircle,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "cn";
import type { MergeSuggestionDTO } from "./merge-types";
import type { UseMergesResult } from "./useMerges";

/** `app/map/**` → `app/map/`; exact file paths unchanged. */
export function formatMember(member: string): string {
  return member.endsWith("/**") ? `${member.slice(0, -3)}/` : member;
}

function titleFor(s: MergeSuggestionDTO): string {
  switch (s.kind) {
    case "merge":
      return `Merge into “${s.name}”`;
    case "extend":
      return `Add to “${s.name}”`;
    case "move-file":
      return `Move ${s.members.length === 1 ? "a file" : `${s.members.length} files`} into “${s.name}”`;
  }
}

export interface MergesControlProps {
  merges: UseMergesResult;
  open: boolean;
  onToggle: () => void;
  /** Present when domain groups exist: re-runs labeling to fit them to the merged modules. */
  onRegroup?: () => void;
}

export function MergesControl({ merges, open, onToggle, onRegroup }: MergesControlProps) {
  if (!merges.data) return null;
  const count = merges.openCount;
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={open}
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
          open ? "border-brand/50 bg-brand/10 text-foreground" : "border-border bg-card text-foreground hover:bg-secondary"
        )}
        title="Folders that look like one feature — merge them into a single node"
      >
        <GitMerge className="size-3.5 text-brand" aria-hidden />
        Merge suggestions
        {count > 0 && (
          <span className="rounded-full bg-brand px-1.5 font-mono text-[10px] leading-4 text-white">{count}</span>
        )}
      </button>
      {merges.data.domainsStale && onRegroup && (
        <button
          type="button"
          onClick={onRegroup}
          className="flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning transition-colors hover:bg-warning/20"
          title="A merge moved modules between domain groups. Re-generate labels to regroup them (uses the AI provider)."
        >
          <TriangleAlert className="size-3" aria-hidden />
          Groups out of date — regroup
        </button>
      )}
    </div>
  );
}

export interface MergeSuggestionsPanelProps {
  merges: UseMergesResult;
  onPreview: (componentIds: string[] | null) => void;
  /** Called with the new/extended module id after a successful accept. */
  onAccepted: (componentId: string) => void;
  onClose: () => void;
}

export function MergeSuggestionsPanel({ merges, onPreview, onAccepted, onClose }: MergeSuggestionsPanelProps) {
  const [showRejected, setShowRejected] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const suggestions = merges.data?.suggestions ?? [];
  const open = suggestions.filter((s) => s.status === "open");
  const rejected = suggestions.filter((s) => s.status === "rejected");
  const acceptingAll = merges.busy?.action === "accept-all";

  // An armed "Click again" disarms itself, so a stray first click can't sit
  // waiting for an accidental second one.
  useEffect(() => {
    if (!confirmAll) return;
    const timer = setTimeout(() => setConfirmAll(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmAll]);

  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
      <div className="flex items-start gap-2 border-b border-border px-3 py-2.5">
        <GitMerge className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tracking-tight">Merge suggestions</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Folders that look like one feature. Recomputed after every analysis — no AI involved.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mr-1 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Close merge suggestions"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {merges.notice && (
        <div className="flex items-start gap-1.5 border-b border-border bg-warning/10 px-3 py-2 text-[11px] text-warning">
          <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
          <span className="flex-1">{merges.notice}</span>
          <button type="button" onClick={merges.dismissNotice} aria-label="Dismiss" className="shrink-0">
            <X className="size-3" />
          </button>
        </div>
      )}

      {open.length > 1 && (
        // Two clicks rather than a dialog, like Unmerge: it changes a lot of
        // nodes at once, but every merge can be undone one by one.
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <button
            type="button"
            disabled={merges.busy !== null && merges.busy.action !== "naming"}
            onClick={async () => {
              if (!confirmAll) {
                setConfirmAll(true);
                return;
              }
              setConfirmAll(false);
              onPreview(null);
              await merges.acceptAll();
            }}
            onBlur={() => setConfirmAll(false)}
            onMouseEnter={() => onPreview([...new Set(open.flatMap((s) => s.memberComponentIds))])}
            onMouseLeave={() => onPreview(null)}
            className={cn(
              "flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-opacity hover:opacity-90 disabled:opacity-50",
              confirmAll ? "bg-warning text-black" : "bg-brand text-white"
            )}
            title="Accept every open suggestion, strongest first. Overlapping ones are skipped and recomputed."
          >
            {acceptingAll ? (
              <LoaderCircle className="size-3 animate-spin" aria-hidden />
            ) : (
              <CheckCheck className="size-3" aria-hidden />
            )}
            {acceptingAll
              ? "Accepting…"
              : confirmAll
                ? `Click again to accept all ${open.length}`
                : `Accept all (${open.length})`}
          </button>
          {merges.data?.aiConfigured && !acceptingAll && (
            <span className="text-[10px] text-muted-foreground">
              then names each new module with AI (one call each)
            </span>
          )}
        </div>
      )}

      {merges.namingProgress && (
        <p className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin text-brand" aria-hidden />
          Naming new modules with AI…{" "}
          <span className="font-mono text-foreground">
            {merges.namingProgress.done}/{merges.namingProgress.total}
          </span>
        </p>
      )}

      {merges.busy?.action === "naming" && (
        <p className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin text-brand" aria-hidden />
          Naming the new module with AI…
        </p>
      )}

      {open.length === 0 ? (
        <p className="px-3 py-4 text-[11px] text-muted-foreground">No open suggestions right now.</p>
      ) : (
        <ul className="divide-y divide-border">
          {open.map((s) => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              merges={merges}
              onPreview={onPreview}
              onAccepted={onAccepted}
            />
          ))}
        </ul>
      )}

      {rejected.length > 0 && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setShowRejected((v) => !v)}
            className="flex w-full items-center gap-1 px-3 py-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            {showRejected ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Rejected ({rejected.length})
          </button>
          {showRejected && (
            <ul className="divide-y divide-border border-t border-border bg-background/40">
              {rejected.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 px-3 py-2"
                  onMouseEnter={() => onPreview(s.memberComponentIds)}
                  onMouseLeave={() => onPreview(null)}
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={s.members.map(formatMember).join(", ")}>
                    {titleFor(s)}
                  </span>
                  <button
                    type="button"
                    disabled={merges.busy !== null}
                    onClick={() => void merges.reopen(s.id)}
                    className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
                  >
                    <RotateCcw className="size-2.5" aria-hidden />
                    Reopen
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SuggestionCard({
  suggestion: s,
  merges,
  onPreview,
  onAccepted,
}: {
  suggestion: MergeSuggestionDTO;
  merges: UseMergesResult;
  onPreview: (componentIds: string[] | null) => void;
  onAccepted: (componentId: string) => void;
}) {
  const busyHere = merges.busy !== null && "id" in merges.busy && merges.busy.id === s.id;
  const disabled = merges.busy !== null && merges.busy.action !== "naming";
  const pct = Math.round(s.score * 100);

  return (
    <li
      className="px-3 py-2.5 transition-colors hover:bg-secondary/40"
      onMouseEnter={() => onPreview(s.memberComponentIds)}
      onMouseLeave={() => onPreview(null)}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-xs font-semibold tracking-tight">{titleFor(s)}</p>
        <span
          className="shrink-0 font-mono text-[10px] text-muted-foreground"
          title="How strongly the names and imports say these belong together"
        >
          {pct}%
        </span>
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {s.members.map((member) => (
          <li key={member} className="truncate font-mono text-[11px] text-foreground/90" title={member}>
            {formatMember(member)}
          </li>
        ))}
      </ul>
      {s.reasons.length > 0 && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{s.reasons.join(" · ")}</p>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={async () => {
            onPreview(null);
            const id = await merges.accept(s.id);
            if (id) onAccepted(id);
          }}
          className="flex items-center gap-1 rounded-full bg-brand px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busyHere && merges.busy?.action === "accept" ? (
            <LoaderCircle className="size-3 animate-spin" aria-hidden />
          ) : (
            <Check className="size-3" aria-hidden />
          )}
          Accept
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => void merges.reject(s.id)}
          className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
        >
          <X className="size-3" aria-hidden />
          Reject
        </button>
      </div>
    </li>
  );
}
