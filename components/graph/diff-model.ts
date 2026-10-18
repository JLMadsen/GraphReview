// What the diff viewer does to parsed hunks before drawing them
// (DESIGN.md §6.24): drop whitespace-only changes when git couldn't, pair
// each change block's removed and added lines, mark the words that differ
// inside a pair, find blocks of code that moved, and lay a hunk out as
// side-by-side rows. Plain functions of the hunks — no React — so the smoke
// test (lib/jobs/smoke-test-diff-viewer.ts) checks them directly.

import type { DiffHunk, DiffLine } from "./diff-utils";

/** A line's content with all whitespace removed — what `git diff -w` compares. */
function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

/** The change blocks of a hunk: each maximal run of removed then added lines, as index ranges into `hunk.lines`. */
export function changeBlocks(lines: readonly DiffLine[]): Array<{ removes: number[]; adds: number[] }> {
  const blocks: Array<{ removes: number[]; adds: number[] }> = [];
  let current: { removes: number[]; adds: number[] } | null = null;
  lines.forEach((line, i) => {
    if (line.type === "remove") {
      if (!current || current.adds.length > 0) {
        current = { removes: [], adds: [] };
        blocks.push(current);
      }
      current.removes.push(i);
    } else if (line.type === "add") {
      if (!current) {
        current = { removes: [], adds: [] };
        blocks.push(current);
      }
      current.adds.push(i);
    } else if (line.type === "context") {
      current = null;
    }
  });
  return blocks;
}

