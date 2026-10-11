/**
 * Reading schema files that aren't code (DESIGN.md §6.13 §2): `.sql`
 * (migrations, schema dumps), `.prisma`, Drizzle's `meta/_journal.json` and
 * Prisma's `migration_lock.toml`. One file at a time, no cross-file
 * knowledge — cached by the file's git blob, like a parse. Which folder is
 * which tool's migrations is decided across files in ./sources.ts.
 *
 * Also the lexical SQL-literal scan for code languages without a syntax-tree
 * reader for tables (Go, Java, Kotlin, Rust): string literals that start
 * like SQL, for the "from SQL text" links.
 */
import { guessDialect, parseSql } from "./sql";
import type { DbCodeFacts, DbDialect, DbOp } from "./types";

export type DbReader = "sql" | "prisma" | "journal" | "prisma-lock";

export interface PrismaField {
  name: string;
  type: string;
  optional?: true;
  list?: true;
  /** Field attributes as written (`@id @default(autoincrement()) @db.VarChar(50)`). */
  attrs: string;
  line: number;
}

export interface PrismaBlock {
  kind: "model" | "view" | "enum" | "type";
  name: string;
  line: number;
  endLine: number;
  fields: PrismaField[];
  /** `@@map("x")`, `@@index([a])`, … as written. */
  blockAttrs: string[];
  /** Enum values (with their `@map` names when mapped). */
  values?: Array<{ name: string; map?: string }>;
}

export interface PrismaFacts {
  provider?: string;
  /** `schemas = ["a", "b"]` (multiSchema). */
  schemas?: string[];
  blocks: PrismaBlock[];
}

export type DbFileFacts =
  | {
      kind: "sql";
      ops: DbOp[];
      dialect?: DbDialect;
      markers?: "dbmate" | "goose";
      statements: number;
      /**
       * Where a comment starts a new part of the file (the first line of a
       * run of comment lines after code), with the comment's first line —
       * a change log's entries (./sources/sql-files.ts).
       */
      blocks?: Array<{ line: number; title: string }>;
    }
  | { kind: "prisma"; prisma: PrismaFacts }
  | { kind: "journal"; dialect?: string; entries: Array<{ idx: number; tag: string; when?: number }> }
  | { kind: "prisma-lock"; provider?: string }
  | { kind: "none" };

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Which reader a non-code file needs, if any. */
export function dbReaderFor(path: string): DbReader | undefined {
  const name = base(path);
  const lower = name.toLowerCase();
  if (lower.endsWith(".prisma")) return "prisma";
  if (lower === "_journal.json" && path.includes("/meta/")) return "journal";
  if (lower === "migration_lock.toml") return "prisma-lock";
  if (lower.endsWith(".sql")) {
    if (/\.down\.sql$/i.test(name) || /^U\d[\w.]*__/.test(name)) return undefined;
    return "sql";
  }
  return undefined;
}

/** The up part of a dbmate / goose file, with its first line. */
function upSection(source: string): { text: string; firstLine: number; markers?: "dbmate" | "goose" } {
  const lines = source.split("\n");
  const dbmateUp = lines.findIndex((l) => /^\s*--\s*migrate:up\b/.test(l));
  const gooseUp = lines.findIndex((l) => /^\s*--\s*\+goose\s+up\b/i.test(l));
  const start = dbmateUp >= 0 ? dbmateUp : gooseUp;
  if (start < 0) return { text: source, firstLine: 1 };
  const markers = dbmateUp >= 0 ? "dbmate" : "goose";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (markers === "dbmate" ? /^\s*--\s*migrate:down\b/.test(lines[i]) : /^\s*--\s*\+goose\s+down\b/i.test(lines[i])) {
      end = i;
      break;
    }
  }
  // goose statement blocks are a comment pair around one statement; the `;` split handles them.
  return { text: lines.slice(start + 1, end).join("\n"), firstLine: start + 2, markers };
}

