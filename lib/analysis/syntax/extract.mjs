// Symbol facts from a tree-sitter syntax tree: what a file declares, which
// names it imports and exports, where it refers to names, and what it calls.
//
// Plain JavaScript on purpose: the same code runs inside the parse worker
// thread (./parse-worker.mjs, loaded from disk, never bundled) and, as a
// fallback, in the server process itself (./parse-pool.ts). Everything it
// returns is plain data — no syntax nodes survive the call.
//
// Lines are 1-based. Declarations are the module-level ones plus the methods
// of module-level classes; anything nested deeper belongs to the enclosing
// declaration (a call inside a nested arrow function is a call of the
// function that contains it).

/**
 * @typedef {"function" | "class" | "method" | "interface" | "type" | "enum" | "const" | "variable" | "module"} DeclKind
 * @typedef {{ name: string, kind: DeclKind, parent?: string, exported: string | null, startLine: number, endLine: number, signature: string, textHash?: string }} DeclFact
 * @typedef {{ imported: string, local: string, typeOnly?: boolean }} BindingFact
 * @typedef {{ source: string, bindings: BindingFact[], typeOnly: boolean, startLine: number, endLine: number, kind: "import" | "require" | "call", star?: boolean, isStatic?: boolean }} ImportFact
 * @typedef {{ local?: string, exported: string, from?: string, imported?: string, star?: boolean, line: number }} ExportFact
 * @typedef {{ callee: string | null, object?: string, line: number, inDecl: number, kind: "call" | "new" }} CallFact
 * @typedef {{ decls: DeclFact[], imports: ImportFact[], exports: ExportFact[], refs: Record<string, number[]>, members: Record<string, number[]>, calls: CallFact[], opaqueExports?: boolean, pkg?: string, all?: string[], routes?: object, db?: object }} SymbolFacts
 */

import { hashText } from "./hash.mjs";
import { extractJavaRoutes, extractJsRoutes, extractPythonRoutes } from "./routes.mjs";
import { extractJsDb, extractPythonDb } from "./db.mjs";

export { hashText };

/** Longest signature text kept (whitespace collapsed). */
const MAX_SIGNATURE = 600;
/** Longest "shape" kept for a type or interface. */
const MAX_SHAPE = 2000;
/** Reference occurrences recorded per file — a generated file can have millions. */
const MAX_REFS = 40000;

function collapse(text, max) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function line(node) {
  return node.startPosition.row + 1;
}

function endLine(node) {
  return node.endPosition.row + 1;
}

/** `text` up to where `body` starts, when `body` is the node's tail (a function's block). */
function headOf(node, body) {
  const text = node.text;
  if (!body) return text;
  const tail = body.text;
  return text.endsWith(tail) ? text.slice(0, text.length - tail.length) : text.split("\n")[0];
}

