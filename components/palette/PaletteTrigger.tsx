"use client";

// The search box in the middle of the top bar: a button dressed as an input
// that opens the command palette (DESIGN.md §6.18), for anyone who doesn't
// know the shortcut yet.

import { Search } from "lucide-react";
import { openPalette } from "./bus";

export function PaletteTrigger() {
  return (
    <button
      type="button"
      onClick={() => openPalette()}
      aria-haspopup="dialog"
      className="mx-auto hidden h-8 w-full max-w-sm min-w-40 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 text-left text-[13px] text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground/80 md:flex"
    >
      <Search className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">Search or jump to…</span>
      <kbd className="shrink-0 rounded border border-border bg-background px-1.5 py-px font-mono text-[10px] text-muted-foreground">Ctrl Space</kbd>
    </button>
  );
}
