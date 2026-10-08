/**
 * Kotlin route facts, read lexically like the rest of the Kotlin analyzer:
 * annotated classes and their annotated `fun`s (Spring, JAX-RS and
 * Micronaut controllers — the same shape the Java extractor produces, so
 * lib/analysis/api/decorated.ts reads both), and the constructor properties
 * of classes (DTOs, for request/response shapes). Best-effort: string
 * contents are kept only where an annotation argument needs them.
 */
import type { ModelFact, RouteClassFact, RouteDecorator, RouteFacts, RouteMethodFact, RouteParamFact, Val } from "../../ir";
import { hashText } from "../../syntax/extract.mjs";

const MAX_FIELDS = 40;

/** Offset of the bracket matching the one at `open`, skipping strings; -1 when unbalanced. */
function matching(src: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      const triple = src.startsWith('"""', i);
      const end = triple ? src.indexOf('"""', i + 3) : (() => {
        let j = i + 1;
        while (j < src.length && src[j] !== '"' && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
        return j;
      })();
      if (end === -1) return -1;
      i = triple ? end + 2 : end;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}

/** Split at top-level commas (not inside brackets or strings). */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function value(text: string): Val {
  const t = text.trim();
  const str = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
  if (str) return /\$/.test(str[1]) ? { t: str[1].replace(/\$\{?([\w.]+)\}?/g, "{$1}") } : { s: str[1] };
  const list = /^(?:\[|arrayOf\()([\s\S]*)[\])]$/.exec(t);
  if (list) return { list: splitArgs(list[1]).map(value) };
  if (/^[\w.]+$/.test(t)) return /^(true|false)$/.test(t) ? { x: t } : { id: t };
  if (/^"[^"]*"(\s*\+\s*[\w."]+)+$/.test(t)) return { t: t.split("+").map((p) => (p.trim().startsWith('"') ? p.trim().slice(1, -1) : `{${p.trim()}}`)).join("") };
  return { x: t.slice(0, 120) };
}

function annotation(name: string, argText: string | undefined): RouteDecorator {
  const args: Val[] = [];
  const kw: Record<string, Val> = {};
  for (const part of argText ? splitArgs(argText) : []) {
    const pair = /^(\w+)\s*=\s*([\s\S]+)$/.exec(part);
    if (pair) kw[pair[1]] = value(pair[2]);
    else args.push(value(part));
  }
  return { name: name.split(".").pop()!, args, ...(Object.keys(kw).length ? { kw } : {}) };
}

/** The annotations written right before `end` (an offset), in order. */
function annotationsBefore(src: string, from: number, end: number): RouteDecorator[] {
  const out: RouteDecorator[] = [];
  const text = src.slice(from, end);
  const re = /@([\w.]+)(?=[\s(@]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const after = from + m.index + m[0].length;
    let args: string | undefined;
    if (src[after] === "(") {
      const close = matching(src, after, "(", ")");
      if (close !== -1) {
        args = src.slice(after + 1, close);
        re.lastIndex = close - from + 1;
      }
    }
    // @get:JsonProperty("x") — a use-site target, not an annotation name.
    if (m[1].includes(":")) continue;
    out.push(annotation(m[1], args));
  }
  return out;
}

function params(src: string, open: number, close: number): RouteParamFact[] {
  const out: RouteParamFact[] = [];
  for (const part of splitArgs(src.slice(open + 1, close))) {
    const m = /^((?:@[\w.]+(?:\([^)]*\))?\s*)*)(?:(?:val|var|private|override|open|internal|protected)\s+)*(\w+)\s*:\s*([^=]+?)(\s*=\s*[\s\S]+)?$/.exec(part);
    if (!m) continue;
    const annotations = m[1] ? annotationsBefore(m[1], 0, m[1].length) : [];
    out.push({ name: m[2], type: m[3].trim(), ...(m[3].trim().endsWith("?") || m[4] ? { optional: true } : {}), ...(annotations.length ? { annotations } : {}) });
  }
  return out;
}

