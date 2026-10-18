"use client";

// Code-editor-style rendering of a parsed unified diff — the file viewer's
// Diff tab and every file of the all-files reader (DESIGN.md §6.24). Two
// layouts: unified (old/new line-number gutters, a +/- marker column and
// the content, GitHub's own shape) and split (old on the left, new on the
// right, each change block's lines side by side). The +/- column stays in
// both, so an added or removed line never rests on colour alone. Lines are
// syntax-highlighted by the file's language (highlight.ts); inside a
// removed/added pair the words that changed are marked (diff-model.ts), and
// a block of code that moved gets a "moved from / to" row above it.

import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";
import { cn } from "cn";
import type { DiffHunk, DiffLine } from "./diff-utils";
import { annotateIntraline, markRanges, rangePieces, splitRows } from "./diff-model";
import { highlightHunks, languageForPath } from "./highlight";
import { linkFromEvent, linkLine, type CodeDecl, type CodeLink, type LineLinks } from "./code-links";
import { UsagesButton } from "./UsagesDialog";

export type DiffLayout = "unified" | "split";

export interface DiffViewerProps {
  hunks: DiffHunk[];
  /** The file the diff is of — its extension picks the syntax highlighting. */
  filePath?: string;
  /** Inclusive `[start, end]` new-file line numbers to highlight — the finding's own location, so the reader can find it inside a multi-hunk file. */
  highlightRange?: [number, number] | null;
  layout?: DiffLayout;
  /** Scroll the first highlighted line into view once drawn. */
  scrollToHighlight?: boolean;
  /** Imports and names that open another file or a declaration (DESIGN.md §6.28): removed lines are read at the base, the rest at the head. */
  links?: { base: LineLinks | null; head: LineLinks | null };
  onLink?: (link: CodeLink) => void;
  /** A declaration's "N usages" button, on the head side's line of it (DESIGN.md §6.28). */
  onUsages?: (decl: CodeDecl) => void;
}

/** A line's HTML with its links, or the highlighted HTML as it was. */
function linkedHtml(line: DiffLine | undefined, html: string | null, links: DiffViewerProps["links"]): string | null {
  if (!line || !links) return html;
  const linked = line.type === "remove" ? linkLine(line.content, html, line.oldLine, links.base) : linkLine(line.content, html, line.newLine, links.head);
  return linked ?? html;
}

function isHighlighted(line: DiffLine | undefined, range: [number, number] | null | undefined): boolean {
  if (!line || !range || line.newLine == null) return false;
  return line.newLine >= range[0] && line.newLine <= range[1];
}

const GUTTER = "w-10 shrink-0 border-r border-border/40 px-1.5 text-right align-top font-mono text-[10px] text-muted-foreground select-none";

function rowTone(line: DiffLine | undefined): string | false {
  if (!line) return false;
  if (line.moved) return line.type === "add" ? "diff-add bg-brand/10" : line.type === "remove" ? "diff-remove bg-brand/[0.07]" : false;
  return line.type === "add" ? "diff-add bg-success/10" : line.type === "remove" ? "diff-remove bg-destructive/10" : false;
}

function Marker({ line, className }: { line: DiffLine | undefined; className?: string | false }) {
  const sign = line?.type === "add" ? "+" : line?.type === "remove" ? "−" : "";
  return (
    <td
      className={cn(
        "w-4 shrink-0 px-1 text-center align-top font-mono text-[11px] select-none",
        line?.type === "add" && "text-success",
        line?.type === "remove" && "text-destructive",
        className
      )}
    >
      {sign}
      {line?.moved && <span className="sr-only">{line.type === "add" ? " moved here" : " moved away"}</span>}
    </td>
  );
}

function Content({
  line,
  html,
  wrap,
  className,
  extra,
}: {
  line: DiffLine | undefined;
  html: string | null;
  wrap: boolean;
  className?: string | false;
  /** After the code: a usages button. */
  extra?: ReactNode;
}) {
  const cls = cn(
    "px-2 align-top font-mono text-[12px] leading-relaxed",
    wrap ? "w-1/2 whitespace-pre-wrap break-all" : "w-full whitespace-pre",
    !line && "bg-muted/40",
    className
  );
  if (!line) return <td className={cls} />;
  const ranges = line.ranges && line.ranges.length > 0 ? line.ranges : null;
  if (html) {
    // highlight.js output: the line's text, escaped, inside its token spans (and link spans).
    const __html = ranges ? markRanges(html, ranges) : html;
    if (extra) {
      return (
        <td className={cls} data-side={line.type === "remove" ? "base" : "head"}>
          <span dangerouslySetInnerHTML={{ __html }} />
          {extra}
        </td>
      );
    }
    return <td className={cls} data-side={line.type === "remove" ? "base" : "head"} dangerouslySetInnerHTML={{ __html }} />;
  }
  if (ranges) {
    return (
      <td className={cls}>
        {rangePieces(line.content, ranges).map(([text, marked], i) =>
          marked ? (
            <mark key={i} className="diff-word">
              {text}
            </mark>
          ) : (
            <Fragment key={i}>{text}</Fragment>
          )
        )}
        {extra}
      </td>
    );
  }
  return (
    <td className={cls}>
      {line.content || " "}
      {extra}
    </td>
  );
}