export function readPrisma(source: string): PrismaFacts {
  const facts: PrismaFacts = { blocks: [] };
  const lines = source.split(/\r?\n/);
  let block: PrismaBlock | null = null;
  let inDatasource = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\/\/.*$/, "").trim();
    if (!raw) continue;
    const open = /^(model|view|enum|type|datasource|generator)\s+(\w+)\s*\{\s*(\})?$/.exec(raw);
    if (open && !block && !inDatasource) {
      if (open[1] === "datasource") {
        inDatasource = !open[3];
        continue;
      }
      if (open[1] === "generator") {
        // Skipped like a datasource, without reading it.
        if (!open[3]) {
          while (i < lines.length && !/^\s*\}/.test(lines[i])) i++;
        }
        continue;
      }
      block = { kind: open[1] as PrismaBlock["kind"], name: open[2], line: i + 1, endLine: i + 1, fields: [], blockAttrs: [], ...(open[1] === "enum" ? { values: [] } : {}) };
      if (open[3]) {
        facts.blocks.push(block);
        block = null;
      }
      continue;
    }
    if (inDatasource) {
      if (raw === "}") {
        inDatasource = false;
        continue;
      }
      const provider = /^provider\s*=\s*"([^"]+)"/.exec(raw);
      if (provider) facts.provider = provider[1];
      const schemas = /^schemas\s*=\s*\[([^\]]*)\]/.exec(raw);
      if (schemas) facts.schemas = [...schemas[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      continue;
    }
    if (!block) continue;
    if (raw === "}") {
      block.endLine = i + 1;
      facts.blocks.push(block);
      block = null;
      continue;
    }
    if (raw.startsWith("@@")) {
      block.blockAttrs.push(raw);
      continue;
    }
    if (block.kind === "enum") {
      const m = /^(\w+)\s*(?:@map\("([^"]*)"\))?/.exec(raw);
      if (m) block.values!.push({ name: m[1], ...(m[2] !== undefined ? { map: m[2] } : {}) });
      continue;
    }
    const f = /^(\w+)\s+([\w.]+(?:\([^)]*\))?)(\[\])?(\?)?\s*(.*)$/.exec(raw);
    if (f) block.fields.push({ name: f[1], type: f[2], ...(f[3] ? { list: true as const } : {}), ...(f[4] ? { optional: true as const } : {}), attrs: f[5], line: i + 1 });
  }
  return facts;
}

