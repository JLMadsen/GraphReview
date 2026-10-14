"use client";

// The diff picker's commit list, for picking a base and head commit.

import { History, LoaderCircle } from "lucide-react";
import { cn } from "cn";
import { formatRelativeDate, shortRef } from "../types";
import { type ListFetchState, type CommitOption, sameCommit } from "./options";

export interface CommitPickerProps {
  state: ListFetchState<CommitOption>;
  picked: string[];
  lastAnalyzedSha?: string;
  onToggle: (sha: string) => void;
  onClear: () => void;
  /** `[base, head]` for the current pick, or `null` until two are picked. */
  ordered: [string, string] | null;
  commitIndex: (sha: string) => number;
  /** Compare immediately (the per-row and "since last analysis" shortcuts). */
  onCompare: (base: string, head: string) => void;
}

/**
 * The default branch's newest commits; pick two to compare. Whichever is
 * older becomes the base (the diff is `base...head`), so the order they're
 * clicked in never matters.
 */
export function CommitPicker({
  state,
  picked,
  lastAnalyzedSha,
  onToggle,
  onClear,
  ordered,
  commitIndex,
  onCompare,
}: CommitPickerProps) {
  if (state.status === "idle" || state.status === "loading") {
    return (
      <p className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        Loading commits…
      </p>
    );
  }
  if (state.status === "fallback") {
    return (
      <p className="text-xs text-muted-foreground">
        Couldn&apos;t list this repo&apos;s commits (not linked, or the request failed). Use{" "}
        <span className="font-medium text-foreground">Branches</span> with commit shas instead.
      </p>
    );
  }

  const commits = state.items;
  const isPicked = (sha: string) => picked.some((p) => sameCommit(sha, p));
  const analyzedIndex = lastAnalyzedSha ? commits.findIndex((c) => sameCommit(c.sha, lastAnalyzedSha)) : -1;
  const span =
    ordered && commitIndex(ordered[0]) !== -1 && commitIndex(ordered[1]) !== -1
      ? commitIndex(ordered[0]) - commitIndex(ordered[1])
      : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">Commits on the default branch</span>
        {analyzedIndex > 0 && (
          <button
            type="button"
            onClick={() => onCompare(commits[analyzedIndex].sha, commits[0].sha)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            title="Compare the analyzed commit with the newest one"
          >
            <History className="size-3" aria-hidden />
            Since last analysis
          </button>
        )}
      </div>

      <p className="min-h-4 text-[11px] text-muted-foreground">
        {ordered ? (
          <>
            <span className="font-mono text-foreground">{shortRef(ordered[0])}</span> →{" "}
            <span className="font-mono text-foreground">{shortRef(ordered[1])}</span>
            {span !== null && ` · ${span} commit${span === 1 ? "" : "s"}`}
            <button type="button" onClick={onClear} className="ml-2 underline-offset-2 hover:text-foreground hover:underline">
              clear
            </button>
          </>
        ) : picked.length === 1 ? (
          "Pick one more commit."
        ) : (
          "Pick two commits — the older one is the base."
        )}
      </p>

      <ul className="max-h-72 divide-y divide-border/60 overflow-y-auto border-y border-border">
        {commits.map((commit, index) => {
          const selected = isPicked(commit.sha);
          const parent = commit.parents[0];
          return (
            <li key={commit.sha} className={cn("group relative", selected && "bg-brand-muted")}>
              <button
                type="button"
                onClick={() => onToggle(commit.sha)}
                aria-pressed={selected}
                className="flex w-full min-w-0 items-start gap-2 px-2.5 py-1.5 text-left"
                title={commit.subject}
              >
                <span
                  className={cn(
                    "mt-1 size-2.5 shrink-0 rounded-full ring-1",
                    selected ? "bg-brand ring-brand" : "ring-border"
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="min-w-0 truncate text-xs">{commit.subject || "(no message)"}</span>
                    {index === analyzedIndex && (
                      <span className="shrink-0 text-[10px] text-brand" title="The commit the graph was analyzed at">
                        analyzed
                      </span>
                    )}
                  </span>
                  {/* One line however narrow the column: sha and age keep
                      their size, only the author truncates. */}
                  <span className="flex items-center gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-muted-foreground">
                    <span className="shrink-0 font-mono">{commit.sha.slice(0, 7)}</span>
                    <span className="shrink-0">{formatRelativeDate(commit.date)}</span>
                    {commit.author && <span className="min-w-0 truncate">{commit.author}</span>}
                  </span>
                </span>
              </button>
              {parent && (
                <button
                  type="button"
                  onClick={() => onCompare(parent, commit.sha)}
                  // Over the row's right end on hover, not a column of its own,
                  // so the commit text keeps the full width.
                  className="absolute inset-y-0 right-0 bg-linear-to-l from-card from-70% to-transparent pr-2.5 pl-6 text-[11px] text-muted-foreground opacity-0 pointer-events-none transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                  title="What this commit changed (compare with its parent)"
                >
                  Only this
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
