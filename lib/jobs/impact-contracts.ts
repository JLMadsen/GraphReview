// Changed-contract detection for the impact check (DESIGN.md §9, "Impact").
//
// A "contract" is something other code depends on by name: a function or
// method signature, a type/interface/enum/struct shape, an exported
// constant. This reads a diff's hunks and reports the ones whose *contract*
// changed — not their bodies — or that disappeared, so the impact pass can
// go looking for callers the PR left behind.
//
// Pure and language-agnostic on purpose, like review-context.ts: the same
// line-based declaration matcher, run over each hunk's old side and new
// side. A missed declaration costs a missed finding, never a wrong one.

import { extractDeclarations, type Declaration } from "./review-context";

export type ContractKind = "callable" | "type" | "value";

export interface ChangedContract {
  name: string;
  /** The file that declares it (its path at the head). */
  filePath: string;
  kind: ContractKind;
  /** `removed`: no declaration of that name is left in the file. */
  change: "changed" | "removed";
  /** The declaration before the change — a signature, or a block excerpt for types/values. */
  before: string;
  /** The declaration after the change; absent when removed. */
  after?: string;
  /**
   * Set when the declaration moved here from another file *and* its
   * contract changed on the way: `before` is then the old file's version.
   * (The old file also gets its own `removed` contract, for callers that
   * still import it from there.)
   */
  movedFrom?: string;
}

export interface ContractSourceFile {
  path: string;
  status?: string;
  patch?: string;
  /**
   * The file's full text at the head commit: `null` when it doesn't exist
   * there (deleted), `undefined` when it couldn't be read — the hunk's new
   * side is used instead.
   */
  headContent?: string | null;
}

/** Contracts reported per review, worst kinds first (removed, then callables, types, values). */
export const MAX_CONTRACTS = 20;
const MAX_SIGNATURE_LINES = 10;
const MAX_BLOCK_LINES = 40;
const MAX_TEXT_CHARS = 1200;

// ---------------------------------------------------------------------------
// Hunks
// ---------------------------------------------------------------------------

interface SideLine {
  text: string;
  /** A `-` line on the old side, a `+` line on the new side. */
  changed: boolean;
}

interface Hunk {
  heading: string;
  old: SideLine[];
  new: SideLine[];
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@[ \t]*(.*)$/;

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = { heading: header[2].trim(), old: [], new: [] };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("\\")) continue;
    const body = line.slice(1).replace(/\r$/, "");
    if (line.startsWith("-")) current.old.push({ text: body, changed: true });
    else if (line.startsWith("+")) current.new.push({ text: body, changed: true });
    else {
      current.old.push({ text: body, changed: false });
      current.new.push({ text: body, changed: false });
    }
  }
  return hunks;
}

/** New-file line numbers of every `+` line in a unified diff — the lines a PR wrote. */
export function addedLineNumbers(patch: string | undefined): Set<number> {
  const added = new Set<number>();
  if (!patch) return added;
  let line = 0;
  for (const row of patch.split("\n")) {
    const header = HUNK_HEADER.exec(row);
    if (header) {
      line = Number(header[1]);
      continue;
    }
    if (line === 0 || row.startsWith("\\") || row.startsWith("-")) continue;
    if (row.startsWith("+")) added.add(line);
    line++;
  }
  return added;
}

// ---------------------------------------------------------------------------
// Declarations → contract text
// ---------------------------------------------------------------------------

const TYPE_KEYWORD = /\b(?:interface|type|enum|struct|trait|record|typealias)\s+[A-Za-z_$]/;
const VALUE_KEYWORD = /\b(?:const|let|var|static)\s+[A-Za-z_$]/;

export function contractKind(signature: string): ContractKind {
  if (TYPE_KEYWORD.test(signature) && !/\bfunction\b/.test(signature)) return "type";
  if (VALUE_KEYWORD.test(signature) && !/=>|\bfunction\b/.test(signature)) return "value";
  return "callable";
}

function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)![0].replace(/\t/g, "    ").length;
}

interface Span {
  start: number;
  /** Exclusive. */
  end: number;
}