/** Comment runs that follow code (or open the file): each starts a part of the file. */
export function commentBlocks(text: string, firstLine = 1): Array<{ line: number; title: string }> {
  const out: Array<{ line: number; title: string }> = [];
  const lines = text.split("\n");
  let prev: "code" | "comment" | "start" = "start";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const comment = l.startsWith("--") || l.startsWith("/*") || l.startsWith("#");
    if (comment && prev !== "comment") {
      const title = l.replace(/^(--+|\/\*+|#+)\s*/, "").replace(/\*+\/\s*$/, "").trim();
      out.push({ line: firstLine + i, title: title.slice(0, 120) });
    }
    prev = comment ? "comment" : "code";
  }
  return out;
}

export function readDbFile(reader: DbReader, path: string, source: string): DbFileFacts {
  try {
    switch (reader) {
      case "sql": {
        const up = upSection(source.replace(/\r\n/g, "\n"));
        const ops = parseSql(up.text, up.firstLine);
        const dialect = guessDialect([up.text]);
        const blocks = commentBlocks(up.text, up.firstLine);
        return { kind: "sql", ops, ...(dialect ? { dialect } : {}), ...(up.markers ? { markers: up.markers } : {}), statements: ops.length, ...(blocks.length ? { blocks } : {}) };
      }
      case "prisma":
        return { kind: "prisma", prisma: readPrisma(source) };
      case "journal": {
        const json = JSON.parse(source) as { dialect?: string; entries?: Array<{ idx: number; tag: string; when?: number }> };
        return { kind: "journal", ...(json.dialect ? { dialect: json.dialect } : {}), entries: (json.entries ?? []).map((e) => ({ idx: e.idx, tag: e.tag, ...(e.when ? { when: e.when } : {}) })) };
      }
      case "prisma-lock": {
        const provider = /provider\s*=\s*"([^"]+)"/.exec(source)?.[1];
        return { kind: "prisma-lock", ...(provider ? { provider } : {}) };
      }
    }
  } catch (error) {
    console.warn(`[db] could not read ${path}: ${(error as Error).message}`);
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// SQL literals in code without a syntax-tree reader
// ---------------------------------------------------------------------------

const SQLISH = /^\s*(select\s[\s\S]*\sfrom\s|insert\s+into\s|update\s+[\w".`[\]]+\s+set\s|delete\s+from\s|with\s+(recursive\s+)?\w+\s+as\s*\()/i;
const LEXICAL_LANGUAGES = new Set(["go", "java", "kotlin", "rust"]);
/** Leading SQL comments (sqlc's `-- name: X :one`) don't stop a literal reading as SQL. */
const LEADING_COMMENTS = /^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))+/;

/** DDL at a literal's start, naming its object — a schema defined in code (same rule as ../syntax/db.mjs). */
export const DDL_LITERAL = /^\s*(create\s+(or\s+replace\s+)?((temp|temporary|unlogged|virtual)\s+)?(table|(unique\s+)?index|type|(materialized\s+)?view)|alter\s+(table|type)|drop\s+(table|index|type|view))\s+(if\s+(not\s+)?exists\s+)?(concurrently\s+)?["`[\w]/i;

/**
 * String literals that start like SQL, in Go / Java / Kotlin / Rust source,
 * and literals holding DDL (kept apart: a definition, not a use). A DDL
 * literal's group is the bracket it sits in, so the elements of one slice /
 * list / array literal are ordered migrations. `undefined` when there are
 * none (or for other languages).
 */
export function scanSqlLiterals(language: string, source: string): DbCodeFacts | undefined {
  if (!LEXICAL_LANGUAGES.has(language)) return undefined;
  if (!/\b(select|insert|update|delete|with|create|alter|drop)\b/i.test(source)) return undefined;
  const uses: NonNullable<DbCodeFacts["uses"]> = [];
  const ddl: NonNullable<DbCodeFacts["ddl"]> = [];
  /** Open brackets (their offsets) around the current position, and the DDL literals counted per bracket. */
  const brackets: number[] = [];
  const perBracket = new Map<number, number>();
  const writes = new Set<number>();
  let line = 1;
  let i = 0;
  const n = source.length;
  const add = (text: string, at: number) => {
    const bare = text.replace(LEADING_COMMENTS, "");
    if (DDL_LITERAL.test(bare)) {
      if (ddl.length >= 400) return;
      const open = brackets[brackets.length - 1];
      const index = (perBracket.get(open ?? -1) ?? 0) + 1;
      perBracket.set(open ?? -1, index);
      ddl.push({ text: text.slice(0, 20000), line: at, ...(open !== undefined ? { group: `b${open}`, index } : {}) });
      return;
    }
    if (uses.length >= 600 || !SQLISH.test(bare)) return;
    uses.push({ k: "sql", text: text.slice(0, 4000), line: at, lit: 1 });
    if (/^\s*(insert|update|delete)\b/i.test(text)) writes.add(at);
  };
  while (i < n) {
    const c = source[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    // Text blocks / raw strings: """…""" (Java, Kotlin), `…` (Go), r#"…"# (Rust).
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      const stop = end < 0 ? n : end;
      const text = source.slice(i + 3, stop);
      add(text, line);
      for (const ch of text) if (ch === "\n") line++;
      i = stop + 3;
      continue;
    }
    if (c === "`" && language === "go") {
      const end = source.indexOf("`", i + 1);
      const stop = end < 0 ? n : end;
      const text = source.slice(i + 1, stop);
      add(text, line);
      for (const ch of text) if (ch === "\n") line++;
      i = stop + 1;
      continue;
    }
    const raw = language === "rust" ? /^r(#*)"/.exec(source.slice(i, i + 8)) : null;
    if (raw) {
      const close = `"${raw[1]}`;
      const end = source.indexOf(close, i + raw[0].length);
      const stop = end < 0 ? n : end;
      const text = source.slice(i + raw[0].length, stop);
      add(text, line);
      for (const ch of text) if (ch === "\n") line++;
      i = stop + close.length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = "";
      while (j < n && source[j] !== '"' && source[j] !== "\n") {
        if (source[j] === "\\") {
          text += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        text += source[j++];
      }
      add(text, line);
      i = j + 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") brackets.push(i);
    else if (c === ")" || c === "]" || c === "}") brackets.pop();
    if (c === "'" && language !== "rust") {
      // A char literal — skip it so a quote inside doesn't open a string.
      const m = /^'(\\.|[^'\\])'/.exec(source.slice(i, i + 4));
      i += m ? m[0].length : 1;
      continue;
    }
    i++;
  }
  // A group of one isn't an array of migrations.
  const sizes = new Map<string, number>();
  for (const d of ddl) if (d.group) sizes.set(d.group, (sizes.get(d.group) ?? 0) + 1);
  for (const d of ddl) {
    if (d.group && (sizes.get(d.group) ?? 0) < 2) {
      delete d.group;
      delete d.index;
    }
  }
  if (uses.length === 0 && ddl.length === 0) return undefined;
  return { ...(uses.length ? { uses } : {}), ...(ddl.length ? { ddl } : {}), ...(writes.size ? { writes: [...writes] } : {}) };
}
