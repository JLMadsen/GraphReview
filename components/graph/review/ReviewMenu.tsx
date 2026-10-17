"use client";

// The review dock's ⋯ menu.

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ClipboardCopy,
  Ellipsis,
  FileText,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  REVIEW_EFFORT_OPTIONS,
  type ReviewEffort,
} from "../types";

/** Secondary review actions: effort for the next run, copying and exporting the review, and posting it to the PR (DESIGN.md §6.23). */
export function ReviewMenu({
  effort,
  onEffortChange,
  aiConfigured,
  canCopy,
  copied,
  onCopy,
  onExport,
  onPost,
  postLabel,
}: {
  effort: ReviewEffort;
  onEffortChange: (effort: ReviewEffort) => void;
  aiConfigured: boolean;
  canCopy: boolean;
  copied: boolean;
  onCopy: () => void;
  /** Opens the export dialog (full report, change brief). */
  onExport?: () => void;
  /** Opens the post dialog. Absent for a ref comparison — it has no PR to post to. */
  onPost?: () => void;
  postLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!aiConfigured && !canCopy && !onExport && !onPost) return null;
  return (
    <div ref={ref} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="More review actions"
        title="More"
      >
        <Ellipsis aria-hidden />
      </Button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-56 rounded-md border border-border bg-popover p-1 text-xs shadow-lg">
          {aiConfigured && (
            <label className="flex items-center justify-between gap-2 rounded-sm px-2 py-1.5">
              <span className="text-muted-foreground">Effort next run</span>
              <select
                value={effort}
                onChange={(event) => onEffortChange(event.target.value as ReviewEffort)}
                className="rounded-sm border border-border bg-transparent px-1 py-0.5 text-[11px] outline-none focus-visible:border-brand"
                title={`${REVIEW_EFFORT_OPTIONS.find((o) => o.value === effort)?.description ?? ""} Larger diffs are split into several calls rather than cut off.`}
              >
                {REVIEW_EFFORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} title={option.description}>
                    {option.label} · {option.budget}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canCopy && (
            <button
              type="button"
              onClick={() => {
                onCopy();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-secondary"
              title="The overall verdict and every open/resolved finding"
            >
              {copied ? <Check className="size-3.5" aria-hidden /> : <ClipboardCopy className="size-3.5" aria-hidden />}
              {copied ? "Copied" : "Copy as Markdown"}
            </button>
          )}
          {onExport && (
            <button
              type="button"
              onClick={() => {
                onExport();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-secondary"
              title="The full report — verdict, findings, checklist, catalog changes, previews — and the change brief, to copy or download"
            >
              <FileText className="size-3.5" aria-hidden />
              Export report…
            </button>
          )}
          {onPost && (
            <button
              type="button"
              onClick={() => {
                onPost();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-secondary"
              title="Pick findings and post them as a review — you see everything before it's sent"
            >
              <Send className="size-3.5" aria-hidden />
              {postLabel ?? "Post review…"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