function namedChildren(node) {
  const out = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

function hasChildType(node, type) {
  for (let i = 0; i < node.childCount; i++) if (node.child(i)?.type === type) return true;
  return false;
}

function stringValue(node) {
  if (!node) return undefined;
  if (node.type === "string_fragment" || node.type === "string_content") return node.text;
  for (const child of namedChildren(node)) {
    if (child.type === "string_fragment" || child.type === "string_content") return child.text;
  }
  const raw = node.text;
  const quoted = /^(['"`])(.*)\1$/s.exec(raw);
  return quoted ? quoted[2] : undefined;
}

/** Collects references (identifier occurrences per name) and calls during one walk. */
class Collector {
  constructor(declIndexById, refTypes) {
    this.declIndexById = declIndexById;
    this.refTypes = refTypes;
    /** @type {Record<string, number[]>} */
    this.refs = Object.create(null);
    /** @type {Record<string, number[]>} */
    this.members = Object.create(null);
    /** @type {CallFact[]} */
    this.calls = [];
    this.refCount = 0;
  }

  ref(name, row) {
    if (this.refCount >= MAX_REFS) return;
    const lines = (this.refs[name] ??= []);
    const ln = row + 1;
    if (lines[lines.length - 1] !== ln) {
      lines.push(ln);
      this.refCount++;
    }
  }

  member(object, property, row) {
    if (this.refCount >= MAX_REFS) return;
    const key = `${object}.${property}`;
    const lines = (this.members[key] ??= []);
    const ln = row + 1;
    if (lines[lines.length - 1] !== ln) {
      lines.push(ln);
      this.refCount++;
    }
  }
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript / JSX / TSX
// ---------------------------------------------------------------------------

const JS_FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const JS_REF_TYPES = new Set(["identifier", "type_identifier", "shorthand_property_identifier"]);

function jsFunctionValue(value) {
  if (!value) return null;
  if (JS_FUNCTION_VALUES.has(value.type)) return value;
  // memo(() => …), forwardRef(function …): the wrapped function is the body.
  if (value.type === "call_expression") {
    const args = value.childForFieldName("arguments");
    for (const arg of args ? namedChildren(args) : []) {
      const inner = jsFunctionValue(arg);
      if (inner) return inner;
    }
  }
  return null;
}

function extractJs(root) {
  /** @type {DeclFact[]} */
  const decls = [];
  /** @type {ImportFact[]} */
  const imports = [];
  /** @type {ExportFact[]} */
  const exports = [];
  const declIndexById = new Map();
  let opaqueExports = false;

  const addDecl = (node, fact) => {
    declIndexById.set(node.id, decls.length);
    decls.push({ ...fact, textHash: hashText(node.text) });
  };

  /** A module-level declaration node; `outer` is the export statement wrapping it (for its range). */
  const declare = (node, exported, outer) => {
    const start = line(outer ?? node);
    const end = endLine(outer ?? node);
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration":
      case "function_signature": {
        const name = node.childForFieldName("name")?.text ?? (exported === "default" ? "default" : null);
        if (!name) return;
        const body = node.childForFieldName("body");
        addDecl(node, { name, kind: "function", exported: exported === "default" ? "default" : exported ? name : null, startLine: start, endLine: end, signature: collapse(headOf(node, body), MAX_SIGNATURE) });
        return;
      }
      case "class_declaration":
      case "abstract_class_declaration":
      case "class": {
        const name = node.childForFieldName("name")?.text ?? (exported === "default" ? "default" : null);
        if (!name) return;
        const body = node.childForFieldName("body");
        addDecl(node, { name, kind: "class", exported: exported === "default" ? "default" : exported ? name : null, startLine: start, endLine: end, signature: collapse(headOf(node, body), MAX_SIGNATURE) });
        for (const member of body ? namedChildren(body) : []) {
          if (member.type !== "method_definition" && member.type !== "method_signature" && member.type !== "abstract_method_signature") continue;
          const methodName = member.childForFieldName("name")?.text;
          if (!methodName) continue;
          const methodBody = member.childForFieldName("body");
          addDecl(member, { name: methodName, kind: "method", parent: name, exported: null, startLine: line(member), endLine: endLine(member), signature: collapse(headOf(member, methodBody), MAX_SIGNATURE) });
        }
        return;
      }
      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (!name) return;
        const kind = node.type === "interface_declaration" ? "interface" : node.type === "enum_declaration" ? "enum" : "type";
        addDecl(node, { name, kind, exported: exported ? name : null, startLine: start, endLine: end, signature: collapse(node.text, MAX_SHAPE) });
        return;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        const isConst = node.text.startsWith("const");
        const declarators = namedChildren(node).filter((c) => c.type === "variable_declarator");
        for (const declarator of declarators) {
          const nameNode = declarator.childForFieldName("name");
          const value = declarator.childForFieldName("value");
          if (!nameNode) continue;
          if (nameNode.type !== "identifier") {
            // const { a, b } = require("x") is an import, not a declaration.
            continue;
          }
          if (value?.type === "call_expression" && value.childForFieldName("function")?.text === "require") continue;
          const fn = jsFunctionValue(value);
          const one = declarators.length === 1;
          const startD = one ? start : line(declarator);
          const endD = one ? end : endLine(declarator);
          if (fn) {
            const body = fn.childForFieldName("body");
            addDecl(declarator, { name: nameNode.text, kind: "function", exported: exported ? nameNode.text : null, startLine: startD, endLine: endD, signature: collapse(headOf(declarator, body), MAX_SIGNATURE) });
          } else {
            const isClass = value?.type === "class";
            addDecl(declarator, { name: nameNode.text, kind: isClass ? "class" : isConst ? "const" : "variable", exported: exported ? nameNode.text : null, startLine: startD, endLine: endD, signature: collapse(declarator.text, MAX_SIGNATURE) });
          }
        }
        return;
      }
      case "ambient_declaration": {
        for (const child of namedChildren(node)) declare(child, exported, outer ?? node);
        return;
      }
      case "internal_module":
      case "module": {
        const name = node.childForFieldName("name")?.text;
        if (name) addDecl(node, { name: name.replace(/^['"]|['"]$/g, ""), kind: "module", exported: exported ? name : null, startLine: start, endLine: end, signature: collapse(node.text.split("{")[0], MAX_SIGNATURE) });
        return;
      }
      default:
    }
  };

  const requireImport = (declarator, value, statement) => {
    const source = stringValue(value.childForFieldName("arguments")?.namedChild(0));
    if (source === undefined) return false;
    const nameNode = declarator.childForFieldName("name");
    const bindings = [];
    if (nameNode?.type === "identifier") bindings.push({ imported: "*", local: nameNode.text });
    else if (nameNode?.type === "object_pattern") {
      for (const prop of namedChildren(nameNode)) {
        if (prop.type === "shorthand_property_identifier_pattern") bindings.push({ imported: prop.text, local: prop.text });
        else if (prop.type === "pair_pattern") {
          const key = prop.childForFieldName("key")?.text;
          const val = prop.childForFieldName("value");
          if (key && val?.type === "identifier") bindings.push({ imported: key, local: val.text });
        }
      }
    }
    imports.push({ source, bindings, typeOnly: false, startLine: line(statement), endLine: endLine(statement), kind: "require" });
    return true;
  };

  for (const node of namedChildren(root)) {
    if (node.type === "import_statement") {
      const source = stringValue(node.childForFieldName("source"));
      if (source === undefined) continue;
      const typeOnly = hasChildType(node, "type");
      const bindings = [];
      const clause = namedChildren(node).find((c) => c.type === "import_clause");
      for (const part of clause ? namedChildren(clause) : []) {
        if (part.type === "identifier") bindings.push({ imported: "default", local: part.text });
        else if (part.type === "namespace_import") {
          const local = namedChildren(part).find((c) => c.type === "identifier")?.text;
          if (local) bindings.push({ imported: "*", local });
        } else if (part.type === "named_imports") {
          for (const spec of namedChildren(part)) {
            if (spec.type !== "import_specifier") continue;
            const imported = spec.childForFieldName("name")?.text;
            const local = spec.childForFieldName("alias")?.text ?? imported;
            if (imported && local) bindings.push({ imported, local, ...(hasChildType(spec, "type") ? { typeOnly: true } : {}) });
          }
        }
      }
      const allTypes = typeOnly || (bindings.length > 0 && bindings.every((b) => b.typeOnly));
      imports.push({ source, bindings, typeOnly: allTypes, startLine: line(node), endLine: endLine(node), kind: "import" });
      continue;
    }

    if (node.type === "export_statement") {
      const source = stringValue(node.childForFieldName("source"));
      const isDefault = hasChildType(node, "default");
      const declaration = node.childForFieldName("declaration");
      const value = node.childForFieldName("value");
      if (declaration) {
        declare(declaration, isDefault ? "default" : "named", node);
        continue;
      }
      if (isDefault && value) {
        if (value.type === "identifier") exports.push({ local: value.text, exported: "default", line: line(node) });
        else {
          const fn = jsFunctionValue(value);
          const body = fn?.childForFieldName("body");
          addDecl(node, { name: "default", kind: fn ? "function" : value.type === "class" ? "class" : "const", exported: "default", startLine: line(node), endLine: endLine(node), signature: collapse(fn ? headOf(node, body) : node.text, MAX_SIGNATURE) });
        }
        continue;
      }
      const clause = namedChildren(node).find((c) => c.type === "export_clause");
      const namespace = namedChildren(node).find((c) => c.type === "namespace_export");
      if (source !== undefined) {
        const typeOnly = hasChildType(node, "type");
        if (namespace) {
          const exported = namedChildren(namespace).find((c) => c.type === "identifier" || c.type === "string")?.text;
          if (exported) exports.push({ exported, from: source, imported: "*", line: line(node) });
        } else if (clause) {
          for (const spec of namedChildren(clause)) {
            if (spec.type !== "export_specifier") continue;
            const imported = spec.childForFieldName("name")?.text;
            const exported = spec.childForFieldName("alias")?.text ?? imported;
            if (imported && exported) exports.push({ exported, from: source, imported, line: line(node) });
          }
        } else {
          exports.push({ exported: "*", from: source, star: true, line: line(node) });
        }
        // A re-export is also a dependency of this file.
        imports.push({ source, bindings: [], typeOnly, startLine: line(node), endLine: endLine(node), kind: "import" });
        continue;
      }
      if (clause) {
        for (const spec of namedChildren(clause)) {
          if (spec.type !== "export_specifier") continue;
          const local = spec.childForFieldName("name")?.text;
          const exported = spec.childForFieldName("alias")?.text ?? local;
          if (local && exported) exports.push({ local, exported, line: line(node) });
        }
        continue;
      }
      // `export = x` (TypeScript CommonJS interop): what it exports isn't a named list.
      opaqueExports = true;
      continue;
    }

    if ((node.type === "lexical_declaration" || node.type === "variable_declaration")) {
      let handled = false;
      for (const declarator of namedChildren(node)) {
        if (declarator.type !== "variable_declarator") continue;
        const value = declarator.childForFieldName("value");
        if (value?.type === "call_expression" && value.childForFieldName("function")?.text === "require") {
          handled = requireImport(declarator, value, node) || handled;
        }
      }
      declare(node, null, null);
      if (handled) continue;
      continue;
    }

    if (node.type === "expression_statement") {
      // module.exports = … / exports.x = …: CommonJS — its export list isn't named statically.
      const text = node.text;
      if (/^(module\.)?exports(\.|\s*=|\[)/.test(text)) opaqueExports = true;
      continue;
    }

    declare(node, null, null);
  }

  const collector = new Collector(declIndexById, JS_REF_TYPES);
  walkJs(root, -1, collector);
  const routes = extractJsRoutes(root, declIndexById);
  const db = extractJsDb(root);
  return { decls, imports, exports, refs: collector.refs, members: collector.members, calls: collector.calls, ...(opaqueExports ? { opaqueExports } : {}), ...(routes ? { routes } : {}), ...(db ? { db } : {}) };
}

function jsCallee(fn) {
  if (!fn) return { callee: null };
  if (fn.type === "identifier") return { callee: fn.text };
  if (fn.type === "member_expression") {
    const object = fn.childForFieldName("object");
    const property = fn.childForFieldName("property");
    if (property && object && (object.type === "identifier" || object.type === "this")) {
      return { callee: property.text, object: object.type === "this" ? "this" : object.text };
    }
    return { callee: property?.text ?? null, object: "?" };
  }
  return { callee: null };
}

function walkJs(node, inDecl, collector) {
  const own = collector.declIndexById.get(node.id);
  const current = own === undefined ? inDecl : own;
  const type = node.type;
  if (collector.refTypes.has(type)) {
    collector.ref(node.text, node.startPosition.row);
  } else if (type === "member_expression") {
    const object = node.childForFieldName("object");
    const property = node.childForFieldName("property");
    if (object?.type === "identifier" && property) collector.member(object.text, property.text, node.startPosition.row);
  } else if (type === "call_expression") {
    const { callee, object } = jsCallee(node.childForFieldName("function"));
    if (callee !== "require" || object) {
      collector.calls.push({ callee, ...(object ? { object } : {}), line: node.startPosition.row + 1, inDecl: current, kind: "call" });
    }
  } else if (type === "new_expression") {
    const ctor = node.childForFieldName("constructor");
    if (ctor?.type === "identifier") collector.calls.push({ callee: ctor.text, line: node.startPosition.row + 1, inDecl: current, kind: "new" });
    else if (ctor?.type === "member_expression") {
      const { callee, object } = jsCallee(ctor);
      collector.calls.push({ callee, ...(object ? { object } : {}), line: node.startPosition.row + 1, inDecl: current, kind: "new" });
    }
  } else if (type === "jsx_opening_element" || type === "jsx_self_closing_element") {
    const name = node.childForFieldName("name");
    if (name?.type === "identifier" && /^[A-Z]/.test(name.text)) {
      collector.calls.push({ callee: name.text, line: node.startPosition.row + 1, inDecl: current, kind: "call" });
    } else if (name?.type === "member_expression" || name?.type === "nested_identifier") {
      const parts = name.text.split(".");
      if (parts.length === 2) collector.calls.push({ callee: parts[1], object: parts[0], line: node.startPosition.row + 1, inDecl: current, kind: "call" });
    }
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkJs(child, current, collector);
  }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function extractPython(root) {
  /** @type {DeclFact[]} */
  const decls = [];
  /** @type {ImportFact[]} */
  const imports = [];
  const declIndexById = new Map();
  let all;

  const addDecl = (node, fact) => {
    declIndexById.set(node.id, decls.length);
    decls.push({ ...fact, textHash: hashText(node.text) });
  };

  for (const top of namedChildren(root)) {
    const node = top.type === "decorated_definition" ? top.childForFieldName("definition") : top;
    if (!node) continue;
    if (node.type === "function_definition") {
      const name = node.childForFieldName("name")?.text;
      if (!name) continue;
      addDecl(node, { name, kind: "function", exported: name.startsWith("_") ? null : name, startLine: line(top), endLine: endLine(top), signature: collapse(headOf(node, node.childForFieldName("body")), MAX_SIGNATURE) });
      continue;
    }
    if (node.type === "class_definition") {
      const name = node.childForFieldName("name")?.text;
      if (!name) continue;
      const body = node.childForFieldName("body");
      addDecl(node, { name, kind: "class", exported: name.startsWith("_") ? null : name, startLine: line(top), endLine: endLine(top), signature: collapse(headOf(node, body), MAX_SIGNATURE) });
      for (const memberTop of body ? namedChildren(body) : []) {
        const member = memberTop.type === "decorated_definition" ? memberTop.childForFieldName("definition") : memberTop;
        if (member?.type !== "function_definition") continue;
        const methodName = member.childForFieldName("name")?.text;
        if (!methodName) continue;
        addDecl(member, { name: methodName, kind: "method", parent: name, exported: null, startLine: line(memberTop), endLine: endLine(memberTop), signature: collapse(headOf(member, member.childForFieldName("body")), MAX_SIGNATURE) });
      }
      continue;
    }
    if (node.type === "import_statement") {
      for (const part of namedChildren(node)) {
        if (part.type === "dotted_name") {
          const source = part.text;
          // `import a.b` binds `a`; only `import a` / `import a.b as x` give a usable namespace.
          const local = source.split(".")[0];
          imports.push({ source: source.includes(".") ? local : source, bindings: [{ imported: "*", local }], typeOnly: false, startLine: line(node), endLine: endLine(node), kind: "import" });
        } else if (part.type === "aliased_import") {
          const source = part.childForFieldName("name")?.text;
          const local = part.childForFieldName("alias")?.text;
          if (source && local) imports.push({ source, bindings: [{ imported: "*", local }], typeOnly: false, startLine: line(node), endLine: endLine(node), kind: "import" });
        }
      }
      continue;
    }
    if (node.type === "import_from_statement") {
      const source = node.childForFieldName("module_name")?.text;
      if (!source) continue;
      const bindings = [];
      let star = false;
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        if (node.fieldNameForChild(i) !== "name") {
          if (child.type === "wildcard_import") star = true;
          continue;
        }
        if (child.type === "dotted_name") bindings.push({ imported: child.text, local: child.text });
        else if (child.type === "aliased_import") {
          const imported = child.childForFieldName("name")?.text;
          const local = child.childForFieldName("alias")?.text;
          if (imported && local) bindings.push({ imported, local });
        }
      }
      imports.push({ source, bindings, typeOnly: false, startLine: line(node), endLine: endLine(node), kind: "import", ...(star ? { star: true } : {}) });
      continue;
    }
    if (node.type === "expression_statement") {
      const assignment = node.namedChild(0);
      if (assignment?.type !== "assignment") continue;
      const left = assignment.childForFieldName("left");
      if (left?.type !== "identifier") continue;
      if (left.text === "__all__") {
        const right = assignment.childForFieldName("right");
        all = right ? namedChildren(right).map((c) => stringValue(c)).filter((v) => typeof v === "string") : [];
        continue;
      }
      addDecl(assignment, { name: left.text, kind: /^[A-Z][A-Z0-9_]*$/.test(left.text) ? "const" : "variable", exported: left.text.startsWith("_") ? null : left.text, startLine: line(top), endLine: endLine(top), signature: collapse(top.text, MAX_SIGNATURE) });
    }
  }

  const collector = new Collector(declIndexById, new Set(["identifier"]));
  walkPython(root, -1, collector);
  const routes = extractPythonRoutes(root);
  const db = extractPythonDb(root);
  return { decls, imports, exports: [], refs: collector.refs, members: collector.members, calls: collector.calls, ...(all ? { all } : {}), ...(routes ? { routes } : {}), ...(db ? { db } : {}) };
}

function walkPython(node, inDecl, collector) {
  const own = collector.declIndexById.get(node.id);
  const current = own === undefined ? inDecl : own;
  const type = node.type;
  if (type === "identifier") {
    collector.ref(node.text, node.startPosition.row);
  } else if (type === "attribute") {
    const object = node.childForFieldName("object");
    const attribute = node.childForFieldName("attribute");
    if (object?.type === "identifier" && attribute) collector.member(object.text, attribute.text, node.startPosition.row);
  } else if (type === "call") {
    const fn = node.childForFieldName("function");
    let callee = null;
    let object;
    if (fn?.type === "identifier") callee = fn.text;
    else if (fn?.type === "attribute") {
      const obj = fn.childForFieldName("object");
      callee = fn.childForFieldName("attribute")?.text ?? null;
      object = obj?.type === "identifier" ? (obj.text === "self" || obj.text === "cls" ? "this" : obj.text) : "?";
    }
    collector.calls.push({ callee, ...(object ? { object } : {}), line: node.startPosition.row + 1, inDecl: current, kind: "call" });
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkPython(child, current, collector);
  }
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const JAVA_TYPES = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"]);

function extractJava(root) {
  /** @type {DeclFact[]} */
  const decls = [];
  /** @type {ImportFact[]} */
  const imports = [];
  const declIndexById = new Map();
  let pkg = "";

  const addDecl = (node, fact) => {
    declIndexById.set(node.id, decls.length);
    decls.push({ ...fact, textHash: hashText(node.text) });
  };

  const declareType = (node, outerName) => {
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    const qualified = outerName ? `${outerName}.${name}` : name;
    const body = node.childForFieldName("body");
    const kind = node.type === "interface_declaration" || node.type === "annotation_type_declaration" ? "interface" : node.type === "enum_declaration" ? "enum" : "class";
    const isPrivate = /\bprivate\b/.test(namedChildren(node).find((c) => c.type === "modifiers")?.text ?? "");
    addDecl(node, { name: qualified, kind, exported: isPrivate ? null : qualified, startLine: line(node), endLine: endLine(node), signature: collapse(headOf(node, body), MAX_SIGNATURE) });
    const members = [];
    for (const member of body ? namedChildren(body) : []) {
      if (member.type === "enum_body_declarations") members.push(...namedChildren(member));
      else members.push(member);
    }
    for (const member of members) {
      if (member.type === "method_declaration" || member.type === "constructor_declaration" || member.type === "compact_constructor_declaration") {
        const methodName = member.type === "method_declaration" ? member.childForFieldName("name")?.text : "<init>";
        if (!methodName) continue;
        const modifiers = namedChildren(member).find((c) => c.type === "modifiers")?.text ?? "";
        addDecl(member, { name: methodName, kind: "method", parent: qualified, exported: /\bprivate\b/.test(modifiers) ? null : methodName, startLine: line(member), endLine: endLine(member), signature: collapse(headOf(member, member.childForFieldName("body")), MAX_SIGNATURE) });
      } else if (JAVA_TYPES.has(member.type)) {
        declareType(member, qualified);
      }
    }
  };

  for (const node of namedChildren(root)) {
    if (node.type === "package_declaration") {
      pkg = namedChildren(node).find((c) => c.type === "scoped_identifier" || c.type === "identifier")?.text ?? "";
    } else if (node.type === "import_declaration") {
      const nameNode = namedChildren(node).find((c) => c.type === "scoped_identifier" || c.type === "identifier");
      if (!nameNode) continue;
      const wildcard = namedChildren(node).some((c) => c.type === "asterisk");
      const isStatic = hasChildType(node, "static");
      const source = nameNode.text;
      const last = source.split(".").pop();
      imports.push({ source, bindings: wildcard ? [] : [{ imported: last, local: last }], typeOnly: false, startLine: line(node), endLine: endLine(node), kind: "import", ...(wildcard ? { star: true } : {}), ...(isStatic ? { isStatic } : {}) });
    } else if (JAVA_TYPES.has(node.type)) {
      declareType(node, null);
    }
  }

  const collector = new Collector(declIndexById, new Set(["identifier", "type_identifier"]));
  walkJava(root, -1, collector);
  const routes = extractJavaRoutes(root);
  return { decls, imports, exports: [], refs: collector.refs, members: collector.members, calls: collector.calls, pkg, ...(routes ? { routes } : {}) };
}

function walkJava(node, inDecl, collector) {
  const own = collector.declIndexById.get(node.id);
  const current = own === undefined ? inDecl : own;
  const type = node.type;
  if (type === "identifier" || type === "type_identifier") {
    collector.ref(node.text, node.startPosition.row);
  } else if (type === "field_access") {
    const object = node.childForFieldName("object");
    const field = node.childForFieldName("field");
    if (object?.type === "identifier" && field) collector.member(object.text, field.text, node.startPosition.row);
  } else if (type === "method_invocation") {
    const object = node.childForFieldName("object");
    const name = node.childForFieldName("name")?.text ?? null;
    let objectName;
    if (object) objectName = object.type === "identifier" ? object.text : object.type === "this" ? "this" : "?";
    collector.calls.push({ callee: name, ...(objectName ? { object: objectName } : {}), line: node.startPosition.row + 1, inDecl: current, kind: "call" });
  } else if (type === "object_creation_expression") {
    const typeNode = node.childForFieldName("type");
    const name = typeNode?.type === "generic_type" ? typeNode.namedChild(0)?.text : typeNode?.text;
    if (name) collector.calls.push({ callee: name.split(".").pop(), line: node.startPosition.row + 1, inDecl: current, kind: "new" });
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkJava(child, current, collector);
  }
}

// ---------------------------------------------------------------------------

/**
 * Symbol facts for one parsed file. `family` picks the extractor: `js`
 * (TypeScript, TSX, JavaScript), `python` or `java`. Returns `null` for any
 * other family.
 *
 * @param {import("web-tree-sitter").Node} root
 * @param {string} family
 * @returns {SymbolFacts | null}
 */
export function extractSymbols(root, family) {
  if (family === "js") return extractJs(root);
  if (family === "python") return extractPython(root);
  if (family === "java") return extractJava(root);
  return null;
}
