/**
 * Java analyzer (v2 - proves out the language extension point).
 *
 * File-level import edges. Besides explicit `import`s it reports the file's
 * `package` and top-level types (`FileAnalysis.declares`) and, for coupling that
 * needs no import (same-package and wildcard-imported types), speculative
 * type-reference candidates - see `../jvm/references.ts`. Resolution is shared with
 * Kotlin in `../jvm/resolve.ts`.
 */
import path from "node:path";
import type {
  AnalyzerContext,
  GrammarSpec,
  LanguageAnalyzer,
  QueryMatchData,
  RawImport,
  SourceInput,
  SyntaxFacts,
} from "../../analyzer";
import { grammarCandidates, resolveLanguageDir } from "../../paths";
import { buildJvmImports, fqn, type ExplicitImport } from "../jvm/references";
import { collectReferences, tokenize } from "../jvm/tokenize";
import {
  indexJavaDeclarations,
  javaExternalPackage,
  prepareJava,
  resolveJavaImportPaths,
} from "./resolve";

const LANGUAGE_ID = "java";

const HERE = typeof __dirname === "string" ? __dirname : undefined;
let languageDir: string | undefined;
function dir(): string {
  languageDir ??= resolveLanguageDir(LANGUAGE_ID, HERE);
  return languageDir;
}

const JAVA_GRAMMAR: GrammarSpec = {
  id: "java",
  get candidates() {
    return grammarCandidates("tree-sitter-java.wasm", dir());
  },
};

const DOTTED_NAME = /^[\w$]+(\.[\w$]+)*$/;

/** Everything the query reports about a file. */
function readMatches(matches: QueryMatchData[]): {
  pkg: string;
  imports: ExplicitImport[];
  topTypes: string[];
  localTypes: Set<string>;
} {
  let pkg = "";
  const imports: ExplicitImport[] = [];
  const topTypes: string[] = [];
  const localTypes = new Set<string>();

  for (const match of matches) {
    let name: string | undefined;
    let wildcard = false;
    let declaration: string | undefined;
    for (const capture of match.captures) {
      switch (capture.name) {
        case "name":
          name = capture.text.replace(/\s+/g, "");
          break;
        case "wildcard":
          wildcard = true;
          break;
        case "import":
          declaration = capture.text;
          break;
        case "package": {
          const dotted = capture.text.replace(/\s+/g, "");
          if (DOTTED_NAME.test(dotted)) pkg = dotted;
          break;
        }
        case "top_type":
          topTypes.push(capture.text);
          break;
        case "type":
          localTypes.add(capture.text);
          break;
      }
    }
    // Error-recovered garbage from a syntax error (`import a.b.;`) is not an import.
    if (declaration !== undefined && name && DOTTED_NAME.test(name)) {
      imports.push({
        name,
        wildcard,
        isStatic: /^import\s+static\b/.test(declaration),
      });
    }
  }
  return { pkg, imports, topTypes, localTypes };
}

export const javaAnalyzer: LanguageAnalyzer = {
  id: LANGUAGE_ID,
  extensions: [".java"],

  queryPath() {
    return path.join(dir(), "queries.scm");
  },

  grammarFor() {
    return JAVA_GRAMMAR;
  },

  languageId() {
    return "java";
  },

  analyzeMatches(matches: QueryMatchData[], input: SourceInput): SyntaxFacts {
    const { pkg, imports, topTypes, localTypes } = readMatches(matches);
    const references = collectReferences(tokenize(input.source, { kotlin: false }));
    const declares = [...new Set(topTypes)].map((name) => fqn(pkg, name));
    return {
      imports: buildJvmImports({
        pkg,
        imports,
        localTypes,
        references,
        includeCalls: false,
      }),
      declares,
    };
  },

  collectImports(matches: QueryMatchData[]): RawImport[] {
    return readMatches(matches).imports.map((imp) => ({
      raw: imp.wildcard ? `${imp.name}.*` : imp.name,
      kind: "import" as const,
    }));
  },

  resolveImportPath(raw: string, fromFile: string, ctx: AnalyzerContext) {
    return resolveJavaImportPaths(raw, fromFile, ctx)[0];
  },

  resolveImportPaths(raw: string, fromFile: string, ctx: AnalyzerContext) {
    return resolveJavaImportPaths(raw, fromFile, ctx);
  },

  externalPackageName(raw: string, ctx: AnalyzerContext) {
    return javaExternalPackage(raw, ctx);
  },

  prepare(ctx: AnalyzerContext) {
    return prepareJava(ctx);
  },

  indexDeclarations(ctx: AnalyzerContext) {
    return indexJavaDeclarations(ctx);
  },
};

export default javaAnalyzer;
