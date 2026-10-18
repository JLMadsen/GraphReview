"use client";

// Clickable imports and names in the code views (DESIGN.md §6.28): the file
// viewer's File/Base tabs, the Diff tab, the Files view and the all-files
// reader. The analysis lists, per file and commit, the import specifiers that
// resolve to another repo file and the names that lead to a declaration
// (lib/analysis/code-links.ts); here each one is found on its line and
// wrapped in a `<span data-link>` inside the line's highlighted HTML. One
// click handler on the table reads the span back — see `linkFromEvent`.

import { useEffect, useState } from "react";
// Type-only: nothing server-side reaches the client bundle.
import type { CodeDecl, CodeLink } from "@/lib/analysis/code-links";

export type { CodeDecl, CodeLink };

export type CodeLinksResponseDTO =
  | { state: "ready"; sha: string; links: CodeLink[]; decls: CodeDecl[] }
  | { state: "none"; links: CodeLink[]; decls: CodeDecl[] };

/** A few lines of code around one or more uses (1-based `from`; `uses` are line numbers inside it). */
export interface UsageBlock {
  from: number;
  lines: string[];
  uses: number[];
}

/** `GET /api/repos/[repoId]/code-usages` — lib/jobs/code-usages.ts. */
export type CodeUsagesResponseDTO =
  | { state: "none" }
  | { state: "missing" }
  | {
      state: "ready";
      sha: string;
      decl: CodeDecl & {
        file: string;
        /** Its lines, from `line` on; `null` when the file couldn't be read. */
        source: string[] | null;
        /** Lines past the shown source. */
        sourceCut: number;
      };
      /** Use sites in all. */
      total: number;
      files: Array<{
        file: string;
        /** What the uses call it — marked in the snippets. */
        names: string[];
        lines: number[];
        /** `null`: past the files read for snippets, or unreadable — listed by line only. */
        blocks: UsageBlock[] | null;
        moreSites: number;
      }>;
    };

/** A file's links by line, plus the line-less imports that may stand on any line, and its declarations by line. */
export interface LineLinks {
  links: readonly CodeLink[];
  byLine: Map<number, number[]>;
  anywhere: number[];
  decls: Map<number, CodeDecl>;
}

export function indexLinks(links: readonly CodeLink[] | null | undefined, decls: readonly CodeDecl[] = []): LineLinks | null {
  if ((!links || links.length === 0) && decls.length === 0) return null;
  links ??= [];
  const declsByLine = new Map<number, CodeDecl>();
  for (const decl of decls) if (!declsByLine.has(decl.line)) declsByLine.set(decl.line, decl);
  const byLine = new Map<number, number[]>();
  const anywhere: number[] = [];
  links.forEach((link, i) => {
    if (!link.lines) {
      anywhere.push(i);
      return;
    }
    for (const line of link.lines) {
      const list = byLine.get(line);
      if (list) list.push(i);
      else byLine.set(line, [i]);
    }
  });
  return { links, byLine, anywhere, decls: declsByLine };
}

const WORD = /[\w$]/;
/** A specifier doesn't continue into these (`./a` isn't `./ab`, `a.b` isn't `a.bc`). */
const SPECIFIER_BEFORE = /[\w$./@-]/;
const QUOTES = new Set(['"', "'", "`", "<"]);
/** A line that reads like an import, for the specifiers of a language without line facts (Go, Rust, C, CSS, …). */
const IMPORT_LINE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:use|mod|import|from|extern\s+crate|#\s*include|@import|@use|require|include)\b/;

function specifierAt(text: string, start: number, length: number): boolean {
  const before = text[start - 1];
  const after = text[start + length];
  if (before !== undefined && SPECIFIER_BEFORE.test(before)) return false;
  if (after === undefined) return true;
  if (/[\w$-]/.test(after)) return false;
  return !(/[./]/.test(after) && WORD.test(text[start + length + 1] ?? ""));
}

function nameAt(text: string, start: number, length: number): boolean {
  const before = text[start - 1];
  const after = text[start + length];
  return !(before !== undefined && WORD.test(before)) && !(after !== undefined && WORD.test(after));
}

type Range = { start: number; end: number; link: number };

