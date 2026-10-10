// Database facts: the raw syntax a schema is declared and used with, read
// from a tree-sitter tree next to the symbol and route facts (./extract.mjs,
// DESIGN.md §6.13 §2). Nothing here decides what a table is called or which
// source wins — that takes other files and happens in lib/analysis/db/. Per
// file, as plain data:
//
//   entities    TS/JS classes with decorators on the class or its properties
//               (TypeORM `@Entity`, `@Column`, relations, `@Index`)
//   migrations  TS/JS classes with an `up(queryRunner)` method: the calls in it
//               (TypeORM `queryRunner.query(…)`, `createTable`, `addColumn`, …)
//   tables      module-level `const x = pgTable("x", {…}, …)` and kin, and
//               `pgEnum` (Drizzle)
//   classes     Python classes: bases, class keywords, attributes with their
//               values and annotations, an inner `class Meta` (Django models
//               and migrations, SQLAlchemy / SQLModel models)
//   assigns     Python module-level assignments (Alembic `revision`,
//               `down_revision`; SQLAlchemy `Table(…)`)
//   upgrade     the `op.*` calls of a Python `upgrade()` function (Alembic),
//               including `with op.batch_alter_table(t) as b:` blocks
//   uses        where code reaches a table: Prisma delegates
//               (`prisma.order.findMany`), query-builder table strings
//               (`knex("orders")`, `.from("orders")`, `selectFrom`, `table()`),
//               SQL text passed to a SQL call or a literal that starts like SQL
//   writes      lines with a write-ish call (`create`, `save`, `insert`, …)
//   hints       dialects the code names (`postgresql://…`, `dialect: "mysql"`)
//
// Values are kept as data (`DV`): a string, a template with holes, a
// number/boolean/null, a name, a call, a call chain, a list, an object, a
// function body, or other text. Plain JavaScript: it runs inside the parse
// worker. Lines are 1-based.

/**
 * @typedef {{ s: string } | { t: string } | { n: number } | { b: boolean } | { nil: true } | { id: string } | { call: string, args: DV[], kw?: Record<string, DV> } | { chain: Array<{ name: string, args: DV[] }> } | { list: DV[] } | { obj: Record<string, DV> } | { fn: DV } | { x: string }} DV
 */

const MAX_DEPTH = 12;
const MAX_ENTRIES = 400;
const MAX_STRING = 20000;
const MAX_USES = 600;
const MAX_TEXT = 200;

const PRISMA_OPS = new Set([
  "findMany", "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "create", "createMany", "createManyAndReturn",
  "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany", "count", "aggregate", "groupBy",
]);
const PRISMA_WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"]);
/** Builder methods whose first string argument names a table. */
const BUILDER_METHODS = new Set([
  "from", "table", "join", "leftJoin", "rightJoin", "innerJoin", "fullOuterJoin", "crossJoin", "leftOuterJoin", "rightOuterJoin", "into",
  "selectFrom", "insertInto", "updateTable", "deleteFrom", "replaceInto", "mergeInto", "getRepository",
]);
const BUILDER_WRITES = new Set(["into", "insertInto", "updateTable", "deleteFrom", "replaceInto", "mergeInto"]);
/** Callables that are a query builder on a table (`knex("orders")`). */
const BUILDER_CALLEES = new Set(["knex", "trx", "k"]);
/** Calls whose first argument is SQL text. */
const SQL_CALLS = new Set([
  "query", "execute", "exec", "executeQuery", "$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe", "raw", "unsafe", "prepare",
  "sql", "text", "RunSQL", "executemany", "executescript", "runSql", "executeSql", "queryRaw", "executeRaw", "mogrify",
]);
/** Tagged-template tags that hold SQL. */
const SQL_TAGS = /(^|\.)(sql|\$queryRaw|\$executeRaw|raw|query|SQL)$/;
const WRITE_CALLS = new Set([
  "create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany", "insert", "insertMany", "save", "remove", "softDelete",
  "softRemove", "increment", "decrement", "bulk_create", "bulk_update", "get_or_create", "update_or_create", "add", "add_all", "merge",
  "insertInto", "updateTable", "deleteFrom", "executeRaw", "$executeRaw", "$executeRawUnsafe",
]);
/** A literal that reads like a statement: kept as SQL text even outside a SQL call. */
const SQLISH = /^\s*(select\s[\s\S]*\sfrom\s|insert\s+into\s|update\s+[\w".`[\]]+\s+set\s|delete\s+from\s|with\s+(recursive\s+)?\w+\s+as\s*\()/i;
/** Leading SQL comments (sqlc's `-- name: X :one`) don't stop a literal reading as SQL. */
const stripLead = (text) => text.replace(/^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))+/, "");

