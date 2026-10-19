"use client";

// The open repo's name in the top bar (app/@nav), as a switcher: a click
// opens the command palette scoped to repos (DESIGN.md §6.18), so switching
// repos and finding anything else are one search with one ranking. Picking a
// repo goes to its Graph tab; → on it offers its Pull requests, Branches or Stats.

import { ChevronDown } from "lucide-react";
import { cn } from "cn";
import { openPalette } from "@/components/palette/bus";

export interface RepoSwitcherProps {
  repoId: string;
  repoName: string;
  /** Extra classes for the trigger (the top bar sets the name's weight). */
  className?: string;
}

export function RepoSwitcher({ repoName, className }: RepoSwitcherProps) {
  return (
    <button
      type="button"
      onClick={() => openPalette({ scope: "repos" })}
      aria-haspopup="dialog"
      className={cn(
        "flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-foreground/80 transition-colors hover:text-foreground",
        className
      )}
      title="Switch repo (Ctrl+Space)"
    >
      <span className="max-w-48 truncate">{repoName}</span>
      <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
    </button>
  );
}
