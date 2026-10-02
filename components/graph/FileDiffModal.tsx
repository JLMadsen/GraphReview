"use client";

// The "view diff" action behind a finding in `ReviewPanel`: fetches
// `GET /api/repos/[repoId]/diff-impact/file` for the
// finding's `filePath` against the review's own target (PR or refs) and
// renders it in `DiffViewer`, with the finding's `lineRange` highlighted so
// a reviewer can find the spot the finding is actually about inside a
// larger file.
//
// One modal instance lives in `ReviewPanel`, driven by which finding (if
// any) is "open" — not one per finding — so opening a second diff replaces
// the first rather than stacking dialogs.
//
// For JS/TS and Python files a second tab, "Before / after", runs the
// changed functions and components at both ends of the diff (PreviewPanel,
// DESIGN.md §6.9). The tab resets to the diff whenever another file opens.

import { useEffect, useState } from "react";
import { FileDiff, LoaderCircle, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { runtimeForPath } from "@/lib/preview/runtime";
import { cn } from "cn";
import { DiffViewer } from "./DiffViewer";
import { PreviewPanel } from "./PreviewPanel";
import { Segmented } from "./Segmented";
import { parseLineRange, parseUnifiedDiff } from "./diff-utils";
import type { FileDiffResponseDTO, FindingDTO, ReviewTargetDTO } from "./types";

function diffQuery(target: ReviewTargetDTO, filePath: string, sha?: string): string {
  const params = new URLSearchParams({ path: filePath });
  if (sha) params.set("sha", sha);
  if ("prNumber" in target) {
    params.set("prNumber", String(target.prNumber));
  } else {
    params.set("baseRef", target.baseRef);
    params.set("headRef", target.headRef);
  }
  return params.toString();
}

type FetchState =
  | { status: "loading" }
  | { status: "loaded"; data: FileDiffResponseDTO }
  | { status: "error"; message: string };

export interface FileDiffModalProps {
  repoId: string;
  target: ReviewTargetDTO;
  /** The file to show (a finding, or a bare `{ filePath }` from a PR map chip), or `null` when the modal is closed. */
  finding: (Pick<FindingDTO, "filePath" | "lineRange"> & { reviewedHeadSha?: string }) | null;
  /** Open on the Before / after tab, showing this component (from the "Looks different" list). */
  initialComponent?: string;
  onClose: () => void;
}

export function FileDiffModal({ repoId, target, finding, initialComponent, onClose }: FileDiffModalProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [tab, setTab] = useState<"diff" | "preview">("diff");
  const filePath = finding?.filePath;
  const headSha = finding?.reviewedHeadSha;
  // A file outside the diff (an impact finding's caller) has no before/after.
  // With a head sha the file may turn out to be one, so the tab waits for the answer.
  const outsideDiff = state.status === "loaded" ? state.data.content !== undefined : Boolean(headSha);
  const previewable = Boolean(filePath && runtimeForPath(filePath)) && !outsideDiff;

  useEffect(() => {
    setTab(initialComponent ? "preview" : "diff");
  }, [filePath, initialComponent]);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    setState({ status: "loading" });
    fetch(`/api/repos/${repoId}/diff-impact/file?${diffQuery(target, filePath, headSha)}`)
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as
          | FileDiffResponseDTO
          | { error: string }
          | null;
        if (!res.ok || !json || "error" in json) {
          throw new Error(
            json && "error" in json ? json.error : `Request failed (${res.status}).`
          );
        }
        return json;
      })
      .then((data) => {
        if (!cancelled) setState({ status: "loaded", data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load the diff.",
        });
      });
    return () => {
      cancelled = true;
    };
    // `target` is fixed for the lifetime of a review dock — only the
    // selected finding's file ever changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, filePath, headSha]);

  const highlightRange = parseLineRange(finding?.lineRange);

  return (
    <Dialog open={Boolean(finding)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={cn(
          "flex w-full max-w-[calc(100%-2rem)] flex-col",
          tab === "preview" ? "max-h-[92vh] sm:max-w-7xl" : "max-h-[85vh] sm:max-w-4xl"
        )}
      >
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8 font-mono text-[13px] font-normal">
            <FileDiff className="size-4 shrink-0 text-brand" aria-hidden />
            <span className="truncate" title={filePath}>
              {filePath}
            </span>
            {previewable && (
              <Segmented
                className="ml-auto shrink-0 font-sans"
                size="xs"
                label="View"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "diff", label: "Diff" },
                  { value: "preview", label: "Before / after", title: "Render the changed components and run the changed functions, before and after" },
                ]}
              />
            )}
            {state.status === "loaded" && state.data.content !== undefined && (
              <span className={cn("shrink-0 font-sans text-[11px] font-normal text-muted-foreground", !previewable && "ml-auto")}>
                not changed by this diff{headSha ? ` · at ${headSha.slice(0, 7)}` : ""}
              </span>
            )}
            {state.status === "loaded" && state.data.content === undefined && (
              <span className={cn("shrink-0 font-sans text-[11px] font-normal text-muted-foreground", !previewable && "ml-auto")}>
                <span className="text-success">+{state.data.additions}</span>{" "}
                <span className="text-destructive">-{state.data.deletions}</span>
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "preview" && filePath && (
            <PreviewPanel repoId={repoId} target={target} filePath={filePath} initialSymbol={initialComponent} />
          )}
          {tab === "diff" && state.status === "loading" && (
            <p className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              Loading diff…
            </p>
          )}
          {tab === "diff" && state.status === "error" && (
            <p className="flex items-start gap-2 px-1 py-6 text-xs text-destructive">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>{state.message}</span>
            </p>
          )}
          {tab === "diff" && state.status === "loaded" && state.data.content !== undefined && (
            <FileText content={state.data.content} highlightRange={highlightRange} />
          )}
          {tab === "diff" &&
            state.status === "loaded" &&
            state.data.content === undefined &&
            (state.data.patch ? (
              <DiffViewer
                hunks={parseUnifiedDiff(state.data.patch)}
                highlightRange={highlightRange}
              />
            ) : (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                {state.data.status === "added" || state.data.status === "removed"
                  ? `File was ${state.data.status}; no line-by-line diff to show.`
                  : "No textual diff for this file (binary, or too large)."}
              </p>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Lines shown around the highlighted range of a whole file; the rest is folded away. */
const FILE_CONTEXT_LINES = 12;

/**
 * A whole file that the diff didn't touch — the caller an impact finding
 * points at — as numbered lines, the finding's line ringed like the diff
 * view does, and only a window around it shown.
 */
function FileText({ content, highlightRange }: { content: string; highlightRange: [number, number] | null }) {
  const lines = content.split(/\r?\n/);
  const from = highlightRange ? Math.max(1, highlightRange[0] - FILE_CONTEXT_LINES) : 1;
  const to = highlightRange ? Math.min(lines.length, highlightRange[1] + FILE_CONTEXT_LINES) : lines.length;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse">
        <tbody>
          {from > 1 && (
            <tr>
              <td colSpan={2} className="px-2 py-0.5 font-mono text-[10px] text-muted-foreground/60 italic">
                … {from - 1} line{from === 2 ? "" : "s"} above
              </td>
            </tr>
          )}
          {lines.slice(from - 1, to).map((text, index) => {
            const n = from + index;
            const highlighted = Boolean(highlightRange && n >= highlightRange[0] && n <= highlightRange[1]);
            return (
              <tr key={n} className={cn(highlighted && "bg-destructive/10 ring-1 ring-inset ring-brand/60")}>
                <td className="w-10 shrink-0 border-r border-border/40 px-1.5 text-right font-mono text-[10px] text-muted-foreground/50 select-none">
                  {n}
                </td>
                <td className="w-full px-2 font-mono text-[12px] leading-relaxed whitespace-pre">{text || " "}</td>
              </tr>
            );
          })}
          {to < lines.length && (
            <tr>
              <td colSpan={2} className="px-2 py-0.5 font-mono text-[10px] text-muted-foreground/60 italic">
                … {lines.length - to} line{lines.length - to === 1 ? "" : "s"} below
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
