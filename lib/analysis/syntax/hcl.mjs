// A lexical reader for HCL (Terraform / OpenTofu, Nomad jobspecs), DESIGN.md §6.12.
//
// `@vscode/tree-sitter-wasm` ships no HCL grammar, so — as for Kotlin (§5) —
// this is a small hand-written reader instead. HCL's grammar is small:
// a body is attributes (`name = expr`) and blocks (`type "label" … { body }`).
// Expressions are never evaluated: each is kept as its source text plus the
// traversals it contains (`aws_x.y.attr`, `var.n`, `local.n`, `module.m.out`,
// `data.t.n.attr`, `each.key`, `count.index`), which is all the infra catalog
// needs to draw references.
//
// Handled: `#`, `//` and block comments; quoted strings with `${}` / `%{}`
// templates (nested, with strings inside); heredocs (`<<EOF`, `<<-EOF`);
// multi-line expressions inside brackets; one-line blocks; Levant /
// nomad-pack `[[ … ]]` templating (kept as text, the file marked templated).
// Never throws: unreadable input is skipped line by line and counted.
//
// Plain JS (ESM) with JSDoc types, like the rest of ./syntax: it ships in
// the package as is and is imported from TS directly.

/**
 * @typedef {{ text: string, refs: string[] }} HclExpr
 * @typedef {{ name: string, line: number, endLine: number, expr: HclExpr }} HclAttr
 * @typedef {{ type: string, labels: string[], line: number, endLine: number, body: HclBody }} HclBlock
 * @typedef {{ attrs: HclAttr[], blocks: HclBlock[] }} HclBody
 * @typedef {{ body: HclBody, templated?: boolean, errors: number }} HclFile
 */

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_\-]/;
/** Longest expression text kept per attribute. */
const MAX_TEXT = 4000;
const MAX_REFS = 60;

/** `var.x`, `module.m.out`, `data.t.n.attr`, `each.value.k`, … */
const KEYWORD_REF = /(?<![\w.])(var|local|module|data|each|count|self|path|terraform)\.[A-Za-z_][\w-]*(?:\.[A-Za-z_*][\w-]*|\[[^\]\n]{0,40}\])*/g;
/** `aws_db_instance.main.arn` — a resource type always has an underscore. */
const RESOURCE_REF = /(?<![\w.$])([a-z][a-z0-9]*_[a-z0-9_]+)\.([A-Za-z_][\w-]*)(?:\.[A-Za-z_*][\w-]*|\[[^\]\n]{0,40}\])*/g;

/**
 * Read an HCL file.
 * @param {string} source
 * @returns {HclFile}
 */
