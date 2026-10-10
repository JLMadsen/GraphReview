/**
 * What a JS/TS handler's own code says about its contract, where its types
 * don't (DESIGN.md §6.11): the query parameters, headers and cookies it
 * reads off the request, the body it reads (`await req.json() as X`, a
 * destructure, `body.field`), the object literals it answers with
 * (`NextResponse.json({ … })`, `res.json({ … })`, a server action's
 * `return { … }`), and whether it is a proxy — forwards the request to
 * another server and passes the answer back.
 *
 * Read from the handler's text, no model. Shapes found here are marked
 * `source: "code"`; a field whose type the code doesn't show is `unknown`,
 * which leaves the ✦ inference something to add. Runs after the framework
 * resolvers and the OpenAPI merge, and only fills what they left empty.
 */
import { shapeOf, splitTop, type ApiContext } from "./context";
import type { ApiField, ApiParam, ApiShape, Endpoint } from "./types";

const JS = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;

/** The handler's text with comments blanked out (strings kept, so `"https://…"` survives). */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== "`" && text[j] === "\n")) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The text between the bracket at `open` and its match (to the end when unbalanced). */
function bracketed(text: string, open: number): string {
  const o = text[open];
  const close = o === "(" ? ")" : o === "[" ? "]" : o === "<" ? ">" : "}";
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === o) depth++;
    else if (c === close && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** A type written at `at`: a `{ … }` literal, or a name with its generics and `[]`s. */
function typeAt(text: string, at: number): string | undefined {
  const rest = text.slice(at).replace(/^\s+/, "");
  // Fields of a type literal on their own lines need no `;` — add them, so it reads like any other.
  if (rest.startsWith("{")) {
    const body = bracketed(rest, 0)
      .replace(/\n(?!\s*[|&])/g, ";")
      .replace(/\s+/g, " ")
      .replace(/(;\s*)+/g, "; ")
      .replace(/^[\s;]+|[\s;]+$/g, "");
    return `{ ${body} }`;
  }
  const m = /^[\w$.]+/.exec(rest);
  if (!m) return undefined;
  let t = m[0];
  let tail = rest.slice(t.length);
  if (tail.startsWith("<")) {
    const g = bracketed(tail, 0);
    t += `<${g}>`;
    tail = tail.slice(g.length + 2);
  }
  while (tail.startsWith("[]")) {
    t += "[]";
    tail = tail.slice(2);
  }
  return t;
}

const esc = (s: string) => s.replace(/[$]/g, "\\$");

/**
 * The handler's parameter names, in order: the first parenthesised list
 * followed by `=>` or a function body (`withAuth(async (req) => …)` skips
 * the wrapper's own parentheses). `({ params }) =>` gives an empty name.
 */
function paramNames(text: string): string[] {
  for (let open = text.indexOf("("); open !== -1; open = text.indexOf("(", open + 1)) {
    const inner = bracketed(text, open);
    if (!/^\s*(?::[^={]*?)?\s*(=>|\{)/.test(text.slice(open + inner.length + 2))) continue;
    return splitTop(inner, ",").map((p) => /^([\w$]+)/.exec(p)?.[1] ?? "");
  }
  return [];
}

/** Names bound by `const { a, b = 1, c: d, ...rest } = …`: each with whether it had a default. */
function destructured(pattern: string): Array<{ name: string; optional: boolean }> {
  return splitTop(pattern, ",")
    .filter((p) => !p.startsWith("..."))
    .map((p) => {
      const m = /^["']?([\w$-]+)["']?\s*(?::\s*[\s\S]+?)?(\s*=\s*[\s\S]+)?$/.exec(p);
      return m ? { name: m[1], optional: Boolean(m[2]) } : null;
    })
    .filter((x): x is { name: string; optional: boolean } => x !== null);
}

/** Variables assigned `= await <expr>` (or `= <expr>`), with their type annotation if any. */
function assignedFrom(text: string, expr: string): Array<{ name?: string; pattern?: string; type?: string; cast?: string }> {
  const out: Array<{ name?: string; pattern?: string; type?: string; cast?: string }> = [];
  const re = new RegExp(String.raw`(?:const|let|var)\s+(?:([\w$]+)|\{([^}]*)\})\s*(?::\s*([^=]+?))?\s*=\s*\(?\s*(?:await\s+)?${expr}`, "g");
  for (const m of text.matchAll(re)) {
    const after = m.index! + m[0].length;
    const cast = /^\s*\)?\s*(?:as|satisfies)\s+/.exec(text.slice(after));
    out.push({
      ...(m[1] ? { name: m[1] } : {}),
      ...(m[2] !== undefined ? { pattern: m[2] } : {}),
      ...(m[3] ? { type: m[3].trim() } : {}),
      ...(cast ? { cast: typeAt(text, after + cast[0].length) } : {}),
    });
  }
  return out;
}

const NOT_FIELDS = new Set(["length", "map", "filter", "forEach", "some", "every", "find", "reduce", "slice", "includes", "toString", "then", "keys", "values", "entries", "get", "has"]);

/** `body.a`, `body?.b`, `body["c"]`, `const { d } = body` — the fields read off a variable. */
function fieldsReadOff(text: string, variable: string): ApiField[] {
  const names = new Map<string, boolean>();
  const v = esc(variable);
  for (const m of text.matchAll(new RegExp(String.raw`\b${v}\??\.([\w$]+)`, "g"))) if (!NOT_FIELDS.has(m[1])) names.set(m[1], names.get(m[1]) ?? true);
  for (const m of text.matchAll(new RegExp(String.raw`\b${v}\??\.?\[\s*(['"])([^'"]+)\1\s*\]`, "g"))) names.set(m[2], names.get(m[2]) ?? true);
  for (const m of text.matchAll(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*${v}\b(?!\s*\.)`, "g"))) {
    for (const d of destructured(m[1])) names.set(d.name, !d.optional);
  }
  return [...names].slice(0, 40).map(([name, required]) => ({ name, type: "unknown", required }));
}

// ---------------------------------------------------------------------------
// Literal types
// ---------------------------------------------------------------------------

/** A value's type as far as its text shows it (`"x"` → string, `items.length` → number), else `unknown`. */
function literalType(value: string, text: string, depth = 0): string {
  const v = value.trim().replace(/\s+as\s+const$/, "");
  const typed = /\s(?:as|satisfies)\s+([\w$.<>[\]]+)$/.exec(v);
  if (typed) return typed[1];
  if (/^(['"`])/.test(v)) return "string";
  if (/^-?\d[\d_.]*(e\d+)?$/.test(v)) return "number";
  if (/^(true|false)$/.test(v)) return "boolean";
  if (v === "null") return "null";
  if (v === "undefined") return "undefined";
  if (v.startsWith("[") || /\.(map|filter|flatMap|slice|concat|sort)\(/.test(v) || /^Array\.from\(/.test(v) || /\.(keys|values)\(\)\s*\]?$/.test(v)) return "array";
  if (v.startsWith("{")) return "object";
  if (/\.length$|^(Number|parseInt|parseFloat|Math\.\w+)\(|\.(getTime|valueOf)\(\)$|^Date\.now\(\)$/.test(v)) return "number";
  if (/^(String|JSON\.stringify)\(|\.(toString|toISOString|toFixed|join|trim|toLowerCase|toUpperCase)\([^)]*\)$/.test(v)) return "string";
  if (/^new Date\(/.test(v)) return "Date";
  if (/^!|^Boolean\(|[=!]==|\s(>|<|>=|<=)\s|\.(includes|some|every|has|startsWith|endsWith)\(/.test(v)) return "boolean";
  const coalesce = /^([\s\S]+?)\s*(\?\?|\|\|)\s*([\s\S]+)$/.exec(v);
  if (coalesce && depth < 2) {
    const left = literalType(coalesce[1], text, depth + 1);
    const right = literalType(coalesce[3], text, depth + 1);
    if (left === "unknown") return right === "null" ? "unknown" : right;
    return right === "null" ? `${left} | null` : left;
  }
  if (/^[\w$]+$/.test(v) && depth < 2) {
    const decl = new RegExp(String.raw`(?:const|let|var)\s+${esc(v)}\s*(?::\s*([^=]+?))?\s*=\s*([^\n;]+)`).exec(text);
    if (decl?.[1]) return decl[1].trim();
    if (decl?.[2]) return literalType(decl[2], text, depth + 1);
    const param = new RegExp(String.raw`[(,]\s*${esc(v)}\s*:\s*([\w$.<>[\]| ]+?)\s*[,)=]`).exec(text);
    if (param) return param[1].trim();
  }
  return "unknown";
}

/** The fields of an object literal's body, each typed as far as its value shows. */
function literalFields(body: string, text: string): ApiField[] | undefined {
  const fields: ApiField[] = [];
  for (const part of splitTop(body, ",")) {
    if (part.startsWith("...")) continue;
    const kv = /^["']?([\w$-]+)["']?\s*:\s*([\s\S]+)$/.exec(part);
    if (kv) fields.push({ name: kv[1], type: literalType(kv[2], text), required: true });
    else if (/^[\w$]+$/.test(part)) fields.push({ name: part, type: literalType(part, text), required: true });
    else if (/^(?:async\s+)?[\w$]+\s*\(/.test(part)) continue; // a method
    if (fields.length >= 40) break;
  }
  return fields;
}

const ERROR_KEYS = /^(error|errors|message|detail|details|reason|code|status|ok|success)$/;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function readParams(text: string, reqNames: string[], http: boolean): ApiParam[] {
  const out: ApiParam[] = [];
  const add = (name: string, where: ApiParam["in"], type = "string") => {
    if (name && !out.some((p) => p.name === name && p.in === where)) out.push({ name, in: where, type });
  };
  if (http) {
    for (const m of text.matchAll(/\bsearchParams\??\.(get|getAll|has)\(\s*(['"`])([^'"`]+)\2/g)) add(m[3], "query", m[1] === "getAll" ? "string[]" : m[1] === "has" ? "flag" : "string");
  }
  // Variables holding `headers()` / `cookies()` from next/headers.
  const headerVars = ["headers()", ...[...text.matchAll(/(?:const|let)\s+([\w$]+)\s*=\s*(?:await\s+)?headers\(\)/g)].map((m) => m[1])];
  const cookieVars = ["cookies()", ...[...text.matchAll(/(?:const|let)\s+([\w$]+)\s*=\s*(?:await\s+)?cookies\(\)/g)].map((m) => m[1])];
  for (const h of headerVars) for (const m of text.matchAll(new RegExp(String.raw`\b${h.replace(/[()$]/g, "\\$&")}\)?\.get\(\s*(['"\`])([^'"\`]+)\1`, "g"))) add(m[2].toLowerCase(), "header");
  for (const c of cookieVars) for (const m of text.matchAll(new RegExp(String.raw`\b${c.replace(/[()$]/g, "\\$&")}\)?\.get\(\s*(['"\`])([^'"\`]+)\1`, "g"))) add(m[2], "cookie");
  for (const r of reqNames) {
    const R = esc(r);
    if (http) {
      for (const m of text.matchAll(new RegExp(String.raw`\b${R}\.query\??\.([\w$]+)`, "g"))) add(m[1], "query");
      for (const m of text.matchAll(new RegExp(String.raw`\b${R}\.query\[\s*(['"])([^'"]+)\1\s*\]`, "g"))) add(m[2], "query");
      for (const m of text.matchAll(new RegExp(String.raw`(?:const|let)\s*\{([^}]*)\}\s*=\s*${R}\.query\b`, "g"))) for (const d of destructured(m[1])) add(d.name, "query");
    }
    for (const m of text.matchAll(new RegExp(String.raw`\b${R}\.headers\.get\(\s*(['"\`])([^'"\`]+)\1`, "g"))) add(m[2].toLowerCase(), "header");
    for (const m of text.matchAll(new RegExp(String.raw`\b${R}\.headers\[\s*(['"])([^'"]+)\1\s*\]`, "g"))) add(m[2].toLowerCase(), "header");
    for (const m of text.matchAll(new RegExp(String.raw`\b${R}\.(?:get|header)\(\s*(['"])([^'"]+)\1`, "g"))) add(m[2].toLowerCase(), "header");
    for (const m of text.matchAll(new RegExp(String.raw`\b${R}\.cookies\.get\(\s*(['"\`])([^'"\`]+)\1`, "g"))) add(m[2], "cookie");
    for (const m of text.matchAll(new RegExp(String.raw`\b${R}\.cookies\??\.([\w$]+)\b(?!\s*\()`, "g"))) if (!/^(get|getAll|has|set|delete)$/.test(m[1])) add(m[1], "cookie");
  }
  return out;
}

function readRequest(ctx: ApiContext, file: string, text: string, reqNames: string[]): ApiShape | undefined {
  for (const r of reqNames) {
    const R = esc(r);
    // `await req.json() as X`, `req.json<X>()`, `req.body as X`
    for (const re of [new RegExp(String.raw`\(?\s*await\s+${R}\.json\(\)\s*\)?\s*(?:as|satisfies)\s+`), new RegExp(String.raw`\b${R}\.body\s+as\s+`)]) {
      const m = re.exec(text);
      const type = m ? typeAt(text, m.index + m[0].length) : undefined;
      if (type && !/^(any|unknown)$/.test(type)) return codeShape(shapeOf(ctx, file, type));
    }
    const generic = new RegExp(String.raw`\b${R}\.json<`).exec(text);
    if (generic) {
      const type = bracketed(text, generic.index + generic[0].length - 1);
      if (type && !/^(any|unknown)$/.test(type)) return codeShape(shapeOf(ctx, file, type));
    }
    for (const source of [String.raw`${R}\.json\(\)`, String.raw`${R}\.body\b`]) {
      for (const a of assignedFrom(text, source)) {
        const declared = a.cast ?? a.type;
        if (declared && !/^(any|unknown)$/.test(declared)) return codeShape(shapeOf(ctx, file, declared));
        if (a.pattern !== undefined) {
          const fields = destructured(a.pattern).map((d) => ({ name: d.name, type: "unknown", required: !d.optional }));
          if (fields.length) return { fields, source: "code" };
        }
        if (a.name) {
          const fields = fieldsReadOff(text, a.name);
          if (fields.length) return { fields, source: "code" };
        }
      }
    }
    // Express without a variable: `req.body.name`.
    const direct = fieldsReadOff(text, `${r}.body`);
    if (direct.length) return { fields: direct, source: "code" };
    // Form data: `const form = await req.formData(); form.get("file")`.
    if (new RegExp(String.raw`\b${R}\.formData\(\)`).test(text)) {
      const vars = assignedFrom(text, String.raw`${R}\.formData\(\)`).flatMap((a) => (a.name ? [a.name] : []));
      const fields: ApiField[] = [];
      for (const v of vars) {
        for (const m of text.matchAll(new RegExp(String.raw`\b${esc(v)}\.(get|getAll)\(\s*(['"\`])([^'"\`]+)\2`, "g"))) {
          if (!fields.some((f) => f.name === m[3])) fields.push({ name: m[3], type: m[1] === "getAll" ? "FormDataEntryValue[]" : "FormDataEntryValue", required: true });
        }
      }
      return fields.length ? { type: "FormData", fields, source: "code" } : { type: "FormData", source: "code", opaque: true };
    }
    const raw = new RegExp(String.raw`\b${R}\.(arrayBuffer|blob|text)\(\)`).exec(text);
    if (raw) return { type: raw[1] === "text" ? "text" : "binary", source: "code", opaque: true };
  }
  return undefined;
}

/** A shape from the code's own types, found by reading the handler: marked as read from the code. */
function codeShape(shape: ApiShape | undefined): ApiShape | undefined {
  return shape ? { ...shape, source: "code" } : undefined;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** One way the handler answers: its body expression and whether it is an error. */
interface Answer {
  body: string;
  error: boolean;
  generic?: string;
}

function answers(text: string, resNames: string[]): Answer[] {
  const out: Answer[] = [];
  const statusError = (s: string | undefined) => {
    if (!s) return false;
    const n = /status\s*:\s*(\d{3})\b/.exec(s)?.[1] ?? /^\s*(\d{3})\b/.exec(s)?.[1];
    if (n) return Number(n) >= 400;
    // `{ status: res.status }` after `!res.ok`, `{ status: code }`: an error passed on.
    return /\bstatus\s*:/.test(s);
  };
  for (const m of text.matchAll(/\b(?:NextResponse|Response)\.json\s*(<)?/g)) {
    let at = m.index! + m[0].length;
    let generic: string | undefined;
    if (m[1]) {
      generic = bracketed(text, at - 1);
      at += generic.length + 1;
    }
    const open = text.indexOf("(", at);
    if (open === -1 || text.slice(at, open).trim()) continue;
    const args = splitTop(bracketed(text, open), ",");
    if (args.length === 0) continue;
    out.push({ body: args[0], error: statusError(args[1]), ...(generic ? { generic } : {}) });
  }
  for (const r of resNames) {
    for (const m of text.matchAll(new RegExp(String.raw`\b${esc(r)}((?:\.(?:status|code)\(\s*[^)]*\))?)\.(?:json|send)\(`, "g"))) {
      const status = /\(\s*([^)]*)\)/.exec(m[1])?.[1];
      const args = splitTop(bracketed(text, m.index! + m[0].length - 1), ",");
      if (args.length === 0) continue;
      out.push({ body: args[0], error: status ? statusError(status) : false });
    }
  }
  return out;
}

/** An answer whose object has only error-ish keys (`{ error }`, `{ message, code }`). */
function looksLikeError(fields: ApiField[]): boolean {
  return fields.length > 0 && fields.every((f) => ERROR_KEYS.test(f.name)) && fields.some((f) => /^(error|errors|message|detail|reason)$/.test(f.name));
}

function shapeOfBody(ctx: ApiContext, file: string, text: string, body: string, generic?: string): ApiShape | undefined {
  if (generic && !/^(any|unknown)$/.test(generic)) return codeShape(shapeOf(ctx, file, generic));
  const b = body.trim();
  const cast = /^([\s\S]+?)\s+(?:as|satisfies)\s+([\w$.<>[\]]+)$/.exec(b);
  if (cast && !/^(any|unknown|const)$/.test(cast[2])) return codeShape(shapeOf(ctx, file, cast[2]));
  if (b.startsWith("{")) return { fields: literalFields(bracketed(b, 0), text), source: "code" };
  if (b.startsWith("[")) return { type: "array", source: "code" };
  if (/^[\w$]+$/.test(b)) {
    const decl = new RegExp(String.raw`(?:const|let|var)\s+${esc(b)}\s*(?::\s*([^=]+?))?\s*=\s*`).exec(text);
    if (decl?.[1] && !/^(any|unknown)$/.test(decl[1].trim())) return codeShape(shapeOf(ctx, file, decl[1].trim()));
    if (decl) {
      const init = text.slice(decl.index + decl[0].length).trimStart();
      if (init.startsWith("{")) return { fields: literalFields(bracketed(init, 0), text), source: "code" };
      const castInit = /^[^\n;]*?\s(?:as|satisfies)\s+([\w$.<>[\]]+)/.exec(init);
      if (castInit && !/^(any|unknown|const)$/.test(castInit[1])) return codeShape(shapeOf(ctx, file, castInit[1]));
      // `const data = await res.json(); return NextResponse.json(data)`: whatever the upstream sent.
      if (/^await\s+[\w$]+\.json\(\)/.test(init)) return { type: "upstream JSON, passed on", source: "code" };
    }
  }
  return undefined;
}

/** Answers that aren't JSON: a passed-on stream, an image, a redirect, a file. */
function opaqueAnswer(text: string, upstream: Set<string>, resNames: string[]): ApiShape | undefined {
  const passOn = /new\s+(?:Next)?Response\(\s*([\w$]+)\.body\b/.exec(text);
  if (passOn && upstream.has(passOn[1])) return { type: "upstream response (streamed)", source: "code", opaque: true };
  if (/new\s+ImageResponse\(/.test(text)) return { type: "image", source: "code", opaque: true };
  for (const r of resNames) {
    if (new RegExp(String.raw`\b${esc(r)}\.(sendFile|download|attachment)\(`).test(text)) return { type: "file", source: "code", opaque: true };
    if (new RegExp(String.raw`\.pipe\(\s*${esc(r)}\s*\)`).test(text)) return { type: "stream", source: "code", opaque: true };
  }
  if (/new\s+(?:Next)?Response\(\s*[\w$.]+\s*[,)]/.test(text) && !/\b(?:NextResponse|Response)\.json\(/.test(text)) return { type: "Response", source: "code", opaque: true };
  if (/\bNextResponse\.redirect\(|\bredirect\(/.test(text) && !/\.json\(/.test(text)) return { type: "redirect", source: "code", opaque: true };
  return undefined;
}

function readResponse(ctx: ApiContext, file: string, text: string, resNames: string[], upstream: Set<string>, action: boolean): ApiShape | undefined {
  const found = action
    ? [...text.matchAll(/\breturn\s+(?=[{\w$])/g)].map((m) => {
        const at = m.index! + m[0].length;
        const body = text[at] === "{" ? `{${bracketed(text, at)}}` : (/^[\w$]+/.exec(text.slice(at))?.[0] ?? "");
        return { body, error: false } as Answer;
      })
    : answers(text, resNames);
  const shapes: ApiShape[] = [];
  for (const a of found) {
    if (a.error) continue;
    const shape = shapeOfBody(ctx, file, text, a.body, a.generic);
    if (!shape) continue;
    if (shape.fields && shape.source === "code" && !shape.type && looksLikeError(shape.fields)) continue;
    shapes.push(shape);
  }
  // A typed answer wins; else the object literals' fields together, required where every answer has them.
  const typed = shapes.find((s) => s.type && s.fields?.length);
  if (typed) return typed;
  const literal = shapes.filter((s) => s.fields && !s.type);
  if (literal.length > 0) {
    const fields = new Map<string, ApiField>();
    for (const s of literal) {
      for (const f of s.fields!) {
        const had = fields.get(f.name);
        if (!had) {
          fields.set(f.name, { ...f });
          continue;
        }
        // The more telling type wins: `string[]` over `array` (an empty `[]` answer), anything over `unknown`.
        if (f.type !== "unknown" && f.type !== "null" && (had.type === "unknown" || ((had.type === "array" || had.type === "object") && f.type !== had.type))) had.type = f.type;
        // `{ url: null }` on one path and `{ url }` on another: nullable.
        if (had.type !== f.type && (had.type === "null" || f.type === "null")) {
          const other = had.type === "null" ? f.type : had.type;
          had.type = other === "unknown" || other === "null" ? "unknown" : other.endsWith("| null") ? other : `${other} | null`;
        }
      }
    }
    for (const f of fields.values()) f.required = literal.every((s) => s.fields!.some((x) => x.name === f.name));
    const all = [...fields.values()];
    if (all.length) return { fields: all, source: "code" };
  }
  const named = shapes.find((s) => s.type);
  if (named) return named;
  return action ? undefined : opaqueAnswer(text, upstream, resNames);
}

// ---------------------------------------------------------------------------
// Proxies
// ---------------------------------------------------------------------------

const OUTBOUND = /\b(?:fetch|[\w$]+\.fetch|axios(?:\.(?:request|get|post|put|patch|delete))?|got(?:\.\w+)?|ky(?:\.\w+)?|undici\.request|https?\.request)\s*\(/g;
const PROXY_LIB = /\b(createProxyMiddleware|createProxyServer|httpProxy|proxy\.web)\s*\(/;

/** Variables holding an outbound call's answer (`const upstream = await fetch(…)`). */
function upstreamVars(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*await\s+([\w$.]+)\s*\(/g)) {
    if (/(^|\.)(fetch|request|get|post|put|patch|delete)$|^(axios|got|ky)\b/.test(m[2])) out.add(m[1]);
  }
  return out;
}

function readProxy(text: string, reqNames: string[], resNames: string[], upstream: Set<string>): Endpoint["proxy"] | undefined {
  if (PROXY_LIB.test(text)) return {};
  const calls = [...text.matchAll(OUTBOUND)];
  if (calls.length === 0) return undefined;
  const R = reqNames.map(esc).join("|");
  const signals = [
    // The request's own method, headers or body passed on.
    new RegExp(String.raw`method\s*:\s*(?:${R})\.method\b`),
    new RegExp(String.raw`\b(?:${R})\.headers\.(?:forEach|entries)\(|new Headers\(\s*(?:${R})\.headers\s*\)|headers\s*:\s*(?:${R})\.headers\b`),
    new RegExp(String.raw`body\s*:[^,\n]*\b(?:${R})\.(?:body|arrayBuffer|blob|text)\b`),
    /duplex\s*:\s*["']half["']/,
  ];
  const passesOn = (() => {
    const m = /new\s+(?:Next)?Response\(\s*([\w$]+)\.body\b/.exec(text);
    if (m && upstream.has(m[1])) return true;
    return resNames.some((r) => new RegExp(String.raw`\.pipe\(\s*${esc(r)}\s*\)`).test(text));
  })();
  const forwards = signals.filter((re) => re.test(text)).length;
  if (forwards === 0 && !passesOn) return undefined;
  // A request-shaped forward (method / headers / body) or a stream passed back from one.
  if (forwards === 0 && !(passesOn && calls.length === 1)) return undefined;
  const first = bracketed(text, calls[0].index! + calls[0][0].length - 1);
  const host = /^\s*["'`]https?:\/\/([^/"'`$]+)/.exec(first)?.[1];
  return host ? { upstream: host } : {};
}

// ---------------------------------------------------------------------------

/** Fills each JS/TS endpoint's params, shapes and proxy flag from its handler's code. */
export async function readHandlerCode(ctx: ApiContext, endpoints: Endpoint[]): Promise<void> {
  const texts = new Map<string, string[] | null>();
  for (const e of endpoints) {
    const h = e.handler;
    if (!h || !JS.test(h.file) || (e.kind !== "http" && e.kind !== "action")) continue;
    if (!texts.has(h.file)) texts.set(h.file, (await ctx.readText(h.file))?.split("\n") ?? null);
    const lines = texts.get(h.file);
    if (!lines) continue;
    const text = stripComments(lines.slice(Math.max(0, h.startLine - 1), h.endLine).join("\n"));
    const http = e.kind === "http";
    const params = paramNames(text);
    const upstream = upstreamVars(text);
    const reqNames = [...new Set([params[0], "req", "request"].filter((n): n is string => Boolean(n) && !upstream.has(n!)))];
    const resNames = [...new Set([params.length >= 2 ? params[1] : "", "res", "reply"].filter((n) => n && !upstream.has(n)))];

    if (http) {
      for (const p of readParams(text, reqNames, http)) if (!e.params.some((x) => x.name === p.name && x.in === p.in)) e.params.push(p);
      const proxy = readProxy(text, reqNames, resNames, upstream);
      if (proxy) e.proxy = proxy;
      if (!e.request?.fields?.length && !e.proxy) {
        const request = readRequest(ctx, h.file, text, reqNames);
        if (request) e.request = request;
      }
    }
    if (!e.response?.fields?.length) {
      const response = e.proxy ? { type: "upstream response", source: "code" as const, opaque: true as const } : readResponse(ctx, h.file, text, resNames, upstream, !http);
      if (response) e.response = response;
    }
  }
}
