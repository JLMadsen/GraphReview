"use client";

// One file opened in the Files view: code, image or rendered markdown.

import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  Check,
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
            scrollToRange={scrollToLine}
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
