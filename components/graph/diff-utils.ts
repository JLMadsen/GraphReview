// Unified-diff parsing for `DiffViewer` — turns the raw patch text
// `GET /api/repos/[repoId]/diff-impact/file` returns into per-hunk,
// per-line data the code-editor-style viewer can render (old/new line
// numbers + change type), with no server-side parsing step.
//
// Handles both shapes the app's two diff sources produce: GitHub's `patch`
// field, which is just the `@@ ... @@` hunks with no `diff --git`/`---`/`+++`
// preamble, and local git's `git diff -U3` output, which has the full
// preamble. Any line before the first `@@` is preamble and is skipped.

export type DiffLineType = "context" | "add" | "remove" | "meta";

export interface DiffLine {
  type: DiffLineType;
  /** 1-based old-file line number, or `null` for an added/meta line. */
  oldLine: number | null;
  /** 1-based new-file line number, or `null` for a removed/meta line. */
  newLine: number | null;
  content: string;
}

export interface DiffHunk {
  /** The raw `@@ -a,b +c,d @@ ...` header line, shown verbatim. */
  header: string;
  lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/;

/** Parses a unified-diff patch into hunks. Returns `[]` for empty/absent input (binary files, oversized diffs). */
export function parseUnifiedDiff(patch: string | undefined): DiffHunk[] {
  if (!patch) return [];

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  // A trailing newline would otherwise split into one spurious empty
  // "context" line at the end of the last hunk.
  const lines = patch.replace(/\n$/, "").split("\n");

  for (const raw of lines) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // preamble (diff --git / index / --- / +++)

    if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
      current.lines.push({ type: "meta", oldLine: null, newLine: null, content: raw });
      continue;
    }

    const marker = raw.charAt(0);
    const content = raw.slice(1);
    if (marker === "+") {
      current.lines.push({ type: "add", oldLine: null, newLine, content });
      newLine += 1;
    } else if (marker === "-") {
      current.lines.push({ type: "remove", oldLine, newLine: null, content });
      oldLine += 1;
    } else {
      // Context line — normally starts with a space, but a wholly blank
      // context line arrives as an empty string with no leading space.
      current.lines.push({ type: "context", oldLine, newLine, content: marker === " " ? content : raw });
      oldLine += 1;
      newLine += 1;
    }
  }

  return hunks;
}

/** `"120-148"` → `[120, 148]`, `"120"` → `[120, 120]`, anything else → `null`. */
export function parseLineRange(range: string | undefined): [number, number] | null {
  if (!range) return null;
  const match = /^(\d+)(?:-(\d+))?$/.exec(range.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  return start <= end ? [start, end] : [end, start];
}
