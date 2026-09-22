/**
 * The shared `LanguageAnalyzer` extension point (DESIGN.md §5).
 *
 * Adding language N+1 means dropping a folder under `languages/<lang>/`
 * (`queries.scm` + `resolve.ts` + an analyzer definition) and registering it in
 * `registry.ts`. Nothing in `graph-builder.ts` changes.
 */
import type { FileImport } from "./ir";

/** Where a tree-sitter WASM grammar can be found, in priority order. */
export interface GrammarSpec {
  /** Cache key — one compiled `Language` per id per process. */
  id: string;
  /** Absolute candidate paths to the `.wasm` file; the first that exists wins. */
  candidates: string[];
}

/** A flattened query capture: plain data, so the syntax tree can be freed immediately. */
export interface QueryCaptureData {
  name: string;
  text: string;
  /** 0-based start row of the captured node. */
  startRow: number;
}

/** A flattened query match. */
export interface QueryMatchData {
  patternIndex: number;
  captures: QueryCaptureData[];
}

/** An import specifier lifted out of the query matches, before path resolution. */
export interface RawImport {
  raw: string;
  kind: FileImport["kind"];
  /**
   * Best-effort guess (e.g. Python `from pkg import name`, where `name` *might*
   * be a submodule and might be a plain symbol). Speculative imports are dropped
   * entirely when they do not resolve to a real file, so they never pollute the
   * IR or `externalPackages`.
   */
  speculative?: boolean;
}

/** What an analyzer learned about one file from its syntax (or, grammar-free, its text). */
export interface SyntaxFacts {
  imports: RawImport[];
  /** See `FileAnalysis.declares`. Omit for languages without the notion. */
  declares?: string[];
}

/** The file being analysed, handed to the richer analyzer hooks. */
export interface SourceInput {
  /** Repo-relative path, POSIX separators. */
  file: string;
  source: string;
}

/** Repo-wide context handed to analyzers; built once per `analyzeRepo` run. */
export interface AnalyzerContext {
  /** Absolute path of the repo root. */
  rootDir: string;
  /**
   * Every file discovered by the walk (repo-relative, POSIX separators),
   * including files no analyzer handles — import resolution is pure set
   * membership, so it needs no extra filesystem calls.
   */
  files: ReadonlySet<string>;
  /** Scratch space for analyzers to memoize per-run work (e.g. parsed tsconfig paths). */
  cache: Map<string, unknown>;
  /**
   * `FileAnalysis.declares` of every analysed file (repo-relative path -> fully
   * qualified names). Filled after all files were parsed and before any import is
   * resolved (see {@link LanguageAnalyzer.indexDeclarations}); absent during
   * `prepare` and in hand-built contexts that never ran a full analysis.
   */
  declarations?: ReadonlyMap<string, readonly string[]>;
}

export interface LanguageAnalyzer {
  /** Stable identifier, also the folder name under `languages/`. */
  readonly id: string;
  /** Lower-case file extensions this analyzer claims, including the leading dot. */
  readonly extensions: readonly string[];
  /**
   * Absolute path to this analyzer's tree-sitter query file. Together with
   * `grammarFor` and `collectImports` (or `analyzeMatches`) this is the
   * grammar-based path; a grammar-free analyzer implements `analyzeSource` instead.
   */
  queryPath?(): string;
  /** Which grammar to parse a given extension with (TS vs TSX, for instance). */
  grammarFor?(ext: string): GrammarSpec;
  /** The `FileAnalysis.language` value to report for a given extension. */
  languageId(ext: string): string;
  /** Turn `queries.scm` matches into raw import specifiers. */
  collectImports?(matches: QueryMatchData[]): RawImport[];
  /**
   * Richer form of {@link collectImports} for analyzers that also need the source
   * text or report `declares` (Java). Takes precedence over `collectImports`.
   */
  analyzeMatches?(matches: QueryMatchData[], input: SourceInput): SyntaxFacts;
  /**
   * Grammar-free path: analyse the raw text directly, no tree-sitter (Kotlin: the
   * only prebuilt WASM grammar that loads under web-tree-sitter 0.27 mis-parses
   * common formatting, and a lexical reader is more dependable). When present,
   * `queryPath`, `grammarFor` and `collectImports` are never called.
   */
  analyzeSource?(input: SourceInput): SyntaxFacts;
  /**
   * Optional hook run once after *every* file was analysed (so
   * `ctx.declarations` is complete) and before any import is resolved. Build
   * cross-file indexes from the declarations here (JVM: fully-qualified name ->
   * file). Analyzers that share an index must make this idempotent.
   */
  indexDeclarations?(ctx: AnalyzerContext): void;
  /**
   * Resolve a specifier to a repo-relative path, or `undefined` when it is
   * external / unresolvable (DESIGN.md §5).
   */
  resolveImportPath(
    raw: string,
    fromFile: string,
    ctx: AnalyzerContext,
  ): string | undefined;
  /**
   * Optional one-to-many form of {@link resolveImportPath}, for languages whose
   * import unit is a *group* of files rather than a single file (a Go package is
   * a directory, a Java `import a.b.*` names a package directory). When present
   * the graph builder uses it instead of `resolveImportPath` and emits one
   * resolved import (hence one edge) per returned path; an empty array means
   * "unresolved". Analyzers implementing it still implement
   * `resolveImportPath` (typically `resolveImportPaths(...)[0]`).
   */
  resolveImportPaths?(
    raw: string,
    fromFile: string,
    ctx: AnalyzerContext,
  ): string[];
  /**
   * The external package an unresolved specifier belongs to, for the grouped
   * "external" nodes in §5 — or `undefined` when the specifier is not an
   * external package (e.g. a relative path pointing at a missing file).
   */
  externalPackageName(raw: string, ctx: AnalyzerContext): string | undefined;
  /** Optional one-time per-run setup (e.g. reading `tsconfig.json`). */
  prepare?(ctx: AnalyzerContext): void | Promise<void>;
}