/** Longest common subsequence of two sequences, as matched index pairs in order. */
function lcsPairs<T>(a: readonly T[], b: readonly T[], equal: (x: T, y: T) => boolean): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = equal(a[i], b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (equal(a[i], b[j])) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Change blocks bigger than this (removed × added lines) skip the whitespace match — it is quadratic. */
const MAX_WS_BLOCK = 250_000;

/**
 * `git diff -w` for a patch git didn't make (a host's API patch): within each
 * change block, a removed line and an added line that are equal once
 * whitespace is removed become one context line (shown as the new text), and
 * hunks left with no change at all are dropped.
 */
export function ignoreWhitespaceHunks(hunks: readonly DiffHunk[]): DiffHunk[] {
  const out: DiffHunk[] = [];
  for (const hunk of hunks) {
    const replaced = new Map<number, DiffLine[]>();
    const dropped = new Set<number>();
    for (const block of changeBlocks(hunk.lines)) {
      if (block.removes.length === 0 || block.adds.length === 0) continue;
      if (block.removes.length * block.adds.length > MAX_WS_BLOCK) continue;
      const removed = block.removes.map((i) => squash(hunk.lines[i].content));
      const added = block.adds.map((i) => squash(hunk.lines[i].content));
      const matches = lcsPairs(removed, added, (x, y) => x === y);
      if (matches.length === 0) continue;
      // Rebuild the block in order: unmatched removes and adds before each
      // match, then the match as a context line.
      const rebuilt: DiffLine[] = [];
      let r = 0;
      let a = 0;
      for (const [ri, ai] of [...matches, [block.removes.length, block.adds.length] as [number, number]]) {
        while (r < ri) rebuilt.push(hunk.lines[block.removes[r++]]);
        while (a < ai) rebuilt.push(hunk.lines[block.adds[a++]]);
        if (ri < block.removes.length) {
          const oldLine = hunk.lines[block.removes[ri]];
          const newLine = hunk.lines[block.adds[ai]];
          rebuilt.push({ type: "context", oldLine: oldLine.oldLine, newLine: newLine.newLine, content: newLine.content });
          r++;
          a++;
        }
      }
      const first = block.removes[0];
      replaced.set(first, rebuilt);
      for (const i of [...block.removes, ...block.adds]) if (i !== first) dropped.add(i);
    }
    const lines: DiffLine[] = [];
    hunk.lines.forEach((line, i) => {
      if (replaced.has(i)) lines.push(...replaced.get(i)!);
      else if (!dropped.has(i)) lines.push(line);
    });
    if (lines.some((l) => l.type === "add" || l.type === "remove")) out.push({ header: hunk.header, lines });
  }
  return out;
}

/** The removed/added line pairs of a hunk, `[removeIndex, addIndex]` — positional within each change block, as GitHub pairs them. */
export function pairChangedLines(lines: readonly DiffLine[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (const block of changeBlocks(lines)) {
    const n = Math.min(block.removes.length, block.adds.length);
    for (let k = 0; k < n; k++) pairs.push([block.removes[k], block.adds[k]]);
  }
  return pairs;
}

const TOKEN = /\w+|\s+|[^\w\s]/g;
/** Lines longer than this (in tokens) aren't word-diffed — minified code; the whole line is the change. */
const MAX_TOKENS = 400;
/** Below this share of unchanged characters the pair is two different lines, and marking words in it is noise. */
const MIN_SIMILARITY = 0.4;

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = out.at(-1);
    if (last && last[1] >= r[0]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * The word-level difference between a removed and an added line: the
 * changed `[start, end)` character ranges on each side, or `null` when the
 * lines are too different (or too long) for word marks to help.
 */
export function wordDiff(oldText: string, newText: string): { old: Array<[number, number]>; new: Array<[number, number]> } | null {
  if (oldText === newText) return null;
  const a = oldText.match(TOKEN) ?? [];
  const b = newText.match(TOKEN) ?? [];
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;
  const pairs = lcsPairs(a, b, (x, y) => x === y);
  const keptA = new Set(pairs.map((p) => p[0]));
  const keptB = new Set(pairs.map((p) => p[1]));
  const common = pairs.reduce((sum, [i]) => sum + a[i].length, 0);
  if ((2 * common) / Math.max(1, oldText.length + newText.length) < MIN_SIMILARITY) return null;
  const ranges = (tokens: string[], kept: Set<number>) => {
    const out: Array<[number, number]> = [];
    let at = 0;
    tokens.forEach((t, i) => {
      if (!kept.has(i)) out.push([at, at + t.length]);
      at += t.length;
    });
    return mergeRanges(out);
  };
  return { old: ranges(a, keptA), new: ranges(b, keptB) };
}

/** Copies of the hunks with each paired line's changed word ranges set (`DiffLine.ranges`). */
export function annotateIntraline(hunks: readonly DiffHunk[]): DiffHunk[] {
  return hunks.map((hunk) => {
    const lines = hunk.lines.slice();
    for (const [ri, ai] of pairChangedLines(lines)) {
      const diff = wordDiff(lines[ri].content, lines[ai].content);
      if (!diff) continue;
      lines[ri] = { ...lines[ri], ranges: diff.old };
      lines[ai] = { ...lines[ai], ranges: diff.new };
    }
    return { header: hunk.header, lines };
  });
}

/** A moved block needs at least this many letters and digits — git's own `--color-moved` threshold — so a run of `}` lines is never "moved". */
const MIN_MOVED_ALNUM = 20;

interface RunLine {
  file: number;
  hunk: number;
  line: number;
  key: string;
  block: string;
}

/**
 * Marks blocks of code the diff moved — removed in one place and added
 * unchanged (apart from indentation) in another, in the same file or another
 * one — the way `git diff --color-moved` does: consecutive lines that match
 * consecutive lines on the other side, at least 20 letters and digits long.
 * A removed and added line in the same change block are an edit, not a move.
 * `files[i].path` names each file for the "moved from / to" label.
 */
export function markMovedLines(files: ReadonlyArray<{ path: string; hunks: readonly DiffHunk[] }>): DiffHunk[][] {
  const runs = { remove: [] as RunLine[][], add: [] as RunLine[][] };
  files.forEach((file, f) => {
    file.hunks.forEach((hunk, h) => {
      let blockNo = 0;
      let prev: DiffLine["type"] | null = null;
      let run: RunLine[] | null = null;
      hunk.lines.forEach((line, l) => {
        if (line.type === "context" || line.type === "meta" || (line.type === "remove" && prev === "add")) blockNo++;
        if (line.type === "add" || line.type === "remove") {
          if (line.type !== prev) {
            run = [];
            runs[line.type].push(run);
          }
          run!.push({ file: f, hunk: h, line: l, key: line.content.trim(), block: `${f}:${h}:${blockNo}` });
        }
        prev = line.type;
      });
    });
  });

  const index = new Map<string, Array<{ run: RunLine[]; at: number }>>();
  for (const run of runs.remove) run.forEach((rl, at) => {
    if (!rl.key) return;
    const list = index.get(rl.key) ?? [];
    if (list.length < 64) list.push({ run, at });
    index.set(rl.key, list);
  });

  const marks = new Map<string, NonNullable<DiffLine["moved"]>>();
  const id = (rl: RunLine) => `${rl.file}:${rl.hunk}:${rl.line}`;
  const lineOf = (rl: RunLine) => files[rl.file].hunks[rl.hunk].lines[rl.line];
  const alnum = (text: string) => text.replace(/[^A-Za-z0-9]/g, "").length;
  for (const run of runs.add) {
    let i = 0;
    while (i < run.length) {
      let best: { run: RunLine[]; at: number; len: number } | null = null;
      for (const occ of index.get(run[i].key) ?? []) {
        if (occ.run[occ.at].block === run[i].block || marks.has(id(occ.run[occ.at]))) continue;
        let len = 0;
        while (
          i + len < run.length &&
          occ.at + len < occ.run.length &&
          run[i + len].key === occ.run[occ.at + len].key &&
          !marks.has(id(occ.run[occ.at + len]))
        ) len++;
        if (!best || len > best.len) best = { ...occ, len };
      }
      const size = best ? run.slice(i, i + best.len).reduce((s, rl) => s + alnum(rl.key), 0) : 0;
      if (!best || size < MIN_MOVED_ALNUM) {
        i++;
        continue;
      }
      for (let k = 0; k < best.len; k++) {
        const added = run[i + k];
        const removed = best.run[best.at + k];
        const from = best.run[best.at];
        const to = run[i];
        marks.set(id(added), { start: k === 0, path: files[from.file].path, line: lineOf(from).oldLine ?? 0 });
        marks.set(id(removed), { start: k === 0, path: files[to.file].path, line: lineOf(to).newLine ?? 0 });
      }
      i += best.len;
    }
  }

  return files.map((file, f) =>
    file.hunks.map((hunk, h) => ({
      header: hunk.header,
      lines: hunk.lines.map((line, l) => {
        const mark = marks.get(`${f}:${h}:${l}`);
        return mark ? { ...line, moved: mark } : line;
      }),
    }))
  );
}

/** One side-by-side row: indices into the hunk's lines for the old (left) and new (right) side; a meta line spans both. */
export interface SplitRow {
  left: number | null;
  right: number | null;
  meta?: number;
}

/** A hunk as side-by-side rows: context on both sides, each change block's removed and added lines next to each other. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let removes: number[] = [];
  let adds: number[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(removes.length, adds.length); k++) rows.push({ left: removes[k] ?? null, right: adds[k] ?? null });
    removes = [];
    adds = [];
  };
  lines.forEach((line, i) => {
    if (line.type === "remove") {
      if (adds.length > 0) flush();
      removes.push(i);
    } else if (line.type === "add") adds.push(i);
    else {
      flush();
      if (line.type === "meta") rows.push({ left: null, right: null, meta: i });
      else rows.push({ left: i, right: i });
    }
  });
  flush();
  return rows;
}

/**
 * Wraps the character ranges of a line's *text* in `<mark>` inside its
 * syntax-highlighted HTML. Tags don't count as characters and an entity is
 * one; a mark is closed before every tag and opened again before the next
 * text, so the highlighter's nesting is never broken.
 */
export function markRanges(html: string, ranges: ReadonlyArray<[number, number]>, open = '<mark class="diff-word">', close = "</mark>"): string {
  if (ranges.length === 0) return html;
  let out = "";
  let at = 0; // text characters seen
  let r = 0;
  let inside = false;
  const inRange = () => {
    while (r < ranges.length && at >= ranges[r][1]) r++;
    return r < ranges.length && at >= ranges[r][0];
  };
  for (let i = 0; i < html.length; ) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      const tag = html.slice(i, end < 0 ? html.length : end + 1);
      // Closed before the tag and opened again only before the next text, so no empty mark is left behind.
      if (inside) out += close;
      inside = false;
      out += tag;
      i += tag.length;
      continue;
    }
    let char = html[i];
    if (char === "&") {
      const end = html.indexOf(";", i);
      if (end > i && end - i < 10) char = html.slice(i, end + 1);
    }
    const want = inRange();
    if (want !== inside) {
      out += want ? open : close;
      inside = want;
    }
    out += char;
    i += char.length;
    at++;
  }
  if (inside) out += close;
  return out;
}

/** The ranges of a line's plain text as `[text, marked]` pieces, for a line with no syntax highlighting. */
export function rangePieces(text: string, ranges: ReadonlyArray<[number, number]>): Array<[string, boolean]> {
  const pieces: Array<[string, boolean]> = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) pieces.push([text.slice(at, start), false]);
    pieces.push([text.slice(start, end), true]);
    at = end;
  }
  if (at < text.length) pieces.push([text.slice(at), false]);
  return pieces;
}

/** A short string hash (FNV-1a) — the "viewed" fingerprint of a file whose source gave no blob id. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
