// Route facts: the raw syntax web frameworks declare endpoints with, read
// from a tree-sitter tree next to the symbol facts (./extract.mjs).
//
// Nothing here knows what a path resolves to or which object is a router —
// that takes other files (an imported router, a prefix it is mounted under)
// and happens in lib/analysis/api/. This file only records, per file, the
// candidates in a plain-data form:
//
//   calls      `x.get("/p", …)`, `x.use("/p", r)`, `x.include_router(r, prefix=…)`
//   creates    module-level `const r = express.Router()`, `r = APIRouter(prefix=…)`
//   classes    decorated / annotated classes and methods (NestJS, Spring, JAX-RS, …)
//   decorated  decorated Python functions (`@router.get("/p")`)
//   trpc       `router({ a: procedure.query(…) })` objects
//   resolvers  `{ Query: { a: () => … } }` GraphQL resolver maps
//   gql        GraphQL SDL in `gql\`…\`` templates
//   urlpatterns  Django `urlpatterns = [path(…), …]`
//   models     classes' fields (Pydantic, dataclasses, DTOs, serializers)
//   useServer / actions  Next.js server actions
//
// Plain JavaScript for the same reason as ./extract.mjs: it runs inside the
// parse worker. Lines are 1-based.

import { hashText } from "./hash.mjs";

/**
 * A value as written: a string, a template with holes, a name, an inline
 * function, a call, a list, an object/keywords, or other text.
 * @typedef {{ s: string } | { t: string } | { id: string } | { fn: [number, number], hash: string, sig?: string } | { call: string, args: Val[], kw?: Record<string, Val> } | { list: Val[] } | { obj: Record<string, Val> } | { x: string }} Val
 */

const VERBS = new Set(["get", "post", "put", "patch", "delete", "del", "head", "options", "all", "any"]);
const JS_ROUTE_CALLS = new Set([...VERBS, "use", "route", "register", "mount", "basePath", "on", "group", "setGlobalPrefix"]);
const JS_ROUTER_FACTORIES = new Set(["express", "Router", "Hono", "OpenAPIHono", "fastify", "Fastify", "Koa", "KoaRouter", "Elysia", "basePath", "polka", "createServer", "createApp"]);
const TRPC_ROUTERS = new Set(["router", "createTRPCRouter", "createRouter", "mergeRouters"]);
const TRPC_OPS = new Set(["query", "mutation", "subscription"]);
const PY_ROUTER_FACTORIES = new Set(["FastAPI", "APIRouter", "Flask", "Blueprint", "Starlette", "Router", "NinjaAPI", "DefaultRouter", "SimpleRouter", "Quart", "Sanic", "Litestar"]);
const PY_ROUTE_CALLS = new Set(["include_router", "register_blueprint", "add_url_rule", "mount", "register", "add_api_route", "add_router", "include", "add_api_websocket_route"]);
const MAX_CALLS = 600;
const MAX_FIELDS = 40;
const MAX_TEXT = 300;
const MAX_SDL = 30000;
/** How deep calls are followed into their arguments. */
const MAX_DEPTH = 4;
/** How deep object and list literals are kept (a Fastify route schema nests six deep). */
const MAX_LITERAL_DEPTH = 8;
/** Entries kept per object or list literal. */
const MAX_ENTRIES = 40;

