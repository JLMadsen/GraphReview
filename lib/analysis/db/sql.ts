/**
 * A tolerant SQL reader (DESIGN.md §6.13 §2): CREATE / ALTER / DROP of
 * TABLE, INDEX, TYPE … AS ENUM and VIEW, plus RENAME, across Postgres,
 * MySQL and SQLite — read into {@link DbOp}s for the replay. Self-contained
 * (the app runs air-gapped; no parser dependency). Anything it doesn't
 * recognise — data updates, `DO` blocks, functions, triggers, dialect extras
 * — becomes an `opaque` op, so the history keeps it.
 *
 * Also: the table names a query reads or writes (`sqlTableRefs`, for the
 * "from SQL text" links of §4) and a dialect guess from the text.
 */
import type { DbCheck, DbColumn, DbDialect, DbFk, DbIndex, DbOp } from "./types";

// ---------------------------------------------------------------------------
// Statements and tokens
// ---------------------------------------------------------------------------

export interface SqlStatement {
  text: string;
  /** 1-based line where the statement starts (offset by `firstLine`). */
  line: number;
}

/**
 * Splits SQL text into statements on `;` outside quotes, comments, `$tag$`
 * bodies and `BEGIN … END` blocks (triggers, MySQL procedures). Comments are
 * dropped; line numbers are kept.
 */
export function splitSqlStatements(text: string, firstLine = 1): SqlStatement[] {
  const out: SqlStatement[] = [];
  let buf = "";
  let line = firstLine;
  let startLine = -1;
  let blockDepth = 0;
  let i = 0;
  const n = text.length;
  const push = () => {
    const t = buf.trim();
    if (t) out.push({ text: t, line: startLine < 0 ? line : startLine });
    buf = "";
    startLine = -1;
  };
  const mark = () => {
    if (startLine < 0) startLine = line;
  };
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "\n") {
      line++;
      buf += c;
      i++;
      continue;
    }
    if (c === "-" && next === "-") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "#" && /^#\s/.test(text.slice(i, i + 2)) && buf.trim() === "") {
      // MySQL line comment at a statement's start.
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") line++;
        i++;
      }
      i += 2;
      buf += " ";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      mark();
      const q = c;
      buf += c;
      i++;
      while (i < n) {
        if (text[i] === "\n") line++;
        if (text[i] === q) {
          if (text[i + 1] === q) {
            buf += q + q;
            i += 2;
            continue;
          }
          break;
        }
        if (text[i] === "\\" && q === "'" && i + 1 < n) {
          buf += text[i] + text[i + 1];
          if (text[i + 1] === "\n") line++;
          i += 2;
          continue;
        }
        buf += text[i];
        i++;
      }
      buf += q;
      i++;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][\w]*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        mark();
        const tag = m[0];
        const end = text.indexOf(tag, i + tag.length);
        const stop = end < 0 ? n : end + tag.length;
        const body = text.slice(i, stop);
        for (const ch of body) if (ch === "\n") line++;
        buf += body;
        i = stop;
        continue;
      }
    }
    if (/[A-Za-z]/.test(c) && (i === 0 || !/[\w$]/.test(text[i - 1]))) {
      const word = /^[A-Za-z_]\w*/.exec(text.slice(i, i + 32))?.[0] ?? c;
      const up = word.toUpperCase();
      // BEGIN … END (a trigger or procedure body) holds `;`s of its own; BEGIN TRANSACTION / BEGIN; doesn't.
      if (up === "BEGIN") {
        const after = text.slice(i + word.length, i + word.length + 40);
        if (!/^\s*(;|transaction\b|work\b|deferred\b|immediate\b|exclusive\b|isolation\b|$)/i.test(after) && /\b(CREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|PROCEDURE|FUNCTION)|DO\b)/i.test(buf)) blockDepth++;
      } else if (up === "END" && blockDepth > 0) {
        const after = text.slice(i + 3, i + 12);
        if (!/^\s*(IF|LOOP|WHILE|CASE|REPEAT)\b/i.test(after)) blockDepth--;
      } else if (up === "CASE" && blockDepth > 0) {
        blockDepth++;
      }
      mark();
      buf += word;
      i += word.length;
      continue;
    }
    if (c === ";" && blockDepth === 0) {
      push();
      i++;
      continue;
    }
    if (!/\s/.test(c)) mark();
    buf += c;
    i++;
  }
  push();
  return out;
}

export type TokKind = "word" | "quoted" | "string" | "number" | "punct";

export interface Tok {
  k: TokKind;
  /** Words and punctuation as written; a quoted identifier unquoted; a string's content. */
  v: string;
  /** Upper-cased `v` for words. */
  u: string;
}

