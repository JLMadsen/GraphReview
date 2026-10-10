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
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  File as FileIcon,
  FileCode2,
  FileSymlink,
  Folder,
  FolderGit2,
  FolderOpen,
  GitCommitHorizontal,
  GitCompare,
  LoaderCircle,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "cn";
import { Segmented } from "./Segmented";
import { VIEW_TOOLBAR } from "./view-chrome";
import { FileText } from "./FileDiffModal";
import { highlightLines, languageForFence, languageForPath } from "./highlight";
import type { RepoTreeEntryDTO, RepoTreeResponseDTO } from "./files-types";
import type { FileContentResponseDTO } from "./types";

// ---------------------------------------------------------------------------
// Tree model
// ---------------------------------------------------------------------------

interface FileEntry extends RepoTreeEntryDTO {
  name: string;
  /** Not in the analysed commit — the selected diff adds it. */
  added?: boolean;
}

interface DirNode {
  path: string;
  name: string;
  dirs: string[];
  files: FileEntry[];
}

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function buildTree(entries: readonly FileEntry[]): Map<string, DirNode> {
  const dirs = new Map<string, DirNode>([["", { path: "", name: "", dirs: [], files: [] }]]);
  const ensure = (path: string): DirNode => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const node: DirNode = { path, name: nameOf(path), dirs: [], files: [] };
    dirs.set(path, node);
    ensure(parentOf(path)).dirs.push(path);
    return node;
  };
  for (const entry of entries) ensure(parentOf(entry.path)).files.push(entry);
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  for (const node of dirs.values()) {
    node.dirs.sort((a, b) => byName(nameOf(a), nameOf(b)));
    node.files.sort((a, b) => byName(a.name, b.name));
  }
  return dirs;
}

/** A folder holding nothing but one folder reads as one row: `src/main/java`. */
function collapseChain(dirs: Map<string, DirNode>, path: string): string {
  let node = dirs.get(path);
  while (node && node.files.length === 0 && node.dirs.length === 1) {
    path = node.dirs[0];
    node = dirs.get(path);
  }
  return path;
}

/** Every folder above a changed file. */
function changedDirsOf(files: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    let p = parentOf(f);
    while (p && !out.has(p)) {
      out.add(p);
      p = parentOf(p);
    }
  }
  return out;
}

/** The shortest stretch of `text` holding `q`'s characters in order, or `null` when it doesn't. */
function tightestSpan(text: string, q: string): number | null {
  let best: number | null = null;
  for (let start = text.indexOf(q[0]); start !== -1; start = text.indexOf(q[0], start + 1)) {
    let i = 1;
    let end = start;
    while (i < q.length) {
      end = text.indexOf(q[i], end + 1);
      if (end === -1) return best;
      i++;
    }
    const span = end - start + 1;
    if (best === null || span < best) best = span;
  }
  return best;
}

/**
 * Fuzzy "go to file": the query's characters in order. A hit in the file's
 * name beats one across its folders, a run of them beats scattered ones.
 */