function collapse(text, max = MAX_TEXT) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function named(node) {
  const out = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

const line = (node) => node.startPosition.row + 1;
const endLine = (node) => node.endPosition.row + 1;

function fnVal(node, body) {
  const head = body && node.text.endsWith(body.text) ? node.text.slice(0, node.text.length - body.text.length) : node.text.split("\n")[0];
  return { fn: [line(node), endLine(node)], hash: hashText(node.text), sig: collapse(head, 200) };
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript
// ---------------------------------------------------------------------------

function jsString(node) {
  if (node.type === "string") return named(node).map((c) => c.text).join("");
  return undefined;
}

/** @returns {Val} */
function jsVal(node, depth = 0) {
  if (!node) return { x: "" };
  switch (node.type) {
    case "string":
      return { s: jsString(node) ?? "" };
    case "template_string": {
      let text = "";
      let holes = false;
      for (const part of named(node)) {
        if (part.type === "template_substitution") {
          holes = true;
          text += `{${collapse(part.text.replace(/^\$\{|\}$/g, ""), 60)}}`;
        } else text += part.text;
      }
      // Fragments only cover named text; take the raw text when there were no holes.
      return holes ? { t: text } : { s: node.text.slice(1, -1) };
    }
    case "binary_expression": {
      const op = node.childForFieldName("operator")?.text;
      if (op === "+") {
        const left = jsVal(node.childForFieldName("left"), depth + 1);
        const right = jsVal(node.childForFieldName("right"), depth + 1);
        const part = (v) => ("s" in v ? v.s : "t" in v ? v.t : "id" in v ? `{${v.id}}` : `{${collapse(node.text, 40)}}`);
        return { t: part(left) + part(right) };
      }
      return { x: collapse(node.text, 120) };
    }
    case "identifier":
    case "property_identifier":
    case "this":
      return { id: node.text };
    case "member_expression":
      return /^[\w$.]+$/.test(node.text) ? { id: node.text } : { x: collapse(node.text, 120) };
    case "arrow_function":
    case "function_expression":
    case "function":
      return fnVal(node, node.childForFieldName("body"));
    case "parenthesized_expression":
    case "as_expression":
    case "satisfies_expression":
    case "non_null_expression":
      return jsVal(named(node)[0], depth);
    case "await_expression":
      return jsVal(named(node)[0], depth);
    case "call_expression":
    case "new_expression": {
      if (depth >= MAX_DEPTH) return { x: collapse(node.text, 120) };
      const fn = node.childForFieldName(node.type === "new_expression" ? "constructor" : "function");
      const args = node.childForFieldName("arguments");
      const list = args && args.type === "arguments" ? named(args).map((a) => jsVal(a, depth + 1)) : args ? [jsVal(args, depth + 1)] : [];
      return { call: `${node.type === "new_expression" ? "new " : ""}${collapse(fn?.text ?? "", 80)}`, args: list };
    }
    case "array":
      if (depth >= MAX_LITERAL_DEPTH) return { x: collapse(node.text, 120) };
      return { list: named(node).slice(0, MAX_ENTRIES).map((c) => jsVal(c, depth + 1)) };
    case "object": {
      if (depth >= MAX_LITERAL_DEPTH) return { x: collapse(node.text, 120) };
      /** @type {Record<string, Val>} */
      const obj = {};
      for (const prop of named(node).slice(0, MAX_ENTRIES)) {
        if (prop.type === "pair") {
          const key = prop.childForFieldName("key");
          const keyText = key ? (key.type === "string" ? (jsString(key) ?? key.text) : key.text) : "";
          obj[keyText] = jsVal(prop.childForFieldName("value"), depth + 1);
        } else if (prop.type === "shorthand_property_identifier") {
          obj[prop.text] = { id: prop.text };
        } else if (prop.type === "method_definition") {
          const name = prop.childForFieldName("name")?.text;
          if (name) obj[name] = fnVal(prop, prop.childForFieldName("body"));
        }
      }
      return { obj };
    }
    default:
      return { x: collapse(node.text, 120) };
  }
}

function memberParts(fn) {
  if (fn?.type !== "member_expression") return null;
  const property = fn.childForFieldName("property")?.text;
  const object = fn.childForFieldName("object");
  return property && object ? { property, object } : null;
}

/** The decorators directly on `node` (a class, or collected before a method). */
function jsDecorator(dec) {
  const expr = named(dec)[0];
  if (!expr) return null;
  if (expr.type === "call_expression") {
    const args = expr.childForFieldName("arguments");
    return { name: collapse(expr.childForFieldName("function")?.text ?? "", 80), args: args ? named(args).map((a) => jsVal(a, 1)) : [] };
  }
  return { name: collapse(expr.text, 80), args: [] };
}

function jsParams(params) {
  const out = [];
  for (const param of params ? named(params) : []) {
    if (param.type !== "required_parameter" && param.type !== "optional_parameter") continue;
    const decorators = named(param).filter((c) => c.type === "decorator").map(jsDecorator).filter(Boolean);
    const pattern = param.childForFieldName("pattern");
    const type = param.childForFieldName("type");
    out.push({
      name: collapse(pattern?.text ?? "", 60),
      ...(type ? { type: collapse(type.text.replace(/^:\s*/, ""), 200) } : {}),
      ...(param.type === "optional_parameter" ? { optional: true } : {}),
      ...(decorators.length ? { decorators } : {}),
    });
  }
  return out;
}

function jsClass(node, outerDecorators) {
  const name = node.childForFieldName("name")?.text;
  const body = node.childForFieldName("body");
  if (!name || !body) return null;
  const decorators = [...outerDecorators, ...named(node).filter((c) => c.type === "decorator")].map(jsDecorator).filter(Boolean);
  const methods = [];
  let pending = [];
  for (const member of named(body)) {
    if (member.type === "decorator") {
      pending.push(member);
      continue;
    }
    if (member.type === "method_definition") {
      const own = [...pending, ...named(member).filter((c) => c.type === "decorator")];
      pending = [];
      const methodName = member.childForFieldName("name")?.text;
      if (!methodName || own.length === 0) continue;
      const params = jsParams(member.childForFieldName("parameters"));
      const returns = member.childForFieldName("return_type");
      const start = own.length ? Math.min(line(own[0]), line(member)) : line(member);
      methods.push({
        name: methodName,
        line: start,
        endLine: endLine(member),
        hash: hashText(member.text),
        decorators: own.map(jsDecorator).filter(Boolean),
        params,
        ...(returns ? { returns: collapse(returns.text.replace(/^:\s*/, ""), 200) } : {}),
      });
      continue;
    }
    pending = [];
  }
  if (decorators.length === 0 && methods.length === 0) return null;
  return { name, line: line(node), endLine: endLine(node), decorators, methods };
}

/** The `"use server"` / `"use client"` prologue of a block or program. */
function hasDirective(block, directive) {
  for (const stmt of block ? named(block) : []) {
    if (stmt.type === "comment") continue;
    if (stmt.type !== "expression_statement") return false;
    const expr = named(stmt)[0];
    if (expr?.type !== "string") return false;
    if (jsString(expr) === directive) return true;
  }
  return false;
}

/** A tRPC router's `{ key: procedure… }` object. */
function trpcEntries(object, depth) {
  const entries = [];
  for (const prop of named(object)) {
    let key;
    let value;
    if (prop.type === "pair") {
      const keyNode = prop.childForFieldName("key");
      key = keyNode?.type === "string" ? jsString(keyNode) : keyNode?.text;
      value = prop.childForFieldName("value");
    } else if (prop.type === "shorthand_property_identifier") {
      entries.push({ key: prop.text, line: line(prop), ref: prop.text });
      continue;
    }
    if (!key || !value) continue;
    if (value.type === "identifier" || value.type === "member_expression") {
      entries.push({ key, line: line(prop), ref: value.text });
      continue;
    }
    if (value.type !== "call_expression") continue;
    const fn = value.childForFieldName("function");
    const callee = fn?.type === "identifier" ? fn.text : memberParts(fn)?.property;
    if (callee && TRPC_ROUTERS.has(callee) && depth < 3) {
      const arg = named(value.childForFieldName("arguments") ?? value)[0];
      if (arg?.type === "object") entries.push({ key, line: line(prop), nested: trpcEntries(arg, depth + 1) });
      continue;
    }
    const op = memberParts(fn);
    if (!op || !TRPC_OPS.has(op.property)) continue;
    let input;
    let output;
    let middleware = [];
    let cursor = op.object;
    while (cursor?.type === "call_expression") {
      const part = memberParts(cursor.childForFieldName("function"));
      if (!part) break;
      const arg = named(cursor.childForFieldName("arguments") ?? cursor)[0];
      if (part.property === "input" && arg) input = collapse(arg.text, 600);
      else if (part.property === "output" && arg) output = collapse(arg.text, 600);
      else if (part.property === "use" && arg) middleware.push(collapse(arg.text, 60));
      cursor = part.object;
    }
    const base = cursor ? collapse(cursor.text, 60) : undefined;
    const handler = named(value.childForFieldName("arguments") ?? value)[0];
    entries.push({
      key,
      line: line(prop),
      endLine: endLine(prop),
      op: op.property,
      hash: hashText(prop.text),
      ...(base ? { base } : {}),
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
      ...(middleware.length ? { middleware: middleware.reverse() } : {}),
      ...(handler ? { fn: [line(handler), endLine(handler)] } : {}),
    });
  }
  return entries;
}

/**
 * @param {import("web-tree-sitter").Node} root
 * @param {Map<number, number>} declIndexById syntax node id → index into the file's decls
 */
export function extractJsRoutes(root, declIndexById) {
  const calls = [];
  const creates = [];
  const classes = [];
  const trpc = [];
  const resolvers = [];
  const gql = [];
  const actions = [];
  const useServer = hasDirective(root, "use server");

  // Module level: router factories, decorated classes, inline server actions.
  for (const top of named(root)) {
    const isExport = top.type === "export_statement";
    const node = isExport ? (top.childForFieldName("declaration") ?? null) : top;
    if (!node) continue;
    if (node.type === "class_declaration" || node.type === "abstract_class_declaration") {
      const outer = isExport ? named(top).filter((c) => c.type === "decorator") : [];
      const cls = jsClass(node, outer);
      if (cls) classes.push(cls);
      continue;
    }
    if (node.type === "function_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (name && hasDirective(node.childForFieldName("body"), "use server")) actions.push(name);
      continue;
    }
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const declarator of named(node)) {
        if (declarator.type !== "variable_declarator") continue;
        const nameNode = declarator.childForFieldName("name");
        let value = declarator.childForFieldName("value");
        while (value && (value.type === "await_expression" || value.type === "parenthesized_expression" || value.type === "as_expression" || value.type === "satisfies_expression")) value = named(value)[0];
        if (!nameNode || nameNode.type !== "identifier" || !value) continue;
        if ((value.type === "arrow_function" || value.type === "function_expression") && hasDirective(value.childForFieldName("body"), "use server")) {
          actions.push(nameNode.text);
          continue;
        }
        if (value.type !== "call_expression" && value.type !== "new_expression") continue;
        const fn = value.childForFieldName(value.type === "new_expression" ? "constructor" : "function");
        const final = fn?.type === "identifier" ? fn.text : memberParts(fn)?.property;
        if (final && JS_ROUTER_FACTORIES.has(final)) {
          const v = jsVal(value);
          creates.push({ local: nameNode.text, callee: "call" in v ? v.call : collapse(value.text, 80), args: "args" in v ? v.args : [], line: line(declarator) });
        }
      }
    }
  }

  // Everywhere: route calls, tRPC routers, resolver maps, gql templates.
  const walk = (node, inDecl) => {
    const own = declIndexById.get(node.id);
    const current = own === undefined ? inDecl : own;
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const args = node.childForFieldName("arguments");
      // gql`…` / graphql(`…`): GraphQL SDL.
      if (fn?.type === "identifier" && (fn.text === "gql" || fn.text === "graphql") && gql.length < 20) {
        const template = args?.type === "template_string" ? args : args ? named(args).find((a) => a.type === "template_string") : undefined;
        if (template && /\b(type|extend\s+type)\s+(Query|Mutation|Subscription)\b/.test(template.text)) {
          gql.push({ line: line(template), text: template.text.slice(1, -1).slice(0, MAX_SDL) });
        }
      }
      const callee = fn?.type === "identifier" ? fn.text : memberParts(fn)?.property;
      if (callee && TRPC_ROUTERS.has(callee) && args) {
        const object = named(args)[0];
        if (object?.type === "object") {
          const entries = trpcEntries(object, 0);
          if (entries.length) {
            const parent = node.parent;
            const local = parent?.type === "variable_declarator" ? parent.childForFieldName("name")?.text : undefined;
            trpc.push({ line: line(node), entries, ...(local ? { local } : {}), ...(current >= 0 ? { inDecl: current } : {}) });
            return; // its procedures are recorded; their bodies hold no routes
          }
        }
      }
      const member = memberParts(fn);
      if (member && JS_ROUTE_CALLS.has(member.property) && args && calls.length < MAX_CALLS) {
        const list = named(args);
        const first = list[0];
        const pathLike = first && (first.type === "string" || first.type === "template_string" || first.type === "binary_expression");
        const verb = VERBS.has(member.property);
        // Descend `router.route("/x").get(h).post(h)` to its root object.
        let object = member.object;
        let route;
        while (object?.type === "call_expression") {
          const inner = memberParts(object.childForFieldName("function"));
          if (!inner || !(VERBS.has(inner.property) || inner.property === "route" || inner.property === "basePath")) break;
          if (inner.property === "route" || inner.property === "basePath") {
            const arg = named(object.childForFieldName("arguments") ?? object)[0];
            if (arg && route === undefined) route = jsVal(arg);
          }
          object = inner.object;
        }
        const keep = verb
          ? (pathLike && list.length >= 2) || (route !== undefined && list.length >= 1 && !pathLike)
          : member.property === "route"
            ? pathLike || first?.type === "object"
            : member.property === "on"
              ? list.length >= 3
              : true;
        if (keep) {
          const rootText = object ? collapse(object.text, 80) : "";
          calls.push({
            obj: rootText,
            m: member.property,
            args: list.map((a) => jsVal(a)),
            line: line(node),
            endLine: endLine(node),
            ...(route ? { route } : {}),
            ...(current >= 0 ? { inDecl: current } : {}),
          });
        }
      }
    } else if (node.type === "pair" && resolvers.length < 400) {
      const key = node.childForFieldName("key")?.text;
      const value = node.childForFieldName("value");
      if ((key === "Query" || key === "Mutation" || key === "Subscription") && value?.type === "object") {
        for (const prop of named(value)) {
          if (prop.type === "pair") {
            const field = prop.childForFieldName("key")?.text;
            const v = prop.childForFieldName("value");
            if (field && v) resolvers.push({ type: key, field, line: line(prop), endLine: endLine(prop), hash: hashText(prop.text), ...(v.type === "identifier" || v.type === "member_expression" ? { ref: v.text } : {}) });
          } else if (prop.type === "method_definition") {
            const field = prop.childForFieldName("name")?.text;
            if (field) resolvers.push({ type: key, field, line: line(prop), endLine: endLine(prop), hash: hashText(prop.text) });
          } else if (prop.type === "shorthand_property_identifier") {
            resolvers.push({ type: key, field: prop.text, line: line(prop), endLine: endLine(prop), ref: prop.text });
          }
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child, current);
    }
  };
  walk(root, -1);

  const out = {};
  if (calls.length) out.calls = calls;
  if (creates.length) out.creates = creates;
  if (classes.length) out.classes = classes;
  if (trpc.length) out.trpc = trpc;
  if (resolvers.length) out.resolvers = resolvers;
  if (gql.length) out.gql = gql;
  if (useServer) out.useServer = true;
  if (actions.length) out.actions = actions;
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function pyString(node) {
  const parts = named(node).filter((c) => c.type === "string_content" || c.type === "interpolation" || c.type === "escape_sequence");
  const isF = /^[rbuRBU]*[fF]/.test(node.text);
  let text = "";
  let holes = false;
  for (const p of parts) {
    if (p.type === "interpolation") {
      holes = true;
      text += `{${collapse(p.text.replace(/^\{|\}$/g, ""), 60)}}`;
    } else text += p.text;
  }
  return isF && holes ? { t: text } : { s: text };
}

/** @returns {Val} */
function pyVal(node, depth = 0) {
  if (!node) return { x: "" };
  switch (node.type) {
    case "string":
      return pyString(node);
    case "concatenated_string":
      return { s: named(node).map((s) => ("s" in pyString(s) ? pyString(s).s : "")).join("") };
    case "binary_operator": {
      if (node.childForFieldName("operator")?.text !== "+") return { x: collapse(node.text, 120) };
      const left = pyVal(node.childForFieldName("left"), depth + 1);
      const right = pyVal(node.childForFieldName("right"), depth + 1);
      // `[…] + router.urls`: a list joined with more patterns.
      if ("list" in left || "list" in right) return { list: [...("list" in left ? left.list : [left]), ...("list" in right ? right.list : [right])] };
      const part = (v) => ("s" in v ? v.s : "t" in v ? v.t : "id" in v ? `{${v.id}}` : "{…}");
      return { t: part(left) + part(right) };
    }
    case "identifier":
      return { id: node.text };
    case "attribute":
      return /^[\w.]+$/.test(node.text) ? { id: node.text } : { x: collapse(node.text, 120) };
    case "lambda":
      return fnVal(node, node.childForFieldName("body"));
    case "call": {
      if (depth >= MAX_DEPTH) return { x: collapse(node.text, 120) };
      const fn = node.childForFieldName("function");
      const argList = node.childForFieldName("arguments");
      const args = [];
      /** @type {Record<string, Val>} */
      const kw = {};
      for (const arg of argList ? named(argList) : []) {
        if (arg.type === "keyword_argument") {
          const name = arg.childForFieldName("name")?.text;
          if (name) kw[name] = pyVal(arg.childForFieldName("value"), depth + 1);
        } else if (arg.type !== "comment") args.push(pyVal(arg, depth + 1));
      }
      return { call: collapse(fn?.text ?? "", 80), args, ...(Object.keys(kw).length ? { kw } : {}) };
    }
    case "list":
    case "tuple":
    case "set":
      if (depth >= MAX_LITERAL_DEPTH) return { x: collapse(node.text, 120) };
      return { list: named(node).filter((c) => c.type !== "comment").slice(0, MAX_ENTRIES).map((c) => pyVal(c, depth + 1)) };
    case "dictionary": {
      if (depth >= MAX_LITERAL_DEPTH) return { x: collapse(node.text, 120) };
      const obj = {};
      for (const pair of named(node)) {
        if (pair.type !== "pair") continue;
        const key = pair.childForFieldName("key");
        const keyText = key?.type === "string" ? ("s" in pyString(key) ? pyString(key).s : key.text) : (key?.text ?? "");
        obj[keyText] = pyVal(pair.childForFieldName("value"), depth + 1);
      }
      return { obj };
    }
    case "parenthesized_expression":
      return pyVal(named(node)[0], depth);
    default:
      return { x: collapse(node.text, 120) };
  }
}

function pyDecorator(dec) {
  const expr = named(dec).find((c) => c.type !== "comment");
  if (!expr) return null;
  if (expr.type === "call") {
    const v = pyVal(expr, 1);
    return { name: v.call, args: v.args, ...(v.kw ? { kw: v.kw } : {}) };
  }
  return { name: collapse(expr.text, 80), args: [] };
}

function pyParams(params) {
  const out = [];
  for (const p of params ? named(params) : []) {
    if (p.type === "identifier") out.push({ name: p.text });
    else if (p.type === "typed_parameter") {
      const nameNode = named(p).find((c) => c.type === "identifier");
      const type = p.childForFieldName("type");
      if (nameNode) out.push({ name: nameNode.text, ...(type ? { type: collapse(type.text, 200) } : {}) });
    } else if (p.type === "default_parameter" || p.type === "typed_default_parameter") {
      const nameNode = p.childForFieldName("name");
      const type = p.childForFieldName("type");
      const value = p.childForFieldName("value");
      if (nameNode) out.push({ name: nameNode.text, ...(type ? { type: collapse(type.text, 200) } : {}), ...(value ? { default: pyVal(value, 1) } : {}) });
    }
  }
  return out;
}

function pyModel(node) {
  const name = node.childForFieldName("name")?.text;
  const supers = node.childForFieldName("superclasses");
  const body = node.childForFieldName("body");
  if (!name || !body) return null;
  const bases = supers ? named(supers).filter((c) => c.type !== "keyword_argument").map((c) => collapse(c.text, 80)) : [];
  const fields = [];
  let meta;
  /** Class attributes naming another class: DRF `serializer_class = UserSerializer`, `queryset = …`. */
  const attrs = {};
  for (const stmtTop of named(body)) {
    const stmt = stmtTop.type === "decorated_definition" ? stmtTop.childForFieldName("definition") : stmtTop;
    if (stmt?.type === "class_definition" && stmt.childForFieldName("name")?.text === "Meta") {
      meta = {};
      for (const m of named(stmt.childForFieldName("body") ?? stmt)) {
        const a = m.type === "expression_statement" ? named(m)[0] : null;
        if (a?.type !== "assignment") continue;
        const key = a.childForFieldName("left")?.text;
        if (key === "model" || key === "fields" || key === "exclude") meta[key] = pyVal(a.childForFieldName("right"), 1);
      }
      continue;
    }
    if (stmt?.type !== "expression_statement" || fields.length >= MAX_FIELDS) continue;
    const a = named(stmt)[0];
    if (a?.type !== "assignment") continue;
    const left = a.childForFieldName("left");
    if (left?.type !== "identifier" || left.text.startsWith("_") || left.text === "model_config") continue;
    const type = a.childForFieldName("type");
    const right = a.childForFieldName("right");
    if (/^(serializer_class|queryset|model|permission_classes|authentication_classes|http_method_names|lookup_field)$/.test(left.text) && right) {
      attrs[left.text] = pyVal(right, 1);
      continue;
    }
    if (type) fields.push({ name: left.text, type: collapse(type.text, 160), ...(right ? { optional: true, default: collapse(right.text, 80) } : {}) });
    else if (right?.type === "call") fields.push({ name: left.text, type: collapse(right.childForFieldName("function")?.text ?? "", 80), call: collapse(right.text, 160) });
  }
  const hasAttrs = Object.keys(attrs).length > 0;
  if (fields.length === 0 && !meta && !hasAttrs) return null;
  return { name, line: line(node), bases, fields, ...(meta ? { meta } : {}), ...(hasAttrs ? { attrs } : {}) };
}

/** @param {import("web-tree-sitter").Node} root */
export function extractPythonRoutes(root) {
  const decorated = [];
  const creates = [];
  const calls = [];
  const urlpatterns = [];
  const models = [];

  const visitDecorated = (top, parentClass) => {
    const def = top.childForFieldName("definition");
    if (def?.type !== "function_definition") return;
    const decorators = named(top).filter((c) => c.type === "decorator").map(pyDecorator).filter(Boolean);
    if (!decorators.some((d) => d.name.includes(".") || /^(api_view|action|route|get|post|put|patch|delete)$/.test(d.name))) return;
    const name = def.childForFieldName("name")?.text;
    if (!name) return;
    const returns = def.childForFieldName("return_type");
    decorated.push({
      name,
      ...(parentClass ? { parent: parentClass } : {}),
      line: line(top),
      endLine: endLine(top),
      hash: hashText(top.text),
      decorators,
      params: pyParams(def.childForFieldName("parameters")),
      ...(returns ? { returns: collapse(returns.text, 200) } : {}),
    });
  };

  for (const top of named(root)) {
    if (top.type === "decorated_definition") {
      const def = top.childForFieldName("definition");
      if (def?.type === "function_definition") visitDecorated(top, undefined);
      else if (def?.type === "class_definition") {
        const model = pyModel(def);
        if (model) models.push(model);
        const classDecorators = named(top).filter((c) => c.type === "decorator").map(pyDecorator).filter(Boolean);
        const className = def.childForFieldName("name")?.text;
        for (const member of named(def.childForFieldName("body") ?? def)) if (member.type === "decorated_definition") visitDecorated(member, className);
        if (classDecorators.length && className) decorated.push({ name: className, kind: "class", line: line(top), endLine: endLine(top), hash: hashText(top.text), decorators: classDecorators, params: [] });
      }
      continue;
    }
    if (top.type === "class_definition") {
      const model = pyModel(top);
      if (model) models.push(model);
      const className = top.childForFieldName("name")?.text;
      for (const member of named(top.childForFieldName("body") ?? top)) if (member.type === "decorated_definition") visitDecorated(member, className);
      continue;
    }
    if (top.type === "expression_statement") {
      const a = named(top)[0];
      if (a?.type === "assignment" || a?.type === "augmented_assignment") {
        const left = a.childForFieldName("left");
        const right = a.childForFieldName("right");
        if (left?.text === "urlpatterns" && right) {
          urlpatterns.push({ line: line(top), value: pyVal(right, 0) });
          continue;
        }
        if (a.type === "assignment" && left?.type === "identifier" && right?.type === "call") {
          const fn = right.childForFieldName("function");
          const final = fn?.type === "identifier" ? fn.text : fn?.type === "attribute" ? fn.childForFieldName("attribute")?.text : undefined;
          if (final && PY_ROUTER_FACTORIES.has(final)) {
            const v = pyVal(right, 0);
            creates.push({ local: left.text, callee: v.call, args: v.args, ...(v.kw ? { kw: v.kw } : {}), line: line(top) });
          }
        }
      }
    }
  }

  // Mounting calls anywhere (an app factory's body included).
  const walk = (node, inFn) => {
    if (node.type === "call" && calls.length < MAX_CALLS) {
      const fn = node.childForFieldName("function");
      if (fn?.type === "attribute") {
        const m = fn.childForFieldName("attribute")?.text;
        if (m && PY_ROUTE_CALLS.has(m)) {
          const v = pyVal(node, 0);
          calls.push({ obj: collapse(fn.childForFieldName("object")?.text ?? "", 80), m, args: v.args, ...(v.kw ? { kw: v.kw } : {}), line: line(node), ...(inFn ? { inFn } : {}) });
        }
      }
    }
    const nextFn = node.type === "function_definition" ? (node.childForFieldName("name")?.text ?? inFn) : inFn;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child, nextFn);
    }
  };
  walk(root, undefined);

  const out = {};
  if (decorated.length) out.decorated = decorated;
  if (creates.length) out.creates = creates;
  if (calls.length) out.calls = calls;
  if (urlpatterns.length) out.urlpatterns = urlpatterns;
  if (models.length) out.models = models;
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

