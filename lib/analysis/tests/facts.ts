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

const COMMENT_START: Record<Family, RegExp> = {
  js: /\/\/|\/\*/,
  python: /#/,
  jvm: /\/\/|\/\*/,
  go: /\/\//,
  other: /$^/,
};

/** Cases and markers of a test file; `null` for a language it can't read. */
export function scanTestFacts(languageId: string, source: string): TestFileFacts | null {
  const family = familyOf(languageId);
  if (family === "other") return null;
  const lines = source.split(/\r?\n/);
  let cases = 0;
  const markers: TestMarker[] = [];
  const casesRe = CASES[family];
  lines.forEach((text, i) => {
    // Code before a line comment only; a marker in a comment is not a marker.
    const comment = COMMENT_START[family].exec(text);
    const code = comment ? text.slice(0, comment.index) : text;
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