/** Tokens of one statement. */
export function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'" || (c === "E" && text[i + 1] === "'") || (c === "N" && text[i + 1] === "'")) {
      if (c !== "'") i++;
      let v = "";
      i++;
      while (i < n) {
        if (text[i] === "'" && text[i + 1] === "'") {
          v += "'";
          i += 2;
          continue;
        }
        if (text[i] === "\\" && i + 1 < n) {
          v += text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === "'") break;
        v += text[i++];
      }
      i++;
      toks.push({ k: "string", v, u: v.toUpperCase() });
      continue;
    }
    if (c === "[" && text[i + 1] === "]") {
      toks.push({ k: "punct", v: "[]", u: "[]" });
      i += 2;
      continue;
    }
    if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let v = "";
      i++;
      while (i < n) {
        if (text[i] === close && text[i + 1] === close && close !== "]") {
          v += close;
          i += 2;
          continue;
        }
        if (text[i] === close) break;
        v += text[i++];
      }
      i++;
      toks.push({ k: "quoted", v, u: v.toUpperCase() });
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const end = text.indexOf(m[0], i + m[0].length);
        const stop = end < 0 ? n : end + m[0].length;
        const v = text.slice(i + m[0].length, end < 0 ? n : end);
        toks.push({ k: "string", v, u: v.toUpperCase() });
        i = stop;
        continue;
      }
      const p = /^\$\d+/.exec(text.slice(i));
      if (p) {
        toks.push({ k: "punct", v: p[0], u: p[0] });
        i += p[0].length;
        continue;
      }
    }
    const word = /^[A-Za-z_À-￿][\w$À-￿]*/.exec(text.slice(i, i + 256));
    if (word) {
      toks.push({ k: "word", v: word[0], u: word[0].toUpperCase() });
      i += word[0].length;
      continue;
    }
    const num = /^\d+(\.\d+)?([eE][-+]?\d+)?/.exec(text.slice(i, i + 64));
    if (num) {
      toks.push({ k: "number", v: num[0], u: num[0] });
      i += num[0].length;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === "::" || two === "<>" || two === "!=" || two === ">=" || two === "<=" || two === "||" || two === "->") {
      toks.push({ k: "punct", v: two, u: two });
      i += 2;
      continue;
    }
    toks.push({ k: "punct", v: c, u: c });
    i++;
  }
  return toks;
}

/** Text of tokens, re-joined readably. */
export function joinToks(toks: readonly Tok[]): string {
  return toks
    .map((t) => (t.k === "string" ? `'${t.v.replace(/'/g, "''")}'` : t.k === "quoted" ? `"${t.v}"` : t.v))
    .join(" ")
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)/g, ")")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s*::\s*/g, "::")
    .replace(/\b(AND|OR|NOT|IN|ON|AS|IS|USING|WHERE)\(/gi, "$1 (")
    .trim();
}

class Cursor {
  i = 0;
  constructor(readonly toks: Tok[]) {}
  peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }
  is(...words: string[]): boolean {
    return words.every((w, o) => this.toks[this.i + o]?.u === w);
  }
  eat(...words: string[]): boolean {
    if (!this.is(...words)) return false;
    this.i += words.length;
    return true;
  }
  done(): boolean {
    return this.i >= this.toks.length;
  }
  next(): Tok | undefined {
    return this.toks[this.i++];
  }
  /** A possibly qualified name (`schema.table`, `"Order"`, `` `db`.`t` ``). */
  name(): string | undefined {
    const parts: string[] = [];
    const first = this.peek();
    if (!first || (first.k !== "word" && first.k !== "quoted" && first.k !== "string")) return undefined;
    parts.push(first.v);
    this.i++;
    while (this.peek()?.v === "." && (this.peek(1)?.k === "word" || this.peek(1)?.k === "quoted")) {
      parts.push(this.peek(1)!.v);
      this.i += 2;
    }
    return parts.join(".");
  }
  /** Tokens of a parenthesised group (the cursor on its `(`), without the outer parens. */
  group(): Tok[] {
    if (this.peek()?.v !== "(") return [];
    let depth = 0;
    const start = this.i;
    while (!this.done()) {
      const t = this.next()!;
      if (t.v === "(") depth++;
      else if (t.v === ")") {
        depth--;
        if (depth === 0) return this.toks.slice(start + 1, this.i - 1);
      }
    }
    return this.toks.slice(start + 1);
  }
  rest(): Tok[] {
    const r = this.toks.slice(this.i);
    this.i = this.toks.length;
    return r;
  }
}