function findFiles(entries: readonly FileEntry[], query: string, limit = 80): FileEntry[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return [];
  const scored: Array<{ entry: FileEntry; score: number }> = [];
  for (const entry of entries) {
    const path = entry.path.toLowerCase();
    const name = entry.name.toLowerCase();
    let score: number;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (path.includes(q)) score = 2;
    else {
      const inName = tightestSpan(name, q);
      const inPath = inName === null ? tightestSpan(path, q) : null;
      if (inName === null && inPath === null) continue;
      score = inName !== null ? 3 + inName / 1000 : 4 + inPath! / 10_000;
    }
    scored.push({ entry, score });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path));
  return scored.slice(0, limit).map((s) => s.entry);
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function relativeDate(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const s = Math.round((Date.now() - then) / 1000);
  const steps: Array<[number, string]> = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [30, "day"],
    [12, "month"],
    [Infinity, "year"],
  ];
  let n = s;
  for (const [size, unit] of steps) {
    if (Math.abs(n) < size) return n <= 1 && unit === "second" ? "just now" : `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    n = Math.round(n / size);
  }
  return "";
}

const README = /^readme(\.(md|markdown|mdx|txt|rst))?$/i;
const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
/** Shown as a picture (lib/jobs/repo-tree.ts `IMAGE_TYPES`, served by `/raw`). */
const isImage = (path: string) => /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(path);
const rawUrl = (repoId: string, sha: string, path: string) =>
  `/api/repos/${encodeURIComponent(repoId)}/raw?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(sha)}`;

// ---------------------------------------------------------------------------
// File text, fetched per path and kept for the session
// ---------------------------------------------------------------------------

type FileState = { status: "loading" } | { status: "ready"; data: FileContentResponseDTO } | { status: "error"; message: string };

function useFileText(repoId: string, path: string | null, cacheKey: string): FileState | null {
  const cache = useRef(new Map<string, FileState>());
  const [, rerender] = useState(0);
  useEffect(() => cache.current.clear(), [repoId, cacheKey]);
  useEffect(() => {
    if (!path || cache.current.has(path)) return;
    cache.current.set(path, { status: "loading" });
    rerender((n) => n + 1);
    fetch(`/api/repos/${encodeURIComponent(repoId)}/file?path=${encodeURIComponent(path)}`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as FileContentResponseDTO | { error: string } | null;
        if (!res.ok || !json || "error" in json) throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        cache.current.set(path, { status: "ready", data: json });
      })
      .catch((err: unknown) => {
        cache.current.set(path, { status: "error", message: err instanceof Error ? err.message : "Couldn't read the file." });
      })
      .finally(() => rerender((n) => n + 1));
  }, [repoId, path, cacheKey]);
  return path ? (cache.current.get(path) ?? { status: "loading" }) : null;
}

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

function EntryIcon({ entry, className }: { entry: FileEntry; className?: string }) {
  const Icon = entry.kind === "submodule" ? FolderGit2 : entry.kind === "symlink" ? FileSymlink : languageForPath(entry.path) ? FileCode2 : FileIcon;
  return <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} aria-hidden />;
}

/** "M" for a file the diff changes, "new" for one it adds. */
function ChangeMark({ path, entry, changedFiles }: { path: string; entry?: FileEntry; changedFiles?: ReadonlySet<string> }) {
  if (entry?.added) return <span className="ml-auto shrink-0 font-mono text-[10px] text-success" title="Added by this diff">new</span>;
  if (!changedFiles?.has(path)) return null;
  return (
    <span className="ml-auto shrink-0 font-mono text-[10px] font-semibold text-warning" title="Changed by this diff">
      M
    </span>
  );
}

function TreeLevel({
  dirs,
  dir,
  depth,
  current,
  expanded,
  onToggle,
  onOpenDir,
  onOpenFile,
  changedFiles,
  changedDirs,
}: {
  dirs: Map<string, DirNode>;
  dir: string;
  depth: number;
  current: string;
  expanded: ReadonlySet<string>;
  onToggle: (dir: string) => void;
  onOpenDir: (dir: string) => void;
  onOpenFile: (entry: FileEntry) => void;
  changedFiles?: ReadonlySet<string>;
  changedDirs: ReadonlySet<string>;
}) {
  const node = dirs.get(dir);
  if (!node) return null;
  const pad = { paddingLeft: `${8 + depth * 12}px` };
  return (
    <ul>
      {node.dirs.map((child) => {
        const open = expanded.has(child);
        const Chevron = open ? ChevronDown : ChevronRight;
        const FolderIcon = open ? FolderOpen : Folder;
        return (
          <li key={child}>
            <div
              className={cn(
                "flex w-full items-center gap-1 py-[3px] pr-2 text-[12px] hover:bg-secondary/60",
                child === current && "bg-secondary font-medium text-foreground"
              )}
              style={pad}
            >
              <button type="button" onClick={() => onToggle(child)} aria-label={open ? "Collapse" : "Expand"} aria-expanded={open} className="shrink-0 text-muted-foreground hover:text-foreground">
                <Chevron className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => {
                  onOpenDir(child);
                  if (!open) onToggle(child);
                }}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                title={child}
              >
                <FolderIcon className="size-3.5 shrink-0 text-brand/70" aria-hidden />
                <span className="truncate">{nameOf(child)}</span>
                {changedDirs.has(child) && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-warning" title="Something in here changed" />}
              </button>
            </div>
            {open && (
              <TreeLevel
                dirs={dirs}
                dir={child}
                depth={depth + 1}
                current={current}
                expanded={expanded}
                onToggle={onToggle}
                onOpenDir={onOpenDir}
                onOpenFile={onOpenFile}
                changedFiles={changedFiles}
                changedDirs={changedDirs}
              />
            )}
          </li>
        );
      })}
      {node.files.map((entry) => (
        <li key={entry.path}>
          <button
            type="button"
            onClick={() => onOpenFile(entry)}
            disabled={entry.kind === "submodule"}
            className={cn(
              "flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[12px] hover:bg-secondary/60 disabled:cursor-default disabled:hover:bg-transparent",
              entry.path === current && "bg-secondary font-medium text-foreground"
            )}
            style={{ paddingLeft: `${8 + depth * 12 + 18}px` }}
            title={entry.path}
          >
            <EntryIcon entry={entry} />
            <span className={cn("truncate", entry.added && "text-success")}>{entry.name}</span>
            <ChangeMark path={entry.path} entry={entry} changedFiles={changedFiles} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function DirectoryPane({
  repoId,
  dirs,
  dir,
  tree,
  showCommit,
  onOpenDir,
  onOpenFile,
  filesByPath,
  changedFiles,
  changedDirs,
}: {
  repoId: string;
  dirs: Map<string, DirNode>;
  dir: string;
  tree: RepoTreeResponseDTO;
  showCommit: boolean;
  onOpenDir: (dir: string) => void;
  onOpenFile: (entry: FileEntry) => void;
  filesByPath: Map<string, FileEntry>;
  changedFiles?: ReadonlySet<string>;
  changedDirs: ReadonlySet<string>;
}) {
  const node = dirs.get(dir)!;
  const readme = node.files.find((f) => README.test(f.name) && !f.added);
  const fileCount = useMemo(() => {
    let n = 0;
    for (const [p, d] of dirs) if (p === dir || p.startsWith(`${dir}/`) || dir === "") n += d.files.length;
    return n;
  }, [dirs, dir]);

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {showCommit && (
          <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2 text-[12px]">
            <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            {tree.commit ? (
              <>
                <span className="shrink-0 font-medium text-foreground">{tree.commit.author}</span>
                <span className="min-w-0 truncate text-muted-foreground" title={tree.commit.subject}>
                  {tree.commit.subject}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Analysed commit</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <span title={tree.sha}>{tree.sha.slice(0, 7)}</span>
              {tree.commit?.date && <span title={new Date(tree.commit.date).toLocaleString()}>· {relativeDate(tree.commit.date)}</span>}
              <span>· {fileCount.toLocaleString()} files</span>
            </span>
          </div>
        )}
        <table className="w-full text-[13px]">
          <tbody className="divide-y divide-border">
            {dir && (
              <tr className="hover:bg-secondary/40">
                <td colSpan={2}>
                  <button type="button" onClick={() => onOpenDir(parentOf(dir))} className="flex w-full items-center gap-2 px-3 py-1.5 font-mono text-muted-foreground">
                    <Folder className="size-4 shrink-0 text-brand/70" aria-hidden />
                    ..
                  </button>
                </td>
              </tr>
            )}
            {node.dirs.map((child) => {
              const target = collapseChain(dirs, child);
              return (
                <tr key={child} className="hover:bg-secondary/40">
                  <td>
                    <button type="button" onClick={() => onOpenDir(target)} className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left">
                      <Folder className="size-4 shrink-0 text-brand/70" aria-hidden />
                      <span className="truncate hover:text-brand hover:underline">{target.slice(dir ? dir.length + 1 : 0)}</span>
                      {changedDirs.has(child) && <span className="size-1.5 shrink-0 rounded-full bg-warning" title="Something in here changed" />}
                    </button>
                  </td>
                  <td className="w-24 px-3 text-right font-mono text-[11px] text-muted-foreground" />
                </tr>
              );
            })}
            {node.files.map((entry) => (
              <tr key={entry.path} className="hover:bg-secondary/40">
                <td>
                  <button
                    type="button"
                    onClick={() => onOpenFile(entry)}
                    disabled={entry.kind === "submodule"}
                    className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left disabled:cursor-default"
                  >
                    <EntryIcon entry={entry} className="size-4" />
                    <span className={cn("truncate", entry.kind !== "submodule" && "hover:text-brand hover:underline", entry.added && "text-success")}>
                      {entry.name}
                    </span>
                    {entry.kind === "submodule" && <span className="font-mono text-[10px] text-muted-foreground">submodule</span>}
                    <ChangeMark path={entry.path} entry={entry} changedFiles={changedFiles} />
                  </button>
                </td>
                <td className="w-24 px-3 text-right font-mono text-[11px] whitespace-nowrap text-muted-foreground">{formatBytes(entry.size)}</td>
              </tr>
            ))}
            {node.dirs.length === 0 && node.files.length === 0 && (
              <tr>
                <td colSpan={2} className="px-3 py-6 text-center text-xs text-muted-foreground">
                  Nothing here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {readme && <ReadmeCard repoId={repoId} entry={readme} cacheKey={tree.sha} dirs={dirs} filesByPath={filesByPath} onNavigate={onOpenDir} />}
    </>
  );
}

function ReadmeCard({
  repoId,
  entry,
  cacheKey,
  dirs,
  filesByPath,
  onNavigate,
}: {
  repoId: string;
  entry: FileEntry;
  cacheKey: string;
  dirs: Map<string, DirNode>;
  filesByPath: Map<string, FileEntry>;
  onNavigate: (path: string) => void;
}) {
  const state = useFileText(repoId, entry.path, cacheKey);
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <h3 className="flex items-center gap-2 border-b border-border px-4 py-2 text-[12px] font-semibold">
        <FileIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <button type="button" onClick={() => onNavigate(entry.path)} className="hover:text-brand hover:underline">
          {entry.name}
        </button>
      </h3>
      <div className="px-6 py-5">
        {state?.status === "ready" ? (
          isMarkdown(entry.path) ? (
            <MarkdownDoc source={state.data.content} repoId={repoId} sha={cacheKey} dir={parentOf(entry.path)} dirs={dirs} filesByPath={filesByPath} onNavigate={onNavigate} />
          ) : (
            <pre className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{state.data.content}</pre>
          )
        ) : state?.status === "error" ? (
          <p className="text-xs text-muted-foreground">{state.message}</p>
        ) : (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
        )}
      </div>
    </section>
  );
}

function FilePane({
  repoId,
  entry,
  cacheKey,
  line,
  onLine,
  changed,
  onOpenDiff,
  onNavigate,
  filesByPath,
  dirs,
}: {
  repoId: string;
  entry: FileEntry;
  cacheKey: string;
  line: number | null;
  onLine: (line: number | null) => void;
  changed: boolean;
  onOpenDiff: (path: string) => void;
  onNavigate: (path: string) => void;
  filesByPath: Map<string, FileEntry>;
  dirs: Map<string, DirNode>;
}) {
  const image = isImage(entry.path);
  const svg = /\.svg$/i.test(entry.path);
  const markdown = isMarkdown(entry.path);
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const showPreview = (markdown || image) && mode === "preview";
  // A picture isn't fetched as text — unless it is an SVG asked for as code.
  const state = useFileText(repoId, image && !(svg && mode === "code") ? null : entry.path, cacheKey);
  const content = state?.status === "ready" ? state.data.content : null;
  const lineCount = useMemo(() => (content === null ? 0 : content.replace(/\r?\n$/, "").split(/\r?\n/).length), [content]);
  const language = languageForPath(entry.path);

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-secondary/40 px-3 py-1.5">
        {(markdown || svg) && (
          <Segmented
            label="Show as"
            size="xs"
            value={mode}
            onChange={setMode}
            options={[
              { value: "preview" as const, label: "Preview" },
              { value: "code" as const, label: "Code" },
            ]}
          />
        )}
        <span className="font-mono text-[11px] text-muted-foreground">
          {content !== null && `${lineCount.toLocaleString()} line${lineCount === 1 ? "" : "s"} · `}
          {formatBytes(entry.size)}
          {language && ` · ${language}`}
          {entry.kind === "symlink" && " · symlink"}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {line !== null && !showPreview && (
            <button
              type="button"
              onClick={() => onLine(null)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="Clear the marked line"
            >
              L{line} <X className="size-3" aria-hidden />
            </button>
          )}
          {changed && (
            <button
              type="button"
              onClick={() => onOpenDiff(entry.path)}
              className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-secondary"
              title="This diff changes the file — open its diff"
            >
              <GitCompare className="size-3.5" aria-hidden /> Show diff
            </button>
          )}
          {content !== null && <CopyButton text={content} label="Copy contents" />}
        </div>
      </div>
      {image && showPreview ? (
        <div className="bp-grid flex justify-center px-4 py-8">
          {/* eslint-disable-next-line @next/next/no-img-element -- a repo file at a commit, served by /raw */}
          <img src={rawUrl(repoId, cacheKey, entry.path)} alt={entry.name} className="max-h-[70vh] max-w-full object-contain" />
        </div>
      ) : state?.status === "error" ? (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          {(entry.size ?? 0) > 400_000 ? `This file is too large to show (${formatBytes(entry.size)}).` : "This file can't be shown — it is binary, or couldn't be read."}
        </p>
      ) : content === null ? (
        <div className="flex justify-center py-10">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
        </div>
      ) : showPreview ? (
        <div className="px-6 py-5">
          <MarkdownDoc source={content} repoId={repoId} sha={cacheKey} dir={parentOf(entry.path)} dirs={dirs} filesByPath={filesByPath} onNavigate={onNavigate} />
        </div>
      ) : content === "" ? (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">This file is empty.</p>
      ) : (
        <div className="[&>div]:rounded-none [&>div]:border-0">
          <FileText
            content={content}
            filePath={entry.path}
            highlightRange={line !== null ? [line, line] : null}
            whole
            scrollToRange={false}
            onLineClick={(n) => onLine(n === line ? null : n)}
          />
        </div>
      )}
      {state?.status === "ready" && state.data.truncated && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">The file is longer than the viewer reads — the rest is cut off.</p>
      )}
    </section>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true));
      }}
      aria-label={label}
      title={label}
      className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
    >
      {done ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// README rendering: the Markdown a README uses — headings, paragraphs,
// lists (task lists too), code fences, quotes, tables, rules, links and
// images — into React elements, no HTML passed through. Links into the repo
// open in the view; others in a new tab. Inline HTML is reduced to its text
// (an <img> to an image).
// ---------------------------------------------------------------------------

interface MdContext {
  repoId: string;
  /** The tree's commit — repo images are read at it. */
  sha: string;
  dir: string;
  dirs: Map<string, DirNode>;
  filesByPath: Map<string, FileEntry>;
  onNavigate: (path: string) => void;
}

/** `../docs/a.md#x` from `dir` → `docs/a.md`, when the repo has it. */
function resolveRepoLink(href: string, ctx: MdContext): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return null;
  const clean = decodeURIComponent(href.replace(/[?#].*$/, ""));
  const parts = clean.startsWith("/") ? [] : ctx.dir ? ctx.dir.split("/") : [];
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const path = parts.join("/");
  return ctx.filesByPath.has(path) || ctx.dirs.has(path) ? path : null;
}

const SAFE_URL = /^(https?:|mailto:)/i;

function MdLink({ href, children, ctx }: { href: string; children: React.ReactNode; ctx: MdContext }) {
  const repoPath = resolveRepoLink(href, ctx);
  if (repoPath !== null) {
    return (
      <button type="button" onClick={() => ctx.onNavigate(repoPath)} className="text-brand hover:underline">
        {children}
      </button>
    );
  }
  if (SAFE_URL.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="text-brand hover:underline">
        {children}
      </a>
    );
  }
  return <span className="text-brand">{children}</span>;
}

function MdImage({ src, alt, width, ctx }: { src: string; alt: string; width?: string; ctx: MdContext }) {
  // The repo's own images come from `/raw` at the tree's commit; web images (badges, screenshots) load as they are.
  const repoPath = resolveRepoLink(src, ctx);
  const url = repoPath && isImage(repoPath) ? rawUrl(ctx.repoId, ctx.sha, repoPath) : /^https:/i.test(src) ? src : null;
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- arbitrary README images
      <img
        src={url}
        alt={alt}
        width={width ? Number(width) : undefined}
        className="inline-block max-w-full align-middle"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  return alt ? <span className="rounded border border-dashed border-border px-1 text-[11px] text-muted-foreground">{alt}</span> : null;
}

/** Inline HTML down to Markdown: `<img src alt>` → `![alt](src)`, `<br>` → space, autolinks kept, other tags dropped. */
function stripHtml(text: string): string {
  return text
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = /\ssrc=["']([^"']+)["']/i.exec(tag)?.[1];
      const alt = /\salt=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
      const width = /\swidth=["']?(\d+)/i.exec(tag)?.[1];
      return src ? `![${alt}](${src}${width ? ` =${width}` : ""})` : "";
    })
    .replace(/<(https?:\/\/[^>\s]+)>/g, "[$1]($1)")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const INLINE =
  /\[!\[([^\]]*)\]\(([^)\s]+)[^)]*\)\]\(([^)\s]+)[^)]*\)|!\[([^\]]*)\]\(([^)\s]+)(?:\s+=(\d+))?[^)]*\)|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\s][^*]*)\*(?!\w)|(?<!\w)_([^_\s][^_]*)_(?!\w)|~~([^~]+)~~/g;

