/**
 * What the code views can link (DESIGN.md §6.28): per file, the import
 * specifiers that resolve to another repo file, and the names — imported
 * ones, namespace members, resolved calls — that lead to a declaration.
 *
 * Built from an {@link AnalysisResult} that already has everything: each
 * file's resolved imports (`FileImport.resolvedPath`) and the symbol graph's
 * uses and calls (./symbols.ts). A link is the text as it stands on the line
 * plus where it goes; the viewer finds the text on the line itself, so no
 * column is kept and nothing here reads the source again.
 */
import type { AnalysisResult } from "./graph-builder";
import type { SymbolDecl } from "./symbols";

export interface CodeLink {
  /** The text that is the link: an import specifier as written, or a name (`ns.member` for a namespace member). */
  text: string;
  /** Repo-relative file it opens. */
  to: string;
  /** 1-based line in `to` — the declaration a name leads to; absent for a specifier (the top of the file). */
  toLine?: number;
  /**
   * Lines `text` is a link on. Absent for the imports of a language without
   * symbol facts (Go, Rust, …): the viewer links the text wherever it stands
   * quoted, or on an import-looking line.
   */
  lines?: number[];
  kind: "import" | "name";
}

/** Links per file, for the files that have any. */
export type CodeLinkIndex = Map<string, CodeLink[]>;

/** Methods a call to a class lands on: shown under the class's name, which is what the call site says. */
const CONSTRUCTORS = new Set(["constructor", "<init>", "__init__"]);

const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

