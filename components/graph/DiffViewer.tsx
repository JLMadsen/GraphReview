"use client";

// Code-editor-style rendering of a parsed unified diff — the finding-level
// "view diff" action in `ReviewPanel` (DESIGN.md §9/§10). Two line-number
// gutters (old/new), a +/- marker column and monospace content, the same
// shape GitHub's own file diff uses, so a reviewer already fluent in that
// convention doesn't have to learn a new one.

import { Fragment } from "react";
import { cn } from "cn";
import type { DiffHunk, DiffLine } from "./diff-utils";

export interface DiffViewerProps {
  hunks: DiffHunk[];
  /** Inclusive `[start, end]` new-file line numbers to highlight — the finding's own location, so the reader can find it inside a multi-hunk file. */
  highlightRange?: [number, number] | null;
}

function isHighlighted(line: DiffLine, range: [number, number] | null | undefined): boolean {
  if (!range || line.newLine == null) return false;
  return line.newLine >= range[0] && line.newLine <= range[1];
}

function LineRow({ line, highlighted }: { line: DiffLine; highlighted: boolean }) {
  if (line.type === "meta") {
    return (
      <tr>
        <td
          colSpan={4}
          className="px-2 py-0.5 font-mono text-[10px] text-muted-foreground/60 italic"
        >
          {line.content}
        </td>
      </tr>
    );
  }
  return (
    <tr
      className={cn(
        line.type === "add" && "bg-success/10",
        line.type === "remove" && "bg-destructive/10",
        highlighted && "ring-1 ring-inset ring-brand/60"
      )}
    >
      <td className="w-10 shrink-0 border-r border-border/40 px-1.5 text-right font-mono text-[10px] text-muted-foreground/50 select-none">
        {line.oldLine ?? ""}
      </td>
      <td className="w-10 shrink-0 border-r border-border/40 px-1.5 text-right font-mono text-[10px] text-muted-foreground/50 select-none">
        {line.newLine ?? ""}
      </td>
      <td
        className={cn(
          "w-4 shrink-0 px-1 text-center font-mono text-[11px] select-none",
          line.type === "add" && "text-success",
          line.type === "remove" && "text-destructive"
        )}
      >
        {line.type === "add" ? "+" : line.type === "remove" ? "−" : ""}
      </td>
      <td className="w-full px-2 font-mono text-[12px] leading-relaxed whitespace-pre">
        {line.content || " "}
      </td>
    </tr>
  );
}

export function DiffViewer({ hunks, highlightRange }: DiffViewerProps) {
  if (hunks.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-muted-foreground">
        No textual diff for this file.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-background/60">
      <table className="w-full min-w-max border-collapse">
        <tbody>
          {hunks.map((hunk, i) => (
            <Fragment key={i}>
              <tr>
                <td
                  colSpan={4}
                  className="border-y border-border bg-muted/60 px-2 py-1 font-mono text-[11px] text-brand"
                >
                  {hunk.header}
                </td>
              </tr>
              {hunk.lines.map((line, j) => (
                <LineRow key={j} line={line} highlighted={isHighlighted(line, highlightRange)} />
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