/** Where the links of `lineNo` stand on `text`: specifiers first, then the longest names; never overlapping. */
function rangesOn(text: string, lineNo: number, index: LineLinks, codeOnly: (at: number) => boolean): Range[] {
  const candidates = [...(index.byLine.get(lineNo) ?? []), ...index.anywhere];
  if (candidates.length === 0) return [];
  const importLine = IMPORT_LINE.test(text);
  candidates.sort((a, b) => {
    const la = index.links[a];
    const lb = index.links[b];
    if (la.kind !== lb.kind) return la.kind === "import" ? -1 : 1;
    return lb.text.length - la.text.length;
  });
  const ranges: Range[] = [];
  const free = (start: number, end: number) => ranges.every((r) => end <= r.start || start >= r.end);
  for (const i of candidates) {
    const link = index.links[i];
    if (!link.text) continue;
    for (let at = text.indexOf(link.text); at >= 0; at = text.indexOf(link.text, at + 1)) {
      const end = at + link.text.length;
      if (link.kind === "import") {
        if (!specifierAt(text, at, link.text.length)) continue;
        // Without line facts: quoted (`"fmt"`, `<stdio.h>`) or on an import line.
        if (!link.lines && !(QUOTES.has(text[at - 1] ?? "") || importLine)) continue;
      } else if (!nameAt(text, at, link.text.length) || !codeOnly(at)) {
        continue;
      }
      if (free(at, end)) ranges.push({ start: at, end, link: i });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** Per text character of a highlighted line: is it outside a comment and a string? (a name there isn't a use). */
function codeChars(html: string): boolean[] {
  const flags: boolean[] = [];
  const stack: boolean[] = [];
  for (let i = 0; i < html.length; ) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      const tag = html.slice(i, end < 0 ? html.length : end + 1);
      if (tag.startsWith("</")) stack.pop();
      else stack.push(/hljs-(?:comment|string|doctag)/.test(tag) || stack[stack.length - 1] === true);
      i += tag.length;
      continue;
    }
    let length = 1;
    if (html[i] === "&") {
      const end = html.indexOf(";", i);
      if (end > i && end - i < 10) length = end + 1 - i;
    }
    flags.push(stack[stack.length - 1] !== true);
    i += length;
  }
  return flags;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

function openTag(link: CodeLink, i: number): string {
  const where = `${link.to}${link.toLine ? `:${link.toLine}` : ""}`;
  return `<span class="code-link" data-link="${i}" title="${escapeHtml(`Open ${where}`)}">`;
}

/**
 * Line `lineNo` (`text`, and its highlighted `html` when there is one) with
 * its links wrapped in `<span data-link>` — or `null` when no link stands on
 * it, so the caller renders the line as before. A link span is closed before
 * every tag and opened again before the next text, so the highlighter's
 * nesting holds.
 */
export function linkLine(text: string, html: string | null, lineNo: number | null | undefined, index: LineLinks | null): string | null {
  if (!index || lineNo == null) return null;
  const source = html ?? escapeHtml(text);
  let flags: boolean[] | null = null;
  const codeOnly = (at: number) => {
    if (!html) return true;
    flags ??= codeChars(html);
    return flags[at] !== false;
  };
  const ranges = rangesOn(text, lineNo, index, codeOnly);
  if (ranges.length === 0) return null;
  let out = "";
  let at = 0;
  let r = 0;
  let open: string | null = null;
  const current = (): string | null => {
    while (r < ranges.length && at >= ranges[r].end) r++;
    return r < ranges.length && at >= ranges[r].start ? openTag(index.links[ranges[r].link], ranges[r].link) : null;
  };
  for (let i = 0; i < source.length; ) {
    if (source[i] === "<") {
      const end = source.indexOf(">", i);
      const tag = source.slice(i, end < 0 ? source.length : end + 1);
      // Closed before every tag and opened again only before text, so no empty span is left behind.
      if (open) out += "</span>";
      open = null;
      out += tag;
      i += tag.length;
      continue;
    }
    let char = source[i];
    if (char === "&") {
      const end = source.indexOf(";", i);
      if (end > i && end - i < 10) char = source.slice(i, end + 1);
    }
    const want = current();
    if (want !== open) {
      if (open) out += "</span>";
      if (want) out += want;
      open = want;
    }
    out += char;
    i += char.length;
    at++;
  }
  if (open) out += "</span>";
  return out;
}

const NAME_CHAR = /[\w$]/;

/** Where `names` stand as whole names on `text` (longest first, never overlapping) — for marking a used name. */
export function nameRanges(text: string, names: readonly string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (!name) continue;
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      const end = at + name.length;
      if (NAME_CHAR.test(text[at - 1] ?? "") || NAME_CHAR.test(text[end] ?? "")) continue;
      if (ranges.some(([s, e]) => at < e && end > s)) continue;
      ranges.push([at, end]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** The link a click landed on — unless the click ended a text selection (dragging over code to copy it). */
export function linkFromEvent(event: { target: EventTarget | null }, index: LineLinks | null): CodeLink | null {
  if (!index || !(event.target instanceof Element)) return null;
  const el = event.target.closest("[data-link]");
  if (!el) return null;
  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  if (selection && !selection.isCollapsed && selection.toString().length > 0) return null;
  return index.links[Number(el.getAttribute("data-link"))] ?? null;
}

const cache = new Map<string, Promise<{ links: CodeLink[]; decls: CodeDecl[] }>>();
const MAX_CACHED = 200;

function fetchLinks(repoId: string, path: string, sha: string | undefined, version: string): Promise<{ links: CodeLink[]; decls: CodeDecl[] }> {
  const key = `${repoId}\u0000${sha ?? `tip:${version}`}\u0000${path}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const url = `/api/repos/${encodeURIComponent(repoId)}/code-links?path=${encodeURIComponent(path)}${sha ? `&sha=${encodeURIComponent(sha)}` : ""}`;
  const pending = fetch(url, { cache: "no-store" })
    .then(async (res) => {
      const json = (await res.json().catch(() => null)) as CodeLinksResponseDTO | null;
      return res.ok && json && Array.isArray(json.links) ? { links: json.links, decls: json.decls ?? [] } : { links: [], decls: [] };
    })
    .catch(() => ({ links: [] as CodeLink[], decls: [] as CodeDecl[] }));
  cache.set(key, pending);
  // Links are a nicety: a failed or empty answer is never retried for the same key.
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return pending;
}

/**
 * The links of `path` at `sha` (a review target's head or merge-base), or at
 * the repo's analysed commit when `sha` is undefined — `version` then keys the
 * cache (the analysed commit as the view knows it). `null` path: none.
 */
export function useCodeLinks(repoId: string, path: string | null | undefined, sha: string | undefined, version = ""): LineLinks | null {
  const [state, setState] = useState<{ key: string; index: LineLinks | null } | null>(null);
  const key = path ? `${repoId}\u0000${sha ?? `tip:${version}`}\u0000${path}` : "";
  useEffect(() => {
    if (!path) return;
    let live = true;
    void fetchLinks(repoId, path, sha, version).then(({ links, decls }) => {
      if (live) setState({ key, index: indexLinks(links, decls) });
    });
    return () => {
      live = false;
    };
  }, [repoId, path, sha, version, key]);
  return state && state.key === key ? state.index : null;
}
