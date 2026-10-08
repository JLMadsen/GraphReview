// Syntax highlighting for the code views (DiffViewer, the file viewer's
// FileText, chat code blocks). highlight.js, bundled — no CDN, so it works
// air-gapped — with only the languages registered below, picked by file
// extension.
//
// The views render one table row per line, so highlighted HTML is split into
// lines here: a token that spans lines (a block comment, a template string)
// has its <span>s closed at each line end and reopened on the next. A diff is
// highlighted one hunk side at a time — the old text (context + removed
// lines) and the new text (context + added lines) — so each line is coloured
// in the context of the code around it rather than on its own.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { DiffHunk } from "./diff-utils";

const LANGUAGES = {
  bash, c, cpp, csharp, css, dockerfile, go, graphql, ini, java, javascript, json, kotlin,
  less, makefile, markdown, php, powershell, python, ruby, rust, scss, sql, swift, typescript, xml, yaml,
};
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python",
  go: "go", java: "java", kt: "kotlin", kts: "kotlin", rs: "rust",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", php: "php", rb: "ruby", swift: "swift",
  css: "css", scss: "scss", less: "less",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", svelte: "xml",
  json: "json", jsonc: "json", json5: "json",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", properties: "ini",
  md: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", psm1: "powershell",
  sql: "sql", graphql: "graphql", gql: "graphql",
};

const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
};

/** The highlight.js language for a file, or `null` for one it has no grammar for. */
export function languageForPath(path: string | undefined): string | null {
  if (!path) return null;
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  if (name === ".env" || name.startsWith(".env.")) return "bash";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (BY_EXTENSION[name.slice(dot + 1)] ?? null) : null;
}

/** The language a chat code fence names (```ts, ```python, …), if registered. */
export function languageForFence(tag: string): string | null {
  const name = tag.trim().toLowerCase();
  if (!name) return null;
  if (hljs.getLanguage(name)) return name;
  return BY_EXTENSION[name] ?? null;
}

/** Past this much text a file is shown plain — highlighting it would stall the page. */
const MAX_CHARS = 1_000_000;

const TAG = /<span[^>]*>|<\/span>|\n/g;

/** highlight.js HTML cut into lines, every line's open spans closed at its end and reopened on the next. */
function splitLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let line = "";
  let last = 0;
  for (const match of html.matchAll(TAG)) {
    line += html.slice(last, match.index);
    last = match.index + match[0].length;
    const tag = match[0];
    if (tag === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else if (tag === "</span>") {
      open.pop();
      line += tag;
    } else {
      open.push(tag);
      line += tag;
    }
  }
  lines.push(line + html.slice(last));
  return lines;
}

/**
 * `lines` highlighted together, as one escaped HTML string per line — or
 * `null` when there is no grammar for the language or the text is too big.
 */
export function highlightLines(lines: readonly string[], language: string | null): string[] | null {
  if (!language || !hljs.getLanguage(language)) return null;
  const text = lines.join("\n");
  if (text.length > MAX_CHARS) return null;
  try {
    const out = splitLines(hljs.highlight(text, { language, ignoreIllegals: true }).value);
    return out.length === lines.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Every line of every hunk highlighted, as `[hunk][line]` HTML (`null` for
 * meta lines), or `null` when the file can't be highlighted. Context lines
 * take the new side's colouring.
 */
export function highlightHunks(hunks: readonly DiffHunk[], language: string | null): (string | null)[][] | null {
  if (!language || !hljs.getLanguage(language)) return null;
  const out: (string | null)[][] = [];
  for (const hunk of hunks) {
    const oldText: string[] = [];
    const newText: string[] = [];
    for (const line of hunk.lines) {
      if (line.type !== "add" && line.type !== "meta") oldText.push(line.content);
      if (line.type !== "remove" && line.type !== "meta") newText.push(line.content);
    }
    const oldHtml = highlightLines(oldText, language);
    const newHtml = highlightLines(newText, language);
    if (!oldHtml || !newHtml) return null;
    let o = 0;
    let n = 0;
    out.push(
      hunk.lines.map((line) => {
        if (line.type === "meta") return null;
        if (line.type === "remove") return oldHtml[o++];
        if (line.type === "context") o++;
        return newHtml[n++];
      })
    );
  }
  return out;
}
