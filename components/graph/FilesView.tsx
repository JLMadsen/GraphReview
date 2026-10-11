"use client";

// The Graph tab's Files view: the repo as files, the way a code host shows
// it — a folder tree on the left; on the right a folder's listing with the
// latest commit above it and its README rendered under it, or a file with
// line numbers (each a link that marks the line) and, for Markdown, a
// rendered preview. "Go to file" (press `t`) finds a file by a fuzzy match
// on its path.
//
// Everything is the last analysed commit, like the other views: the tree
// from `/tree`, each file from `/file`. With a diff selected the files it
// touches are marked (folders too, when something under them changed), a
// changed file offers its diff (the shared file viewer), files the diff adds
// appear in the tree as new, and "Changed" narrows the tree to them.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LoaderCircle,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "cn";
import { Segmented } from "./Segmented";
import { VIEW_TOOLBAR } from "./view-chrome";
import type { RepoTreeResponseDTO } from "./files-types";
import { DirectoryPane } from "./files/DirectoryPane";
import { CopyButton, FilePane } from "./files/FilePane";
import { type FileEntry, nameOf, buildTree, changedDirsOf, parentOf, findFiles } from "./files/tree";
import { EntryIcon, ChangeMark, TreeLevel } from "./files/TreeLevel";

// ---------------------------------------------------------------------------
// Tree model
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// File text, fetched per path and kept for the session
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface FilesViewProps {
  repoId: string;
  repoName?: string;
  tree: RepoTreeResponseDTO | null;
  loading: boolean;
  error: string | null;
  /** The selected diff's files, when there is one. */
  changedFiles?: ReadonlySet<string>;
  /** Opens the shared file viewer on a changed file's diff. */
  onOpenDiff: (path: string) => void;
  /** The view is the one on screen — `t` focuses "Go to file" only then. */
  active: boolean;
  leading?: React.ReactNode;
  className?: string;
}

const pathStorageKey = (repoId: string) => `graphreview.files.path.${repoId}`;

