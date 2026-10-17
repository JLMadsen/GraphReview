"use client";

// The diff viewers' two switches (DESIGN.md §6.24): unified or split, and
// whether whitespace-only changes are shown. Each viewer (the file modal,
// the all-files reader) remembers its own choice in this browser. Both are
// plain buttons — reachable by Tab — and `S` / `W` flip them while the
// viewer has focus (`useDiffShortcuts`).

import { useCallback, useEffect } from "react";
import { Columns2, Rows3, Space } from "lucide-react";
import { cn } from "cn";
import { useStoredState } from "./graph-view/view-state";
import type { DiffLayout } from "./DiffViewer";

export type DiffViewerName = "modal" | "reader";

const parseLayout = (raw: string | null): DiffLayout | undefined => (raw === "split" || raw === "unified" ? raw : undefined);
const parseFlag = (raw: string | null): boolean | undefined => (raw === "1" ? true : raw === "0" ? false : undefined);
const serializeFlag = (v: boolean) => (v ? "1" : "0");

export interface DiffPrefs {
  layout: DiffLayout;
  setLayout: (layout: DiffLayout) => void;
  ignoreWhitespace: boolean;
  setIgnoreWhitespace: (ignore: boolean) => void;
}

/** One viewer's layout and whitespace choice, remembered per browser. */
export function useDiffPrefs(viewer: DiffViewerName): DiffPrefs {
  const [layout, setLayout] = useStoredState<DiffLayout>(`graphreview.diff.${viewer}.layout`, "unified", parseLayout);
  const [ignoreWhitespace, setIgnoreWhitespace] = useStoredState(`graphreview.diff.${viewer}.ignoreWhitespace`, false, parseFlag, serializeFlag);
  return { layout, setLayout, ignoreWhitespace, setIgnoreWhitespace };
}

/** A key press that is typing into a field, not a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(target.type);
}

/** `S` flips split/unified, `W` the whitespace toggle — while `active`, and not while typing. */
export function useDiffShortcuts(prefs: DiffPrefs, active: boolean) {
  const { layout, setLayout, ignoreWhitespace, setIgnoreWhitespace } = prefs;
  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "s") setLayout(layout === "split" ? "unified" : "split");
      else if (key === "w") setIgnoreWhitespace(!ignoreWhitespace);
      else return;
      event.preventDefault();
    },
    [layout, setLayout, ignoreWhitespace, setIgnoreWhitespace]
  );
  useEffect(() => {
    if (!active) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onKey]);
}

const BUTTON =
  "inline-flex h-6 items-center gap-1 border border-border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";

export function DiffToolbar({ prefs, className }: { prefs: DiffPrefs; className?: string }) {
  const { layout, setLayout, ignoreWhitespace, setIgnoreWhitespace } = prefs;
  return (
    <div className={cn("flex items-center gap-2 font-sans", className)}>
      <div role="group" aria-label="Diff layout" className="flex">
        <button
          type="button"
          aria-pressed={layout === "unified"}
          onClick={() => setLayout("unified")}
          title="Unified: old and new lines in one column (S)"
          className={cn(BUTTON, layout === "unified" && "bg-secondary text-foreground")}
        >
          <Rows3 className="size-3" aria-hidden />
          Unified
        </button>
        <button
          type="button"
          aria-pressed={layout === "split"}
          onClick={() => setLayout("split")}
          title="Split: old on the left, new on the right (S)"
          className={cn(BUTTON, "-ml-px", layout === "split" && "bg-secondary text-foreground")}
        >
          <Columns2 className="size-3" aria-hidden />
          Split
        </button>
      </div>
      <button
        type="button"
        aria-pressed={ignoreWhitespace}
        onClick={() => setIgnoreWhitespace(!ignoreWhitespace)}
        title="Hide changes that only touch whitespace (W)"
        className={cn(BUTTON, ignoreWhitespace && "bg-secondary text-foreground")}
      >
        <Space className="size-3" aria-hidden />
        {ignoreWhitespace ? "Whitespace hidden" : "Hide whitespace"}
      </button>
    </div>
  );
}