export function readHcl(source) {
  const src = source.replace(/\r\n?/g, "\n");
  const newlines = [];
  for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) newlines.push(k);
  /** 1-based line of offset `at`. */
  const lineAt = (at) => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < at) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };

  let i = 0;
  let templated = false;
  let errors = 0;
  const n = src.length;

  const skipLine = () => {
    while (i < n && src[i] !== "\n") i++;
  };
  const skipBlockComment = () => {
    const end = src.indexOf("*/", i + 2);
    i = end === -1 ? n : end + 2;
  };
  /** Spaces, comments and (when `newlines`) line breaks. */
  const skipTrivia = (newlinesToo) => {
    while (i < n) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\f" || c === "\v" || (newlinesToo && (c === "\n" || c === ";"))) i++;
      else if (c === "#" || (c === "/" && src[i + 1] === "/")) skipLine();
      else if (c === "/" && src[i + 1] === "*") skipBlockComment();
      else break;
    }
  };
  const readIdent = () => {
    const start = i;
    if (i < n && IDENT_START.test(src[i])) {
      i++;
      while (i < n && IDENT_CHAR.test(src[i])) i++;
    }
    return src.slice(start, i);
  };
  /** `[[ … ]]` (Levant / nomad-pack). */
  const skipLevant = (out) => {
    templated = true;
    const end = src.indexOf("]]", i + 2);
    const stop = end === -1 ? n : end + 2;
    if (out) out.push(src.slice(i, stop));
    i = stop;
  };

  /**
   * A `${…}` / `%{…}` interpolation starting at `i` (on the `$`/`%`): its
   * inside goes to `code` (traversals live there).
   */
  const readInterpolation = (code) => {
    i += 2;
    let depth = 1;
    while (i < n && depth > 0) {
      const c = src[i];
      if (c === '"') {
        readString(code);
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          i++;
          code.push(" ");
          return;
        }
      }
      code.push(c);
      i++;
    }
  };

  /** A quoted string starting at `i`; literal text is blanked in `code`, interpolations kept. */
  const readString = (code) => {
    i++;
    code.push('"');
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        code.push("  ");
        continue;
      }
      if (c === '"') {
        i++;
        code.push('"');
        return;
      }
      if (c === "\n") return; // unterminated: stop at the line end
      if ((c === "$" || c === "%") && src[i + 1] === "{") {
        if (src[i - 1] === c) {
          // `$${` escapes the interpolation
          code.push(" ");
          i++;
          continue;
        }
        readInterpolation(code);
        continue;
      }
      if (c === "[" && src[i + 1] === "[") {
        // Levant / nomad-pack inside a string: `"[[ var "name" . ]]"` — its quotes don't end the string.
        templated = true;
        const end = src.indexOf("]]", i + 2);
        const stop = end === -1 || src.slice(i, end).includes("\n") ? i + 2 : end + 2;
        code.push(" ".repeat(stop - i));
        i = stop;
        continue;
      }
      code.push(" ");
      i++;
    }
  };

  /** The offset of the quote closing the string label that opens at `from`, or -1. */
  const labelEnd = (from) => {
    for (let k = from + 1; k < n; k++) {
      const c = src[k];
      if (c === "\\") k++;
      else if (c === "\n") return -1;
      else if (c === "[" && src[k + 1] === "[") {
        templated = true;
        const end = src.indexOf("]]", k + 2);
        if (end === -1) return -1;
        k = end + 1;
      } else if (c === '"') return k;
    }
    return -1;
  };

  /** A heredoc starting at `i` (on `<<`). Its text is a template: interpolations kept in `code`. */
  const readHeredoc = (code) => {
    let j = i + 2;
    if (src[j] === "-") j++;
    const markerStart = j;
    while (j < n && IDENT_CHAR.test(src[j])) j++;
    const marker = src.slice(markerStart, j);
    if (!marker) return false;
    // the rest of the opening line, then lines up to the marker
    let k = src.indexOf("\n", j);
    if (k === -1) {
      i = n;
      return true;
    }
    k++;
    for (;;) {
      const end = src.indexOf("\n", k);
      const lineText = src.slice(k, end === -1 ? n : end);
      if (lineText.trim() === marker) {
        i = end === -1 ? n : end;
        return true;
      }
      // interpolations in the heredoc's text
      for (const m of lineText.matchAll(/[$%]\{([^}]*)\}/g)) code.push(` ${m[1]} `);
      if (lineText.includes("[[")) templated = true;
      if (end === -1) {
        i = n;
        return true;
      }
      k = end + 1;
    }
  };

  /**
   * An expression from `i` to the end of its line (or an unmatched `}` / `,`
   * closing a one-line block), continuing over line breaks inside brackets.
   * @returns {HclExpr}
   */
  const readExpression = () => {
    const start = i;
    /** @type {string[]} */
    const code = [];
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "\n") {
        if (depth === 0) break;
        code.push(" ");
        i++;
        continue;
      }
      if (c === "}" && depth === 0) break;
      if (c === "#" || (c === "/" && src[i + 1] === "/")) {
        skipLine();
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        skipBlockComment();
        continue;
      }
      if (c === '"') {
        readString(code);
        continue;
      }
      if (c === "<" && src[i + 1] === "<" && (src[i + 2] === "-" || IDENT_START.test(src[i + 2] ?? ""))) {
        if (readHeredoc(code)) continue;
      }
      if (c === "[" && src[i + 1] === "[") {
        skipLevant(code);
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
      code.push(c);
      i++;
    }
    let text = src.slice(start, i).trim();
    // a trailing comment on the line was skipped in `code` but sits in `text`
    text = stripTrailingComment(text);
    if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}…`;
    return { text, refs: traversals(code.join("")) };
  };

  /**
   * @param {boolean} nested inside `{ … }`
   * @returns {HclBody}
   */
  const readBody = (nested) => {
    /** @type {HclBody} */
    const body = { attrs: [], blocks: [] };
    while (i < n) {
      skipTrivia(true);
      if (i >= n) break;
      const c = src[i];
      if (c === "}") {
        if (nested) return body;
        i++; // stray brace at top level
        errors++;
        continue;
      }
      if (c === "[" && src[i + 1] === "[") {
        // a Levant directive on its own (`[[ if .x ]]`)
        skipLevant(null);
        continue;
      }
      if (c === ",") {
        i++;
        continue;
      }
      const at = i;
      let name = readIdent();
      if (!name && c === '"') {
        // a quoted key (`"key" = …` in tfvars-like files)
        const end = src.indexOf('"', i + 1);
        if (end !== -1 && !src.slice(i, end).includes("\n")) {
          name = src.slice(i + 1, end);
          i = end + 1;
        }
      }
      if (!name) {
        errors++;
        skipLine();
        if (i === at) i++;
        continue;
      }
      skipTrivia(false);
      if (src[i] === "=" && src[i + 1] !== "=") {
        i++;
        skipTrivia(false);
        const line = lineAt(at);
        const expr = readExpression();
        body.attrs.push({ name, line, endLine: lineAt(Math.max(at, i - 1)), expr });
        continue;
      }
      // a block: labels, then `{`
      /** @type {string[]} */
      const labels = [];
      for (;;) {
        skipTrivia(false);
        if (src[i] === '"') {
          const end = labelEnd(i);
          if (end === -1) break;
          labels.push(src.slice(i + 1, end));
          i = end + 1;
          continue;
        }
        if (i < n && IDENT_START.test(src[i])) {
          labels.push(readIdent());
          continue;
        }
        break;
      }
      if (src[i] !== "{") {
        errors++;
        skipLine();
        continue;
      }
      i++;
      const inner = readBody(true);
      if (src[i] === "}") i++;
      body.blocks.push({ type: name, labels, line: lineAt(at), endLine: lineAt(Math.max(at, i - 1)), body: inner });
    }
    return body;
  };

  const body = readBody(false);
  return { body, ...(templated ? { templated: true } : {}), errors };
}

/** `x = 1 # comment` → `x = 1`, outside strings. */
function stripTrailingComment(text) {
  let inString = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === "\\" && inString) {
      k++;
      continue;
    }
    if (c === '"') inString = !inString;
    if (!inString && (c === "#" || (c === "/" && text[k + 1] === "/"))) return text.slice(0, k).trimEnd();
  }
  return text;
}