/** The "moved from / to" row above the first line of a moved block. */
function MovedLabel({ line, colSpan }: { line: DiffLine; colSpan: number }) {
  if (!line.moved?.start) return null;
  const where = `${line.moved.path}${line.moved.line ? `:${line.moved.line}` : ""}`;
  return (
    <tr>
      <td colSpan={colSpan} className="border-t border-dashed border-brand/40 bg-brand/5 px-2 py-0.5 text-[10px] text-brand">
        <span aria-hidden>{line.type === "add" ? "↳ " : "↱ "}</span>
        {line.type === "add" ? "Moved from " : "Moved to "}
        <code className="font-mono">{where}</code>
      </td>
    </tr>
  );
}

function MetaRow({ line, colSpan }: { line: DiffLine; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-2 py-0.5 font-mono text-[10px] text-muted-foreground/60 italic">
        {line.content}
      </td>
    </tr>
  );
}

export function DiffViewer({ hunks, filePath, highlightRange, layout = "unified", scrollToHighlight = false, links, onLink, onUsages }: DiffViewerProps) {
  /** The usages button of a head-side line that declares something. */
  const usages = (line: DiffLine | undefined): ReactNode => {
    if (!onUsages || !line || line.type === "remove" || line.newLine == null) return undefined;
    const decl = links?.head?.decls.get(line.newLine);
    return decl ? <UsagesButton decl={decl} onOpen={onUsages} /> : undefined;
  };
  const annotated = useMemo(() => annotateIntraline(hunks), [hunks]);
  const html = useMemo(() => highlightHunks(annotated, languageForPath(filePath)), [annotated, filePath]);
  const firstHighlight = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (scrollToHighlight) firstHighlight.current?.scrollIntoView({ block: "center" });
  }, [scrollToHighlight, annotated, layout]);
  if (hunks.length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-muted-foreground">No textual diff for this file.</p>;
  }

  let refSet = false;
  const rowRef = (highlighted: boolean) => {
    if (!highlighted || refSet) return undefined;
    refSet = true;
    return firstHighlight;
  };
  const split = layout === "split";
  const cols = split ? 6 : 4;

  return (
    <div className={cn("rounded-lg border border-border bg-background/60", !split && "overflow-x-auto")}>
      <table className={cn("w-full border-collapse", split ? "table-fixed" : "min-w-max")}>
        {split && (
          <colgroup>
            <col className="w-10" />
            <col className="w-4" />
            <col />
            <col className="w-10" />
            <col className="w-4" />
            <col />
          </colgroup>
        )}
        <tbody
          onClick={
            onLink && links
              ? (event) => {
                  const link = linkFromEvent(event, (event.target as Element).closest?.("td[data-side=base]") ? links.base : links.head);
                  if (link) onLink(link);
                }
              : undefined
          }
        >
          {annotated.map((hunk, i) => (
            <Fragment key={i}>
              <tr>
                <td colSpan={cols} className="border-y border-border bg-muted/60 px-2 py-1 font-mono text-[11px] break-all text-brand">
                  {hunk.header}
                </td>
              </tr>
              {split
                ? splitRows(hunk.lines).map((row, j) => {
                    if (row.meta !== undefined) return <MetaRow key={j} line={hunk.lines[row.meta]} colSpan={cols} />;
                    const left = row.left !== null ? hunk.lines[row.left] : undefined;
                    const right = row.right !== null ? hunk.lines[row.right] : undefined;
                    const context = left?.type === "context";
                    const highlighted = isHighlighted(right, highlightRange);
                    const moved = context ? [] : [left, right].filter((l): l is DiffLine => Boolean(l?.moved?.start));
                    const leftTone = rowTone(context ? undefined : left);
                    const rightTone = rowTone(context ? undefined : right);
                    return (
                      <Fragment key={j}>
                        {moved.map((l, k) => <MovedLabel key={k} line={l} colSpan={cols} />)}
                        <tr ref={rowRef(highlighted)} className={cn(highlighted && "ring-1 ring-inset ring-brand/60")}>
                          <td className={cn(GUTTER, leftTone)}>{left?.oldLine ?? ""}</td>
                          <Marker line={context ? undefined : left} className={leftTone} />
                          <Content line={left} html={linkedHtml(left, row.left !== null ? (html?.[i][row.left] ?? null) : null, onLink ? links : undefined)} wrap className={leftTone} />
                          <td className={cn(GUTTER, "border-l", rightTone)}>{right?.newLine ?? ""}</td>
                          <Marker line={context ? undefined : right} className={rightTone} />
                          <Content line={right} html={linkedHtml(right, row.right !== null ? (html?.[i][row.right] ?? null) : null, onLink ? links : undefined)} wrap className={rightTone} extra={usages(right)} />
                        </tr>
                      </Fragment>
                    );
                  })
                : hunk.lines.map((line, j) => {
                    if (line.type === "meta") return <MetaRow key={j} line={line} colSpan={cols} />;
                    const highlighted = isHighlighted(line, highlightRange);
                    return (
                      <Fragment key={j}>
                        <MovedLabel line={line} colSpan={cols} />
                        <tr ref={rowRef(highlighted)} className={cn(rowTone(line), highlighted && "ring-1 ring-inset ring-brand/60")}>
                          <td className={GUTTER}>{line.oldLine ?? ""}</td>
                          <td className={GUTTER}>{line.newLine ?? ""}</td>
                          <Marker line={line} />
                          <Content line={line} html={linkedHtml(line, html?.[i][j] ?? null, onLink ? links : undefined)} wrap={false} extra={usages(line)} />
                        </tr>
                      </Fragment>
                    );
                  })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