/** @returns {Val} */
function javaVal(node, depth = 0) {
  if (!node) return { x: "" };
  switch (node.type) {
    case "string_literal":
      return { s: named(node).map((c) => c.text).join("") };
    case "identifier":
    case "field_access":
    case "scoped_identifier":
      return { id: node.text };
    case "element_value_array_initializer":
    case "array_initializer":
      if (depth >= MAX_DEPTH) return { x: collapse(node.text, 120) };
      return { list: named(node).map((c) => javaVal(c, depth + 1)) };
    case "binary_expression": {
      const part = (v) => ("s" in v ? v.s : "t" in v ? v.t : "id" in v ? `{${v.id}}` : "{…}");
      return { t: part(javaVal(node.childForFieldName("left"), depth + 1)) + part(javaVal(node.childForFieldName("right"), depth + 1)) };
    }
    default:
      return { x: collapse(node.text, 120) };
  }
}

function javaAnnotations(modifiers) {
  const out = [];
  for (const a of modifiers ? named(modifiers) : []) {
    if (a.type === "marker_annotation") out.push({ name: a.childForFieldName("name")?.text ?? "", args: [] });
    else if (a.type === "annotation") {
      const argList = a.childForFieldName("arguments");
      const args = [];
      const kw = {};
      for (const arg of argList ? named(argList) : []) {
        if (arg.type === "element_value_pair") {
          const key = arg.childForFieldName("key")?.text;
          if (key) kw[key] = javaVal(arg.childForFieldName("value"));
        } else args.push(javaVal(arg));
      }
      out.push({ name: a.childForFieldName("name")?.text ?? "", args, ...(Object.keys(kw).length ? { kw } : {}) });
    }
  }
  return out;
}