/**
 * The traversals in an expression's code (literal string text already blanked).
 * @param {string} code
 * @returns {string[]}
 */
export function traversals(code) {
  const out = new Set();
  for (const m of code.matchAll(KEYWORD_REF)) {
    if (out.size >= MAX_REFS) break;
    out.add(m[0]);
  }
  for (const m of code.matchAll(RESOURCE_REF)) {
    if (out.size >= MAX_REFS) break;
    out.add(m[0]);
  }
  return [...out];
}

/** Block types of Terraform JSON and how many labels each takes. */
const TF_JSON_LABELS = { resource: 2, data: 2, module: 1, variable: 1, output: 1, provider: 1, check: 1, locals: 0, terraform: 0, moved: 0, import: 0, removed: 0 };

/**
 * A Terraform JSON file (`*.tf.json`) or a JSON tfvars file read into the same
 * shape as {@link readHcl}. Values are attributes with their JSON text;
 * `${…}` inside strings gives the traversals. No line numbers beyond the
 * file's first line.
 * @param {string} source
 * @param {"terraform" | "tfvars"} flavor
 * @returns {HclFile}
 */
export function readHclJson(source, flavor) {
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(source);
  } catch {
    return { body: { attrs: [], blocks: [] }, errors: 1 };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { body: { attrs: [], blocks: [] }, errors: 1 };
  if (flavor === "tfvars") return { body: { attrs: objectAttrs(/** @type {Record<string, unknown>} */ (doc)), blocks: [] }, errors: 0 };
  /** @type {HclBody} */
  const body = { attrs: [], blocks: [] };
  for (const [type, value] of Object.entries(/** @type {Record<string, unknown>} */ (doc))) {
    const depth = /** @type {Record<string, number>} */ (TF_JSON_LABELS)[type];
    if (depth === undefined) continue;
    const visit = (v, labels) => {
      if (Array.isArray(v)) {
        for (const item of v) visit(item, labels);
        return;
      }
      if (!v || typeof v !== "object") return;
      if (labels.length < depth) {
        for (const [k, inner] of Object.entries(v)) visit(inner, [...labels, k]);
        return;
      }
      body.blocks.push({ type, labels, line: 1, endLine: 1, body: jsonBody(/** @type {Record<string, unknown>} */ (v)) });
    };
    visit(value, []);
  }
  return { body, errors: 0 };
}

