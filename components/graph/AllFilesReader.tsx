"use client";

// The all-files reader (DESIGN.md §6.24): every changed file's diff in one
// scrolling view, with a file list on the left. Each file has a "Viewed"
// checkbox; a viewed file folds away, and the mark is kept in this browser
// per diff (target) and per file *content* — the head blob id git reports,
// or a hash of the host's patch — so it clears exactly when a later push
// changes that file and survives pushes that don't. J / K move to the next
// and previous file, V marks the current one viewed and moves on, S and W
// flip split view and whitespace (DiffToolbar).
//
// Opened from the review dock's Files tab, or from the file viewer of a
// finding — then it starts at that file with the finding's lines ringed, as
// the single-file viewer does.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Files, LoaderCircle, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DiffViewer } from "./DiffViewer";
import { useCodeLinks, type CodeDecl, type CodeLink } from "./code-links";
import { UsagesDialog } from "./UsagesDialog";
import { DiffToolbar, isTypingTarget, useDiffPrefs, useDiffShortcuts } from "./DiffToolbar";
import { hashText, ignoreWhitespaceHunks, markMovedLines } from "./diff-model";
import { parseLineRange, parseUnifiedDiff, type DiffHunk } from "./diff-utils";
import { STATUS_BADGES } from "./PrMapNode";
import { reviewTargetKeyOf, type DiffFileDTO, type DiffFilesResponseDTO, type ReviewTargetDTO } from "./types";

const NUMBER = new Intl.NumberFormat("en-US");

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; data: DiffFilesResponseDTO }
  | { status: "error"; message: string };

/** What "viewed" is remembered against: the file's head content. */
export function viewedFingerprint(file: DiffFileDTO): string {
  return file.fingerprint ?? `p:${hashText(`${file.status}\0${file.additions}\0${file.deletions}\0${file.patch ?? ""}`)}`;
}

function storageKey(repoId: string, target: ReviewTargetDTO): string {
  return `graphreview.viewed.${repoId}.${reviewTargetKeyOf(target)}`;
}

/** `path → fingerprint` of the files marked viewed for one diff, kept in localStorage. */
function useViewed(repoId: string, target: ReviewTargetDTO) {
  const key = storageKey(repoId, target);
  const [marks, setMarks] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      setMarks(parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {});
    } catch {
      setMarks({});
    }
  }, [key]);
  const set = useCallback(
    (path: string, fingerprint: string | null) => {
      setMarks((prev) => {
        const next = { ...prev };
        if (fingerprint) next[path] = fingerprint;
        else delete next[path];
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* storage unavailable — the mark lasts for this visit */
        }
        return next;
      });
    },
    [key]
  );
  return [marks, set] as const;
}

function targetParams(target: ReviewTargetDTO): string {
  const params = new URLSearchParams();
  if ("prNumber" in target) params.set("prNumber", String(target.prNumber));
  else {
    params.set("baseRef", target.baseRef);
    params.set("headRef", target.headRef);
  }
  return params.toString();
}

export interface AllFilesReaderProps {
  repoId: string;
  target: ReviewTargetDTO;
  /** `null` while closed; otherwise the file to start at (none: the first) and the finding's lines to ring there. */
  start: { path?: string; lineRange?: string } | null;
  onClose: () => void;
  /** The target's merge-base and head, which its code links are read at (DESIGN.md §6.28). */
  baseSha?: string;
  headSha?: string;
  /** A clicked import or name that leads outside the reader's files, or to a line: open it in the file viewer. */
  onFollowLink?: (path: string, line?: number, names?: string[]) => void;
}

