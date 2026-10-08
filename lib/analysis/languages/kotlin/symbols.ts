/**
 * Kotlin symbol facts, read lexically like the rest of the Kotlin analyzer
 * (see ./index.ts for why there is no grammar): top-level declarations and
 * the methods of top-level classes, imports with their bound names, and the
 * calls and references in between. Best-effort by design — declaration ends
 * come from brace matching, and an expression-bodied function ends where the
 * next declaration starts.
 */
import type { CallFact, DeclFact, DeclKind, ImportFact, SymbolFacts } from "../../ir";
import { tokenize, type Token } from "../jvm/tokenize";
import { hashText } from "../../syntax/hash.mjs";
import { kotlinRoutes } from "./routes";

const MODIFIERS = new Set([
  "public", "private", "protected", "internal", "open", "abstract", "final", "override", "sealed", "data",
  "inline", "suspend", "operator", "infix", "tailrec", "external", "const", "lateinit", "annotation", "enum",
  "inner", "value", "expect", "actual", "companion", "fun",
]);
const DECL_KEYWORDS = new Set(["fun", "class", "interface", "object", "val", "var", "typealias"]);
const MAX_SIGNATURE = 600;

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function collapse(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SIGNATURE ? `${flat.slice(0, MAX_SIGNATURE)}…` : flat;
}

interface Pending {
  fact: DeclFact;
  startAt: number;
  endAt: number;
  depth: number;
}

/** Index of the `}` matching the `{` at `open`, or the last token. */
function matchBrace(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].k !== "p") continue;
    if (tokens[i].v === "{") depth++;
    else if (tokens[i].v === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

/**
 * The last token of an expression body (`fun f() = …`, `val x = …`) starting
 * at its `=`: up to the next declaration at the same nesting, or the `}`
 * closing the scope it sits in.
 */
function expressionEnd(tokens: Token[], eq: number): number {
  let nesting = 0;
  for (let i = eq + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k === "p") {
      if (t.v === "(" || t.v === "{" || t.v === "[") nesting++;
      else if (t.v === ")" || t.v === "]") nesting--;
      else if (t.v === "}") {
        if (nesting === 0) return i - 1;
        nesting--;
      }
      continue;
    }
    if (nesting === 0 && i > eq + 1 && tokens[i - 1].v !== "." && (DECL_KEYWORDS.has(t.v) || MODIFIERS.has(t.v)) && t.v !== "fun") {
      return i - 1;
    }
    if (nesting === 0 && t.v === "fun" && tokens[i - 1].v !== ".") return i - 1;
  }
  return tokens.length - 1;
}