/** Nested blocks Terraform JSON writes as objects. */
const JSON_NESTED_BLOCKS = new Set(["lifecycle", "required_providers", "backend", "provisioner", "connection", "dynamic"]);

function jsonBody(obj) {
  /** @type {HclBody} */
  const body = { attrs: [], blocks: [] };
  for (const [k, v] of Object.entries(obj)) {
    if (JSON_NESTED_BLOCKS.has(k) && v && typeof v === "object" && !Array.isArray(v)) {
      if (k === "backend") {
        for (const [label, inner] of Object.entries(v)) body.blocks.push({ type: k, labels: [label], line: 1, endLine: 1, body: jsonBody(/** @type {any} */ (inner) ?? {}) });
      } else body.blocks.push({ type: k, labels: [], line: 1, endLine: 1, body: jsonBody(/** @type {any} */ (v)) });
      continue;
    }
    body.attrs.push(jsonAttr(k, v));
  }
  return body;
}

function objectAttrs(obj) {
  return Object.entries(obj).map(([k, v]) => jsonAttr(k, v));
}

function jsonAttr(name, value) {
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? "null";
  const code = [];
  for (const m of text.matchAll(/\$\{([^}]*)\}/g)) code.push(m[1]);
  return { name, line: 1, endLine: 1, expr: { text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text, refs: traversals(code.join(" ")) } };
}

/**
 * The value of a literal string expression (`"abc"` → `abc`), or `undefined`
 * when it isn't one (interpolations, references, function calls).
 * @param {string} text
 * @returns {string | undefined}
 */
export function hclString(text) {
  const t = text.trim();
  if (t.length < 2 || t[0] !== '"' || t[t.length - 1] !== '"') return undefined;
  const inner = t.slice(1, -1);
  if (/(^|[^$%])[$%]\{/.test(inner) || /"/.test(inner.replace(/\\"/g, ""))) return undefined;
  return inner.replace(/\\(["\\])/g, "$1").replace(/\\n/g, "\n");
}

/**
 * The elements of a literal list of strings (`["a", "b"]`), or `undefined`.
 * @param {string} text
 * @returns {string[] | undefined}
 */
export function hclStringList(text) {
  const t = text.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return undefined;
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  const out = [];
  for (const part of inner.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const s = hclString(p);
    if (s === undefined) return undefined;
    out.push(s);
  }
  return out;
}
