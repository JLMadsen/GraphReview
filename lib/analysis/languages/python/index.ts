/**
 * Python analyzer (v1 language set).
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
import { pythonExternalPackage, resolvePythonImport } from "./resolve";

const LANGUAGE_ID = "python";

const HERE = typeof __dirname === "string" ? __dirname : undefined;
let languageDir: string | undefined;
function dir(): string {
  languageDir ??= resolveLanguageDir(LANGUAGE_ID, HERE);
  return languageDir;
}

const PYTHON_GRAMMAR: GrammarSpec = {
  id: "python",
  get candidates() {
    return grammarCandidates("tree-sitter-python.wasm", dir());
  },
};

/** Join a (possibly dot-prefixed) module with an imported name. */
function joinModule(moduleSpec: string, name: string): string {
  return moduleSpec.endsWith(".") ? moduleSpec + name : `${moduleSpec}.${name}`;
}

export const pythonAnalyzer: LanguageAnalyzer = {
  id: LANGUAGE_ID,
  extensions: [".py", ".pyi"],

  queryPath() {
    return path.join(dir(), "queries.scm");
  },

  grammarFor() {
    return PYTHON_GRAMMAR;
  },

  languageId() {
    return "python";
  },

  collectImports(matches: QueryMatchData[]): RawImport[] {
    const imports: RawImport[] = [];
    for (const match of matches) {
      let marker: string | undefined;
      let moduleSpec: string | undefined;
      let name: string | undefined;
      for (const capture of match.captures) {
        if (capture.name === "module") moduleSpec = capture.text;
        else if (capture.name === "name") name = capture.text;
        else if (
          capture.name === "import" ||
          capture.name === "submodule" ||
          capture.name === "call"
        ) {
          marker = capture.name;
        }
      }
      if (moduleSpec === undefined || marker === undefined) continue;

      if (marker === "submodule") {
        if (name === undefined) continue;
        imports.push({ raw: joinModule(moduleSpec, name), kind: "import", speculative: true });
      } else if (marker === "call") {
        imports.push({ raw: moduleSpec, kind: "call" });
      } else {
        imports.push({ raw: moduleSpec, kind: "import" });
      }
    }
    return imports;
  },

  resolveImportPath(raw: string, fromFile: string, ctx: AnalyzerContext) {
    return resolvePythonImport(raw, fromFile, ctx);
  },

  externalPackageName(raw: string) {
    return pythonExternalPackage(raw);
  },
};

export default pythonAnalyzer;