export function AllFilesReader({ repoId, target, start, onClose, baseSha, headSha, onFollowLink }: AllFilesReaderProps) {
  const open = start !== null;
  const prefs = useDiffPrefs("reader");
  const { ignoreWhitespace, layout } = prefs;
  useDiffShortcuts(prefs, open);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  /** The source the last answer came from: an API answer is filtered here, so the whitespace toggle needs no new request. */
  const [apiSource, setApiSource] = useState(false);
  const serverWhitespace = ignoreWhitespace && !apiSource;
  const query = targetParams(target);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: "loading" });
    fetch(`/api/repos/${repoId}/diff-impact/files?${query}${serverWhitespace ? "&w=1" : ""}`)
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as DiffFilesResponseDTO | { error: string } | null;
        if (!res.ok || !json || "error" in json) throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        return json;
      })
      .then((data) => {
        if (cancelled) return;
        setApiSource(data.source === "api");
        setState({ status: "loaded", data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load the diff." });
      });
    return () => {
      cancelled = true;
    };
  }, [open, repoId, query, serverWhitespace]);

  const files = useMemo(() => (state.status === "loaded" ? state.data.files : []), [state]);
  const parsed = useMemo(() => {
    const clientFilter = ignoreWhitespace && state.status === "loaded" && state.data.whitespace === "client";
    const list = files.map((f) => {
      const hunks = parseUnifiedDiff(f.patch);
      return { path: f.path, hunks: clientFilter ? ignoreWhitespaceHunks(hunks) : hunks };
    });
    // Moves are found across every file at once: code cut from one file and pasted into another.
    return markMovedLines(list);
  }, [files, ignoreWhitespace, state]);

  const [viewed, setViewed] = useViewed(repoId, target);
  const isViewed = useCallback((f: DiffFileDTO) => viewed[f.path] === viewedFingerprint(f), [viewed]);
  const viewedCount = files.filter(isViewed).length;
  /** Viewed files the reader opened again anyway. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const [current, setCurrent] = useState(0);
  const highlight = useMemo(
    () => (start?.path && start.lineRange ? { path: start.path, range: parseLineRange(start.lineRange) } : null),
    [start]
  );

  const goTo = useCallback(
    (index: number) => {
      const file = files[index];
      const el = file && sectionRefs.current.get(file.path);
      if (!el || !scrollRef.current) return;
      setCurrent(index);
      scrollRef.current.scrollTop = el.offsetTop;
      el.querySelector<HTMLElement>("[data-file-heading]")?.focus({ preventScroll: true });
    },
    [files]
  );
  /** A link to another file the reader shows jumps to it here; a declaration's line, or a file outside the diff, opens in the file viewer. */
  const followLink = useCallback(
    (link: CodeLink) => {
      const index = link.toLine === undefined ? files.findIndex((f) => f.path === link.to) : -1;
      if (index >= 0) goTo(index);
      else onFollowLink?.(link.to, link.toLine);
    },
    [files, goTo, onFollowLink]
  );

  /** The usages dialog, over the reader; its View buttons open the file viewer. */
  const [usagesOf, setUsagesOf] = useState<CodeDecl | null>(null);

  // Start at the requested file once the diff is in (or reset to the top).
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      startedFor.current = null;
      return;
    }
    if (state.status !== "loaded" || startedFor.current !== null) return;
    startedFor.current = start?.path ?? "";
    const index = start?.path ? files.findIndex((f) => f.path === start.path) : -1;
    if (index >= 0) {
      setExpanded((prev) => new Set(prev).add(files[index].path));
      // After the expanded section is drawn.
      requestAnimationFrame(() => goTo(index));
    } else {
      setCurrent(0);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
  }, [open, state.status, start, files, goTo]);

  // The current file follows the scroll: the last section whose top has passed the top edge.
  const onScroll = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const top = box.scrollTop + 8;
    let index = 0;
    files.forEach((f, i) => {
      const el = sectionRefs.current.get(f.path);
      if (el && el.offsetTop <= top) index = i;
    });
    setCurrent(index);
  }, [files]);

  const toggleViewed = useCallback(
    (file: DiffFileDTO, advance: boolean) => {
      const now = !isViewed(file);
      setViewed(file.path, now ? viewedFingerprint(file) : null);
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(file.path);
        return next;
      });
      if (now && advance) {
        // The next file is current at once, so a J pressed before the scroll lands moves on from it.
        const next = Math.min(files.length - 1, files.indexOf(file) + 1);
        setCurrent(next);
        requestAnimationFrame(() => goTo(next));
      }
    },
    [files, goTo, isViewed, setViewed]
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target) || files.length === 0) return;
      const key = event.key.toLowerCase();
      if (key === "j") goTo(Math.min(files.length - 1, current + 1));
      else if (key === "k") goTo(Math.max(0, current - 1));
      else if (key === "v" && files[current]) toggleViewed(files[current], true);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, files, current, goTo, toggleViewed]);

  const source = state.status === "loaded" ? state.data.source : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[92vh] w-full max-w-[calc(100%-2rem)] flex-col gap-3 sm:max-w-[min(96vw,1700px)]">
        <DialogHeader className="gap-2">
          <DialogTitle className="flex items-center gap-2 pr-8 text-[13px] font-medium">
            <Files className="size-4 shrink-0 text-brand" aria-hidden />
            All changed files
            {state.status === "loaded" && (
              <span className="text-[11px] font-normal text-muted-foreground">
                {viewedCount} of {NUMBER.format(files.length)} viewed · {NUMBER.format(files.length - viewedCount)} to go
              </span>
            )}
          </DialogTitle>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pr-8 text-[11px] text-muted-foreground">
            <DiffToolbar prefs={prefs} />
            <span aria-hidden className="hidden md:inline">
              <kbd className="font-mono">J</kbd>/<kbd className="font-mono">K</kbd> next/previous file · <kbd className="font-mono">V</kbd> viewed ·{" "}
              <kbd className="font-mono">S</kbd> split · <kbd className="font-mono">W</kbd> whitespace
            </span>
            <span className="sr-only">Keys: J next file, K previous file, V mark viewed, S split view, W whitespace.</span>
            {source === "api" && (
              <span className="ml-auto" title="No local copy of these commits — the patches are the git host's, which leaves out very large files">
                from the host&apos;s API
              </span>
            )}
          </div>
        </DialogHeader>

        {state.status === "loading" && (
          <p className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            Loading every file&apos;s diff…
          </p>
        )}
        {state.status === "error" && (
          <p className="flex items-start gap-2 px-1 py-6 text-xs text-destructive">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{state.message}</span>
          </p>
        )}
        {state.status === "loaded" && files.length === 0 && <p className="px-1 py-6 text-xs text-muted-foreground">No changed files.</p>}
        {state.status === "loaded" && files.length > 0 && (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(200px,280px)_minmax(0,1fr)]">
            <nav aria-label="Changed files" className="hidden min-h-0 overflow-y-auto rounded-md border border-border md:block">
              <ul>
                {files.map((f, i) => {
                  const badge = STATUS_BADGES[f.status] ?? STATUS_BADGES.changed;
                  const seen = isViewed(f);
                  const slash = f.path.lastIndexOf("/");
                  return (
                    <li key={f.path}>
                      <button
                        type="button"
                        onClick={() => goTo(i)}
                        aria-current={i === current ? "true" : undefined}
                        title={f.path}
                        className={cn(
                          "flex w-full items-center gap-2 border-b border-border/60 px-2 py-1 text-left text-[11px] transition-colors hover:bg-secondary/60",
                          i === current && "bg-secondary",
                          seen && "text-muted-foreground"
                        )}
                      >
                        <span className="w-3 shrink-0" aria-label={seen ? "Viewed" : "Not viewed"}>
                          {seen && <Check className="size-3 text-success" aria-hidden />}
                        </span>
                        <span className={cn("w-3 shrink-0 font-mono font-semibold", badge.className)} title={badge.label}>
                          {badge.letter}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono">{slash >= 0 ? f.path.slice(slash + 1) : f.path}</span>
                        <span className="shrink-0 font-mono text-[10px]">
                          <span className="text-success">+{f.additions}</span> <span className="text-destructive">−{f.deletions}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
            <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 overflow-y-auto pr-1">
              {files.map((f, i) => (
                <FileSection
                  key={f.path}
                  file={f}
                  hunks={parsed[i]}
                  viewed={isViewed(f)}
                  expanded={expanded.has(f.path)}
                  current={i === current}
                  layout={layout}
                  ignoreWhitespace={ignoreWhitespace}
                  highlightRange={highlight?.path === f.path ? highlight.range : null}
                  scrollRoot={scrollRef}
                  sectionRef={(el) => {
                    if (el) sectionRefs.current.set(f.path, el);
                    else sectionRefs.current.delete(f.path);
                  }}
                  linkSource={onFollowLink ? { repoId, baseSha, headSha } : undefined}
                  onLink={onFollowLink ? followLink : undefined}
                  onUsages={onFollowLink ? setUsagesOf : undefined}
                  onToggleViewed={() => toggleViewed(f, false)}
                  onToggleExpanded={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(f.path)) next.delete(f.path);
                      else next.add(f.path);
                      return next;
                    })
                  }
                />
              ))}
            </div>
          </div>
        )}
        {onFollowLink && <UsagesDialog repoId={repoId} decl={usagesOf} sha={headSha} onClose={() => setUsagesOf(null)} onView={onFollowLink} />}
      </DialogContent>
    </Dialog>
  );
}