export function kotlinRoutes(source: string): RouteFacts | undefined {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const classes: RouteClassFact[] = [];
  const models: ModelFact[] = [];
  const classRe = /(^|\n)([ \t]*(?:@[\w.]+(?:\([^)]*\))?\s*)*)((?:(?:public|private|internal|open|abstract|data|sealed|final)\s+)*)class\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(source))) {
    const name = m[4];
    const headStart = m.index + m[1].length;
    const afterName = m.index + m[0].length;
    const annotations = annotationsBefore(source, headStart, headStart + m[2].length);

    // Primary constructor: `class X(val a: Int, …)` — fields for shapes.
    let cursor = afterName;
    while (/\s/.test(source[cursor] ?? "")) cursor++;
    if (source[cursor] === "<") cursor = matching(source, cursor, "<", ">") + 1;
    while (/[\s\w@]/.test(source[cursor] ?? "") && source[cursor] !== "(" && source[cursor] !== "{" && source[cursor] !== ":") cursor++;
    if (source[cursor] === "(") {
      const close = matching(source, cursor, "(", ")");
      if (close !== -1) {
        // Only a constructor that declares properties (`val` / `var`) describes a shape.
        const declaresProperties = /\b(val|var)\b/.test(source.slice(cursor, close));
        const fields = (declaresProperties ? params(source, cursor, close) : [])
          .slice(0, MAX_FIELDS)
          .map((p) => ({ name: p.name, type: p.type ?? "", ...(p.optional ? { optional: true } : {}) }));
        if (fields.length) models.push({ name, line: lineOf(headStart), bases: [], fields });
        cursor = close + 1;
      }
    }
    const bodyOpen = source.indexOf("{", cursor);
    const nextClass = source.slice(cursor).search(/\n[ \t]*(?:@[\w.]+[^\n]*\n\s*)*(?:\w+\s+)*class\s/);
    if (bodyOpen === -1 || (nextClass !== -1 && bodyOpen > cursor + nextClass)) {
      if (annotations.length) classes.push({ name, line: lineOf(headStart), endLine: lineOf(cursor), annotations, methods: [] });
      continue;
    }
    const bodyClose = matching(source, bodyOpen, "{", "}");
    const bodyEnd = bodyClose === -1 ? source.length : bodyClose;

    const methods: RouteMethodFact[] = [];
    const funRe = /((?:@[\w.]+(?:\((?:[^()]|\([^()]*\))*\))?\s*)+)((?:(?:public|private|internal|open|override|suspend|final|protected)\s+)*)fun\s+(?:<[^>]*>\s*)?(\w+)\s*\(/g;
    funRe.lastIndex = bodyOpen;
    let f: RegExpExecArray | null;
    while ((f = funRe.exec(source)) && f.index < bodyEnd) {
      const open = f.index + f[0].length - 1;
      const close = matching(source, open, "(", ")");
      if (close === -1) break;
      const rest = source.slice(close + 1, close + 300);
      const returns = /^\s*:\s*([^={\n]+)/.exec(rest)?.[1]?.trim();
      const bodyStart = close + 1 + rest.search(/[={]/);
      const end = source[bodyStart] === "{" ? matching(source, bodyStart, "{", "}") : source.indexOf("\n", bodyStart);
      const stop = end === -1 ? bodyEnd : end;
      methods.push({
        name: f[3],
        line: lineOf(f.index),
        endLine: lineOf(stop),
        hash: hashText(source.slice(f.index, stop + 1)),
        annotations: annotationsBefore(source, f.index, f.index + f[1].length),
        params: params(source, open, close),
        ...(returns ? { returns } : {}),
      });
      funRe.lastIndex = Math.max(funRe.lastIndex, stop);
    }
    if (annotations.length || methods.length) classes.push({ name, line: lineOf(headStart), endLine: lineOf(bodyEnd), annotations, methods });
    classRe.lastIndex = Math.max(classRe.lastIndex, bodyOpen + 1);
  }

  const out: RouteFacts = {};
  if (classes.length) out.classes = classes;
  if (models.length) out.models = models;
  return Object.keys(out).length ? out : undefined;
}
