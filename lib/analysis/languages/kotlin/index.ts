/**
 * Kotlin analyzer (`.kt`, `.kts`) - a grammar-free, lexical analyzer.
 *
 * Why no tree-sitter grammar: the only prebuilt Kotlin WASM that loads under
 * `web-tree-sitter` 0.27 (`@tree-sitter-grammars/tree-sitter-kotlin` 1.1.0, ABI 14,
 * 3.4 MB) mis-parses very common formatting - a class body whose last member is on
 * the same line as the closing brace (`class A { fun a() = 1 }`, `sealed class S {
 * object C : S() }`) yields ERROR nodes, and in some shapes the declarations after
 * it vanish from the tree. `tree-sitter-wasms@0.1.x` does not load at all and
 * `@vscode/tree-sitter-wasm` has no Kotlin. Since everything this analyzer needs
 * (package, imports, top-level declarations, referenced names) is recoverable from
 * a comment/string-aware token stream, `lexical.ts` reads the text directly: it is
 * deterministic, immune to formatting and syntax errors, and adds no binary asset.
 *
 * Shares its resolver with Java (`../jvm/resolve.ts`), so Kotlin <-> Java imports
 * resolve in both directions.
 */
import type {
  AnalyzerContext,
  LanguageAnalyzer,
  SourceInput,
  SyntaxFacts,
} from "../../analyzer";
import { indexJvmDeclarations, jvmExternalPackage, prepareJvm, resolveJvmImportPaths } from "../jvm/resolve";
import { analyzeKotlinSource } from "./lexical";

export const kotlinAnalyzer: LanguageAnalyzer = {
  id: "kotlin",
  extensions: [".kt", ".kts"],

  languageId() {
    return "kotlin";
  },

  analyzeSource(input: SourceInput): SyntaxFacts {
    return analyzeKotlinSource(input.file, input.source);
  },

  resolveImportPath(raw: string, fromFile: string, ctx: AnalyzerContext) {
    return resolveJvmImportPaths(raw, fromFile, ctx)[0];
  },

  resolveImportPaths(raw: string, fromFile: string, ctx: AnalyzerContext) {
    return resolveJvmImportPaths(raw, fromFile, ctx);
  },

  externalPackageName(raw: string, ctx: AnalyzerContext) {
    return jvmExternalPackage(raw, ctx);
  },

  prepare(ctx: AnalyzerContext) {
    return prepareJvm(ctx);
  },

  indexDeclarations(ctx: AnalyzerContext) {
    return indexJvmDeclarations(ctx);
  },
};

export default kotlinAnalyzer;
