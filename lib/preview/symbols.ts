// Which declarations in a changed file are worth a before/after preview
// (DESIGN.md §6.9).
//
// Both versions of the file are parsed with the analyzer's own tree-sitter
// grammars and their top-level declarations compared by name: a declaration
// whose text differs is `modified`, one only in head is `added`, one only in
// base is `removed`. A function whose own text didn't change but that uses a
// changed declaration of the same file (a helper, a constant) is included
// too, marked `via` that name — its output can change all the same.
//
// Only what the sandbox can call from outside is runnable: exported
// functions and components in JS/TS, top-level functions in Python. Classes
// and unexported functions are listed as skipped, with why; types are ignored.

import path from "node:path";
import type { Node } from "web-tree-sitter";
import { analyzerForPath, withSyntaxTree } from "@/lib/analysis";
import type { PreviewChange, PreviewRuntime, PreviewSymbol, PreviewSymbolKind } from "./types";

interface Declaration {
  /** The local name. */
  name: string;
  /** How it is reachable from outside: the export name (`default` included), or null when it isn't. */
  exportName: string | null;
  callable: boolean;
  isClass: boolean;
  rendersJsx: boolean;
  text: string;
  line: number;
}

const FUNCTION_VALUE_TYPES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const TYPE_ONLY = new Set(["interface_declaration", "type_alias_declaration", "ambient_declaration"]);

function containsJsx(node: Node): boolean {
  if (node.type.startsWith("jsx_")) return true;
  for (const child of node.namedChildren) if (child && containsJsx(child)) return true;
  return false;
}

/** `memo(() => …)`, `forwardRef(function …)`, `styled(…)`: a call wrapping a function is still callable as a component. */
function wrapsFunction(node: Node): boolean {
  if (node.type !== "call_expression") return false;
  const args = node.childForFieldName("arguments");
  return Boolean(args?.namedChildren.some((a) => a && (FUNCTION_VALUE_TYPES.has(a.type) || wrapsFunction(a))));
}

function jsDeclarations(root: Node): Declaration[] {
  const out = new Map<string, Declaration>();
  const exportAliases = new Map<string, string>();

  const add = (node: Node, exportName: string | null) => {
    if (TYPE_ONLY.has(node.type)) return;
    const base = { text: node.text, line: node.startPosition.row + 1, rendersJsx: containsJsx(node) };
    if (node.type === "function_declaration" || node.type === "generator_function_declaration" || node.type === "function_expression") {
      const name = node.childForFieldName("name")?.text ?? (exportName === "default" ? "default" : null);
      if (name) out.set(name, { ...base, name, exportName: exportName === "default" ? "default" : exportName && name, callable: true, isClass: false });
      return;
    }
    if (node.type === "class_declaration" || node.type === "abstract_class_declaration" || node.type === "class") {
      const name = node.childForFieldName("name")?.text ?? "default";
      out.set(name, { ...base, name, exportName: exportName === "default" ? "default" : exportName && name, callable: false, isClass: true });
      return;
    }
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const declarator of node.namedChildren) {
        if (!declarator || declarator.type !== "variable_declarator") continue;
        const nameNode = declarator.childForFieldName("name");
        if (!nameNode || nameNode.type !== "identifier") continue;
        const value = declarator.childForFieldName("value");
        const callable = Boolean(value && (FUNCTION_VALUE_TYPES.has(value.type) || wrapsFunction(value)));
        out.set(nameNode.text, {
          text: node.namedChildren.length > 1 ? declarator.text : node.text,
          line: declarator.startPosition.row + 1,
          rendersJsx: containsJsx(declarator),
          name: nameNode.text,
          exportName: exportName ? nameNode.text : null,
          callable,
          isClass: value?.type === "class",
        });
      }
      return;
    }
    if (node.type === "enum_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (name) out.set(name, { ...base, name, exportName: exportName && name, callable: false, isClass: false });
    }
  };

  for (const node of root.namedChildren) {
    if (!node) continue;
    if (node.type !== "export_statement") {
      add(node, null);
      continue;
    }
    const isDefault = node.children.some((c) => c?.type === "default");
    const declaration = node.childForFieldName("declaration");
    const value = node.childForFieldName("value");
    if (declaration) {
      add(declaration, isDefault ? "default" : "named");
    } else if (value) {
      if (value.type === "identifier") exportAliases.set(value.text, "default");
      else if (FUNCTION_VALUE_TYPES.has(value.type) || value.type === "class" || wrapsFunction(value)) {
        const callable = !(value.type === "class");
        out.set("default", {
          name: "default",
          exportName: "default",
          callable,
          isClass: !callable,
          rendersJsx: containsJsx(value),
          text: node.text,
          line: node.startPosition.row + 1,
        });
      }
    } else {
      // export { a, b as c } — re-exports with a `source` are someone else's code.
      if (node.childForFieldName("source")) continue;
      for (const clause of node.namedChildren) {
        if (!clause || clause.type !== "export_clause") continue;
        for (const spec of clause.namedChildren) {
          if (!spec || spec.type !== "export_specifier") continue;
          const local = spec.childForFieldName("name")?.text;
          const alias = spec.childForFieldName("alias")?.text;
          if (local) exportAliases.set(local, alias ?? local);
        }
      }
    }
  }

  for (const [local, exported] of exportAliases) {
    const decl = out.get(local);
    if (decl && !decl.exportName) decl.exportName = exported;
  }
  // `exportName` is "named" only transiently above (add() maps it to the name).
  return [...out.values()];
}