/** A callable's signature: its declaration line plus continuation lines until the parameter list closes. */
function signatureSpan(lines: readonly string[], start: number): Span {
  let depth = 0;
  let opened = false;
  let index = start;
  for (; index < lines.length && index - start < MAX_SIGNATURE_LINES; index++) {
    for (const ch of lines[index]) {
      if (ch === "(") {
        depth++;
        opened = true;
      } else if (ch === ")") depth--;
    }
    if (!opened || depth <= 0) return { start, end: index + 1 };
  }
  return { start, end: index };
}

/** A type's or value's block: the line, everything indented deeper, and one closing line. */
function blockSpan(lines: readonly string[], declaration: Declaration): Span {
  let index = declaration.line + 1;
  for (; index < lines.length && index - declaration.line < MAX_BLOCK_LINES; index++) {
    const line = lines[index];
    if (line.trim() === "" || indentOf(line) > declaration.indent) continue;
    if (/^\s*(?:[}\])]|end\b)/.test(line)) index++;
    break;
  }
  return { start: declaration.line, end: index };
}

function spanFor(lines: readonly string[], declaration: Declaration, kind: ContractKind): Span {
  return kind === "callable" ? signatureSpan(lines, declaration.line) : blockSpan(lines, declaration);
}

/** Whitespace-insensitive form, without a trailing body opener, for comparing two versions. */
function normalize(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*([(){}[\],:;<>=|&?])\s*/g, "$1")
    .replace(/[{;,]+$/, "")
    .trim();
}

