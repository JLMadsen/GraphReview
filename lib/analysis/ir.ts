/**
 * Common intermediate representation emitted by every `LanguageAnalyzer`
 * (DESIGN.md §5). The graph builder only ever sees this shape, never
 * language-specific syntax trees.
 */

/** A single import/require/dynamic-import site found in a file. */
export interface FileImport {
  /** The raw specifier exactly as written in the source (e.g. `./db/client`, `fastapi`). */
  raw: string;
  /** Repo-relative path (POSIX separators) this specifier resolves to, when resolvable. */
  resolvedPath?: string;
  /**
   * How the dependency was expressed:
   * - `import`  — static ESM `import`/`export … from`, Python `import`/`from … import`
   * - `require` — CommonJS `require()`, TS `import x = require()`
   * - `call`    — dynamic, call-shaped imports (`import("…")`, `importlib.import_module("…")`)
   *
   * JVM note: Java/Kotlin also use `import` for *implicit* references (a class of
   * the same package, or of a wildcard-imported package, used without an import
   * statement). Those entries have a synthesized fully-qualified `raw`
   * (`com.acme.util.Strings`) that never appears literally in the source, and
   * exist only when they resolve to a declared repo name.
   */
  kind: "import" | "require" | "call";
}

/** One analyzed source file. */
export interface FileAnalysis {
  /** Repo-relative path, POSIX separators. */
  file: string;
  /** Language id reported by the analyzer (e.g. `typescript`, `tsx`, `javascript`, `python`). */
  language: string;
  imports: FileImport[];
  /**
   * Fully-qualified names this file declares, for languages where a file can
   * declare several importable things under a package (JVM: `package` + each
   * top-level type, and for Kotlin also top-level functions, properties and
   * typealiases). Analyzers that have no such notion leave it undefined. Used to
   * build a per-run name -> file index so `import a.b.C` and same-package
   * references resolve without relying on file names.
   */
  declares?: string[];
  /** Physical line count of the file (a trailing newline does not count as an extra line). */
  loc: number;
}

/** Count lines the way {@link FileAnalysis.loc} is defined. */
export function countLines(source: string): number {
  if (source.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) lines++;
  }
  // A trailing newline terminates the last line rather than starting a new one.
  if (source.charCodeAt(source.length - 1) === 10) lines--;
  return lines;
}