export function kotlinSymbols(source: string): SymbolFacts {
  const tokens = tokenize(source, { kotlin: true });
  const starts = lineStarts(source);
  const line = (t: Token) => lineAt(starts, t.at);
  const imports: ImportFact[] = [];
  const pending: Pending[] = [];
  const refs: Record<string, number[]> = Object.create(null);
  const members: Record<string, number[]> = Object.create(null);
  const calls: Array<Omit<CallFact, "inDecl"> & { at: number }> = [];
  let pkg = "";

  const push = (map: Record<string, number[]>, key: string, ln: number) => {
    const lines = (map[key] ??= []);
    if (lines[lines.length - 1] !== ln) lines.push(ln);
  };

  /** Reads a dotted name starting at `i`; returns it and the index after it. */
  const dotted = (i: number): [string, number] => {
    const parts: string[] = [];
    while (i < tokens.length && tokens[i].k === "id") {
      parts.push(tokens[i].v);
      if (tokens[i + 1]?.v === "." && (tokens[i + 2]?.k === "id" || tokens[i + 2]?.v === "*")) {
        if (tokens[i + 2].v === "*") {
          parts.push("*");
          return [parts.join("."), i + 3];
        }
        i += 2;
      } else {
        i++;
        break;
      }
    }
    return [parts.join("."), i];
  };

  // Class bodies the walk is inside: depth at which the body's members sit, and the class name.
  const classBodies: Array<{ depth: number; name: string; closeAt: number }> = [];
  let depth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.k === "p") {
      if (token.v === "{") depth++;
      else if (token.v === "}") {
        depth--;
        while (classBodies.length > 0 && classBodies[classBodies.length - 1].closeAt <= i) classBodies.pop();
      }
      continue;
    }
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const ln = line(token);

    if (depth === 0 && token.v === "package" && (i === 0 || prev?.v !== ".")) {
      [pkg] = dotted(i + 1);
      continue;
    }
    if (depth === 0 && token.v === "import" && prev?.v !== ".") {
      const [name, after] = dotted(i + 1);
      const star = name.endsWith(".*");
      let local = name.split(".").pop() ?? name;
      let end = after;
      if (tokens[after]?.v === "as" && tokens[after + 1]?.k === "id") {
        local = tokens[after + 1].v;
        end = after + 2;
      }
      imports.push({
        source: star ? name.slice(0, -2) : name,
        bindings: star ? [] : [{ imported: name.split(".").pop()!, local }],
        typeOnly: false,
        startLine: ln,
        endLine: line(tokens[Math.max(i, end - 1)]),
        kind: "import",
        ...(star ? { star: true } : {}),
      });
      i = end - 1;
      continue;
    }

    const memberDepth = classBodies.length > 0 ? classBodies[classBodies.length - 1].depth : -1;
    const atTop = depth === 0;
    const inClass = memberDepth === depth && depth > 0;
    if ((atTop || inClass) && DECL_KEYWORDS.has(token.v) && prev?.v !== ".") {
      // Walk back over modifiers/annotations for the declaration's start.
      let start = i;
      while (start > 0 && tokens[start - 1].k === "id" && MODIFIERS.has(tokens[start - 1].v)) start--;
      const modifiers = tokens.slice(start, i).map((t) => t.v);
      const isPrivate = modifiers.includes("private");
      let j = i + 1;
      if (tokens[j]?.v === "<") {
        let angle = 0;
        for (; j < tokens.length; j++) {
          if (tokens[j].v === "<") angle++;
          else if (tokens[j].v === ">" && --angle === 0) {
            j++;
            break;
          }
        }
      }
      // `fun Receiver.name(`: the name is the identifier right before `(`.
      let nameIndex = j;
      while (tokens[nameIndex + 1]?.v === "." && tokens[nameIndex + 2]?.k === "id") nameIndex += 2;
      const nameToken = tokens[nameIndex];
      if (!nameToken || nameToken.k !== "id") continue;
      const kind: DeclKind =
        token.v === "fun" ? (inClass ? "method" : "function")
          : token.v === "interface" ? "interface"
            : token.v === "typealias" ? "type"
              : token.v === "val" ? (inClass ? "variable" : "const")
                : token.v === "var" ? "variable"
                  : modifiers.includes("enum") ? "enum" : "class";
      if (inClass && kind !== "method") continue; // only methods of classes
      // Body: the first `{` (or `=`) outside parentheses after the name.
      let k = nameIndex + 1;
      let paren = 0;
      let bodyOpen = -1;
      let signatureEnd = -1;
      for (; k < tokens.length; k++) {
        const v = tokens[k].v;
        if (tokens[k].k !== "p") {
          if (paren === 0 && DECL_KEYWORDS.has(v) && k > nameIndex + 1 && tokens[k - 1].v !== ".") break;
          continue;
        }
        if (v === "(") paren++;
        else if (v === ")") paren--;
        else if (paren === 0 && v === "{") {
          bodyOpen = k;
          signatureEnd = k;
          break;
        } else if (paren === 0 && v === "=") {
          signatureEnd = k;
          break;
        } else if (paren === 0 && (v === "}" || v === ";")) break;
      }
      const endIndex = bodyOpen >= 0 ? matchBrace(tokens, bodyOpen) : signatureEnd >= 0 ? expressionEnd(tokens, signatureEnd) : Math.max(nameIndex, k - 1);
      const sigEndAt = signatureEnd >= 0 ? tokens[signatureEnd].at : tokens[Math.min(endIndex, tokens.length - 1)].at + tokens[Math.min(endIndex, tokens.length - 1)].v.length;
      const parent = inClass ? classBodies[classBodies.length - 1].name : undefined;
      pending.push({
        fact: {
          name: nameToken.v,
          kind,
          ...(parent ? { parent } : {}),
          exported: isPrivate || inClass ? (inClass && !isPrivate ? nameToken.v : null) : nameToken.v,
          startLine: line(tokens[start]),
          endLine: line(tokens[endIndex]),
          signature: collapse(source.slice(tokens[start].at, sigEndAt)),
          textHash: hashText(source.slice(tokens[start].at, tokens[endIndex].at + tokens[endIndex].v.length)),
        },
        startAt: tokens[start].at,
        endAt: tokens[endIndex].at,
        depth,
      });
      if (atTop && (kind === "class" || kind === "interface" || kind === "enum") && bodyOpen >= 0) {
        classBodies.push({ depth: depth + 1, name: nameToken.v, closeAt: endIndex });
      }
      continue;
    }

    push(refs, token.v, ln);
    if (next?.v === "." && tokens[i + 2]?.k === "id") push(members, `${token.v}.${tokens[i + 2].v}`, ln);
    if (next?.v === "(" && prev?.v !== "fun") {
      const qualified = prev?.v === "." || prev?.v === "?.";
      const objectToken = qualified ? tokens[i - 2] : undefined;
      const object = objectToken ? (objectToken.k === "id" ? (objectToken.v === "this" ? "this" : objectToken.v) : "?") : undefined;
      calls.push({ callee: token.v, ...(object ? { object } : {}), line: ln, kind: "call", at: token.at });
    }
  }

  const decls = pending.map((p) => p.fact);
  // A call belongs to the innermost declaration whose range holds it.
  const routes = kotlinRoutes(source);
  const inDecl = (at: number): number => {
    let best = -1;
    let bestSpan = Infinity;
    pending.forEach((p, index) => {
      if (p.startAt <= at && at <= p.endAt && p.endAt - p.startAt < bestSpan) {
        best = index;
        bestSpan = p.endAt - p.startAt;
      }
    });
    return best;
  };
  return {
    decls,
    imports,
    exports: [],
    refs,
    members,
    calls: calls.map(({ at, ...call }) => ({ ...call, inDecl: inDecl(at) })),
    pkg,
    ...(routes ? { routes } : {}),
  };
}
