"use client";

// The repo-detail breadcrumb's name segment, upgraded into a switcher —
// making repo switching available directly from the UI, as a "multi-repo
// switcher UX polish" v3 item.
//
// Until now, switching repos meant "Repositories" -> pick a card -> land on
// its Graph tab: three clicks and a full list re-render for something that
// should be a couple of keystrokes once you have more than a handful of
// repos. This turns the breadcrumb's current repo name into a trigger for a
// small anchored dropdown listing every repo, filterable, that jumps
// straight to the picked repo's Graph tab (matching the repo list card's own
// whole-card-opens-the-graph convention, so "pick a repo" behaves the same
// way everywhere).
//
// No Popover/Command primitive exists in components/ui/ yet, and the
// codebase's established convention when one is missing is a plain
// implementation rather than pulling in a new dependency for it (see
// DiffPanel's hand-rolled <select> and GraphCanvas's custom tooltip) — same
// approach here: a `relative` trigger, an absolutely positioned panel, a
// document click listener to close on an outside click.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Search } from "lucide-react";
import { cn } from "cn";
import type { RepoDto } from "@/lib/jobs";
import { providerIcon } from "./repo-status-badge";

export interface RepoSwitcherProps {
  repoId: string;
  repoName: string;
}

type ListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; repos: RepoDto[] }
  | { status: "error"; message: string };

function matches(repo: RepoDto, query: string): boolean {
  if (!query) return true;
  const haystack = `${repo.name} ${repo.url ?? ""} ${repo.localPath ?? ""}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

export function RepoSwitcher({ repoId, repoName }: RepoSwitcherProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<ListState>({ status: "idle" });
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetched once per mount on first open, not via an effect keyed on `open`
  // (an effect must never re-run itself off state it sets) —
  // a plain guarded call from the click handler that opens the panel has no
  // such footgun, since nothing here is reactive to a changing dependency.
  async function ensureLoaded() {
    if (list.status === "loading" || list.status === "loaded") return;
    setList({ status: "loading" });
    try {
      const res = await fetch("/api/repos", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as RepoDto[] | null;
      if (!res.ok || !Array.isArray(json)) {
        setList({ status: "error", message: `Could not load repos (${res.status}).` });
        return;
      }
      setList({ status: "loaded", repos: json });
    } catch (err) {
      setList({
        status: "error",
        message: err instanceof Error ? err.message : "Could not load repos.",
      });
    }
  }

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setQuery("");
    void ensureLoaded();
    // Focus after the panel actually paints, not before.
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function go(target: RepoDto) {
    setOpen(false);
    if (target.id === repoId) return;
    router.push(`/repo/${target.id}/graph`);
  }

  // Close on outside click / Escape. Attached only while open, per the same
  // "don't run listeners you don't need" instinct as the rest of this file.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const filtered =
    list.status === "loaded" ? list.repos.filter((r) => matches(r, query)) : [];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-foreground/80 transition-colors hover:text-foreground"
      >
        <span className="max-w-48 truncate">{repoName}</span>
        <ChevronDown
          className={cn("size-3.5 opacity-60 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 z-50 mt-1.5 w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
        >
          <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Switch repo…"
              className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="max-h-72 overflow-y-auto py-1">
            {list.status === "loading" || list.status === "idle" ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">Loading…</p>
            ) : list.status === "error" ? (
              <p className="px-3 py-3 text-xs text-destructive">{list.message}</p>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                {list.repos.length === 0 ? "No repos yet." : "No match."}
              </p>
            ) : (
              filtered.map((repo) => {
                const Icon = providerIcon(repo.provider);
                const current = repo.id === repoId;
                return (
                  <button
                    key={repo.id}
                    type="button"
                    role="menuitem"
                    onClick={() => go(repo)}
                    aria-current={current ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition-colors",
                      current
                        ? "bg-secondary text-foreground"
                        : "text-foreground/85 hover:bg-secondary/60"
                    )}
                  >
                    <Icon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{repo.name}</span>
                    {current && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        current
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
