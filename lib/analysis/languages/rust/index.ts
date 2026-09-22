/**
 * Rust analyzer (v2 - proves out the language extension point).
 *
 * File-level edges only. Every `mod foo;`, `extern crate` and each leaf of a
 * (brace/glob) `use` tree becomes one import:
 *
 *   raw                                    meaning
 *   `mod foo`                              out-of-line module declaration
 *   `#[path = "x.rs"] mod foo`             the same, with an explicit file
 *   `extern crate foo`                     extern crate declaration
 *   `crate::a::b::C`, `a::b::*`, `super::x` a flattened `use` path
 *
 * Module-path resolution rules live in `resolve.ts`.
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
import {
  expandUseTree,
  prepareRust,
  resolveRustImportPaths,
  rustExternalPackage,
} from "./resolve";

const LANGUAGE_ID = "rust";

const HERE = typeof __dirname === "string" ? __dirname : undefined;
let languageDir: string | undefined;
function dir(): string {
  languageDir ??= resolveLanguageDir(LANGUAGE_ID, HERE);
  return languageDir;
}

const RUST_GRAMMAR: GrammarSpec = {
  id: "rust",
  get candidates() {
    return grammarCandidates("tree-sitter-rust.wasm", dir());
  },
};

/**
 * Inside an inline `mod x { ... }` block `super::` names the *enclosing file's*
 * module, which is `self::` as far as file resolution goes; `self::` there names
 * the inline module itself and is not a file. A bare `use super::*;` (the
 * ubiquitous `mod tests` idiom) is therefore dropped.
 */
function rebaseInline(flatPath: string): string | undefined {
  const segments = flatPath.split("::");
  if (segments[0] === "self") return undefined;
  if (segments[0] !== "super") return flatPath;
  segments[0] = "self";
  const rest = segments.slice(1).filter((s) => s !== "*");
  return rest.length === 0 ? undefined : segments.join("::");
}

export const rustAnalyzer: LanguageAnalyzer = {
  id: LANGUAGE_ID,
  extensions: [".rs"],

  queryPath() {
    return path.join(dir(), "queries.scm");
  },

  grammarFor() {
    return RUST_GRAMMAR;
  },

  languageId() {
    return "rust";
  },

  collectImports(matches: QueryMatchData[]): RawImport[] {
    const imports: RawImport[] = [];
    const cap = (match: QueryMatchData, name: string) =>
      match.captures.find((c) => c.name === name);

    // `#[path]` modules also satisfy the plain `mod` pattern; keep only the former.
    const pathedRows = new Set<number>();
    const inlineUses = new Set<string>();
    for (const match of matches) {
      const pathmod = cap(match, "pathmod");
      if (pathmod) pathedRows.add(pathmod.startRow);
      const inline = cap(match, "inline_use");
      if (inline) inlineUses.add(`${inline.startRow}:${inline.text}`);
    }

    for (const match of matches) {
      const name = cap(match, "name")?.text;
      const mod = cap(match, "mod");
      const pathmod = cap(match, "pathmod");
      const modPath = cap(match, "path")?.text;
      const extern = cap(match, "extern");
      const use = cap(match, "use");
      const inline = cap(match, "inline_use");

      if (pathmod && name && modPath !== undefined) {
        imports.push({ raw: `#[path = "${modPath}"] mod ${name}`, kind: "import" });
      } else if (mod && name) {
        if (!pathedRows.has(mod.startRow)) imports.push({ raw: `mod ${name}`, kind: "import" });
      } else if (extern && name) {
        imports.push({ raw: `extern crate ${name}`, kind: "import" });
      } else if (inline) {
        for (const flat of expandUseTree(inline.text)) {
          const rebased = rebaseInline(flat);
          if (rebased) imports.push({ raw: rebased, kind: "import" });
        }
      } else if (use) {
        if (inlineUses.has(`${use.startRow}:${use.text}`)) continue;
        for (const flat of expandUseTree(use.text)) imports.push({ raw: flat, kind: "import" });
      }
    }
    return imports;
  },

  resolveImportPath(raw: string, fromFile: string, ctx: AnalyzerContext) {
    return resolveRustImportPaths(raw, fromFile, ctx)[0];
  },

  resolveImportPaths(raw: string, fromFile: string, ctx: AnalyzerContext) {
    return resolveRustImportPaths(raw, fromFile, ctx);
  },

  externalPackageName(raw: string, ctx: AnalyzerContext) {
    return rustExternalPackage(raw, ctx);
  },

  prepare(ctx: AnalyzerContext) {
    return prepareRust(ctx);
  },
};

export default rustAnalyzer;