function FileSection({
  file,
  hunks,
  viewed,
  expanded,
  current,
  layout,
  ignoreWhitespace,
  highlightRange,
  scrollRoot,
  sectionRef,
  linkSource,
  onLink,
  onUsages,
  onToggleViewed,
  onToggleExpanded,
}: {
  file: DiffFileDTO;
  hunks: DiffHunk[];
  viewed: boolean;
  expanded: boolean;
  current: boolean;
  layout: "unified" | "split";
  ignoreWhitespace: boolean;
  highlightRange: [number, number] | null;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
  sectionRef: (el: HTMLElement | null) => void;
  linkSource?: { repoId: string; baseSha?: string; headSha?: string };
  onLink?: (link: CodeLink) => void;
  onUsages?: (decl: CodeDecl) => void;
  onToggleViewed: () => void;
  onToggleExpanded: () => void;
}) {
  const badge = STATUS_BADGES[file.status] ?? STATUS_BADGES.changed;
  const showBody = !viewed || expanded;
  const headingId = `reader-file-${hashText(file.path)}`;
  const bodyId = `${headingId}-body`;
  return (
    <section ref={sectionRef} aria-labelledby={headingId} className="mb-3">
      <div
        className={cn(
          "sticky top-0 z-10 flex items-center gap-2 rounded-t-md border border-border bg-card px-2 py-1.5",
          !showBody && "rounded-b-md",
          current && "border-brand/50"
        )}
      >
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={showBody}
          aria-controls={bodyId}
          className="text-muted-foreground hover:text-foreground"
          title={showBody ? "Fold this file" : "Show this file"}
        >
          {showBody ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
          <span className="sr-only">{showBody ? "Fold" : "Show"} {file.path}</span>
        </button>
        <span className={cn("font-mono text-[11px] font-semibold", badge.className)} title={badge.label}>
          {badge.letter}
          <span className="sr-only"> {badge.label}</span>
        </span>
        <h3 id={headingId} data-file-heading tabIndex={-1} className="min-w-0 flex-1 truncate font-mono text-[12px] outline-none" title={file.path}>
          {file.oldPath && <span className="text-muted-foreground">{file.oldPath} → </span>}
          {file.path}
        </h3>
        <span className="shrink-0 font-mono text-[11px]">
          <span className="text-success">+{NUMBER.format(file.additions)}</span>{" "}
          <span className="text-destructive">−{NUMBER.format(file.deletions)}</span>
        </span>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
          <input type="checkbox" checked={viewed} onChange={onToggleViewed} className="size-3 accent-[var(--brand)]" />
          Viewed
        </label>
      </div>
      {showBody && (
        <div id={bodyId} className="rounded-b-md border border-t-0 border-border">
          <LazyBody estimate={estimateHeight(hunks)} scrollRoot={scrollRoot} eager={highlightRange !== null}>
            {hunks.length > 0 ? (
              linkSource && onLink ? (
                <LinkedDiff file={file} hunks={hunks} layout={layout} highlightRange={highlightRange} source={linkSource} onLink={onLink} onUsages={onUsages} />
              ) : (
                <DiffViewer hunks={hunks} filePath={file.path} layout={layout} highlightRange={highlightRange} scrollToHighlight={highlightRange !== null} />
              )
            ) : (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                {file.whitespaceOnly || (ignoreWhitespace && file.patch)
                  ? "Only whitespace changed in this file."
                  : file.binary
                    ? "Binary file — no text diff."
                    : file.status === "renamed"
                      ? "Renamed with no content change."
                      : file.status === "added" || file.status === "removed"
                        ? `File ${file.status === "added" ? "added" : "deleted"} with no text to show.`
                        : "No text diff for this file (too large for the host to send)."}
              </p>
            )}
            {file.truncated && <p className="px-3 py-2 text-[11px] text-warning">Cut off — the diff of this file is very large.</p>}
          </LazyBody>
        </div>
      )}
    </section>
  );
}

/** A file's diff with its code links — fetched only once the lazy body draws it. */
function LinkedDiff({
  file,
  hunks,
  layout,
  highlightRange,
  source,
  onLink,
  onUsages,
}: {
  file: DiffFileDTO;
  hunks: DiffHunk[];
  layout: "unified" | "split";
  highlightRange: [number, number] | null;
  source: { repoId: string; baseSha?: string; headSha?: string };
  onLink: (link: CodeLink) => void;
  onUsages?: (decl: CodeDecl) => void;
}) {
  const head = useCodeLinks(source.repoId, source.headSha ? file.path : null, source.headSha);
  const base = useCodeLinks(source.repoId, source.baseSha ? (file.oldPath ?? file.path) : null, source.baseSha);
  return (
    <DiffViewer
      hunks={hunks}
      filePath={file.path}
      layout={layout}
      highlightRange={highlightRange}
      scrollToHighlight={highlightRange !== null}
      links={{ base, head }}
      onLink={onLink}
      onUsages={onUsages}
    />
  );
}

function estimateHeight(hunks: readonly DiffHunk[]): number {
  return Math.max(48, hunks.reduce((h, hunk) => h + 26 + hunk.lines.length * 20, 0));
}

/** Draws its children only once they come near the reader's viewport, then keeps them — a PR of thousands of files stays responsive. */
function LazyBody({
  estimate,
  scrollRoot,
  eager,
  children,
}: {
  estimate: number;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
  eager: boolean;
  children: React.ReactNode;
}) {
  const [shown, setShown] = useState(eager);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown || !ref.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown(true);
      },
      { root: scrollRoot.current, rootMargin: "1200px 0px" }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [shown, scrollRoot]);
  if (shown) return <>{children}</>;
  return <div ref={ref} style={{ height: estimate }} aria-hidden />;
}