export function FilesView({ repoId, repoName, tree, loading, error, changedFiles, onOpenDiff, active, leading, className }: FilesViewProps) {
  const [changedOnly, setChangedOnly] = useState(false);
  const hasDiff = Boolean(changedFiles && changedFiles.size > 0);
  useEffect(() => setChangedOnly(hasDiff), [hasDiff, changedFiles]);
  const showChanged = hasDiff && changedOnly;

  const allEntries = useMemo<FileEntry[]>(() => {
    const list: FileEntry[] = (tree?.entries ?? []).map((e) => ({ ...e, name: nameOf(e.path) }));
    if (changedFiles) {
      const known = new Set(list.map((e) => e.path));
      for (const path of changedFiles) if (!known.has(path)) list.push({ path, name: nameOf(path), kind: "file", added: true });
    }
    return list;
  }, [tree, changedFiles]);
  const entries = useMemo(() => (showChanged ? allEntries.filter((e) => changedFiles!.has(e.path)) : allEntries), [allEntries, showChanged, changedFiles]);
  const dirs = useMemo(() => buildTree(entries), [entries]);
  const filesByPath = useMemo(() => new Map(allEntries.map((e) => [e.path, e])), [allEntries]);
  const changedDirs = useMemo(() => (changedFiles ? changedDirsOf(changedFiles) : new Set<string>()), [changedFiles]);
  const newCount = useMemo(() => allEntries.filter((e) => e.added).length, [allEntries]);

  // Where the view is: a folder ("" is the root) or a file — remembered per repo.
  const [path, setPathState] = useState("");
  const [line, setLine] = useState<number | null>(null);
  useEffect(() => {
    try {
      setPathState(window.localStorage.getItem(pathStorageKey(repoId)) ?? "");
    } catch {
      setPathState("");
    }
  }, [repoId]);
  const navigate = useCallback(
    (next: string, nextLine: number | null = null) => {
      setPathState(next);
      setLine(nextLine);
      try {
        window.localStorage.setItem(pathStorageKey(repoId), next);
      } catch {
        /* ignored */
      }
    },
    [repoId]
  );
  const isDir = dirs.has(path);
  const fileEntry = isDir ? undefined : filesByPath.get(path);
  // A remembered path the tree no longer has (or the Changed filter hides): the nearest folder that's there.
  useEffect(() => {
    if (!tree || isDir || fileEntry) return;
    let p = parentOf(path);
    while (p && !dirs.has(p)) p = parentOf(p);
    setPathState(p);
  }, [tree, isDir, fileEntry, path, dirs]);

  // The sidebar's open folders: the root's children closed, the way to the current path open.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      let p = isDir ? path : parentOf(path);
      while (p) {
        next.add(p);
        p = parentOf(p);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [path, isDir]);
  const toggleExpanded = (dir: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  // Go to file.
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => findFiles(entries, query), [entries, query]);
  const [cursor, setCursor] = useState(0);
  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "t" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
  const openResult = (entry: FileEntry | undefined) => {
    if (!entry) return;
    setQuery("");
    searchRef.current?.blur();
    if (entry.added) onOpenDiff(entry.path);
    else navigate(entry.path);
  };

  const openFile = (entry: FileEntry) => (entry.added ? onOpenDiff(entry.path) : navigate(entry.path));

  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [path]);

  const crumbs = path ? path.split("/") : [];

  return (
    <div className={className}>
      <div className={VIEW_TOOLBAR}>
        {leading}
        <div className="ml-auto flex items-center gap-2">
          {loading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          {hasDiff && (
            <Segmented
              label="Show"
              size="xs"
              value={changedOnly ? "changed" : "all"}
              onChange={(v) => setChangedOnly(v === "changed")}
              options={[
                {
                  value: "changed" as const,
                  label: (
                    <>
                      Changed <span className="font-mono text-muted-foreground">{changedFiles!.size}</span>
                    </>
                  ),
                  title: "Only the files this diff touches",
                },
                {
                  value: "all" as const,
                  label: (
                    <>
                      All files <span className="font-mono text-muted-foreground">{allEntries.length}</span>
                    </>
                  ),
                  title: "Every file, with this diff's changes marked",
                },
              ]}
            />
          )}
          <div className="relative">
            <label className="flex h-7 w-52 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs focus-within:border-foreground/30">
              <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setCursor((c) => Math.min(c + 1, results.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setCursor((c) => Math.max(c - 1, 0));
                  } else if (e.key === "Enter") {
                    openResult(results[cursor]);
                  } else if (e.key === "Escape") {
                    setQuery("");
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Go to file"
                aria-label="Go to file"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
              />
              {query ? (
                <button type="button" onClick={() => setQuery("")} aria-label="Clear" className="text-muted-foreground hover:text-foreground">
                  <X className="size-3" />
                </button>
              ) : (
                <kbd className="rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">t</kbd>
              )}
            </label>
            {query.trim() && (
              <ul
                role="listbox"
                aria-label="Matching files"
                className="absolute top-8 right-0 z-30 max-h-[60vh] w-[min(36rem,80vw)] overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-lg"
              >
                {results.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-muted-foreground">No file matches.</li>
                ) : (
                  results.map((entry, i) => (
                    <li key={entry.path} role="option" aria-selected={i === cursor}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setCursor(i)}
                        onClick={() => openResult(entry)}
                        className={cn("flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-[12px]", i === cursor && "bg-secondary")}
                      >
                        <EntryIcon entry={entry} />
                        <span className="truncate">
                          <span className="text-muted-foreground">{parentOf(entry.path) ? `${parentOf(entry.path)}/` : ""}</span>
                          <span className="text-foreground">{entry.name}</span>
                        </span>
                        <ChangeMark path={entry.path} entry={entry} changedFiles={changedFiles} />
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="flex min-h-[220px] flex-1 overflow-hidden bg-background">
        {error && !tree ? (
          <p className="flex items-start gap-2 px-6 py-8 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error}
          </p>
        ) : !tree ? (
          <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading files…
          </div>
        ) : (
          <>
            <aside aria-label="Files" className="hidden w-64 shrink-0 overflow-y-auto border-r border-border bg-card py-1.5 md:block">
              <TreeLevel
                dirs={dirs}
                dir=""
                depth={0}
                current={path}
                expanded={expanded}
                onToggle={toggleExpanded}
                onOpenDir={navigate}
                onOpenFile={openFile}
                changedFiles={changedFiles}
                changedDirs={changedDirs}
              />
            </aside>
            <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto">
            <nav aria-label="Path" className="sticky top-0 z-20 flex min-w-0 items-center gap-1 overflow-hidden border-b border-border bg-background/95 px-5 py-2 font-mono text-[13px] backdrop-blur">
              <button
                type="button"
                onClick={() => navigate("")}
                className={cn("shrink-0 font-semibold hover:underline", path ? "text-brand" : "text-foreground")}
              >
                {repoName ?? "repo"}
              </button>
              {crumbs.map((part, i) => {
                const to = crumbs.slice(0, i + 1).join("/");
                const last = i === crumbs.length - 1;
                return (
                  <Fragment key={to}>
                    <span className="shrink-0 text-muted-foreground">/</span>
                    {last ? (
                      <span className="min-w-0 truncate font-semibold text-foreground">{part}</span>
                    ) : (
                      <button type="button" onClick={() => navigate(to)} className="shrink-0 text-brand hover:underline">
                        {part}
                      </button>
                    )}
                  </Fragment>
                );
              })}
              {!isDir && fileEntry && <CopyButton text={path} label="Copy path" />}
            </nav>
              <div className="mx-auto max-w-[72rem] space-y-4 px-5 py-4">
                {tree.truncated && (
                  <p className="text-xs text-warning">This repo has more files than the view lists — the tree is cut off.</p>
                )}
                {showChanged && newCount > 0 && path === "" && (
                  <p className="text-xs text-muted-foreground">
                    Files marked <span className="font-mono text-success">new</span> are added by the diff — they open on their diff.
                  </p>
                )}
                {isDir ? (
                  <DirectoryPane
                    repoId={repoId}
                    dirs={dirs}
                    dir={path}
                    tree={tree}
                    showCommit={!showChanged}
                    onOpenDir={navigate}
                    onOpenFile={openFile}
                    filesByPath={filesByPath}
                    changedFiles={changedFiles}
                    changedDirs={changedDirs}
                  />
                ) : fileEntry ? (
                  <FilePane
                    repoId={repoId}
                    entry={fileEntry}
                    cacheKey={tree.sha}
                    line={line}
                    onLine={setLine}
                    changed={Boolean(changedFiles?.has(fileEntry.path))}
                    onOpenDiff={onOpenDiff}
                    onNavigate={navigate}
                    filesByPath={filesByPath}
                    dirs={dirs}
                  />
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// README rendering: the Markdown a README uses — headings, paragraphs,
// lists (task lists too), code fences, quotes, tables, rules, links and
// images — into React elements, no HTML passed through. Links into the repo
// open in the view; others in a new tab. Inline HTML is reduced to its text
// (an <img> to an image).
// ---------------------------------------------------------------------------

