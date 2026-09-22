/**
 * JavaScript / TypeScript / JSX / TSX analyzer (DESIGN.md §5, v1 language set).
 *
 * One analyzer covers the whole JS family: tree-sitter's `typescript` grammar is
 * a superset of JavaScript, and its `tsx` sibling additionally handles JSX, so
 * the single `queries.scm` in this folder works for every extension below.
 * `FileAnalysis.language` still distinguishes `typescript`/`tsx`/`javascript`.
 */
import path from "node:path";
import type {
  AnalyzerContext,
  GrammarSpec,
  LanguageAnalyzer,
  QueryMatchData,
  RawImport,
} from "../../analyzer";
import type { FileImport } from "../../ir";
import { grammarCandidates, resolveLanguageDir } from "../../paths";
import {
  prepareTypeScript,
  resolveTypeScriptImport,
  typeScriptExternalPackage,
} from "./resolve";

const LANGUAGE_ID = "typescript";

// `__dirname` exists under CommonJS (tsx, the Next.js server bundle); when it
// does not, resolveLanguageDir() falls back to walking up from the cwd.
const HERE = typeof __dirname === "string" ? __dirname : undefined;
let languageDir: string | undefined;
function dir(): string {
  languageDir ??= resolveLanguageDir(LANGUAGE_ID, HERE);
  return languageDir;
}

const TYPESCRIPT_GRAMMAR: GrammarSpec = {
  id: "typescript",
  get candidates() {
    return grammarCandidates("tree-sitter-typescript.wasm", dir());
  },
};

const TSX_GRAMMAR: GrammarSpec = {
  id: "tsx",
  get candidates() {
    return grammarCandidates("tree-sitter-tsx.wasm", dir());
  },
};

/** Extensions parsed with the plain TypeScript grammar (no JSX). */
const TS_EXTENSIONS = [".ts", ".mts", ".cts"];
/** Everything else in the family goes through the JSX-capable grammar. */
const TSX_EXTENSIONS = [".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const KIND_MARKERS: ReadonlyArray<FileImport["kind"]> = ["import", "require", "call"];

export const typescriptAnalyzer: LanguageAnalyzer = {
  id: LANGUAGE_ID,
  extensions: [...TS_EXTENSIONS, ...TSX_EXTENSIONS],

  queryPath() {
    return path.join(dir(), "queries.scm");
  },

  grammarFor(ext) {
    return TS_EXTENSIONS.includes(ext) ? TYPESCRIPT_GRAMMAR : TSX_GRAMMAR;
  },

  languageId(ext) {
    if (ext === ".tsx") return "tsx";
    if (TS_EXTENSIONS.includes(ext)) return "typescript";
    return "javascript";
  },

  collectImports(matches: QueryMatchData[]): RawImport[] {
    const imports: RawImport[] = [];
    for (const match of matches) {
      let kind: FileImport["kind"] | undefined;
      let specifier: string | undefined;
      for (const capture of match.captures) {
        if (capture.name === "specifier") specifier = capture.text;
        else if ((KIND_MARKERS as string[]).includes(capture.name)) {
          kind = capture.name as FileImport["kind"];
        }
      }
      if (specifier === undefined || kind === undefined) continue;
      imports.push({ raw: specifier, kind });
    }
    return imports;
  },

  resolveImportPath(raw: string, fromFile: string, ctx: AnalyzerContext) {
    return resolveTypeScriptImport(raw, fromFile, ctx);
  },

  externalPackageName(raw: string, ctx: AnalyzerContext) {
    return typeScriptExternalPackage(raw, ctx);
  },

  prepare(ctx: AnalyzerContext) {
    return prepareTypeScript(ctx);
  },
};

export default typescriptAnalyzer;
