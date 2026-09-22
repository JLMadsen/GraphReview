/**
 * Go analyzer (DESIGN.md §5, §15 v2 - proves out the language extension point).
 *
 * File-level import edges only. Resolution rules (a package is a directory, so
 * one import fans out to every non-test `.go` file in it) live in `resolve.ts`.
 */
import path from "node:path";
import type {
  AnalyzerContext,
  GrammarSpec,
  LanguageAnalyzer,
  QueryMatchData,
  RawImport,
} from "../../analyzer";
import { grammarCandidates, resolveLanguageDir } from "../../paths";
import { goExternalPackage, prepareGo, resolveGoImportPaths } from "./resolve";

const LANGUAGE_ID = "go";

const HERE = typeof __dirname === "string" ? __dirname : undefined;
let languageDir: string | undefined;
function dir(): string {
  languageDir ??= resolveLanguageDir(LANGUAGE_ID, HERE);
  return languageDir;
}

const GO_GRAMMAR: GrammarSpec = {
  id: "go",
  get candidates() {
    return grammarCandidates("tree-sitter-go.wasm", dir());
  },
};

export const goAnalyzer: LanguageAnalyzer = {
  id: LANGUAGE_ID,
  extensions: [".go"],

  queryPath() {
    return path.join(dir(), "queries.scm");
  },

  grammarFor() {
    return GO_GRAMMAR;
  },

  languageId() {
    return "go";
  },

  collectImports(matches: QueryMatchData[]): RawImport[] {
    const imports: RawImport[] = [];
    for (const match of matches) {
      const specifier = match.captures.find((c) => c.name === "specifier")?.text;
      if (specifier === undefined || specifier === "") continue;
      imports.push({ raw: specifier, kind: "import" });
    }
    return imports;
  },

  resolveImportPath(raw: string, _fromFile: string, ctx: AnalyzerContext) {
    return resolveGoImportPaths(raw, ctx)[0];
  },

  resolveImportPaths(raw: string, _fromFile: string, ctx: AnalyzerContext) {
    return resolveGoImportPaths(raw, ctx);
  },

  externalPackageName(raw: string, ctx: AnalyzerContext) {
    return goExternalPackage(raw, ctx);
  },

  prepare(ctx: AnalyzerContext) {
    return prepareGo(ctx);
  },
};

export default goAnalyzer;
