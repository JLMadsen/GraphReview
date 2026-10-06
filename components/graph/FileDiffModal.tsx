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
// A file in the diff has a second tab, "File": the whole file at the head of
// the diff (at its base, for a deleted file), with the lines the diff added
// marked in the gutter — fetched the first time the tab opens. For JS/TS and
// Python files a third, "Before / after", runs the changed functions and
// components at both ends of the diff (PreviewPanel, DESIGN.md §6.9). The tab
// resets to the diff whenever another file opens.
//
// It is also the app's one file viewer: any file clicked in any list opens
// here. A file the diff didn't change comes back whole (at the diff's head),
// and with no diff selected at all (`target` null) the file is read as the
// repo was analyzed, through `GET /api/repos/[repoId]/file`.

import { useEffect, useMemo, useRef, useState } from "react";
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
import type { FileContentResponseDTO, FileDiffResponseDTO, FindingDTO, ReviewTargetDTO } from "./types";

function diffQuery(target: ReviewTargetDTO, filePath: string, sha?: string, view?: "file"): string {
  const params = new URLSearchParams({ path: filePath });
  if (sha) params.set("sha", sha);
  if (view) params.set("view", view);
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

type FileState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: FileContentResponseDTO }
  | { status: "error"; message: string };

export type ModalTab = "diff" | "file" | "preview";

/** A short sha for a full one; a branch name or "working copy" as is. */
function shortRefLabel(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
}

export interface FileDiffModalProps {
  repoId: string;
  /** The diff being looked at, or `null` with none selected — then only the file itself can be shown. */
  target: ReviewTargetDTO | null;
  /** The file to show (a finding, or a bare `{ filePath }` from a file list), or `null` when the modal is closed. */
  finding: (Pick<FindingDTO, "filePath" | "lineRange"> & { reviewedHeadSha?: string }) | null;
  /** Open on the Before / after tab, showing this component (from the "Looks different" list). */
  initialComponent?: string;
  /** The tab a changed file opens on — the diff unless a list asks for the whole file. */
  initialTab?: "diff" | "file";
  onClose: () => void;
}

