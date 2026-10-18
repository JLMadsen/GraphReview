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
// marked in the gutter — fetched the first time the tab opens; "Base" is the
// whole file before the change, for a file the diff modifies. For JS/TS and
// Python files a third, "Before / after", runs the changed functions and
// components at both ends of the diff (PreviewPanel, DESIGN.md §6.9). The tab
// resets to the diff whenever another file opens.
//
// It is also the app's one file viewer: any file clicked in any list opens
// here. A file the diff didn't change comes back whole (at the diff's head),
// and with no diff selected at all (`target` null) the file is read as the
// repo was analyzed, through `GET /api/repos/[repoId]/file`.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Files, FileDiff, LoaderCircle, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { runtimeForPath } from "@/lib/preview/runtime";
import { cn } from "cn";
import { DiffViewer } from "./DiffViewer";
import { DiffToolbar, useDiffPrefs, useDiffShortcuts } from "./DiffToolbar";
import { ignoreWhitespaceHunks, markMovedLines, markRanges } from "./diff-model";
import { highlightLines, languageForPath } from "./highlight";
import { escapeHtml, linkFromEvent, linkLine, nameRanges, useCodeLinks, type CodeDecl, type CodeLink, type LineLinks } from "./code-links";
import { UsagesButton, UsagesDialog } from "./UsagesDialog";
import { fetchJsonCached } from "./fetch-cache";
import { startMiddleScroll } from "./middle-scroll";
import { PreviewPanel } from "./PreviewPanel";
import { Segmented } from "./Segmented";
import { parseLineRange, parseUnifiedDiff } from "./diff-utils";
import type { FileContentResponseDTO, FileDiffResponseDTO, FindingDTO, ReviewTargetDTO } from "./types";

export function diffQuery(target: ReviewTargetDTO, filePath: string, sha?: string, view?: "file"): string {
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

export type ModalTab = "diff" | "file" | "base" | "preview";

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
  /** The tab a changed file opens on — the diff unless a list (or the chat) asks for another. */
  initialTab?: "diff" | "file" | "base" | "preview";
  onClose: () => void;
  /** Opens the all-files reader at this file (and the finding's lines) — shown as a header button when given. */
  onOpenReader?: (path: string, lineRange?: string) => void;
  /** The review target's merge-base and head, which its code links are read at (DESIGN.md §6.28). */
  baseSha?: string;
  headSha?: string;
  /** A clicked import or name: open that file (at that line, `names` marked on it). Without it the code shows no links. */
  onNavigate?: (path: string, line?: number, names?: string[]) => void;
  /** Names to mark on the highlighted line — where a usages dialog opened the file. */
  markNames?: string[];
  /** The file a link was followed from — shown as a Back button. */
  back?: { path: string; onBack: () => void };
}

const isSha = (ref: string | undefined): ref is string => Boolean(ref && /^[0-9a-f]{40}$/.test(ref));

