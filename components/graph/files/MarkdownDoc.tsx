"use client";

// A small markdown renderer for READMEs and .md files in the Files view:
// repo-relative links and images resolve against the analysed commit.

import { useMemo, useState } from "react";
import { cn } from "cn";
import { highlightLines, languageForFence } from "../highlight";
import { type DirNode, type FileEntry, isImage, rawUrl } from "./tree";

export interface MdContext {
  repoId: string;
  /** The tree's commit — repo images are read at it. */
  sha: string;
  dir: string;
  dirs: Map<string, DirNode>;
  filesByPath: Map<string, FileEntry>;
  onNavigate: (path: string) => void;
}

/** `../docs/a.md#x` from `dir` → `docs/a.md`, when the repo has it. */
export function resolveRepoLink(href: string, ctx: MdContext): string | null {
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

export const SAFE_URL = /^(https?:|mailto:)/i;

export function MdLink({ href, children, ctx }: { href: string; children: React.ReactNode; ctx: MdContext }) {
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

export function MdImage({ src, alt, width, ctx }: { src: string; alt: string; width?: string; ctx: MdContext }) {
  // The repo's own images come from `/raw` at the tree's commit. Web images
  // (badges, screenshots) are not fetched until asked (DESIGN.md §6.26 §3):
  // loading one tells its host who is reading the README, and on an
  // air-gapped machine it only hangs.
  const repoPath = resolveRepoLink(src, ctx);
  if (repoPath && isImage(repoPath)) return <Img url={rawUrl(ctx.repoId, ctx.sha, repoPath)} alt={alt} width={width} />;
  if (/^https:/i.test(src)) return <RemoteImage url={src} alt={alt} width={width} />;
  return alt ? <span className="rounded border border-dashed border-border px-1 text-[11px] text-muted-foreground">{alt}</span> : null;
}

function Img({ url, alt, width }: { url: string; alt: string; width?: string }) {
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

/** A remote image as its alt text and URL until clicked; a span, since it may sit inside a link. */
function RemoteImage({ url, alt, width }: { url: string; alt: string; width?: string }) {
  const [load, setLoad] = useState(false);
  if (load) return <Img url={url} alt={alt} width={width} />;
  const show = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLoad(true);
  };
  const shortUrl = url.replace(/^https:\/\//i, "");
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={show}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && show(e)}
      title={`Remote image, not loaded: ${url}
Click to load it once.`}
      className="inline-flex max-w-full cursor-pointer items-baseline gap-1 rounded border border-dashed border-border px-1 align-middle text-[11px] text-muted-foreground hover:border-brand hover:text-foreground"
    >
      <span aria-hidden>🖼</span>
      {alt ? <span className="font-medium">{alt}</span> : null}
      <span className="truncate font-mono opacity-70">{shortUrl.length > 60 ? `${shortUrl.slice(0, 57)}…` : shortUrl}</span>
    </span>
  );
}

/** Inline HTML down to Markdown: `<img src alt>` → `![alt](src)`, `<br>` → space, autolinks kept, other tags dropped. */
export function stripHtml(text: string): string {
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

export const INLINE =
  /\[!\[([^\]]*)\]\(([^)\s]+)[^)]*\)\]\(([^)\s]+)[^)]*\)|!\[([^\]]*)\]\(([^)\s]+)(?:\s+=(\d+))?[^)]*\)|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\s][^*]*)\*(?!\w)|(?<!\w)_([^_\s][^_]*)_(?!\w)|~~([^~]+)~~/g;

export function renderInlineMd(text: string, ctx: MdContext): React.ReactNode[] {
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

export const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export const splitRow = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

export function MarkdownDoc({ source, repoId, sha, dir, dirs, filesByPath, onNavigate }: { source: string } & MdContext) {
  const ctx = useMemo<MdContext>(() => ({ repoId, sha, dir, dirs, filesByPath, onNavigate }), [repoId, sha, dir, dirs, filesByPath, onNavigate]);
  const blocks = useMemo(() => renderBlocks(source.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n"), ctx), [source, ctx]);
  return <div className="space-y-3 text-[14px] leading-relaxed text-foreground/90">{blocks}</div>;
}

export function renderBlocks(lines: string[], ctx: MdContext): React.ReactNode[] {
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