export function FileDiffModal({ repoId, target, finding, initialComponent, initialTab = "diff", onClose }: FileDiffModalProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [fileState, setFileState] = useState<FileState>({ status: "idle" });
  const [tab, setTab] = useState<ModalTab>("diff");
  const filePath = finding?.filePath;
  const headSha = finding?.reviewedHeadSha;
  // A file outside the diff (an impact finding's caller, any unchanged file
  // from a list, every file with no diff selected) has no tabs: it is shown
  // whole. With a head sha the file may turn out to be one, so the tabs wait
  // for the answer.
  const outsideDiff = !target || (state.status === "loaded" ? state.data.content !== undefined : Boolean(headSha));
  const previewable = Boolean(target && filePath && runtimeForPath(filePath)) && !outsideDiff;
  const shownTab: ModalTab = outsideDiff ? "diff" : tab;

  /** The file whose whole text has been asked for — at most one request per opened file. */
  const fileRequested = useRef<string | null>(null);
  useEffect(() => {
    setTab(initialComponent ? "preview" : initialTab);
    setFileState({ status: "idle" });
    fileRequested.current = null;
  }, [filePath, initialComponent, initialTab]);

  // The whole file is fetched the first time its tab opens — once the diff is
  // in, which says whether the file changed at all and which lines to mark —
  // then kept until another file opens; an answer for a file no longer open is
  // dropped.
  const wantFile = shownTab === "file" && Boolean(filePath) && state.status === "loaded";
  useEffect(() => {
    if (!wantFile || !filePath || !target || fileRequested.current === filePath) return;
    const path = filePath;
    fileRequested.current = path;
    setFileState({ status: "loading" });
    fetch(`/api/repos/${repoId}/diff-impact/file?${diffQuery(target, path, undefined, "file")}`)
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as FileContentResponseDTO | { error: string } | null;
        if (!res.ok || !json || "error" in json) {
          throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        }
        return json;
      })
      .then((data) => {
        if (fileRequested.current === path) setFileState({ status: "loaded", data });
      })
      .catch((err: unknown) => {
        if (fileRequested.current === path) {
          setFileState({ status: "error", message: err instanceof Error ? err.message : "Failed to load the file." });
        }
      });
    // `target` is fixed for the lifetime of the dock, like the diff fetch below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantFile, filePath, repoId]);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    setState({ status: "loading" });
    const url = target
      ? `/api/repos/${repoId}/diff-impact/file?${diffQuery(target, filePath, headSha)}`
      : `/api/repos/${repoId}/file?${new URLSearchParams({ path: filePath })}`;
    fetch(url)
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as
          | FileDiffResponseDTO
          | FileContentResponseDTO
          | { error: string }
          | null;
        if (!res.ok || !json || "error" in json) {
          throw new Error(
            json && "error" in json ? json.error : `Request failed (${res.status}).`
          );
        }
        // With no diff the answer is just the file — the same shape as an unchanged one.
        return "side" in json
          ? ({ path: json.path, status: "unchanged", additions: 0, deletions: 0, content: json.content, ref: json.ref } satisfies FileDiffResponseDTO)
          : json;
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
    // `target` is fixed while a file is open (GraphView closes the viewer
    // when the diff selection changes) — only the file ever changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, filePath, headSha]);

  const highlightRange = parseLineRange(finding?.lineRange);
  const hunks = useMemo(
    () => (state.status === "loaded" && state.data.patch ? parseUnifiedDiff(state.data.patch) : []),
    [state]
  );
  /** New-file line numbers the diff added — marked in the File tab's gutter. */
  const addedLines = useMemo(() => {
    const lines = new Set<number>();
    for (const hunk of hunks) for (const line of hunk.lines) if (line.type === "add" && line.newLine != null) lines.add(line.newLine);
    return lines;
  }, [hunks]);
  const tabOptions = [
    { value: "diff" as const, label: "Diff" },
    { value: "file" as const, label: "File", title: "The whole file at the head of the diff, with the changed lines marked" },
    ...(previewable
      ? [{ value: "preview" as const, label: "Before / after", title: "Render the changed components and run the changed functions, before and after" }]
      : []),
  ];

  return (
    <Dialog open={Boolean(finding)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={cn(
          "flex w-full max-w-[calc(100%-2rem)] flex-col",
          shownTab === "preview" ? "max-h-[92vh] sm:max-w-7xl" : "max-h-[85vh] sm:max-w-4xl"
        )}
      >
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8 font-mono text-[13px] font-normal">
            <FileDiff className="size-4 shrink-0 text-brand" aria-hidden />
            <span className="truncate" title={filePath}>
              {filePath}
            </span>
            {!outsideDiff && (
              <Segmented
                className="ml-auto shrink-0 font-sans"
                size="xs"
                label="View"
                value={shownTab}
                onChange={setTab}
                options={tabOptions}
              />
            )}
            {state.status === "loaded" && state.data.content !== undefined && (
              <span className="ml-auto shrink-0 font-sans text-[11px] font-normal text-muted-foreground">
                {target ? "not changed by this diff" : "as analyzed"}
                {(state.data.ref ?? headSha) ? ` · at ${shortRefLabel(state.data.ref ?? headSha!)}` : ""}
              </span>
            )}
            {state.status === "loaded" && state.data.content === undefined && (
              <span className="shrink-0 font-sans text-[11px] font-normal text-muted-foreground">
                <span className="text-success">+{state.data.additions}</span>{" "}
                <span className="text-destructive">-{state.data.deletions}</span>
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {shownTab === "preview" && filePath && target && (
            <PreviewPanel repoId={repoId} target={target} filePath={filePath} initialSymbol={initialComponent} />
          )}
          {(shownTab === "diff" || shownTab === "file") && state.status === "loading" && (
            <p className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              {target ? "Loading…" : "Loading the file…"}
            </p>
          )}
          {(shownTab === "diff" || shownTab === "file") && state.status === "error" && (
            <p className="flex items-start gap-2 px-1 py-6 text-xs text-destructive">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>{state.message}</span>
            </p>
          )}
          {shownTab === "diff" && state.status === "loaded" && state.data.content !== undefined && (
            <FileText content={state.data.content} highlightRange={highlightRange} />
          )}
          {shownTab === "diff" &&
            state.status === "loaded" &&
            state.data.content === undefined &&
            (state.data.patch ? (
              <DiffViewer hunks={hunks} highlightRange={highlightRange} />
            ) : (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                {state.data.status === "added" || state.data.status === "removed"
                  ? `File was ${state.data.status}; no line-by-line diff to show.`
                  : "No textual diff for this file (binary, or too large)."}
              </p>
            ))}
          {shownTab === "file" && state.status === "loaded" && (fileState.status === "loading" || fileState.status === "idle") && (
            <p className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              Loading the file…
            </p>
          )}
          {shownTab === "file" && fileState.status === "error" && (
            <p className="flex items-start gap-2 px-1 py-6 text-xs text-destructive">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>{fileState.message}</span>
            </p>
          )}
          {shownTab === "file" && fileState.status === "loaded" && (
            <>
              <p className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground">
                <span>
                  {fileState.data.side === "base" ? "Before the change — this diff deletes the file" : "At the head of the diff"}
                  {" · "}
                  <code className="font-mono" title={fileState.data.ref}>
                    {shortRefLabel(fileState.data.ref)}
                  </code>
                </span>
                {fileState.data.side === "head" && addedLines.size > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="h-3 w-[3px] rounded-[1px] bg-success" aria-hidden />
                    {addedLines.size} line{addedLines.size === 1 ? "" : "s"} added or changed
                  </span>
                )}
                {fileState.data.truncated && <span className="text-warning">Cut off — the file is very large.</span>}
              </p>
              <FileText
                content={fileState.data.content}
                highlightRange={highlightRange}
                addedLines={fileState.data.side === "head" ? addedLines : undefined}
                whole
              />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Lines shown around the highlighted range of a whole file; the rest is folded away. */
const FILE_CONTEXT_LINES = 12;

/**
 * A file as numbered lines, the finding's line ringed like the diff view
 * does. Two uses: a file the diff didn't touch — the caller an impact finding
 * points at — shown as a window around that line; and the File tab
 * (`whole`): every line, the lines the diff added marked in the gutter, and
 * the view scrolled to the finding's line, or else to the first change.
 */
function FileText({
  content,
  highlightRange,
  addedLines,
  whole = false,
}: {
  content: string;
  highlightRange: [number, number] | null;
  addedLines?: ReadonlySet<number>;
  whole?: boolean;
}) {
  const lines = content.replace(/\r?\n$/, "").split(/\r?\n/);
  const windowed = !whole && highlightRange !== null;
  const from = windowed && highlightRange ? Math.max(1, highlightRange[0] - FILE_CONTEXT_LINES) : 1;
  const to = windowed && highlightRange ? Math.min(lines.length, highlightRange[1] + FILE_CONTEXT_LINES) : lines.length;
  let firstAdded: number | null = null;
  if (addedLines) for (const n of addedLines) if (firstAdded === null || n < firstAdded) firstAdded = n;
  const scrollLine = whole ? (highlightRange?.[0] ?? firstAdded) : null;
  const scrollRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ block: "center" });
  }, [content, scrollLine]);
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
            const added = Boolean(addedLines?.has(n));
            return (
              <tr
                key={n}
                ref={n === scrollLine ? scrollRef : undefined}
                className={cn(added && "bg-success/10", highlighted && "bg-destructive/10 ring-1 ring-inset ring-brand/60")}
              >
                <td
                  className={cn(
                    "w-10 shrink-0 border-r border-border/40 px-1.5 text-right font-mono text-[10px] text-muted-foreground select-none",
                    added && "border-l-[3px] border-l-success text-success/80"
                  )}
                >
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