export function buildCodeLinks(result: Pick<AnalysisResult, "files" | "symbols">): CodeLinkIndex {
  const declById = new Map<string, SymbolDecl>(result.symbols.decls.map((d) => [d.id, d]));
  const usesByFile = new Map<string, AnalysisResult["symbols"]["uses"]>();
  for (const use of result.symbols.uses) {
    const list = usesByFile.get(use.file);
    if (list) list.push(use);
    else usesByFile.set(use.file, [use]);
  }
  const callsByFile = new Map<string, AnalysisResult["symbols"]["calls"]>();
  for (const call of result.symbols.calls) {
    const list = callsByFile.get(call.file);
    if (list) list.push(call);
    else callsByFile.set(call.file, [call]);
  }

  const index: CodeLinkIndex = new Map();
  for (const analysis of result.files) {
    const facts = analysis.symbols;
    const specifierLines = new Map<string, number[]>();
    const bindingLines = new Map<string, number[]>();
    for (const imp of facts?.imports ?? []) {
      const lines = range(imp.startLine, imp.endLine);
      specifierLines.set(imp.source, [...(specifierLines.get(imp.source) ?? []), ...lines]);
      for (const b of imp.bindings) bindingLines.set(b.local, [...(bindingLines.get(b.local) ?? []), ...lines]);
    }

    const links: CodeLink[] = [];
    const byKey = new Map<string, CodeLink>();
    const add = (link: CodeLink) => {
      const key = `${link.kind}\u0000${link.text}`;
      const existing = byKey.get(key);
      // The same text leads one place per file: the first target stands.
      if (existing) {
        if (existing.to === link.to && existing.toLine === link.toLine && existing.lines && link.lines) existing.lines.push(...link.lines);
        return;
      }
      byKey.set(key, link);
      links.push(link);
    };

    for (const imp of analysis.imports) {
      if (!imp.resolvedPath || imp.resolvedPath === analysis.file) continue;
      const lines = specifierLines.get(imp.raw);
      // A file with symbol facts names its import lines; a raw it doesn't list
      // there (a JVM implicit reference) never appears in the text.
      if (facts && !lines) continue;
      add({ kind: "import", text: imp.raw, to: imp.resolvedPath, ...(lines ? { lines: [...lines] } : {}) });
    }

    for (const use of usesByFile.get(analysis.file) ?? []) {
      const decl = declById.get(use.target);
      if (!decl) continue;
      const lines = [...use.lines, ...(use.local.includes(".") ? [] : (bindingLines.get(use.local) ?? []))];
      if (lines.length === 0) continue;
      add({ kind: "name", text: use.local, to: decl.file, toLine: decl.startLine, lines });
    }

    for (const call of callsByFile.get(analysis.file) ?? []) {
      const decl = declById.get(call.to);
      if (!decl) continue;
      const text = CONSTRUCTORS.has(decl.name) && decl.parent ? decl.parent : decl.name;
      add({ kind: "name", text, to: decl.file, toLine: decl.startLine, lines: [call.line] });
    }

    for (const link of links) if (link.lines) link.lines = [...new Set(link.lines)].sort((a, b) => a - b);
    if (links.length > 0) index.set(analysis.file, links);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Usages (DESIGN.md §6.28): the "N usages" button on a declaration
// ---------------------------------------------------------------------------

/** Declaration kinds that get a usages button. */
const USAGE_KINDS = new Set<SymbolDecl["kind"]>(["function", "method", "class"]);

/** A declaration a code view shows a usages button on. */
export interface CodeDecl {
  /** Declaration id (`<file>#<qualified>`). */
  id: string;
  /** `name`, or `Class.method`. */
  qualified: string;
  kind: SymbolDecl["kind"];
  line: number;
  endLine: number;
  /** Usage sites: lines, across the repo, that refer to it or call it. */
  usages: number;
}

/** One file's usage sites of a declaration. */
export interface UsageFile {
  file: string;
  lines: number[];
  /** The text a site uses it under (`format`, `util.format`, a method's name) — what the snippet marks. */
  names: string[];
}

export interface CodeUsageIndex {
  /** Per file, its declarations with a usage count. */
  decls: Map<string, CodeDecl[]>;
  /** Per declaration id with any, where it is used — the declaring file first, then by path. */
  usages: Map<string, UsageFile[]>;
}

/**
 * Where each function, method and class is used: names imported from it
 * (on every line they occur, import statements excluded), namespace members,
 * resolved calls (a constructor's count as the class's), and — in its own
 * file — every other line its name occurs on. Same-file names are read
 * lexically, so a local of the same name counts too; instance calls the
 * symbol graph couldn't resolve don't count at all.
 */
export function buildCodeUsages(result: Pick<AnalysisResult, "files" | "symbols">): CodeUsageIndex {
  const declById = new Map<string, SymbolDecl>(result.symbols.decls.map((d) => [d.id, d]));
  /** declId → file → line → names. */
  const sites = new Map<string, Map<string, Map<number, Set<string>>>>();
  const add = (id: string, file: string, line: number, name: string) => {
    let byFile = sites.get(id);
    if (!byFile) sites.set(id, (byFile = new Map()));
    let byLine = byFile.get(file);
    if (!byLine) byFile.set(file, (byLine = new Map()));
    let names = byLine.get(line);
    if (!names) byLine.set(line, (names = new Set()));
    names.add(name);
  };
  /** A constructor's uses are its class's. */
  const owner = (decl: SymbolDecl): SymbolDecl => (CONSTRUCTORS.has(decl.name) && decl.parent ? (declById.get(`${decl.file}#${decl.parent}`) ?? decl) : decl);

  for (const use of result.symbols.uses) {
    const decl = declById.get(use.target);
    if (!decl) continue;
    const target = owner(decl);
    for (const line of use.lines) add(target.id, use.file, line, use.local);
  }
  for (const call of result.symbols.calls) {
    const decl = declById.get(call.to);
    if (!decl) continue;
    const target = owner(decl);
    add(target.id, call.file, call.line, target.name);
  }
  const topByFile = new Map<string, SymbolDecl[]>();
  for (const decl of result.symbols.decls) {
    if (decl.parent || !USAGE_KINDS.has(decl.kind)) continue;
    const list = topByFile.get(decl.file);
    if (list) list.push(decl);
    else topByFile.set(decl.file, [decl]);
  }
  for (const analysis of result.files) {
    const refs = analysis.symbols?.refs;
    if (!refs) continue;
    for (const decl of topByFile.get(analysis.file) ?? []) {
      for (const line of refs[decl.name] ?? []) if (line !== decl.startLine) add(decl.id, decl.file, line, decl.name);
    }
  }

  const usages = new Map<string, UsageFile[]>();
  const counts = new Map<string, number>();
  for (const [id, byFile] of sites) {
    const declFile = declById.get(id)?.file;
    const files: UsageFile[] = [...byFile]
      .map(([file, byLine]) => ({
        file,
        lines: [...byLine.keys()].sort((a, b) => a - b),
        names: [...new Set([...byLine.values()].flatMap((n) => [...n]))],
      }))
      .sort((a, b) => (a.file === declFile ? -1 : b.file === declFile ? 1 : a.file.localeCompare(b.file)));
    usages.set(id, files);
    counts.set(id, files.reduce((n, f) => n + f.lines.length, 0));
  }

  const decls = new Map<string, CodeDecl[]>();
  for (const decl of result.symbols.decls) {
    if (!USAGE_KINDS.has(decl.kind) || CONSTRUCTORS.has(decl.name)) continue;
    const list = decls.get(decl.file) ?? [];
    list.push({ id: decl.id, qualified: decl.qualified, kind: decl.kind, line: decl.startLine, endLine: decl.endLine, usages: counts.get(decl.id) ?? 0 });
    decls.set(decl.file, list);
  }
  return { decls, usages };
}
