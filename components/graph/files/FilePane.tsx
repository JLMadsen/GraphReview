"use client";

// One file opened in the Files view: code, image or rendered markdown.

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Copy,
  Check,
  GitCommitHorizontal,
  GitCompare,
  LoaderCircle,
  X,
} from "lucide-react";
import { Segmented } from "../Segmented";
import { FileText } from "../FileDiffModal";
import { languageForPath } from "../highlight";
import { MarkdownDoc } from "./MarkdownDoc";
import { type FileEntry, type DirNode, isImage, isMarkdown, formatBytes, rawUrl, parentOf } from "./tree";
import { useFileText } from "./useFileText";
import { useLastCommits } from "./useLastCommits";
import { formatRelativeDate } from "../types";
import { useCodeLinks, type CodeDecl } from "../code-links";
import { UsagesDialog } from "../UsagesDialog";

export function FilePane({
  repoId,
  entry,
  cacheKey,
  line,
  scrollToLine = false,
  onLine,
  changed,
  onOpenDiff,
  onNavigate,
  onFollowLink,
  markNames,
  back,
  filesByPath,
  dirs,
}: {
  repoId: string;
  entry: FileEntry;
  cacheKey: string;
  line: number | null;
  /** The line was asked for from outside the view: show the code (not a preview) and scroll to it. */
  scrollToLine?: boolean;
  onLine: (line: number | null) => void;
  changed: boolean;
  onOpenDiff: (path: string) => void;
  onNavigate: (path: string) => void;
  /** A clicked import or name in the code (DESIGN.md §6.28): open that file, at that line. */
  onFollowLink?: (path: string, line?: number, names?: string[]) => void;
  /** Names marked on the marked line (a usages dialog's View). */
  markNames?: readonly string[];
  /** Where the last followed link was clicked — shown as a Back button. */
  back?: { path: string; onBack: () => void };
  filesByPath: Map<string, FileEntry>;
  dirs: Map<string, DirNode>;
}) {
  const image = isImage(entry.path);
  const svg = /\.svg$/i.test(entry.path);
  const markdown = isMarkdown(entry.path);
  const [mode, setMode] = useState<"preview" | "code">("preview");
  useEffect(() => {
    if (scrollToLine && line !== null && (markdown || svg)) setMode("code");
  }, [scrollToLine, line, markdown, svg]);
  const showPreview = (markdown || image) && mode === "preview";
  // A picture isn't fetched as text — unless it is an SVG asked for as code.
  const state = useFileText(repoId, image && !(svg && mode === "code") ? null : entry.path, cacheKey);
  const content = state?.status === "ready" ? state.data.content : null;
  const lineCount = useMemo(() => (content === null ? 0 : content.replace(/\r?\n$/, "").split(/\r?\n/).length), [content]);
  const language = languageForPath(entry.path);
  // The file's newest commit, from its folder's listing (usually already walked).
  const commits = useLastCommits(repoId, cacheKey, entry.added ? null : parentOf(entry.path));
  const commit = commits?.[entry.name];
  // Read as the file is: at the analysed commit, which `cacheKey` names.
  const links = useCodeLinks(repoId, onFollowLink && !image && !showPreview ? entry.path : null, undefined, cacheKey);
  const [usagesOf, setUsagesOf] = useState<CodeDecl | null>(null);

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      {commit && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[12px]">
          <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="shrink-0 font-medium text-foreground">{commit.author}</span>
          <span className="min-w-0 truncate text-muted-foreground" title={commit.subject}>
            {commit.subject}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span title={commit.sha}>{commit.sha.slice(0, 7)}</span>
            {commit.date && <span title={new Date(commit.date).toLocaleString()}>· {formatRelativeDate(commit.date)}</span>}
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-secondary/40 px-3 py-1.5">
        {back && (
          <button
            type="button"
            onClick={back.onBack}
            className="flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] font-medium hover:bg-secondary"
            title={`Back to ${back.path}`}
          >
            <ArrowLeft className="size-3.5" aria-hidden /> Back
          </button>
        )}
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
            scrollToRange={scrollToLine}
            onLineClick={(n) => onLine(n === line ? null : n)}
            links={links}
            onLink={onFollowLink ? (link) => onFollowLink(link.to, link.toLine) : undefined}
            onUsages={onFollowLink ? setUsagesOf : undefined}
            markNames={markNames}
          />
        </div>
      )}
      {onFollowLink && <UsagesDialog repoId={repoId} decl={usagesOf} onClose={() => setUsagesOf(null)} onView={onFollowLink} />}
      {state?.status === "ready" && state.data.truncated && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">The file is longer than the viewer reads — the rest is cut off.</p>
      )}
    </section>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
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