function renderInlineMd(text: string, ctx: MdContext): React.ReactNode[] {
  const source = stripHtml(text);
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of source.matchAll(INLINE)) {
    if (m.index! > last) out.push(source.slice(last, m.index));
    if (m[3] !== undefined) {
      out.push(
        <MdLink key={key++} href={m[3]} ctx={ctx}>
          <MdImage src={m[2]} alt={m[1]} ctx={ctx} />
        </MdLink>
      );
    } else if (m[5] !== undefined) out.push(<MdImage key={key++} src={m[5]} alt={m[4]} width={m[6]} ctx={ctx} />);
    else if (m[8] !== undefined)
      out.push(
        <MdLink key={key++} href={m[8]} ctx={ctx}>
          {renderInlineMd(m[7], ctx)}
        </MdLink>
      );
    else if (m[9] !== undefined)
      out.push(
        <code key={key++} className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.85em]">
          {m[9]}
        </code>
      );
    else if (m[10] !== undefined || m[11] !== undefined) out.push(<strong key={key++}>{renderInlineMd(m[10] ?? m[11], ctx)}</strong>);
    else if (m[12] !== undefined || m[13] !== undefined) out.push(<em key={key++}>{renderInlineMd(m[12] ?? m[13], ctx)}</em>);
    else if (m[14] !== undefined) out.push(<del key={key++}>{m[14]}</del>);
    last = m.index! + m[0].length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const splitRow = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