function render(lines: readonly string[], span: Span, kind: ContractKind): string {
  let text = lines.slice(span.start, span.end).join("\n").replace(/\s+$/, "");
  if (kind === "callable") text = text.replace(/\s*\{\s*$/, "");
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS - 1)}…`;
}

interface SideDeclaration {
  name: string;
  kind: ContractKind;
  text: string;
  touched: boolean;
}

function sideDeclarations(side: readonly SideLine[]): SideDeclaration[] {
  const lines = side.map((line) => line.text);
  return extractDeclarations(lines.join("\n")).map((declaration) => {
    const kind = contractKind(declaration.signature);
    const span = spanFor(lines, declaration, kind);
    return {
      name: declaration.name,
      kind,
      text: render(lines, span, kind),
      touched: side.slice(span.start, span.end).some((line) => line.changed),
    };
  });
}

interface FileDeclaration {
  kind: ContractKind;
  text: string;
  /** 1-based line of the declaration. */
  line: number;
}

/** Every declaration in a whole file, by name — several when a name is declared more than once (methods of different classes, overloads). */
function fileDeclarations(content: string): Map<string, FileDeclaration[]> {
  const lines = content.split(/\r?\n/);
  const out = new Map<string, FileDeclaration[]>();
  for (const declaration of extractDeclarations(content)) {
    const kind = contractKind(declaration.signature);
    const list = out.get(declaration.name) ?? [];
    list.push({ kind, text: render(lines, spanFor(lines, declaration, kind), kind), line: declaration.line + 1 });
    out.set(declaration.name, list);
  }
  return out;
}

/**
 * The head's version of a declaration. With several of the same name, one
 * identical to the old text means "unchanged"; otherwise the hunk's own new
 * side is the best guess at which one it became.
 */
function headVersion(
  candidates: FileDeclaration[] | undefined,
  oldText: string,
  hunkNew: { text: string } | undefined
): { text: string } | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  const wanted = normalize(oldText);
  const same = candidates.find((c) => normalize(c.text) === wanted);
  if (same) return same;
  return hunkNew ?? candidates[0];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const KIND_RANK: Record<ContractKind, number> = { callable: 0, type: 1, value: 2 };

/**
 * The contracts a diff changed or removed. Body-only edits to a function
 * are not contract changes; a changed parameter list, return type, type
 * member or exported constant is. Names shorter than three characters are
 * skipped — too common to search for.
 *
 * A removed declaration that the same diff wrote into exactly one other file
 * (added or modified) moved there; when its contract changed on the way, that
 * is reported as a `changed` contract of the new file with `movedFrom` set.
 * Added files are read only for this.
 */
export function detectChangedContracts(files: readonly ContractSourceFile[]): ChangedContract[] {
  const found = new Map<string, ChangedContract>();

  for (const file of files) {
    if (!file.patch || file.status === "added") continue;
    const head = typeof file.headContent === "string" ? fileDeclarations(file.headContent) : null;
    const fileGone = file.headContent === null || file.status === "removed";

    for (const hunk of parseHunks(file.patch)) {
      const before = sideDeclarations(hunk.old);
      const after = new Map(sideDeclarations(hunk.new).map((d) => [d.name, d]));
      const touchedAfter = new Set([...after.values()].filter((d) => d.touched).map((d) => d.name));

      for (const old of before) {
        if (old.name.length < 3) continue;
        if (!old.touched && !touchedAfter.has(old.name)) continue;
        const key = `${file.path}\0${old.name}`;
        if (found.has(key)) continue;

        const now = fileGone
          ? undefined
          : head
            ? headVersion(head.get(old.name), old.text, after.get(old.name))
            : after.get(old.name);
        if (!now) {
          // Gone from the hunk but the head couldn't be read: only a deleted
          // file is certain enough to call "removed".
          if (!fileGone && !head) continue;
          found.set(key, { name: old.name, filePath: file.path, kind: old.kind, change: "removed", before: old.text });
          continue;
        }
        if (normalize(now.text) === normalize(old.text)) continue;
        found.set(key, {
          name: old.name,
          filePath: file.path,
          kind: old.kind,
          change: "changed",
          before: old.text,
          after: now.text,
        });
      }

      // A hunk that starts inside a type's body has no declaration line of
      // its own; git's hunk heading names the enclosing one.
      const [enclosing] = hunk.heading ? extractDeclarations(hunk.heading) : [];
      if (!enclosing || enclosing.name.length < 3) continue;
      const kind = contractKind(enclosing.signature);
      if (kind !== "type") continue;
      if (before.some((d) => d.name === enclosing.name) || after.has(enclosing.name)) continue;
      const changedOld = hunk.old.some((l) => l.changed);
      const changedNew = hunk.new.some((l) => l.changed);
      if (!changedOld && !changedNew) continue;
      const key = `${file.path}\0${enclosing.name}`;
      if (found.has(key)) continue;
      const excerpt = (side: SideLine[]) =>
        `${enclosing.signature} … ${side.map((l) => l.text.trim()).filter(Boolean).join(" ")}`.slice(0, MAX_TEXT_CHARS);
      found.set(key, {
        name: enclosing.name,
        filePath: file.path,
        kind,
        change: "changed",
        before: excerpt(hunk.old),
        after: head?.get(enclosing.name)?.[0]?.text ?? excerpt(hunk.new),
      });
    }
  }

  pairMoves(files, found);

  return [...found.values()]
    .sort(
      (a, b) =>
        Number(a.change !== "removed") - Number(b.change !== "removed") ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind]
    )
    .slice(0, MAX_CONTRACTS);
}

/** Turns "removed here, written there with a different contract" into a `changed` contract of the new file. */
function pairMoves(files: readonly ContractSourceFile[], found: Map<string, ChangedContract>): void {
  const removed = [...found.values()].filter((c) => c.change === "removed");
  if (removed.length === 0) return;
  const homes = files
    .filter((f) => typeof f.headContent === "string")
    .map((f) => ({
      path: f.path,
      declarations: fileDeclarations(f.headContent as string),
      // Only declarations the diff wrote count: an old same-named one elsewhere is not the moved one.
      wrote: (line: number) => f.status === "added" || addedLineNumbers(f.patch).has(line),
    }));

  for (const contract of removed) {
    const matches = homes.flatMap((home) =>
      home.path === contract.filePath
        ? []
        : (home.declarations.get(contract.name) ?? [])
            .filter((d) => d.kind === contract.kind && home.wrote(d.line))
            .map((d) => ({ path: home.path, declaration: d }))
    );
    if (new Set(matches.map((m) => m.path)).size !== 1) continue; // nowhere, or ambiguous
    const path = matches[0].path;
    const key = `${path}\0${contract.name}`;
    if (found.has(key)) continue;
    const now = headVersion(
      matches.map((m) => m.declaration),
      contract.before,
      undefined
    )!;
    // Moved unchanged: only callers still importing the old file can break — the removal covers them.
    if (normalize(now.text) === normalize(contract.before)) continue;
    found.set(key, {
      name: contract.name,
      filePath: path,
      kind: contract.kind,
      change: "changed",
      before: contract.before,
      after: now.text,
      movedFrom: contract.filePath,
    });
  }
}