export function FileDiffModal({
  repoId,
  target,
  finding,
  initialComponent,
  initialTab = "diff",
  onClose,
  onOpenReader,
  baseSha: targetBaseSha,
  headSha: targetHeadSha,
  onNavigate,
  back,
  markNames,
}: FileDiffModalProps) {
  const prefs = useDiffPrefs("modal");
  const { ignoreWhitespace } = prefs;
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

  /** The file (and side) whose whole text has been asked for — at most one request per opened file and side. */
  const fileRequested = useRef<string | null>(null);
  useEffect(() => {
    setTab(initialComponent || initialTab === "preview" ? "preview" : initialTab);
    setFileState({ status: "idle" });
    fileRequested.current = null;
  }, [filePath, initialComponent, initialTab]);

  // The whole file is fetched the first time its tab opens — once the diff is
  // in, which says whether the file changed at all and which lines to mark —
  // then kept until another file opens; an answer for a file no longer open is
  // dropped.
  const wholeTab = shownTab === "file" || shownTab === "base";
  const wantFile = wholeTab && Boolean(filePath) && state.status === "loaded";
  useEffect(() => {
    const key = filePath && `${shownTab}:${filePath}`;
    if (!wantFile || !key || !target || fileRequested.current === key) return;
    const path = key;
    fileRequested.current = key;
    setFileState({ status: "loading" });
    const query = diffQuery(target, filePath!, undefined, "file") + (shownTab === "base" ? "&side=base" : "");
    fetchJsonCached(`/api/repos/${repoId}/diff-impact/file?${query}`)
      .then(({ ok, status, json: answer }) => {
        const json = answer as FileContentResponseDTO | { error: string } | null;
        if (!ok || !json || "error" in json) {
          throw new Error(json && "error" in json ? json.error : `Request failed (${status}).`);
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
  }, [wantFile, filePath, shownTab, repoId]);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    setState({ status: "loading" });
    const url = target
      ? `/api/repos/${repoId}/diff-impact/file?${diffQuery(target, filePath, headSha)}${ignoreWhitespace ? "&w=1" : ""}`
      : `/api/repos/${repoId}/file?${new URLSearchParams({ path: filePath })}`;
    fetchJsonCached(url)
      .then(({ ok, status, json: answer }) => {
        const json = answer as FileDiffResponseDTO | FileContentResponseDTO | { error: string } | null;
        if (!ok || !json || "error" in json) {
          throw new Error(json && "error" in json ? json.error : `Request failed (${status}).`);
        }
        // A changed file: its File tab is warmed now, so switching to it draws at once.
        if (target && !("side" in json) && json.content === undefined && json.status !== "removed") {
          void fetchJsonCached(`/api/repos/${repoId}/diff-impact/file?${diffQuery(target, filePath, undefined, "file")}`);
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
  }, [repoId, filePath, headSha, ignoreWhitespace]);
  useDiffShortcuts(prefs, Boolean(finding) && shownTab === "diff" && !outsideDiff);

  const highlightRange = parseLineRange(finding?.lineRange);
  const rawHunks = useMemo(
    () => (state.status === "loaded" && state.data.patch ? parseUnifiedDiff(state.data.patch) : []),
    [state]
  );
  /** What the Diff tab draws: whitespace-only changes left out here when the host's patch still has them, moved blocks marked. */
  const hunks = useMemo(() => {
    const filtered =
      ignoreWhitespace && state.status === "loaded" && state.data.whitespace === "client" ? ignoreWhitespaceHunks(rawHunks) : rawHunks;
    return markMovedLines([{ path: filePath ?? "", hunks: filtered }])[0];
  }, [rawHunks, ignoreWhitespace, state, filePath]);
  /** New-file line numbers the diff added — marked in the File tab's gutter. */
  const addedLines = useMemo(() => {
    const lines = new Set<number>();
    for (const hunk of rawHunks) for (const line of hunk.lines) if (line.type === "add" && line.newLine != null) lines.add(line.newLine);
    return lines;
  }, [rawHunks]);
  // Links: a whole file at the commit it was read at (the analysed commit
  // with no diff selected); the diff's removed lines at the merge-base, the
  // rest at the head.
  const linkPath = onNavigate ? filePath : null;
  const shownRef = state.status === "loaded" ? state.data.ref : undefined;
  const wholeRef = fileState.status === "loaded" ? fileState.data.ref : undefined;
  const wholeSide = fileState.status === "loaded" ? fileState.data.side : "head";
  const outsideSha = target ? (isSha(shownRef) ? shownRef : (headSha ?? targetHeadSha)) : undefined;
  const outsideLinks = useCodeLinks(repoId, outsideDiff && state.status === "loaded" ? linkPath : null, outsideSha, shownRef);
  const headLinks = useCodeLinks(repoId, target && !outsideDiff && targetHeadSha ? linkPath : null, targetHeadSha);
  /** A renamed file is read at the base under its old path. */
  const basePath = linkPath && state.status === "loaded" ? (state.data.oldPath ?? linkPath) : linkPath;
  const baseLinks = useCodeLinks(repoId, target && !outsideDiff && targetBaseSha ? basePath : null, targetBaseSha);
  const wholeSha = isSha(wholeRef) ? wholeRef : wholeSide === "base" ? targetBaseSha : targetHeadSha;
  const wholeLinks = useCodeLinks(repoId, wholeTab && fileState.status === "loaded" ? (wholeSide === "base" ? basePath : linkPath) : null, wholeSha);
  const followLink = onNavigate ? (link: CodeLink) => onNavigate(link.to, link.toLine) : undefined;
  /** The usages dialog, with the commit the code it was opened from is read at. */
  const [usages, setUsages] = useState<{ decl: CodeDecl; sha?: string } | null>(null);
  useEffect(() => setUsages(null), [filePath]);
  const usagesAt = (sha: string | undefined) => (onNavigate ? (decl: CodeDecl) => setUsages({ decl, sha }) : undefined);

  const tabOptions = [
    { value: "diff" as const, label: "Diff" },
    { value: "file" as const, label: "File", title: "The whole file at the head of the diff, with the changed lines marked" },
    ...(state.status === "loaded" && (state.data.status === "modified" || state.data.status === "changed")
      ? [{ value: "base" as const, label: "Base", title: "The whole file before the change" }]
      : []),
    ...(previewable
      ? [{ value: "preview" as const, label: "Before / after", title: "Render the changed components and run the changed functions, before and after" }]
      : []),
  ];

  return (
    <Dialog open={Boolean(finding)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={cn(
          "flex w-full max-w-[calc(100%-2rem)] flex-col",
          shownTab === "preview" || (shownTab === "diff" && prefs.layout === "split") ? "max-h-[92vh] sm:max-w-7xl" : "max-h-[85vh] sm:max-w-4xl"
        )}
      >
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8 font-mono text-[13px] font-normal">
            {back && (
              <button
                type="button"
                onClick={back.onBack}
                title={`Back to ${back.path}`}
                className="inline-flex h-6 shrink-0 items-center gap-1 border border-border px-1.5 font-sans text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <ArrowLeft className="size-3" aria-hidden />
                Back
              </button>
            )}
            <FileDiff className="size-4 shrink-0 text-brand" aria-hidden />
            <span className="truncate" title={filePath}>
              {filePath}
            </span>
            {highlightRange && (
              <span className="shrink-0 rounded-sm bg-brand/15 px-1 text-[11px] text-brand">
                {highlightRange[0] === highlightRange[1] ? `line ${highlightRange[0]}` : `lines ${highlightRange[0]}–${highlightRange[1]}`}
              </span>
            )}
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
          {shownTab === "diff" && !outsideDiff && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pr-8 text-[11px] text-muted-foreground">
              <DiffToolbar prefs={prefs} />
              {state.status === "loaded" && state.data.oldPath && (
                <span className="truncate font-mono" title={`Renamed from ${state.data.oldPath}`}>
                  renamed from {state.data.oldPath}
                </span>
              )}
              {state.status === "loaded" && state.data.truncated && <span className="text-warning">Cut off — the diff is very large.</span>}
              {state.status === "loaded" && state.data.source === "api" && (
                <span title="No local copy of these commits — the patch is the git host's, which leaves out very large files">from the host&apos;s API</span>
              )}
              {onOpenReader && filePath && (
                <button
                  type="button"
                  onClick={() => onOpenReader(filePath, finding?.lineRange)}
                  className="ml-auto inline-flex h-6 items-center gap-1 border border-border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <Files className="size-3" aria-hidden />
                  All files
                </button>
              )}
            </div>
          )}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto" onMouseDown={startMiddleScroll}>
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
            <FileText content={state.data.content} filePath={filePath} highlightRange={highlightRange} links={outsideLinks} onLink={followLink} onUsages={usagesAt(outsideSha)} markNames={markNames} />
          )}
          {shownTab === "diff" &&
            state.status === "loaded" &&
            state.data.content === undefined &&
            (state.data.patch && hunks.length > 0 ? (
              <DiffViewer
                hunks={hunks}
                filePath={filePath}
                highlightRange={highlightRange}
                layout={prefs.layout}
                scrollToHighlight
                links={{ base: baseLinks, head: headLinks }}
                onLink={followLink}
                onUsages={usagesAt(targetHeadSha)}
              />
            ) : (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                {state.data.whitespaceOnly || (state.data.patch && ignoreWhitespace)
                  ? "Only whitespace changed in this file. Show whitespace (W) to see it."
                  : state.data.status === "renamed" && !state.data.patch
                    ? `Renamed from ${state.data.oldPath ?? "another path"} with no content change.`
                    : state.data.status === "added" || state.data.status === "removed"
                      ? `File was ${state.data.status}; no line-by-line diff to show.`
                      : "No textual diff for this file (binary, or too large)."}
              </p>
            ))}
          {wholeTab && state.status === "loaded" && (fileState.status === "loading" || fileState.status === "idle") && (
            <p className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              Loading the file…
            </p>
          )}
          {wholeTab && fileState.status === "error" && (
            <p className="flex items-start gap-2 px-1 py-6 text-xs text-destructive">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>{fileState.message}</span>
            </p>
          )}
          {wholeTab && fileState.status === "loaded" && (
            <>
              <p className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground">
                <span>
                  {fileState.data.side === "head"
                    ? "At the head of the diff"
                    : shownTab === "base"
                      ? "Before the change"
                      : "Before the change — this diff deletes the file"}
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
                filePath={filePath}
                highlightRange={highlightRange}
                addedLines={fileState.data.side === "head" ? addedLines : undefined}
                whole
                links={wholeLinks}
                onLink={followLink}
                onUsages={usagesAt(wholeSha)}
                markNames={markNames}
              />
            </>
          )}
        </div>
        {onNavigate && (
          <UsagesDialog repoId={repoId} decl={usages?.decl ?? null} sha={usages?.sha} onClose={() => setUsages(null)} onView={onNavigate} />
        )}
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
 * Syntax-highlighted by the file's language, the whole file at once so a
 * windowed view is coloured as it reads in the file.
 */
export function FileText({
  content,
  filePath,
  highlightRange,
  addedLines,
  whole = false,
  onLineClick,
  scrollToRange = true,
  links,
  onLink,
  onUsages,
  markNames,
}: {
  content: string;
  filePath?: string;
  highlightRange: [number, number] | null;
  addedLines?: ReadonlySet<number>;
  whole?: boolean;
  /** Line numbers become buttons (the Files view's line link). */
  onLineClick?: (line: number) => void;
  /** `false`: a range picked by clicking a line number doesn't scroll the view. */
  scrollToRange?: boolean;
  /** Imports and names that open another file or a declaration (DESIGN.md §6.28). */
  links?: LineLinks | null;
  onLink?: (link: CodeLink) => void;
  /** A function's, method's or class's "N usages" button, at the end of its declaration line (DESIGN.md §6.28). */
  onUsages?: (decl: CodeDecl) => void;
  /** Names marked on the highlighted lines — the use or declaration a usages dialog opened the file at. */
  markNames?: readonly string[];
}) {
  const lines = useMemo(() => content.replace(/\r?\n$/, "").split(/\r?\n/), [content]);
  const html = useMemo(() => highlightLines(lines, languageForPath(filePath)), [lines, filePath]);
  const windowed = !whole && highlightRange !== null;
  const from = windowed && highlightRange ? Math.max(1, highlightRange[0] - FILE_CONTEXT_LINES) : 1;
  const to = windowed && highlightRange ? Math.min(lines.length, highlightRange[1] + FILE_CONTEXT_LINES) : lines.length;
  let firstAdded: number | null = null;
  if (addedLines) for (const n of addedLines) if (firstAdded === null || n < firstAdded) firstAdded = n;
  // A span (a chat answer's `file.ts:305-350`) is scrolled to its top, a few
  // lines of context above it, so as much of it as fits is on screen; a single
  // line is centred.
  const span = highlightRange !== null && highlightRange[1] > highlightRange[0];
  const rangeLine = whole && scrollToRange && highlightRange ? (span ? Math.max(1, highlightRange[0] - 3) : highlightRange[0]) : null;
  const scrollLine = whole ? (rangeLine ?? firstAdded) : null;
  const scrollRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ block: span && rangeLine !== null ? "start" : "center" });
  }, [content, scrollLine, span, rangeLine]);
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse">
        <tbody
          onClick={
            onLink && links
              ? (event) => {
                  const link = linkFromEvent(event, links);
                  if (link) onLink(link);
                }
              : undefined
          }
        >
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
            const linked = (onLink ? linkLine(text, html?.[n - 1] ?? null, n, links ?? null) : null) ?? html?.[n - 1];
            const lineHtml =
              highlighted && markNames?.length ? markRanges(linked ?? escapeHtml(text), nameRanges(text, markNames), '<mark class="usage-mark">', "</mark>") : linked;
            const decl = links?.decls.get(n);
            return (
              <tr
                key={n}
                ref={n === scrollLine ? scrollRef : undefined}
                className={cn(
                  added && "bg-success/10",
                  // One line is ringed; a span is one tinted band with a bar in the gutter.
                  highlighted && (span ? "bg-brand/10" : "bg-destructive/10 ring-1 ring-inset ring-brand/60"),
                  highlighted && span && n === highlightRange![0] && "border-t border-brand/50",
                  highlighted && span && n === highlightRange![1] && "border-b border-brand/50"
                )}
              >
                <td
                  className={cn(
                    "w-10 shrink-0 border-r border-border/40 px-1.5 text-right font-mono text-[10px] text-muted-foreground select-none",
                    added && "border-l-[3px] border-l-success text-success/80",
                    highlighted && span && "border-l-[3px] border-l-brand text-brand",
                    onLineClick && "cursor-pointer hover:text-foreground"
                  )}
                  onClick={onLineClick ? () => onLineClick(n) : undefined}
                >
                  {n}
                </td>
                <td className="w-full px-2 font-mono text-[12px] leading-relaxed whitespace-pre">
                  {lineHtml ? (
                    // highlight.js output: the line's text, escaped, inside its token spans (and link spans).
                    <span dangerouslySetInnerHTML={{ __html: lineHtml }} />
                  ) : (
                    text || " "
                  )}
                  {decl && onUsages && <UsagesButton decl={decl} onOpen={onUsages} />}
                </td>
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