/** JS table builders (Drizzle). */
const TABLE_BUILDERS = /^(pgTable|mysqlTable|sqliteTable|pgTableCreator|mysqlTableCreator|sqliteTableCreator|singlestoreTable|[\w$]+\.table|pgView|mysqlView|sqliteView|pgMaterializedView|pgEnum|mysqlEnum)$/;

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

function clip(text, max = MAX_STRING) {
  return text.length > max ? text.slice(0, max) : text;
}

function collapse(text, max = MAX_TEXT) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Dialect hints from a string the code holds. */
function dialectOfUrl(text) {
  if (/^(postgres(ql)?(\+\w+)?:\/\/|django\.db\.backends\.postgresql|django\.contrib\.gis\.db\.backends\.postgis)/i.test(text)) return "postgresql";
  if (/^(mysql(\+\w+)?:\/\/|mariadb:\/\/|django\.db\.backends\.mysql)/i.test(text)) return "mysql";
  if (/^(sqlite(\+\w+)?:\/\/|django\.db\.backends\.sqlite3)/i.test(text)) return "sqlite";
  return undefined;
}
function dialectOfName(text) {
  const t = text.toLowerCase();
  if (t === "postgres" || t === "postgresql" || t === "pg" || t === "cockroachdb") return "postgresql";
  if (t === "mysql" || t === "mariadb" || t === "mysql2") return "mysql";
  if (t === "sqlite" || t === "better-sqlite3" || t === "sqlite3" || t === "turso" || t === "libsql" || t === "d1") return "sqlite";
  return undefined;
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript
// ---------------------------------------------------------------------------

function jsString(node) {
  if (node.type === "string") return node.text.slice(1, -1);
  return undefined;
}

/** A template literal as text, holes as `{expr}`; `holes` says whether it had any. */
function jsTemplate(node) {
  let text = "";
  let holes = false;
  let last = node.startIndex + 1;
  for (const part of named(node)) {
    if (part.type === "template_substitution") {
      text += node.text.slice(last - node.startIndex, part.startIndex - node.startIndex);
      text += `{${collapse(part.text.replace(/^\$\{|\}$/g, ""), 60)}}`;
      holes = true;
      last = part.endIndex;
    }
  }
  text += node.text.slice(last - node.startIndex, node.text.length - 1);
  return { text, holes };
}

/** The call chain of `a("x").b().c(1)` / `t.a.b(…)`, innermost first. `null` when `node` isn't a call. */
function jsChain(node, depth) {
  const steps = [];
  let cur = node;
  while (cur && (cur.type === "call_expression" || cur.type === "new_expression")) {
    const fn = cur.childForFieldName(cur.type === "new_expression" ? "constructor" : "function");
    const argsNode = cur.childForFieldName("arguments");
    const args = argsNode && argsNode.type === "arguments" ? named(argsNode).filter((a) => a.type !== "comment").slice(0, MAX_ENTRIES).map((a) => jv(a, depth + 1)) : argsNode ? [jv(argsNode, depth + 1)] : [];
    if (fn?.type === "member_expression") {
      const prop = fn.childForFieldName("property")?.text ?? "";
      const obj = fn.childForFieldName("object");
      steps.unshift({ name: prop, args });
      if (obj && (obj.type === "call_expression" || obj.type === "new_expression")) {
        cur = obj;
        continue;
      }
      // `t.a.b(…)`: the object is a plain path — the chain's head is that path.
      steps[0] = { name: `${obj ? collapse(obj.text, 80) : ""}.${prop}`, args };
      return steps;
    }
    steps.unshift({ name: `${cur.type === "new_expression" ? "new " : ""}${collapse(fn?.text ?? "", 80)}`, args });
    return steps;
  }
  return steps;
}

/** @returns {DV} */
function jv(node, depth = 0) {
  if (!node) return { x: "" };
  switch (node.type) {
    case "string":
      return { s: clip(jsString(node) ?? "") };
    case "template_string": {
      const { text, holes } = jsTemplate(node);
      return holes ? { t: clip(text) } : { s: clip(text) };
    }
    case "number":
      return { n: Number(node.text.replace(/_/g, "")) };
    case "true":
    case "false":
      return { b: node.type === "true" };
    case "null":
    case "undefined":
      return { nil: true };
    case "identifier":
    case "property_identifier":
    case "shorthand_property_identifier":
    case "this":
      return { id: node.text };
    case "member_expression":
      return /^[\w$.]+$/.test(node.text) ? { id: node.text } : { x: collapse(node.text) };
    case "arrow_function":
    case "function_expression":
    case "function": {
      if (depth >= MAX_DEPTH) return { x: collapse(node.text) };
      const body = node.childForFieldName("body");
      if (!body) return { fn: { x: "" } };
      if (body.type === "statement_block") {
        const ret = named(body).find((s) => s.type === "return_statement");
        return { fn: ret ? jv(named(ret)[0], depth + 1) : { x: collapse(body.text) } };
      }
      return { fn: jv(body, depth + 1) };
    }
    case "parenthesized_expression":
    case "as_expression":
    case "satisfies_expression":
    case "non_null_expression":
    case "await_expression":
      return jv(named(node)[0], depth);
    case "call_expression":
    case "new_expression": {
      if (depth >= MAX_DEPTH) return { x: collapse(node.text) };
      const fn = node.childForFieldName(node.type === "new_expression" ? "constructor" : "function");
      const argsNode = node.childForFieldName("arguments");
      if (argsNode?.type === "template_string") return { call: collapse(fn?.text ?? "", 80), args: [jv(argsNode, depth + 1)] };
      const chain = jsChain(node, depth);
      if (chain.length === 1) return { call: chain[0].name, args: chain[0].args };
      return { chain };
    }
    case "array":
      if (depth >= MAX_DEPTH) return { x: collapse(node.text) };
      return { list: named(node).filter((c) => c.type !== "comment").slice(0, MAX_ENTRIES).map((c) => jv(c, depth + 1)) };
    case "object": {
      if (depth >= MAX_DEPTH) return { x: collapse(node.text) };
      const obj = {};
      for (const prop of named(node).slice(0, MAX_ENTRIES)) {
        if (prop.type === "pair") {
          const key = prop.childForFieldName("key");
          const keyText = key ? (key.type === "string" ? (jsString(key) ?? key.text) : key.text) : "";
          obj[keyText] = jv(prop.childForFieldName("value"), depth + 1);
        } else if (prop.type === "shorthand_property_identifier") obj[prop.text] = { id: prop.text };
      }
      return { obj };
    }
    case "unary_expression":
      if (/^-\s*\d/.test(node.text)) return { n: Number(node.text.replace(/\s|_/g, "")) };
      return { x: collapse(node.text) };
    default:
      return { x: collapse(node.text) };
  }
}

function jsDecorator(dec) {
  const expr = named(dec)[0];
  if (!expr) return null;
  if (expr.type === "call_expression") {
    const fn = expr.childForFieldName("function");
    const argsNode = expr.childForFieldName("arguments");
    return { name: collapse(fn?.text ?? "", 80), args: argsNode ? named(argsNode).filter((a) => a.type !== "comment").map((a) => jv(a, 1)) : [], line: line(dec) };
  }
  return { name: collapse(expr.text, 80), args: [], line: line(dec) };
}

function jsHeritage(node) {
  const out = { implements: [], extends: undefined };
  for (const child of named(node)) {
    if (child.type !== "class_heritage") continue;
    for (const clause of named(child)) {
      if (clause.type === "implements_clause") out.implements.push(...named(clause).map((c) => c.text));
      else if (clause.type === "extends_clause") out.extends = collapse(named(clause)[0]?.text ?? "", 80);
      else out.extends = collapse(clause.text, 80);
    }
  }
  return out;
}

/** A class's decorated shape (entities) and, when it has `up(queryRunner)`, its migration calls. */
function jsClassFacts(node, outerDecorators, out) {
  const name = node.childForFieldName("name")?.text;
  const body = node.childForFieldName("body");
  if (!name || !body) return;
  const decorators = [...outerDecorators, ...named(node).filter((c) => c.type === "decorator")].map(jsDecorator).filter(Boolean);
  const heritage = jsHeritage(node);
  const props = [];
  let pending = [];
  let up = null;
  for (const member of named(body)) {
    if (member.type === "decorator") {
      pending.push(member);
      continue;
    }
    if (member.type === "public_field_definition" || member.type === "field_definition") {
      const own = [...pending, ...named(member).filter((c) => c.type === "decorator")];
      pending = [];
      const propName = (member.childForFieldName("name") ?? member.childForFieldName("property"))?.text;
      if (!propName) continue;
      const type = member.childForFieldName("type");
      const optional = /^[^:=]*\?\s*:/.test(member.text.replace(/@[\s\S]*?\)\s*/g, ""));
      const value = member.childForFieldName("value");
      props.push({
        name: propName.replace(/^["']|["']$/g, ""),
        line: line(member),
        ...(type ? { type: collapse(type.text.replace(/^:\s*/, ""), 120) } : {}),
        ...(optional ? { optional: true } : {}),
        ...(value ? { value: jv(value, 1) } : {}),
        decorators: own.map(jsDecorator).filter(Boolean),
      });
      continue;
    }
    if (member.type === "method_definition") {
      pending = [];
      const methodName = member.childForFieldName("name")?.text;
      const params = member.childForFieldName("parameters");
      if (methodName === "up" && params && /QueryRunner|queryRunner/.test(params.text)) up = member;
      continue;
    }
    pending = [];
  }
  const isMigration = Boolean(up) || heritage.implements.some((i) => /MigrationInterface/.test(i));
  if (isMigration) {
    const calls = [];
    if (up) {
      const qr = up.childForFieldName("parameters") ? named(up.childForFieldName("parameters"))[0] : null;
      const qrName = qr ? (qr.childForFieldName("pattern")?.text ?? qr.text.split(":")[0].trim()) : "queryRunner";
      const walk = (n) => {
        if (calls.length >= MAX_ENTRIES) return;
        if (n.type === "call_expression") {
          const fn = n.childForFieldName("function");
          if (fn?.type === "member_expression") {
            const obj = fn.childForFieldName("object")?.text ?? "";
            const m = fn.childForFieldName("property")?.text ?? "";
            if (obj === qrName || /queryRunner$/.test(obj) || obj === "this.queryRunner") {
              const argsNode = n.childForFieldName("arguments");
              const args = argsNode?.type === "template_string" ? [jv(argsNode, 1)] : argsNode ? named(argsNode).filter((a) => a.type !== "comment").map((a) => jv(a, 1)) : [];
              calls.push({ m, args, line: line(n) });
              return;
            }
          }
        }
        for (const c of named(n)) walk(c);
      };
      const upBody = up.childForFieldName("body");
      if (upBody) walk(upBody);
    }
    out.migrations.push({ name, line: line(node), endLine: endLine(node), ...(heritage.implements.length ? { implements: heritage.implements } : {}), ...(up ? { up: [line(up), endLine(up)] } : {}), calls });
    return;
  }
  if (decorators.length === 0 && !props.some((p) => p.decorators.length)) return;
  out.entities.push({
    name,
    line: line(node),
    endLine: endLine(node),
    decorators,
    ...(heritage.extends ? { extends: heritage.extends } : {}),
    props: props.filter((p) => p.decorators.length),
  });
}

/** Records table uses and write hints in a JS/TS subtree. */
function jsUses(root, out) {
  const handled = new Set();
  const visit = (node) => {
    if (out.uses.length >= MAX_USES) return;
    if (node.type === "call_expression" || node.type === "new_expression") {
      const fn = node.childForFieldName(node.type === "new_expression" ? "constructor" : "function");
      const argsNode = node.childForFieldName("arguments");
      const first = argsNode?.type === "arguments" ? named(argsNode).find((a) => a.type !== "comment") : argsNode;
      let method = "";
      let object = null;
      if (fn?.type === "member_expression") {
        method = fn.childForFieldName("property")?.text ?? "";
        object = fn.childForFieldName("object");
      } else if (fn?.type === "identifier") method = fn.text;
      if (WRITE_CALLS.has(method)) out.writes.add(line(node));
      // Tagged template: sql`…`, prisma.$queryRaw`…`.
      if (argsNode?.type === "template_string" && fn && SQL_TAGS.test(fn.text)) {
        const { text } = jsTemplate(argsNode);
        out.uses.push({ k: "sql", text: clip(text, 4000), line: line(argsNode) });
        handled.add(argsNode.id);
      } else if (first && SQL_CALLS.has(method) && (first.type === "string" || first.type === "template_string")) {
        const text = first.type === "string" ? (jsString(first) ?? "") : jsTemplate(first).text;
        out.uses.push({ k: "sql", text: clip(text, 4000), line: line(first) });
        handled.add(first.id);
        if (/^\s*(insert|update|delete|merge|replace)\b/i.test(text)) out.writes.add(line(node));
      } else if (first && (first.type === "string" || (first.type === "template_string" && !first.text.includes("${")))) {
        const s = first.type === "string" ? jsString(first) : first.text.slice(1, -1);
        if ((BUILDER_METHODS.has(method) || (fn?.type === "identifier" && BUILDER_CALLEES.has(method))) && s && /^[\w$.]+(\s+(as\s+)?\w+)?$/i.test(s.trim())) {
          out.uses.push({ k: "builder", name: s.trim().split(/\s+/)[0], line: line(node), ...(BUILDER_WRITES.has(method) ? { w: 1 } : {}) });
          if (BUILDER_WRITES.has(method)) out.writes.add(line(node));
        }
      }
      // prisma.order.findMany(…): a delegate on any client object.
      if (object?.type === "member_expression" && PRISMA_OPS.has(method)) {
        const delegate = object.childForFieldName("property")?.text;
        if (delegate && /^[a-z_$][\w$]*$/.test(delegate) && !delegate.startsWith("$")) {
          out.uses.push({ k: "delegate", name: delegate, line: line(node), ...(PRISMA_WRITES.has(method) ? { w: 1 } : {}) });
        }
      }
    } else if ((node.type === "string" || node.type === "template_string") && !handled.has(node.id)) {
      const text = node.type === "string" ? (jsString(node) ?? "") : jsTemplate(node).text;
      if (SQLISH.test(stripLead(text))) out.uses.push({ k: "sql", text: clip(text, 4000), line: line(node), lit: 1 });
      const d = dialectOfUrl(text);
      if (d) out.hints.add(d);
      return;
    } else if (node.type === "pair") {
      const key = node.childForFieldName("key")?.text?.replace(/^["']|["']$/g, "");
      const value = node.childForFieldName("value");
      if (key && /^(dialect|type|client|provider|driver)$/.test(key) && value?.type === "string") {
        const d = dialectOfName(jsString(value) ?? "");
        if (d) out.hints.add(d);
      }
    }
    for (const child of named(node)) visit(child);
  };
  visit(root);
}

/** @param {import("web-tree-sitter").Node} root */
export function extractJsDb(root) {
  const out = { entities: [], migrations: [], tables: [], uses: [], writes: new Set(), hints: new Set() };
  for (const top of named(root)) {
    const isExport = top.type === "export_statement";
    const node = isExport ? (top.childForFieldName("declaration") ?? null) : top;
    if (!node) continue;
    if (node.type === "class_declaration" || node.type === "abstract_class_declaration" || node.type === "class") {
      const outer = isExport ? named(top).filter((c) => c.type === "decorator") : [];
      jsClassFacts(node, outer, out);
      continue;
    }
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const declarator of named(node)) {
        if (declarator.type !== "variable_declarator") continue;
        const local = declarator.childForFieldName("name")?.text;
        const value = declarator.childForFieldName("value");
        if (!local || !value || value.type !== "call_expression") continue;
        const chain = jsChain(value, 0);
        if (chain.length === 0) continue;
        // `pgTable(…)`, `mySchema.table(…)`, `pgTable(…).enableRLS()`, `pgEnum(…)`.
        const head = chain[0];
        const isSchemaTable = /^[\w$]+\.table$/.test(head.name);
        if (TABLE_BUILDERS.test(head.name) || isSchemaTable) {
          out.tables.push({ local, line: line(node), endLine: endLine(node), builder: head.name, args: head.args, ...(chain.length > 1 ? { rest: chain.slice(1).map((s) => s.name) } : {}) });
        } else if (chain.length >= 2 && /^(pgSchema|mysqlSchema)$/.test(head.name) && /^(table|enum|view)$/.test(chain[1].name)) {
          const schema = head.args[0] && "s" in head.args[0] ? head.args[0].s : undefined;
          out.tables.push({ local, line: line(node), endLine: endLine(node), builder: `schema.${chain[1].name}`, args: chain[1].args, ...(schema ? { schema } : {}) });
        }
      }
    }
  }
  jsUses(root, out);
  return finish(out);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function pyString(node) {
  if (node.type === "concatenated_string") return named(node).map((s) => pyString(s) ?? "").join("");
  if (node.type !== "string") return undefined;
  let text = "";
  for (const part of named(node)) {
    if (part.type === "string_content" || part.type === "escape_sequence") text += part.text;
    else if (part.type === "interpolation") text += `{${collapse(part.text.replace(/^\{|\}$/g, ""), 60)}}`;
  }
  return text;
}

/** @returns {DV} */
function pv(node, depth = 0) {
  if (!node) return { x: "" };
  switch (node.type) {
    case "string":
    case "concatenated_string": {
      const text = pyString(node) ?? "";
      return /^[rbuRBU]*[fF]/.test(node.text) && text.includes("{") ? { t: clip(text) } : { s: clip(text) };
    }
    case "integer":
    case "float":
      return { n: Number(node.text.replace(/_/g, "")) };
    case "true":
    case "false":
      return { b: node.type === "true" };
    case "none":
      return { nil: true };
    case "identifier":
      return { id: node.text };
    case "attribute":
      return /^[\w.]+$/.test(node.text) ? { id: node.text } : { x: collapse(node.text) };
    case "lambda":
      return { fn: pv(node.childForFieldName("body"), depth + 1) };
    case "call": {
      if (depth >= MAX_DEPTH) return { x: collapse(node.text) };
      const fn = node.childForFieldName("function");
      const argList = node.childForFieldName("arguments");
      const args = [];
      const kw = {};
      for (const arg of argList ? named(argList) : []) {
        if (arg.type === "keyword_argument") {
          const name = arg.childForFieldName("name")?.text;
          if (name) kw[name] = pv(arg.childForFieldName("value"), depth + 1);
        } else if (arg.type !== "comment" && args.length < MAX_ENTRIES) args.push(pv(arg, depth + 1));
      }
      // `postgresql.ENUM(…).create(…)` and friends: a call on a call.
      if (fn?.type === "attribute" && fn.childForFieldName("object")?.type === "call") {
        const inner = pv(fn.childForFieldName("object"), depth + 1);
        const steps = "chain" in inner ? inner.chain : "call" in inner ? [{ name: inner.call, args: inner.args, ...(inner.kw ? { kw: inner.kw } : {}) }] : [];
        return { chain: [...steps, { name: fn.childForFieldName("attribute")?.text ?? "", args, ...(Object.keys(kw).length ? { kw } : {}) }] };
      }
      return { call: collapse(fn?.text ?? "", 80), args, ...(Object.keys(kw).length ? { kw } : {}) };
    }
    case "list":
    case "tuple":
    case "set":
      if (depth >= MAX_DEPTH) return { x: collapse(node.text) };
      return { list: named(node).filter((c) => c.type !== "comment").slice(0, MAX_ENTRIES).map((c) => pv(c, depth + 1)) };
    case "dictionary": {
      if (depth >= MAX_DEPTH) return { x: collapse(node.text) };
      const obj = {};
      for (const pair of named(node)) {
        if (pair.type !== "pair") continue;
        const key = pair.childForFieldName("key");
        const keyText = key ? (pyString(key) ?? key.text) : "";
        obj[keyText] = pv(pair.childForFieldName("value"), depth + 1);
      }
      return { obj };
    }
    case "parenthesized_expression":
      return pv(named(node)[0], depth);
    case "unary_operator":
      if (/^-\s*\d/.test(node.text)) return { n: Number(node.text.replace(/\s|_/g, "")) };
      return { x: collapse(node.text) };
    default:
      return { x: collapse(node.text) };
  }
}

/** A class's attributes (with values and annotations), bases, class keywords and inner `Meta`. */
function pyClassFacts(node, decorators) {
  const name = node.childForFieldName("name")?.text;
  const supers = node.childForFieldName("superclasses");
  const body = node.childForFieldName("body");
  if (!name || !body) return null;
  const bases = [];
  const kw = {};
  for (const c of supers ? named(supers) : []) {
    if (c.type === "keyword_argument") {
      const k = c.childForFieldName("name")?.text;
      if (k) kw[k] = pv(c.childForFieldName("value"), 1);
    } else if (c.type !== "comment") bases.push(collapse(c.text, 120));
  }
  const attrs = [];
  const inner = {};
  for (const stmtTop of named(body)) {
    const stmt = stmtTop.type === "decorated_definition" ? stmtTop.childForFieldName("definition") : stmtTop;
    if (stmt?.type === "class_definition") {
      const innerName = stmt.childForFieldName("name")?.text;
      if (innerName === "Meta" || innerName === "Config") {
        const meta = {};
        for (const m of named(stmt.childForFieldName("body") ?? stmt)) {
          const a = m.type === "expression_statement" ? named(m)[0] : null;
          if (a?.type !== "assignment") continue;
          const key = a.childForFieldName("left")?.text;
          const right = a.childForFieldName("right");
          if (key && right) meta[key] = pv(right, 1);
        }
        inner[innerName] = meta;
      }
      continue;
    }
    if (stmt?.type !== "expression_statement" || attrs.length >= MAX_ENTRIES) continue;
    const a = named(stmt)[0];
    if (a?.type !== "assignment") continue;
    const left = a.childForFieldName("left");
    if (left?.type !== "identifier") continue;
    const type = a.childForFieldName("type");
    const right = a.childForFieldName("right");
    attrs.push({ name: left.text, line: line(stmt), ...(type ? { ann: collapse(type.text, 160) } : {}), ...(right ? { value: pv(right, 1) } : {}) });
  }
  return {
    name,
    line: line(node),
    endLine: endLine(node),
    bases,
    ...(Object.keys(kw).length ? { kw } : {}),
    ...(decorators.length ? { decorators } : {}),
    attrs,
    ...(inner.Meta ? { meta: inner.Meta } : {}),
  };
}

/** `op.*` calls (and `batch_op.*` inside `with op.batch_alter_table(t) as batch_op:`) in an Alembic `upgrade()`. */
function pyUpgradeCalls(fnNode) {
  const calls = [];
  const visit = (node, batch) => {
    if (calls.length >= MAX_ENTRIES) return;
    if (node.type === "with_statement") {
      let next = batch;
      for (const item of node.descendantsOfType ? node.descendantsOfType("with_item") : []) {
        const value = item.childForFieldName("value") ?? named(item)[0];
        const call = value?.type === "as_pattern" ? named(value)[0] : value;
        const alias = value?.type === "as_pattern" ? value.childForFieldName("alias")?.text ?? named(value)[1]?.text : undefined;
        if (call?.type === "call" && /batch_alter_table$/.test(call.childForFieldName("function")?.text ?? "")) {
          const v = pv(call, 1);
          const table = v.args?.[0] && "s" in v.args[0] ? v.args[0].s : undefined;
          if (alias && table) next = { ...(batch ?? {}), [alias.replace(/^as\s+/, "")]: { table, ...(v.kw?.schema && "s" in v.kw.schema ? { schema: v.kw.schema.s } : {}) } };
        }
      }
      const body = node.childForFieldName("body");
      if (body) for (const c of named(body)) visit(c, next);
      return;
    }
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      if (fn?.type === "attribute") {
        const obj = fn.childForFieldName("object")?.text ?? "";
        const m = fn.childForFieldName("attribute")?.text ?? "";
        const v = pv(node, 0);
        if (obj === "op") {
          calls.push({ m, args: v.args ?? [], ...(v.kw ? { kw: v.kw } : {}), line: line(node) });
          return;
        }
        if (batch && batch[obj]) {
          calls.push({ m, args: v.args ?? [], ...(v.kw ? { kw: v.kw } : {}), line: line(node), batch: batch[obj] });
          return;
        }
        // `postgresql.ENUM(…, name="x").create(op.get_bind())`, `sa.Enum(…).create(bind)`.
        if (m === "create" && "chain" in v) {
          calls.push({ m: "create_enum", args: [v], line: line(node) });
          return;
        }
      }
    }
    for (const c of named(node)) visit(c, batch);
  };
  const body = fnNode.childForFieldName("body");
  if (body) for (const c of named(body)) visit(c, undefined);
  return calls;
}

const PY_SQL_FNS = /(^|\.)(text|RunSQL)$/;

function pyUses(root, out) {
  const handled = new Set();
  const visit = (node) => {
    if (out.uses.length >= MAX_USES) return;
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      const argList = node.childForFieldName("arguments");
      const first = argList ? named(argList).find((a) => a.type !== "comment" && a.type !== "keyword_argument") : null;
      const method = fn?.type === "attribute" ? (fn.childForFieldName("attribute")?.text ?? "") : (fn?.text ?? "");
      if (WRITE_CALLS.has(method)) out.writes.add(line(node));
      const s = first && (first.type === "string" || first.type === "concatenated_string") ? pyString(first) : undefined;
      if (s !== undefined && (SQL_CALLS.has(method) || PY_SQL_FNS.test(fn?.text ?? ""))) {
        out.uses.push({ k: "sql", text: clip(s, 4000), line: line(first) });
        handled.add(first.id);
        if (/^\s*(insert|update|delete|merge|replace)\b/i.test(s)) out.writes.add(line(node));
      } else if (s !== undefined && (method === "table" || method === "Table" || BUILDER_METHODS.has(method)) && /^[\w.]+$/.test(s.trim())) {
        // SQLAlchemy `table("orders")` (lightweight table construct); a module-level `Table("orders", metadata, …)` is a model, read in ./catalog.
        if (method !== "Table") out.uses.push({ k: "builder", name: s.trim(), line: line(node) });
      }
    } else if ((node.type === "string" || node.type === "concatenated_string") && !handled.has(node.id)) {
      const text = pyString(node) ?? "";
      if (SQLISH.test(stripLead(text))) out.uses.push({ k: "sql", text: clip(text, 4000), line: line(node), lit: 1 });
      const d = dialectOfUrl(text);
      if (d) out.hints.add(d);
      return;
    } else if (node.type === "pair") {
      const key = node.childForFieldName("key");
      const value = node.childForFieldName("value");
      const k = key ? pyString(key) : undefined;
      const v = value ? pyString(value) : undefined;
      if (k === "ENGINE" && v) {
        const d = dialectOfUrl(v);
        if (d) out.hints.add(d);
      }
    }
    for (const child of named(node)) visit(child);
  };
  visit(root);
}

/** @param {import("web-tree-sitter").Node} root */
export function extractPythonDb(root) {
  const out = { classes: [], assigns: [], upgrade: [], uses: [], writes: new Set(), hints: new Set() };
  for (const top of named(root)) {
    if (top.type === "decorated_definition") {
      const def = top.childForFieldName("definition");
      if (def?.type === "class_definition") {
        const facts = pyClassFacts(def, named(top).filter((c) => c.type === "decorator").map((d) => collapse(d.text.replace(/^@/, ""), 80)));
        if (facts) out.classes.push(facts);
      }
      continue;
    }
    if (top.type === "class_definition") {
      const facts = pyClassFacts(top, []);
      if (facts) out.classes.push(facts);
      continue;
    }
    if (top.type === "function_definition" && top.childForFieldName("name")?.text === "upgrade") {
      out.upgrade.push(...pyUpgradeCalls(top));
      continue;
    }
    if (top.type === "expression_statement") {
      const a = named(top)[0];
      if (a?.type !== "assignment") continue;
      const left = a.childForFieldName("left");
      const right = a.childForFieldName("right");
      if (left?.type !== "identifier" || !right) continue;
      // Keep what the catalog reads: revision ids, and `Table(…)` / `sa.Table(…)` declarations.
      if (/^(revision|down_revision|branch_labels|depends_on)$/.test(left.text) || (right.type === "call" && /(^|\.)Table$/.test(right.childForFieldName("function")?.text ?? ""))) {
        out.assigns.push({ name: left.text, line: line(top), value: pv(right, 0) });
      }
    }
  }
  pyUses(root, out);
  return finish(out);
}

function finish(out) {
  const result = {};
  for (const [key, value] of Object.entries(out)) {
    if (value instanceof Set) {
      if (value.size) result[key] = [...value].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } else if (Array.isArray(value) && value.length) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}