const modifiersOf = (node) => named(node).find((c) => c.type === "modifiers");
const JAVA_TYPE_DECLS = new Set(["class_declaration", "interface_declaration", "record_declaration", "enum_declaration"]);

/** @param {import("web-tree-sitter").Node} root */
export function extractJavaRoutes(root) {
  const classes = [];
  const models = [];

  const visitType = (node, outer) => {
    const simple = node.childForFieldName("name")?.text;
    if (!simple) return;
    const name = outer ? `${outer}.${simple}` : simple;
    const body = node.childForFieldName("body");
    const annotations = javaAnnotations(modifiersOf(node));
    const methods = [];
    const fields = [];
    if (node.type === "record_declaration") {
      const params = node.childForFieldName("parameters");
      for (const p of params ? named(params) : []) {
        if (p.type !== "formal_parameter") continue;
        const fname = p.childForFieldName("name")?.text;
        const ftype = p.childForFieldName("type")?.text;
        if (fname && ftype) fields.push({ name: fname, type: collapse(ftype, 120) });
      }
    }
    for (const member of body ? named(body) : []) {
      if (JAVA_TYPE_DECLS.has(member.type)) {
        visitType(member, name);
        continue;
      }
      if (member.type === "field_declaration" && fields.length < MAX_FIELDS) {
        const mods = modifiersOf(member)?.text ?? "";
        if (/\bstatic\b/.test(mods)) continue;
        const ftype = member.childForFieldName("type")?.text;
        const fieldAnn = javaAnnotations(modifiersOf(member)).map((a) => a.name);
        for (const d of named(member)) {
          if (d.type !== "variable_declarator") continue;
          const fname = d.childForFieldName("name")?.text;
          if (fname && ftype) fields.push({ name: fname, type: collapse(ftype, 120), ...(fieldAnn.length ? { annotations: fieldAnn } : {}) });
        }
        continue;
      }
      if (member.type !== "method_declaration") continue;
      const ann = javaAnnotations(modifiersOf(member));
      if (ann.length === 0) continue;
      const params = [];
      const plist = member.childForFieldName("parameters");
      for (const p of plist ? named(plist) : []) {
        if (p.type !== "formal_parameter") continue;
        params.push({
          name: p.childForFieldName("name")?.text ?? "",
          type: collapse(p.childForFieldName("type")?.text ?? "", 160),
          annotations: javaAnnotations(modifiersOf(p)),
        });
      }
      methods.push({
        name: member.childForFieldName("name")?.text ?? "",
        line: line(member),
        endLine: endLine(member),
        hash: hashText(member.text),
        annotations: ann,
        params,
        returns: collapse(member.childForFieldName("type")?.text ?? "", 160),
      });
    }
    if (annotations.length || methods.length) classes.push({ name, line: line(node), endLine: endLine(node), annotations, methods });
    if (fields.length) models.push({ name, line: line(node), bases: [node.childForFieldName("superclass")?.text?.replace(/^extends\s+/, "")].filter(Boolean), fields });
  };

  for (const node of named(root)) if (JAVA_TYPE_DECLS.has(node.type)) visitType(node, null);
  const out = {};
  if (classes.length) out.classes = classes;
  if (models.length) out.models = models;
  return Object.keys(out).length ? out : undefined;
}
