// Which lines of a unified diff a review comment can sit on (DESIGN.md §6.23).
//
// GitHub and GitLab only accept an inline comment on a line the diff shows:
// an added line or a context line of a hunk, on the head side. Anything else
// is rejected — and on GitHub one bad comment fails the whole review — so a
// finding whose line isn't in a hunk goes into the summary instead.

export interface DiffLine {
  /** Index of the hunk the line is in — a multi-line comment must stay in one. */
  hunk: number;
  /** The base-side line for a context line; absent for an added line. */
  oldLine?: number;
}

/** Head-side line number → where it is in the diff, for every commentable line. */
export function commentableLines(patch: string | undefined): Map<number, DiffLine> {
  const lines = new Map<number, DiffLine>();
  if (!patch) return lines;
  let hunk = -1;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      hunk += 1;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (hunk < 0 || raw.startsWith("\\")) continue;
    const mark = raw.charAt(0);
    if (mark === "+") {
      lines.set(newLine, { hunk });
      newLine += 1;
    } else if (mark === "-") {
      oldLine += 1;
    } else if (mark === " ") {
      lines.set(newLine, { hunk, oldLine });
      newLine += 1;
      oldLine += 1;
    }
  }
  return lines;
}

/** `"12"` → `{start: 12, end: 12}`, `"12-40"` → `{start: 12, end: 40}`; `null` for anything else. */
export function parseLineRange(range: string | undefined): { start: number; end: number } | null {
  const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(range ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  if (start <= 0 || end <= 0) return null;
  return end >= start ? { start, end } : { start: end, end: start };
}

export type InlinePlacement =
  | { ok: true; line: number; startLine?: number; oldLine?: number }
  | { ok: false; reason: string };

/**
 * Where a finding's comment goes in the diff: on its last line, spanning
 * back to its first when both are in the same hunk.
 */
export function placeComment(patch: string | undefined, range: string | undefined, fileInDiff: boolean): InlinePlacement {
  if (!fileInDiff) return { ok: false, reason: "file not changed by the PR" };
  if (!patch) return { ok: false, reason: "no diff for this file (binary or too large)" };
  const parsed = parseLineRange(range);
  if (!parsed) return { ok: false, reason: "no line number" };
  const lines = commentableLines(patch);
  const end = lines.get(parsed.end);
  if (!end) return { ok: false, reason: `line ${parsed.end} isn't in the diff` };
  const start = parsed.start < parsed.end ? lines.get(parsed.start) : undefined;
  if (start && start.hunk === end.hunk) return { ok: true, line: parsed.end, startLine: parsed.start, oldLine: end.oldLine };
  return { ok: true, line: parsed.end, oldLine: end.oldLine };
}