function MarkdownDoc({ source, repoId, sha, dir, dirs, filesByPath, onNavigate }: { source: string } & MdContext) {
  const ctx = useMemo<MdContext>(() => ({ repoId, sha, dir, dirs, filesByPath, onNavigate }), [repoId, sha, dir, dirs, filesByPath, onNavigate]);
  const blocks = useMemo(() => renderBlocks(source.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n"), ctx), [source, ctx]);
  return <div className="space-y-3 text-[14px] leading-relaxed text-foreground/90">{blocks}</div>;
}

function renderBlocks(lines: string[], ctx: MdContext): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const inline = (t: string) => renderInlineMd(t, ctx);
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const fence = /^(`{3,}|~{3,})\s*([\w+-]*)/.exec(trimmed);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      i++;
      const html = highlightLines(code, languageForFence(fence[2]));
      const cls = "overflow-x-auto rounded-md border border-border bg-background px-3 py-2.5 font-mono text-[12px] leading-relaxed";
      out.push(
        html ? (
          // highlight.js output: the code, escaped, inside its token spans.
          <pre key={key++} className={cls} dangerouslySetInnerHTML={{ __html: html.join("\n") }} />
        ) : (
          <pre key={key++} className={cls}>
            {code.join("\n")}
          </pre>
        )
      );
      continue;
    }
    // `<h1 align="center">Name</h1>`, as READMEs open: a heading.
    const htmlHeading = /^<h([1-6])\b[^>]*>(.*?)<\/h\1>$/i.exec(trimmed);
    const heading = htmlHeading ? ([trimmed, "#".repeat(Number(htmlHeading[1])), htmlHeading[2]] as const) : /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const cls = [
        "text-2xl font-semibold border-b border-border pb-1.5 pt-2",
        "text-xl font-semibold border-b border-border pb-1 pt-2",
        "text-base font-semibold pt-1",
        "text-sm font-semibold",
        "text-sm font-semibold",
        "text-xs font-semibold text-muted-foreground",
      ][level - 1];
      const Tag = `h${Math.min(level + 1, 6)}` as "h2";
      out.push(
        <Tag key={key++} className={cls}>
          {inline(heading[2])}
        </Tag>
      );
      i++;
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      out.push(<hr key={key++} className="border-border" />);
      i++;
      continue;
    }
    if (trimmed.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) quoted.push(lines[i++].trim().replace(/^>\s?/, ""));
      // GitHub's alerts: `> [!NOTE]` and its text — a labelled callout.
      const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(quoted[0] ?? "");
      if (alert) {
        const kind = alert[1].toUpperCase();
        const [border, text] =
          kind === "WARNING"
            ? ["border-warning", "text-warning"]
            : kind === "CAUTION"
              ? ["border-destructive", "text-destructive"]
              : kind === "TIP"
                ? ["border-success", "text-success"]
                : ["border-brand", "text-brand"];
        out.push(
          <div key={key++} className={cn("space-y-1.5 border-l-4 pl-3", border)}>
            <p className={cn("text-[13px] font-semibold", text)}>{kind[0] + kind.slice(1).toLowerCase()}</p>
            {renderBlocks(quoted.slice(1), ctx)}
          </div>
        );
        continue;
      }
      out.push(
        <blockquote key={key++} className="space-y-2 border-l-4 border-border pl-3 text-muted-foreground">
          {renderBlocks(quoted, ctx)}
        </blockquote>
      );
      continue;
    }
    if (trimmed.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().includes("|")) rows.push(splitRow(lines[i++]));
      out.push(
        <div key={key++} className="overflow-x-auto">
          <table className="border-collapse text-[13px]">
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n} className="border border-border bg-secondary/50 px-3 py-1.5 text-left font-semibold">
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {head.map((_, n) => (
                    <td key={n} className="border border-border px-3 py-1.5 align-top">
                      {inline(row[n] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: Array<{ depth: number; text: string }> = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m) {
          items.push({ depth: Math.floor(m[1].replace(/\t/g, "  ").length / 2), text: m[3] });
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ` ${lines[i++].trim()}`;
        } else break;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key++} className={cn("space-y-1 pl-5", ordered ? "list-decimal" : "list-disc")}>
          {items.map((item, n) => {
            const task = /^\[([ xX])\]\s+(.*)$/.exec(item.text);
            return (
              <li key={n} style={item.depth ? { marginLeft: `${item.depth * 1.25}rem` } : undefined} className={cn(task && "list-none -ml-5")}>
                {task ? (
                  <span className="flex items-baseline gap-2">
                    <input type="checkbox" checked={task[1] !== " "} readOnly disabled className="translate-y-px" />
                    <span>{inline(task[2])}</span>
                  </span>
                ) : (
                  inline(item.text)
                )}
              </li>
            );
          })}
        </List>
      );
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(`{3,}|~{3,})/.test(lines[i].trim()) &&
      !/^#{1,6}\s/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith(">") &&
      !LIST_ITEM.test(lines[i])
    ) {
      // `Title` over `===` / `---`: a heading.
      if (paragraph.length > 0 && /^(=+|-+)$/.test(lines[i].trim())) {
        const level = lines[i].trim().startsWith("=") ? 1 : 2;
        const Tag = level === 1 ? "h2" : "h3";
        out.push(
          <Tag key={key++} className={cn("font-semibold border-b border-border pt-2", level === 1 ? "text-2xl pb-1.5" : "text-xl pb-1")}>
            {inline(paragraph.join(" "))}
          </Tag>
        );
        paragraph.length = 0;
        i++;
        break;
      }
      paragraph.push(lines[i++].trim());
    }
    if (paragraph.length === 0 && i > 0 && /^(=+|-+)$/.test(lines[i - 1].trim())) continue;
    if (paragraph.length === 0) {
      // A line no block claims (a bare HTML tag the guard above stopped on) — show it as text.
      paragraph.push(lines[i++].trim());
    }
    const content = inline(paragraph.join(" "));
    if (content.some((c) => (typeof c === "string" ? c.trim() : true))) out.push(<p key={key++}>{content}</p>);
  }
  return out;
}
