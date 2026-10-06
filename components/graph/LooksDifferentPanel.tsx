"use client";

// "Looks different" in the Graph tab's left summary (DESIGN.md §6.9): the
// UI components this diff changed, found by parsing as soon as the target
// loads, and — once previews have run — which of them actually render
// differently. Exceptions first: different and pending ones are listed,
// the ones that look the same fold into one line. Clicking a component
// opens its before/after. Plain function changes are not listed here on
// purpose; they live in each file's dialog.

import { useState } from "react";
import { LoaderCircle, Play } from "lucide-react";
import { cn } from "cn";
import type { PreviewScanFileDTO } from "@/lib/preview/types";
import { Spark } from "./Spark";
import type { UsePreviewScanResult } from "./usePreviewScan";

type Row = PreviewScanFileDTO["components"][number] & { filePath: string; pending: boolean };

const ORDER = { different: 0, pending: 1, failed: 2, none: 3, same: 4 } as const;
/** Not-yet-rendered components listed before "N more". */
const UNRUN_SHOWN = 5;

function orderOf(row: Row): number {
  if (row.pending) return ORDER.pending;
  return ORDER[row.looks ?? "none"];
}

function basename(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

export function LooksDifferentPanel({
  scan: { scan, error, previewAll, starting },
  onOpen,
}: {
  scan: UsePreviewScanResult;
  onOpen: (filePath: string, component: string) => void;
}) {
  const [showSame, setShowSame] = useState(false);
  const [showAllUnrun, setShowAllUnrun] = useState(false);
  const rows: Row[] = (scan?.files ?? []).flatMap((f) =>
    f.components.map((c) => ({ ...c, filePath: f.filePath, pending: f.preview === "queued" || f.preview === "running" }))
  );
  if (!scan || (rows.length === 0 && !error)) return null;

  rows.sort((a, b) => orderOf(a) - orderOf(b) || a.name.localeCompare(b.name));
  const different = rows.filter((r) => !r.pending && r.looks === "different").length;
  const same = rows.filter((r) => !r.pending && r.looks === "same");
  const pending = rows.some((r) => r.pending);
  const anyRun = rows.some((r) => r.looks !== undefined);
  // Results and work in progress always show; components that haven't been
  // rendered yet are capped, so a big UI diff doesn't flood the column.
  const notRun = rows.filter((r) => !r.pending && r.looks === undefined);
  const listed = rows
    .filter((r) => r.pending || (r.looks !== "same" && r.looks !== undefined))
    .concat(showAllUnrun ? notRun : notRun.slice(0, UNRUN_SHOWN));
  const hiddenUnrun = showAllUnrun ? 0 : Math.max(0, notRun.length - UNRUN_SHOWN);
  const sandboxDown = scan.sandbox?.available === false;

  return (
    <section className="mt-3 border-t border-border pt-2.5 text-[11px]">
      <div className="flex items-center gap-1.5">
        <p className="min-w-0 flex-1 font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase">
          Before / after
        </p>
        <button
          type="button"
          onClick={() => void previewAll()}
          disabled={pending || starting || sandboxDown}
          title={
            sandboxDown
              ? scan.sandbox?.reason
              : "Render every changed component before and after, in the Docker sandbox"
          }
          className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
        >
          {pending || starting ? <LoaderCircle className="size-3 animate-spin" aria-hidden /> : <Play className="size-3" aria-hidden />}
          {anyRun ? "Again" : "Preview all"}
          <Spark title="Props are mocked up by the model" />
        </button>
      </div>
      <p className="mt-0.5 font-mono">
        {!anyRun ? (
          <span className="text-muted-foreground">
            {rows.length} changed component{rows.length === 1 ? "" : "s"}
          </span>
        ) : different > 0 ? (
          <span className="text-warning">
            {different} look{different === 1 ? "s" : ""} different
          </span>
        ) : pending ? (
          <span className="text-muted-foreground">rendering…</span>
        ) : (
          <span className="text-muted-foreground">all look the same</span>
        )}
      </p>

      {error && <p className="mt-1 text-destructive">{error}</p>}
      {sandboxDown && !anyRun && <p className="mt-1 leading-snug text-muted-foreground">{scan.sandbox?.reason}</p>}

      <ul className="mt-1.5 space-y-0.5">
        {listed.map((row) => (
          <li key={`${row.filePath}#${row.name}`}>
            <button
              type="button"
              onClick={() => onOpen(row.filePath, row.name)}
              className="group flex w-full min-w-0 items-baseline gap-1.5 rounded-sm py-0.5 text-left hover:text-foreground"
              title={`${row.filePath} — open before / after`}
            >
              <StatusMark row={row} />
              <span className="shrink-0 truncate font-mono text-foreground group-hover:underline" style={{ maxWidth: "100%" }}>{row.name}</span>
              <FileHint row={row} className="text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>

      {hiddenUnrun > 0 && (
        <button
          type="button"
          onClick={() => setShowAllUnrun(true)}
          className="mt-1 block text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {hiddenUnrun} more not rendered yet · show
        </button>
      )}

      {same.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowSame((v) => !v)}
            className="mt-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {same.length} look{same.length === 1 ? "s" : ""} the same · {showSame ? "hide" : "show"}
          </button>
          {showSame && (
            <ul className="mt-1 space-y-0.5">
              {same.map((row) => (
                <li key={`${row.filePath}#${row.name}`}>
                  <button
                    type="button"
                    onClick={() => onOpen(row.filePath, row.name)}
                    className="flex w-full min-w-0 items-baseline gap-1.5 py-0.5 text-left text-muted-foreground hover:text-foreground"
                  >
                    <StatusMark row={row} />
                    <span className="shrink-0 truncate font-mono" style={{ maxWidth: "100%" }}>{row.name}</span>
                    <FileHint row={row} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function StatusMark({ row }: { row: Row }) {
  if (row.pending) return <LoaderCircle className="size-2.5 shrink-0 translate-y-px animate-spin text-muted-foreground" aria-label="Rendering" />;
  const looks = row.looks;
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 -translate-y-px rounded-full",
        looks === "different" && "bg-warning",
        looks === "same" && "bg-muted-foreground/40",
        looks === "failed" && "bg-destructive",
        looks === undefined && "border border-muted-foreground/60"
      )}
      aria-label={looks === undefined ? "Not rendered yet" : looks === "failed" ? "Couldn't render" : `Looks ${looks}`}
    />
  );
}

/** The file, when it says something the component name doesn't (`GraphView` in `GraphView.tsx` needs no hint). Gives way to the name. */
function FileHint({ row, className }: { row: Row; className?: string }) {
  const file = basename(row.filePath);
  if (file.replace(/\.[^.]+$/, "") === row.name) return null;
  return <span className={cn("ml-auto min-w-0 truncate font-mono", className)}>{file}</span>;
}