function pythonDeclarations(root: Node): Declaration[] {
  const out: Declaration[] = [];
  for (const top of root.namedChildren) {
    if (!top) continue;
    const node = top.type === "decorated_definition" ? top.childForFieldName("definition") : top;
    if (!node) continue;
    const name = node.childForFieldName("name")?.text;
    const line = top.startPosition.row + 1;
    if (node.type === "function_definition" && name) {
      out.push({ name, exportName: name, callable: true, isClass: false, rendersJsx: false, text: top.text, line });
    } else if (node.type === "class_definition" && name) {
      out.push({ name, exportName: name, callable: false, isClass: true, rendersJsx: false, text: top.text, line });
    } else if (node.type === "expression_statement") {
      const assignment = node.namedChildren[0];
      const left = assignment?.type === "assignment" ? assignment.childForFieldName("left") : null;
      if (left?.type === "identifier") {
        out.push({ name: left.text, exportName: left.text, callable: false, isClass: false, rendersJsx: false, text: top.text, line });
      }
    }
  }
  return out;
}

async function declarationsOf(filePath: string, source: string | null, runtime: PreviewRuntime): Promise<Map<string, Declaration>> {
  const map = new Map<string, Declaration>();
  if (source === null) return map;
  const analyzer = analyzerForPath(filePath);
  if (!analyzer?.grammarFor) return map;
  const grammar = analyzer.grammarFor(path.posix.extname(filePath).toLowerCase());
  const decls = await withSyntaxTree(grammar, source, (root) =>
    runtime === "python" ? pythonDeclarations(root) : jsDeclarations(root)
  );
  for (const decl of decls ?? []) map.set(decl.name, decl);
  return map;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function kindOf(decl: Declaration, filePath: string): PreviewSymbolKind {
  const jsxFile = /\.(tsx|jsx)$/i.test(filePath) || decl.rendersJsx;
  const pascal = /^[A-Z]/.test(decl.exportName === "default" ? decl.name : (decl.exportName ?? decl.name));
  return jsxFile && decl.rendersJsx && (pascal || decl.name === "default") ? "component" : "function";
}

export interface DetectedSymbols {
  runnable: PreviewSymbol[];
  skipped: Array<{ name: string; reason: string }>;
  /** Each runnable symbol's declaration text on either side, keyed by its `name`. */
  sources: Record<string, { before?: string; after?: string }>;
}

export async function detectChangedSymbols(
  filePath: string,
  runtime: PreviewRuntime,
  before: string | null,
  after: string | null
): Promise<DetectedSymbols> {
  const [base, head] = await Promise.all([
    declarationsOf(filePath, before, runtime),
    declarationsOf(filePath, after, runtime),
  ]);

  const changes = new Map<string, PreviewChange>();
  for (const [name, decl] of head) {
    const old = base.get(name);
    if (!old) changes.set(name, "added");
    else if (normalize(old.text) !== normalize(decl.text)) changes.set(name, "modified");
  }
  for (const name of base.keys()) if (!head.has(name)) changes.set(name, "removed");

  const runnable: PreviewSymbol[] = [];
  const skipped: DetectedSymbols["skipped"] = [];
  const sources: DetectedSymbols["sources"] = {};
  const changedNames = [...changes.keys()];

  const consider = (decl: Declaration, change: PreviewChange, via?: string) => {
    const label = decl.exportName && decl.exportName !== decl.name ? `${decl.name} (as ${decl.exportName})` : decl.name;
    if (decl.isClass) {
      skipped.push({ name: label, reason: "a class — only functions and components are run" });
      return;
    }
    if (!decl.callable) return; // constants: their effect shows through the functions that use them
    if (!decl.exportName) {
      skipped.push({ name: label, reason: "not exported, so it can't be called from outside the file" });
      return;
    }
    // A named default export keeps its own name; the harness finds it through `default`.
    const name = decl.exportName === "default" && decl.name !== "default" ? decl.name : decl.exportName;
    sources[name] = { before: base.get(decl.name)?.text, after: head.get(decl.name)?.text };
    runnable.push({ name, kind: kindOf(decl, filePath), change, line: decl.line, ...(via ? { via } : {}) });
  };

  for (const [name, change] of changes) {
    const decl = change === "removed" ? base.get(name)! : head.get(name)!;
    consider(decl, change);
  }
  // Unchanged functions that use something that changed.
  for (const [name, decl] of head) {
    if (changes.has(name) || !decl.callable || !decl.exportName || !base.has(name)) continue;
    const via = changedNames.find((changed) => changed !== name && new RegExp(`\\b${changed.replace(/\$/g, "\\$")}\\b`).test(decl.text));
    if (via) consider(decl, "modified", via);
  }

  runnable.sort((a, b) => a.line - b.line);
  return { runnable, skipped, sources };
}