/** Splits tokens on top-level commas. */
export function splitTop(toks: readonly Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.v === "(") depth++;
    else if (t.v === ")") depth--;
    if (t.v === "," && depth === 0) {
      out.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Column names in `(a, b DESC, lower(c))`. */
function columnList(toks: readonly Tok[]): string[] {
  return splitTop(toks)
    .map((part) => {
      const words = part.filter((t) => !(t.k === "word" && /^(ASC|DESC|NULLS|FIRST|LAST|COLLATE)$/.test(t.u)));
      if (words.length === 1 && (words[0].k === "word" || words[0].k === "quoted")) return words[0].v;
      // `name(length)` (MySQL prefix index) or an expression: keep the text.
      if ((words[0]?.k === "word" || words[0]?.k === "quoted") && words[1]?.v === "(" && /^\d/.test(words[2]?.v ?? "")) return words[0].v;
      return joinToks(part);
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const TYPE_ALIASES: Array<[RegExp, string]> = [
  [/^character varying/, "varchar"],
  [/^char varying/, "varchar"],
  [/^nvarchar/, "varchar"],
  [/^national character varying/, "varchar"],
  [/^character(?! varying)/, "char"],
  [/^int4\b|^integer\b|^int\b|^mediumint\b/, "integer"],
  [/^int8\b|^bigint\b/, "bigint"],
  [/^int2\b|^smallint\b/, "smallint"],
  [/^tinyint\(1\)/, "boolean"],
  [/^bool\b/, "boolean"],
  [/^float8\b|^double precision\b|^double\b/, "double precision"],
  [/^float4\b/, "real"],
  [/^decimal\b|^dec\b/, "numeric"],
  [/^timestamp with time zone\b|^timestamptz\b/, "timestamptz"],
  [/^timestamp without time zone\b/, "timestamp"],
  [/^time without time zone\b/, "time"],
  [/^serial4\b/, "serial"],
  [/^serial8\b/, "bigserial"],
];

/** A type as compared and shown: lower-cased, spaces collapsed, common aliases folded (`character varying(50)` → `varchar(50)`). */
export function normalizeType(type: string): string {
  let t = type.trim().replace(/\s+/g, " ").replace(/\s*\(\s*/g, "(").replace(/\s*,\s*/g, ",").replace(/\s*\)/g, ")");
  if (!/^enum\(/i.test(t)) t = t.toLowerCase();
  else t = `enum${t.slice(4)}`;
  for (const [re, to] of TYPE_ALIASES) {
    if (re.test(t)) {
      t = t.replace(re, to);
      break;
    }
  }
  return t.replace(/^"(.*)"$/, "$1");
}

const INT_RANK: Record<string, number> = { smallint: 1, smallserial: 1, integer: 2, serial: 2, bigint: 3, bigserial: 3 };
const FLOAT_RANK: Record<string, number> = { real: 1, "double precision": 2 };

/** Why `after` holds less than `before` (`varchar(255) → varchar(50)`, `bigint → integer`, `text → varchar(n)`), or `null`. */
export function typeNarrowing(before: string, after: string): string | null {
  const a = normalizeType(before);
  const b = normalizeType(after);
  if (a === b) return null;
  const base = (t: string) => t.replace(/\(.*$/, "").replace(/\[\]$/, "").trim();
  const params = (t: string) => (/\(([^)]*)\)/.exec(t)?.[1] ?? "").split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
  const ba = base(a);
  const bb = base(b);
  if (INT_RANK[ba] && INT_RANK[bb] && INT_RANK[bb] < INT_RANK[ba]) return `${a} → ${b} holds smaller numbers`;
  if (FLOAT_RANK[ba] && FLOAT_RANK[bb] && FLOAT_RANK[bb] < FLOAT_RANK[ba]) return `${a} → ${b} loses precision`;
  if ((ba === "text" || ba === "longtext" || ba === "mediumtext" || (ba === "varchar" && params(a).length === 0)) && (bb === "varchar" || bb === "char") && params(b).length > 0) {
    return `${a} → ${b} caps the length at ${params(b)[0]}`;
  }
  if ((ba === "varchar" || ba === "char") && ba === bb) {
    const [la] = params(a);
    const [lb] = params(b);
    if (la && lb && lb < la) return `${a} → ${b} shortens the length from ${la} to ${lb}`;
  }
  if (ba === "longtext" && (bb === "mediumtext" || bb === "text" || bb === "tinytext")) return `${a} → ${b} holds less text`;
  if ((ba === "numeric" && bb === "numeric") || (ba === "timestamp" && bb === "timestamp") || (ba === "timestamptz" && bb === "timestamptz") || (ba === "time" && bb === "time")) {
    const [pa, sa] = params(a);
    const [pb, sb] = params(b);
    if (pa !== undefined && pb !== undefined && pb < pa) return `${a} → ${b} lowers the precision from ${pa} to ${pb}`;
    if (sa !== undefined && sb !== undefined && sb < sa) return `${a} → ${b} lowers the scale from ${sa} to ${sb}`;
    if (ba === "numeric" && pa === undefined && pb !== undefined) return `${a} → ${b} caps the precision at ${pb}`;
  }
  if ((ba === "numeric" || FLOAT_RANK[ba]) && INT_RANK[bb]) return `${a} → ${b} drops the fractional part`;
  if ((ba === "timestamptz" && bb === "timestamp") || ((ba === "timestamp" || ba === "timestamptz") && bb === "date")) return `${a} → ${b} drops information`;
  return null;
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const CONSTRAINT_WORDS = new Set([
  "NOT", "NULL", "DEFAULT", "PRIMARY", "UNIQUE", "REFERENCES", "CHECK", "CONSTRAINT", "COLLATE", "GENERATED", "AUTO_INCREMENT",
  "AUTOINCREMENT", "COMMENT", "IDENTITY", "ON", "CHARACTER", "CHARSET", "AS", "DEFERRABLE", "INITIALLY", "STORED", "VIRTUAL", "ENCODE", "FIRST", "AFTER",
]);

function fkActions(c: Cursor): { onDelete?: string } {
  let onDelete: string | undefined;
  while (c.is("ON") || c.is("MATCH") || c.is("DEFERRABLE") || c.is("NOT", "DEFERRABLE") || c.is("INITIALLY")) {
    if (c.eat("ON", "DELETE") || c.eat("ON", "UPDATE")) {
      const was = c.toks[c.i - 1].u;
      const words: string[] = [];
      while (c.peek()?.k === "word" && /^(CASCADE|RESTRICT|SET|NULL|DEFAULT|NO|ACTION)$/.test(c.peek()!.u)) words.push(c.next()!.u);
      if (was === "DELETE") onDelete = words.join(" ");
      continue;
    }
    c.next();
    if (c.peek()?.k === "word") c.next();
  }
  return onDelete ? { onDelete } : {};
}

/** `REFERENCES t (a, b) [ON DELETE …]` with the cursor after REFERENCES. */
function references(c: Cursor): { refTable: string; refColumns: string[]; onDelete?: string } {
  const refTable = c.name() ?? "?";
  const refColumns = c.peek()?.v === "(" ? columnList(c.group()) : [];
  return { refTable, refColumns, ...fkActions(c) };
}

interface ParsedColumn {
  column: DbColumn;
  pk?: true;
  fk?: DbFk;
  check?: DbCheck;
}

/** One column definition: `name type [constraints…]`. */
export function parseColumnDef(toks: Tok[]): ParsedColumn | null {
  const c = new Cursor(toks);
  const nameTok = c.next();
  if (!nameTok || (nameTok.k !== "word" && nameTok.k !== "quoted")) return null;
  const typeToks: Tok[] = [];
  while (!c.done()) {
    const t = c.peek()!;
    if (t.k === "word" && CONSTRAINT_WORDS.has(t.u) && typeToks.length > 0) {
      // `character set` is a type tail in MySQL; `double precision`, `with time zone` stay in the type.
      break;
    }
    if (t.v === "(") {
      typeToks.push(t);
      const inner = c.group();
      typeToks.push(...inner, { k: "punct", v: ")", u: ")" });
      continue;
    }
    typeToks.push(c.next()!);
  }
  const column: DbColumn = { name: nameTok.v, type: typeToks.length ? normalizeType(joinToks(typeToks).replace(/\s*\[\s*\]/g, "[]")) : "", nullable: true, source: "migration" };
  const out: ParsedColumn = { column };
  if (/^(serial|bigserial|smallserial)$/.test(column.type)) {
    column.generated = column.type;
    column.nullable = false;
  }
  while (!c.done()) {
    if (c.eat("CONSTRAINT")) {
      c.name();
      continue;
    }
    if (c.eat("NOT", "NULL")) {
      column.nullable = false;
      continue;
    }
    if (c.eat("NULL")) {
      column.nullable = true;
      continue;
    }
    if (c.eat("PRIMARY", "KEY")) {
      column.primary = true;
      column.nullable = false;
      out.pk = true;
      while (c.is("ASC") || c.is("DESC")) c.next();
      if (c.eat("AUTOINCREMENT")) column.generated = "autoincrement";
      continue;
    }
    if (c.eat("UNIQUE")) {
      c.eat("KEY");
      column.unique = true;
      continue;
    }
    if (c.eat("DEFAULT")) {
      const expr: Tok[] = [];
      let depth = 0;
      while (!c.done()) {
        const t = c.peek()!;
        if (depth === 0 && t.k === "word" && CONSTRAINT_WORDS.has(t.u) && t.u !== "NULL" && expr.length > 0) break;
        if (depth === 0 && t.u === "NULL" && expr.length > 0) break;
        if (t.v === "(") depth++;
        if (t.v === ")") depth--;
        expr.push(c.next()!);
      }
      column.default = joinToks(expr);
      continue;
    }
    if (c.eat("REFERENCES")) {
      const ref = references(c);
      out.fk = { columns: [column.name], ...ref };
      continue;
    }
    if (c.eat("CHECK")) {
      out.check = { expr: joinToks(c.group()) };
      continue;
    }
    if (c.eat("GENERATED")) {
      const words: string[] = [];
      while (!c.done() && c.peek()!.v !== "(" && !(c.peek()!.k === "word" && /^(NOT|NULL|PRIMARY|UNIQUE|REFERENCES|DEFAULT)$/.test(c.peek()!.u))) words.push(c.next()!.u);
      if (c.peek()?.v === "(") {
        const g = c.group();
        column.generated = words.includes("IDENTITY") ? "identity" : joinToks(g);
      } else column.generated = "identity";
      if (c.eat("STORED") || c.eat("VIRTUAL")) {
        /* kind of generated column — not kept */
      }
      if (column.generated === "identity") column.nullable = false;
      continue;
    }
    if (c.eat("AUTO_INCREMENT") || c.eat("AUTOINCREMENT")) {
      column.generated = "autoincrement";
      continue;
    }
    if (c.eat("IDENTITY")) {
      if (c.peek()?.v === "(") c.group();
      column.generated = "identity";
      continue;
    }
    if (c.eat("COLLATE") || c.eat("COMMENT") || c.eat("CHARSET") || c.eat("ENCODE")) {
      c.next();
      continue;
    }
    if (c.eat("CHARACTER", "SET")) {
      c.next();
      continue;
    }
    if (c.eat("ON", "UPDATE")) {
      c.next();
      if (c.peek()?.v === "(") c.group();
      continue;
    }
    if (c.eat("AS")) {
      if (c.peek()?.v === "(") column.generated = joinToks(c.group());
      continue;
    }
    c.next();
  }
  if (out.pk) column.nullable = false;
  return out;
}

// ---------------------------------------------------------------------------
// Statements → ops
// ---------------------------------------------------------------------------

/** The statements of a `DO $$ BEGIN … [EXCEPTION …] END $$` block. */
const DO_BODY = /^\s*BEGIN\b([\s\S]*?)(\bEXCEPTION\b[\s\S]*)?\bEND\b\s*;?\s*$/i;

function opaque(text: string, line: number, table?: string): DbOp {
  const flat = text.replace(/\s+/g, " ").trim();
  return { op: "opaque", text: flat.length > 300 ? `${flat.slice(0, 300)}…` : flat, line, ...(table ? { table } : {}) };
}

/** A table-level constraint inside CREATE TABLE ( … ) or after ALTER TABLE … ADD. `null` when `toks` isn't one. */
function tableConstraint(toks: Tok[]): { pk?: string[]; fk?: DbFk; unique?: DbIndex; index?: DbIndex; check?: DbCheck } | null {
  const c = new Cursor(toks);
  let name: string | undefined;
  if (c.eat("CONSTRAINT")) name = c.name();
  if (c.eat("PRIMARY", "KEY")) {
    while (c.peek()?.k === "word") c.next();
    return { pk: columnList(c.group()) };
  }
  if (c.eat("FOREIGN", "KEY")) {
    if (c.peek()?.k === "word" || c.peek()?.k === "quoted") c.name();
    const columns = columnList(c.group());
    if (!c.eat("REFERENCES")) return null;
    return { fk: { ...(name ? { name } : {}), columns, ...references(c) } };
  }
  if (c.is("UNIQUE")) {
    c.next();
    if (!c.eat("KEY")) c.eat("INDEX");
    if (c.peek()?.v !== "(" && c.peek()) name = c.name() ?? name;
    while (c.peek()?.k === "word" && c.peek()?.v !== "(") c.next();
    return { unique: { ...(name ? { name } : {}), columns: columnList(c.group()), unique: true } };
  }
  if (c.eat("CHECK")) return { check: { ...(name ? { name } : {}), expr: joinToks(c.group()) } };
  if (c.is("INDEX") || c.is("KEY") || c.is("FULLTEXT") || c.is("SPATIAL")) {
    while (c.peek()?.k === "word" && /^(INDEX|KEY|FULLTEXT|SPATIAL)$/.test(c.peek()!.u)) c.next();
    let idxName = name;
    if (c.peek()?.v !== "(") idxName = c.name();
    while (c.peek() && c.peek()!.v !== "(") c.next();
    return { index: { ...(idxName ? { name: idxName } : {}), columns: columnList(c.group()) } };
  }
  if (c.eat("EXCLUDE")) return null;
  return null;
}

function createTable(c: Cursor, line: number, stmt: string): DbOp[] {
  let ifNotExists: true | undefined;
  if (c.eat("IF", "NOT", "EXISTS")) ifNotExists = true;
  const table = c.name();
  if (!table) return [opaque(stmt, line)];
  if (c.eat("PARTITION", "OF") || c.is("AS") || c.is("LIKE")) return [opaque(stmt, line, table)];
  if (c.peek()?.v !== "(") return [opaque(stmt, line, table)];
  const columns: DbColumn[] = [];
  let pk: string[] = [];
  const fks: DbFk[] = [];
  const indexes: DbIndex[] = [];
  const checks: DbCheck[] = [];
  for (const def of splitTop(c.group())) {
    if (def.length === 0) continue;
    const first = def[0];
    // `key` / `index` / `check` can also be column names — a constraint has its own shape.
    const u1 = def[1]?.u;
    const v1 = def[1]?.v;
    const v2 = def[2]?.v;
    const isConstraint =
      first.k === "word" &&
      (first.u === "CONSTRAINT" ||
        ((first.u === "PRIMARY" || first.u === "FOREIGN") && u1 === "KEY") ||
        (first.u === "CHECK" && v1 === "(") ||
        (first.u === "UNIQUE" && (v1 === "(" || u1 === "KEY" || u1 === "INDEX" || v2 === "(")) ||
        (/^(INDEX|KEY|FULLTEXT|SPATIAL)$/.test(first.u) && (v1 === "(" || v2 === "(" || u1 === "KEY" || u1 === "INDEX")) ||
        /^(EXCLUDE|LIKE|PERIOD)$/.test(first.u));
    if (isConstraint) {
      const cons = tableConstraint(def);
      if (cons?.pk) pk = cons.pk;
      if (cons?.fk) fks.push(cons.fk);
      if (cons?.unique) indexes.push(cons.unique);
      if (cons?.index) indexes.push(cons.index);
      if (cons?.check) checks.push(cons.check);
      continue;
    }
    const parsed = parseColumnDef(def);
    if (!parsed) continue;
    columns.push(parsed.column);
    if (parsed.pk) pk = [parsed.column.name];
    if (parsed.fk) fks.push(parsed.fk);
    if (parsed.check) checks.push(parsed.check);
  }
  for (const col of columns) if (pk.some((p) => p.toLowerCase() === col.name.toLowerCase())) {
    col.primary = true;
    col.nullable = false;
  }
  return [{ op: "createTable", table, columns, pk, fks, indexes, checks, ...(ifNotExists ? { ifNotExists } : {}), line }];
}

function alterTable(c: Cursor, line: number, stmt: string): DbOp[] {
  c.eat("IF", "EXISTS");
  c.eat("ONLY");
  const table = c.name();
  if (!table) return [opaque(stmt, line)];
  c.eat("*");
  const ops: DbOp[] = [];
  for (const action of splitTop(c.rest())) {
    const a = new Cursor(action);
    const text = joinToks(action);
    if (a.eat("RENAME", "COLUMN") || (a.is("RENAME") && a.peek(1) && a.peek(2)?.u === "TO" && a.peek(1)!.u !== "TO" && a.peek(1)!.u !== "CONSTRAINT")) {
      if (a.peek()?.u === "RENAME") a.next();
      const from = a.name();
      a.eat("TO");
      const to = a.name();
      if (from && to) ops.push({ op: "renameColumn", table, column: from, to, line });
      continue;
    }
    if (a.eat("RENAME", "CONSTRAINT") || a.eat("RENAME", "INDEX") || a.eat("RENAME", "KEY")) {
      ops.push(opaque(`ALTER TABLE ${table} ${text}`, line, table));
      continue;
    }
    if (a.eat("RENAME")) {
      if (!a.eat("TO")) a.eat("AS");
      const to = a.name();
      if (to) ops.push({ op: "renameTable", table, to, line });
      continue;
    }
    if (a.eat("ADD")) {
      const cons = a.is("CONSTRAINT") || a.is("PRIMARY", "KEY") || a.is("FOREIGN", "KEY") || a.is("UNIQUE") || a.is("CHECK") || a.is("INDEX") || a.is("KEY") || a.is("FULLTEXT") || a.is("SPATIAL");
      if (cons) {
        const parsed = tableConstraint(action.slice(1));
        if (parsed?.pk) ops.push({ op: "addPk", table, columns: parsed.pk, line });
        else if (parsed?.fk) ops.push({ op: "addFk", table, fk: parsed.fk, line });
        else if (parsed?.unique) ops.push({ op: "createIndex", table, index: parsed.unique, line });
        else if (parsed?.index) ops.push({ op: "createIndex", table, index: parsed.index, line });
        else if (parsed?.check) ops.push({ op: "addCheck", table, check: parsed.check, line });
        else ops.push(opaque(`ALTER TABLE ${table} ${text}`, line, table));
        continue;
      }
      a.eat("COLUMN");
      a.eat("IF", "NOT", "EXISTS");
      const defs = a.peek()?.v === "(" ? splitTop(a.group()) : [a.rest()];
      for (const def of defs) {
        const parsed = parseColumnDef(def);
        if (!parsed) continue;
        ops.push({ op: "addColumn", table, column: parsed.column, ...(parsed.fk ? { fk: parsed.fk } : {}), line });
        if (parsed.pk) ops.push({ op: "addPk", table, columns: [parsed.column.name], line });
      }
      continue;
    }
    if (a.eat("DROP")) {
      if (a.eat("CONSTRAINT") || a.eat("FOREIGN", "KEY") || a.eat("CHECK")) {
        a.eat("IF", "EXISTS");
        const name = a.name();
        if (name) ops.push({ op: "dropConstraint", table, name, line });
        continue;
      }
      if (a.eat("PRIMARY", "KEY")) {
        ops.push({ op: "dropConstraint", table, name: "PRIMARY", line });
        continue;
      }
      if (a.eat("INDEX") || a.eat("KEY")) {
        const name = a.name();
        if (name) ops.push({ op: "dropIndex", name, table, line });
        continue;
      }
      a.eat("COLUMN");
      a.eat("IF", "EXISTS");
      const column = a.name();
      if (column) ops.push({ op: "dropColumn", table, column, line });
      continue;
    }
    if (a.eat("ALTER")) {
      a.eat("COLUMN");
      const column = a.name();
      if (!column) continue;
      if (a.eat("SET", "DATA", "TYPE") || a.eat("TYPE")) {
        const typeToks: Tok[] = [];
        while (!a.done() && !(a.peek()!.k === "word" && /^(USING|COLLATE)$/.test(a.peek()!.u))) {
          if (a.peek()!.v === "(") {
            typeToks.push(a.peek()!);
            typeToks.push(...a.group(), { k: "punct", v: ")", u: ")" });
            continue;
          }
          typeToks.push(a.next()!);
        }
        ops.push({ op: "alterColumn", table, column, type: normalizeType(joinToks(typeToks)), line });
      } else if (a.eat("SET", "NOT", "NULL")) ops.push({ op: "alterColumn", table, column, nullable: false, line });
      else if (a.eat("DROP", "NOT", "NULL")) ops.push({ op: "alterColumn", table, column, nullable: true, line });
      else if (a.eat("SET", "DEFAULT")) ops.push({ op: "alterColumn", table, column, default: joinToks(a.rest()), line });
      else if (a.eat("DROP", "DEFAULT")) ops.push({ op: "alterColumn", table, column, default: null, line });
      else ops.push(opaque(`ALTER TABLE ${table} ${text}`, line, table));
      continue;
    }
    if (a.eat("MODIFY")) {
      a.eat("COLUMN");
      const parsed = parseColumnDef(a.rest());
      if (parsed) ops.push({ op: "alterColumn", table, column: parsed.column.name, type: parsed.column.type, nullable: parsed.column.nullable, ...(parsed.column.default !== undefined ? { default: parsed.column.default } : {}), line });
      continue;
    }
    if (a.eat("CHANGE")) {
      a.eat("COLUMN");
      const from = a.name();
      const parsed = parseColumnDef(a.rest());
      if (from && parsed) {
        if (from.toLowerCase() !== parsed.column.name.toLowerCase()) ops.push({ op: "renameColumn", table, column: from, to: parsed.column.name, line });
        ops.push({ op: "alterColumn", table, column: parsed.column.name, type: parsed.column.type, nullable: parsed.column.nullable, ...(parsed.column.default !== undefined ? { default: parsed.column.default } : {}), line });
      }
      continue;
    }
    ops.push(opaque(`ALTER TABLE ${table} ${text}`, line, table));
  }
  return ops;
}

function createIndex(c: Cursor, unique: boolean, line: number, stmt: string): DbOp[] {
  const concurrently = c.eat("CONCURRENTLY");
  c.eat("IF", "NOT", "EXISTS");
  let name: string | undefined;
  if (!c.is("ON")) name = c.name();
  if (!c.eat("ON")) return [opaque(stmt, line)];
  c.eat("ONLY");
  const table = c.name();
  if (!table) return [opaque(stmt, line)];
  if (c.eat("USING")) c.next();
  const columns = columnList(c.group());
  let where: string | undefined;
  while (!c.done()) {
    if (c.eat("WHERE")) {
      where = joinToks(c.rest());
      break;
    }
    if (c.peek()?.v === "(") c.group();
    else c.next();
  }
  return [{ op: "createIndex", table, index: { ...(name ? { name } : {}), columns, ...(unique ? { unique: true } : {}), ...(where ? { where } : {}) }, ...(concurrently ? { concurrently: true } : {}), line }];
}

/** The tables a view's query reads. */
function viewTables(toks: Tok[]): string[] {
  return sqlTableRefs(joinToks(toks)).tables;
}

/** One statement → ops. */
export function parseStatement(stmt: SqlStatement): DbOp[] {
  const toks = tokenize(stmt.text);
  const c = new Cursor(toks);
  const line = stmt.line;
  if (toks.length === 0) return [];
  // Transaction control and session settings are noise in a history.
  if (/^(BEGIN|COMMIT|START|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA)$/.test(toks[0].u) && !(toks[0].u === "BEGIN" && toks.length > 3)) return [];
  if (c.eat("CREATE")) {
    c.eat("OR", "REPLACE");
    while (c.peek()?.k === "word" && /^(TEMP|TEMPORARY|UNLOGGED|GLOBAL|LOCAL|VIRTUAL)$/.test(c.peek()!.u)) {
      if (c.peek()!.u === "TEMP" || c.peek()!.u === "TEMPORARY" || c.peek()!.u === "VIRTUAL") return [opaque(stmt.text, line)];
      c.next();
    }
    if (c.eat("TABLE")) return createTable(c, line, stmt.text);
    if (c.eat("UNIQUE", "INDEX")) return createIndex(c, true, line, stmt.text);
    if (c.eat("INDEX")) return createIndex(c, false, line, stmt.text);
    if (c.eat("TYPE")) {
      const name = c.name();
      if (name && c.eat("AS", "ENUM")) {
        const values = c.group().filter((t) => t.k === "string").map((t) => t.v);
        return [{ op: "createEnum", name, values, line }];
      }
      return [opaque(stmt.text, line)];
    }
    const materialized = c.eat("MATERIALIZED");
    if (c.eat("VIEW")) {
      c.eat("IF", "NOT", "EXISTS");
      const name = c.name();
      if (!name) return [opaque(stmt.text, line)];
      while (!c.done() && !c.is("AS")) c.next();
      c.eat("AS");
      void materialized;
      const reads = viewTables(c.rest());
      return [{ op: "createTable", table: name, columns: [], pk: [], fks: [], indexes: [], checks: reads.length ? [{ name: "reads", expr: reads.join(", ") }] : [], view: true, line }];
    }
    return [opaque(stmt.text, line)];
  }
  if (c.eat("DROP")) {
    if (c.eat("TABLE")) {
      c.eat("IF", "EXISTS");
      const ops: DbOp[] = [];
      for (const part of splitTop(c.rest())) {
        const name = new Cursor(part).name();
        if (name) ops.push({ op: "dropTable", table: name, line });
      }
      return ops;
    }
    if (c.eat("INDEX")) {
      c.eat("CONCURRENTLY");
      c.eat("IF", "EXISTS");
      const name = c.name();
      let table: string | undefined;
      if (c.eat("ON")) table = c.name();
      return name ? [{ op: "dropIndex", name, ...(table ? { table } : {}), line }] : [];
    }
    if (c.eat("TYPE")) {
      c.eat("IF", "EXISTS");
      const name = c.name();
      return name ? [{ op: "dropEnum", name, line }] : [];
    }
    c.eat("MATERIALIZED");
    if (c.eat("VIEW")) {
      c.eat("IF", "EXISTS");
      const name = c.name();
      return name ? [{ op: "dropTable", table: name, view: true, line }] : [];
    }
    return [opaque(stmt.text, line)];
  }
  if (c.eat("ALTER", "TABLE")) return alterTable(c, line, stmt.text);
  if (c.eat("ALTER", "TYPE")) {
    const name = c.name();
    if (!name) return [opaque(stmt.text, line)];
    if (c.eat("ADD", "VALUE")) {
      c.eat("IF", "NOT", "EXISTS");
      const v = c.next();
      return v?.k === "string" ? [{ op: "alterEnum", name, add: [v.v], line }] : [opaque(stmt.text, line)];
    }
    if (c.eat("RENAME", "VALUE")) {
      const from = c.next();
      c.eat("TO");
      const to = c.next();
      if (from?.k === "string" && to?.k === "string") return [{ op: "alterEnum", name, rename: [from.v, to.v], line }];
    }
    return [opaque(stmt.text, line)];
  }
  if (c.eat("RENAME", "TABLE")) {
    const ops: DbOp[] = [];
    for (const part of splitTop(c.rest())) {
      const p = new Cursor(part);
      const from = p.name();
      p.eat("TO");
      const to = p.name();
      if (from && to) ops.push({ op: "renameTable", table: from, to, line });
    }
    return ops;
  }
  if (c.eat("COMMENT", "ON") || c.eat("SET") || c.eat("GRANT") || c.eat("REVOKE")) return [];
  // `DO $$ BEGIN <ddl>; EXCEPTION WHEN duplicate_object THEN null; END $$` (Drizzle's guarded FKs): the DDL inside counts.
  if (c.eat("DO") && c.peek()?.k === "string") {
    const body = DO_BODY.exec(c.peek()!.v);
    if (body) {
      const inner = parseSql(body[1]).map((op) => ({ ...op, line }));
      if (inner.length > 0 && inner.every((op) => op.op !== "opaque")) return inner;
    }
    return [opaque(stmt.text, line)];
  }
  return [opaque(stmt.text, line)];
}

/** Every statement in `text` → ops. */
export function parseSql(text: string, firstLine = 1): DbOp[] {
  const ops: DbOp[] = [];
  for (const stmt of splitSqlStatements(text, firstLine)) {
    try {
      ops.push(...parseStatement(stmt));
    } catch {
      ops.push(opaque(stmt.text, stmt.line));
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Queries: which tables they name
// ---------------------------------------------------------------------------

const AFTER_TABLE = new Set(["FROM", "JOIN", "INTO", "UPDATE", "TABLE"]);
const NOT_TABLES = new Set(["SELECT", "LATERAL", "ONLY", "UNNEST", "VALUES", "GENERATE_SERIES", "JSON_TABLE", "JSON_EACH", "SET", "WHERE", "DUAL", "IF", "EXISTS"]);

/** Names after FROM / JOIN / INTO / UPDATE / DELETE FROM (and FROM lists), and whether the statement writes. CTE names are left out. */
export function sqlTableRefs(text: string): { tables: string[]; write: boolean } {
  const toks = tokenize(text.replace(/\{[^}]*\}/g, " __hole__ "));
  const ctes = new Set<string>();
  for (let i = 0; i < toks.length - 2; i++) {
    if ((toks[i].u === "WITH" || toks[i].u === "," || toks[i].u === "RECURSIVE") && (toks[i + 1].k === "word" || toks[i + 1].k === "quoted") && toks[i + 2].u === "AS") ctes.add(toks[i + 1].v.toLowerCase());
  }
  const tables = new Set<string>();
  const first = toks.find((t) => t.k === "word" && t.u !== "WITH");
  let write = Boolean(first && /^(INSERT|UPDATE|DELETE|MERGE|REPLACE|UPSERT|TRUNCATE)$/.test(first.u));
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== "word" || !AFTER_TABLE.has(t.u)) continue;
    if (t.u === "UPDATE" && toks[i - 1]?.u === "ON") continue; // ON UPDATE / ON CONFLICT … DO UPDATE
    if (t.u === "UPDATE" && toks[i - 1]?.u === "DO") continue;
    if (t.u === "TABLE" && !/^(TRUNCATE|INTO)$/.test(toks[i - 1]?.u ?? "")) continue;
    if (t.u === "INTO" || t.u === "UPDATE") write = write || toks[0]?.u !== "SELECT";
    let j = i + 1;
    for (;;) {
      const nt = toks[j];
      if (!nt || (nt.k !== "word" && nt.k !== "quoted") || (nt.k === "word" && NOT_TABLES.has(nt.u)) || nt.v === "__hole__") break;
      if (toks[j + 1]?.v === "(" && nt.k === "word") break; // a function call
      let name = nt.v;
      j++;
      while (toks[j]?.v === "." && (toks[j + 1]?.k === "word" || toks[j + 1]?.k === "quoted")) {
        name += `.${toks[j + 1].v}`;
        j += 2;
      }
      if (!ctes.has(name.toLowerCase())) tables.add(name);
      // `FROM a x, b y`: a FROM list goes on after an alias and a comma.
      if (t.u !== "FROM") break;
      if (toks[j]?.u === "AS") j++;
      if (toks[j]?.k === "word" && !/^(WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|GROUP|ORDER|LIMIT|USING|NATURAL|UNION|HAVING|WINDOW|RETURNING|SET|VALUES|FOR|OFFSET)$/.test(toks[j].u)) j++;
      if (toks[j]?.v !== ",") break;
      j++;
    }
  }
  return { tables: [...tables], write };
}

// ---------------------------------------------------------------------------
// Dialect
// ---------------------------------------------------------------------------

/** A dialect guess from SQL text: Postgres, MySQL and SQLite each have tell-tale words. */
export function guessDialect(texts: readonly string[]): DbDialect | undefined {
  let pg = 0;
  let my = 0;
  let lite = 0;
  for (const text of texts) {
    if (/\b(BIGSERIAL|SERIAL|JSONB|TIMESTAMPTZ|BYTEA|UUID_GENERATE_V4|GEN_RANDOM_UUID|CREATE\s+EXTENSION|::\w+|USING\s+(btree|gin|gist)|DO\s+\$\$|CREATE\s+TYPE\s+\S+\s+AS\s+ENUM|CONCURRENTLY|TEXT\[\]|plpgsql)\b/i.test(text)) pg++;
    if (/(\bAUTO_INCREMENT\b|\bENGINE\s*=|`\w+`|\bUNSIGNED\b|\bDEFAULT\s+CHARSET\b|\bTINYINT\b|\bMEDIUMTEXT\b|\bLONGTEXT\b)/i.test(text)) my++;
    if (/\b(AUTOINCREMENT|PRAGMA|WITHOUT\s+ROWID|STRICT\s*;)\b/i.test(text)) lite++;
  }
  const best = Math.max(pg, my, lite);
  if (best === 0) return undefined;
  return pg === best ? "postgresql" : my === best ? "mysql" : "sqlite";
}
