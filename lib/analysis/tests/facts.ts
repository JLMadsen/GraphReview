// Test cases and skip/focus markers in a test file's text — a lexical scan
// beside each parse, cached by blob (DESIGN.md §6.22 §1).

import type { TestFileFacts, TestMarker } from "./types";

type Family = "js" | "python" | "jvm" | "go" | "other";

function familyOf(languageId: string): Family {
  if (/^(typescript|tsx|javascript|jsx)$/.test(languageId)) return "js";
  if (languageId === "python") return "python";
  if (/^(java|kotlin|scala)$/.test(languageId)) return "jvm";
  if (languageId === "go") return "go";
  return "other";
}

const CASES: Record<Family, RegExp | null> = {
  js: /(?<![\w.$])(?:it|test|fit|xit|ftest|xtest)(?:\.(?:only|skip|todo|concurrent|fixme|fails|each\s*(?:\([^)]*\)|`[^`]*`)))*\s*\(/g,
  python: /^\s*(?:async\s+)?def\s+test\w*\s*\(/gm,
  jvm: /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/g,
  go: /^func\s+Test\w*\s*\(/gm,
  other: null,
};

const MARKERS: Record<Family, Array<{ re: RegExp; kind: TestMarker["kind"] }>> = {
  js: [
    { re: /(?<![\w.$])(?:describe|it|test|context|suite)\.only\b/g, kind: "focus" },
    { re: /(?<![\w.$])(?:fit|fdescribe|ftest)\s*\(/g, kind: "focus" },
    { re: /(?<![\w.$])(?:describe|it|test|context|suite)\.(?:skip|fixme)\b/g, kind: "skip" },
    { re: /(?<![\w.$])(?:xit|xdescribe|xtest|xcontext)\s*\(/g, kind: "skip" },
  ],
  python: [
    { re: /@pytest\.mark\.skip(?:if)?\b/g, kind: "skip" },
    { re: /(?<![\w.])pytest\.skip\s*\(/g, kind: "skip" },
    { re: /@unittest\.skip(?:If|Unless)?\b/g, kind: "skip" },
  ],
  jvm: [{ re: /@(?:Disabled|Ignore)\b/g, kind: "skip" }],
  go: [{ re: /\bt\.Skip(?:f|Now)?\s*\(/g, kind: "skip" }],
  other: [],
};

// After one of these, a JS `/` starts a regex literal rather than dividing.
const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%<>~^"]);

/**
 * The source with comments and the contents of string, template and regex
 * literals blanked to spaces (newlines and quote marks kept, so lines and
 * columns stay put). A marker inside one is text, not a marker: a fixture
 * like `'it.only("x")'` in a test of a test scanner, or "it.only" in a
 * test's name.
 */
function codeOnly(src: string, family: Family): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  const lineComment = family === "python" ? "#" : "//";
  const blockComments = family !== "python";
  const tripleQuotes = family === "python" || family === "jvm";
  const n = src.length;
  let prev = "";
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (src.startsWith(lineComment, i) || (blockComments && src.startsWith("/*", i))) {
      const block = src[i] === "/" && src[i + 1] === "*";
      const at = block ? src.indexOf("*/", i + 2) : src.indexOf("\n", i);
      const end = at < 0 ? n : block ? at + 2 : at;
      blank(i, end);
      i = end;
      continue;
    }
    if (tripleQuotes && (src.startsWith('"""', i) || src.startsWith("'''", i))) {
      const at = src.indexOf(src.slice(i, i + 3), i + 3);
      const end = at < 0 ? n : at;
      blank(i + 3, end);
      i = at < 0 ? n : at + 3;
      prev = c;
      continue;
    }
    const backtick = c === "`" && (family === "js" || family === "go");
    const regex = c === "/" && family === "js" && (prev === "" || REGEX_AFTER.has(prev));
    if (c === '"' || c === "'" || backtick || regex) {
      // Backtick strings may span lines (Go's are raw: no escapes); the rest end at the line.
      let j = i + 1;
      let inClass = false;
      for (; j < n; j++) {
        const d = src[j];
        if (d === "\n" && !backtick) break;
        if (d === "\\" && !(backtick && family === "go")) {
          j++;
          continue;
        }
        if (regex && d === "[") inClass = true;
        else if (regex && d === "]") inClass = false;
        else if (d === c && !inClass) break;
      }
      blank(i + 1, Math.min(j, n));
      i = j + 1;
      prev = c;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

/** Cases and markers of a test file; `null` for a language it can't read. */
export function scanTestFacts(languageId: string, source: string): TestFileFacts | null {
  const family = familyOf(languageId);
  if (family === "other") return null;
  const lines = codeOnly(source, family).split(/\r?\n/);
  let cases = 0;
  const markers: TestMarker[] = [];
  const casesRe = CASES[family];
  lines.forEach((code, i) => {
    if (!code.trim()) return;
    if (casesRe) {
      casesRe.lastIndex = 0;
      cases += [...code.matchAll(casesRe)].length;
    }
    for (const { re, kind } of MARKERS[family]) {
      re.lastIndex = 0;
      for (const m of code.matchAll(re)) markers.push({ line: i + 1, marker: m[0].replace(/\s*\($/, "").trim(), kind });
    }
  });
  return { cases, markers };
}
