/**
 * Links from code to tables (DESIGN.md §6.13 §4), three ways, each marked:
 *
 *   model    a reference to the table's model — the class, the Drizzle
 *            table object (through the symbol graph's resolved uses, and
 *            same-file references), or a Prisma delegate (`prisma.order.*`)
 *   builder  a table named as a string in a query-builder call (Knex,
 *            Kysely, TypeORM `from("orders")`, SQLAlchemy `table("orders")`)
 *   sql      table names in SQL text — kept only when they name a known
 *            table ("from SQL text")
 *
 * Each use sits in a declaration (by line), so an endpoint is linked to
 * every table its handler, or a function its handler reaches (§6.11), uses.
 */
import type { ApiCatalog } from "../api/types";
import type { SymbolFacts } from "../ir";
import type { SymbolGraph } from "../symbols";
import { tableKey } from "./replay";
import { sqlTableRefs } from "./sql";
import { MAX_USES, type Database, type DbCodeFacts, type DbSchema, type DbTableUse, type DbUseVia } from "./types";

export interface LinkInput {
  code: ReadonlyArray<{ file: string; facts: DbCodeFacts; symbols?: SymbolFacts }>;
  symbols: SymbolGraph;
  api: ApiCatalog;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function linkTables(databases: readonly Database[], input: LinkInput): Pick<DbSchema, "uses" | "endpointTables"> {
  const tables = databases.flatMap((d) => d.tables);
  if (tables.length === 0) return { uses: [], endpointTables: {} };
  // Name → tables (bare and schema-qualified, case-insensitive).
  const byName = new Map<string, string[]>();
  const addName = (name: string, id: string) => {
    const k = tableKey(name);
    const list = byName.get(k) ?? byName.set(k, []).get(k)!;
    if (!list.includes(id)) list.push(id);
  };
  const modelDecls = new Map<string, string>();
  const delegates = new Map<string, string>();
  for (const t of tables) {
    addName(t.schema ? `${t.schema}.${t.name}` : t.name, t.id);
    if (t.schema) addName(t.name, t.id);
    for (const m of t.models) {
      if (m.decl) modelDecls.set(m.decl, t.id);
      if (m.tool === "prisma") delegates.set(lowerFirst(m.name), t.id);
    }
  }
  const resolveName = (raw: string) => {
    const clean = raw.replace(/["`[\]]/g, "");
    return byName.get(tableKey(clean)) ?? [];
  };
  const migrationFiles = new Set(databases.flatMap((d) => d.migrations.map((m) => m.file)));

  // Declarations per file, for "which function is this line in".
  const declsByFile = new Map<string, Array<{ id: string; start: number; end: number }>>();
  for (const d of input.symbols.decls) (declsByFile.get(d.file) ?? declsByFile.set(d.file, []).get(d.file)!).push({ id: d.id, start: d.startLine, end: d.endLine });
  const innermost = (file: string, line: number) => {
    let best: { id: string; start: number; end: number } | undefined;
    for (const d of declsByFile.get(file) ?? []) if (d.start <= line && line <= d.end && (!best || d.end - d.start < best.end - best.start)) best = d;
    return best?.id;
  };

  const uses: DbTableUse[] = [];
  const seen = new Set<string>();
  const writesByFile = new Map(input.code.map((c) => [c.file, new Set(c.facts.writes ?? [])]));
  const add = (table: string, file: string, line: number, via: DbUseVia, write: boolean | undefined) => {
    const key = `${table}\u0000${file}\u0000${line}\u0000${via}`;
    if (seen.has(key)) return;
    seen.add(key);
    const decl = innermost(file, line);
    uses.push({ table, file, line, via, ...(write === undefined ? {} : { access: write ? "write" : "read" }), ...(decl ? { decl } : {}) });
  };

  for (const { file, facts } of input.code) {
    if (migrationFiles.has(file)) continue;
    const writes = writesByFile.get(file);
    for (const u of facts.uses ?? []) {
      const write = Boolean(u.w) || Boolean(writes?.has(u.line));
      if (u.k === "delegate" && u.name) {
        const id = delegates.get(u.name);
        if (id) add(id, file, u.line, "model", write);
      } else if (u.k === "builder" && u.name) {
        for (const id of resolveName(u.name).slice(0, 3)) add(id, file, u.line, "builder", write);
      } else if (u.k === "sql" && u.text) {
        const refs = sqlTableRefs(u.text);
        for (const name of refs.tables) for (const id of resolveName(name).slice(0, 3)) add(id, file, u.line, "sql", refs.write);
      }
    }
  }
  // Model references through the symbol graph (imports resolved), then in the model's own file.
  for (const use of input.symbols.uses) {
    const id = modelDecls.get(use.target);
    if (!id || migrationFiles.has(use.file) || use.typeOnly) continue;
    const writes = writesByFile.get(use.file);
    for (const line of use.lines) add(id, use.file, line, "model", writes?.has(line) ? true : undefined);
  }
  const symbolsByFile = new Map(input.code.filter((c) => c.symbols).map((c) => [c.file, c.symbols!]));
  for (const [declId, id] of modelDecls) {
    const at = declId.lastIndexOf("#");
    const file = declId.slice(0, at);
    const name = declId.slice(at + 1);
    const facts = symbolsByFile.get(file);
    const own = input.symbols.decls.find((d) => d.id === declId);
    const writes = writesByFile.get(file);
    for (const line of facts?.refs[name] ?? []) {
      if (own && line >= own.startLine && line <= own.endLine) continue;
      add(id, file, line, "model", writes?.has(line) ? true : undefined);
    }
  }

  // Python imports the resolver couldn't place (a package under `backend/`
  // imported as `app.models`): a `from <module> import <Model>` whose module
  // path ends the model's file path still names that model.
  const pyModels = [...modelDecls].flatMap(([declId, id]) => {
    const at = declId.lastIndexOf("#");
    const file = declId.slice(0, at);
    if (!file.endsWith(".py")) return [];
    return [{ module: file.replace(/(\/__init__)?\.py$/, ""), name: declId.slice(at + 1), id }];
  });
  if (pyModels.length) {
    for (const { file, symbols } of input.code) {
      if (!file.endsWith(".py") || !symbols || migrationFiles.has(file)) continue;
      const writes = writesByFile.get(file);
      for (const imp of symbols.imports) {
        const path = imp.source.replace(/^\.+/, "").replace(/\./g, "/");
        if (!path) continue;
        for (const b of imp.bindings) {
          const m = pyModels.find((x) => x.name === b.imported && (x.module === path || x.module.endsWith(`/${path}`)));
          if (!m) continue;
          for (const line of symbols.refs[b.local] ?? []) if (line < imp.startLine || line > imp.endLine) add(m.id, file, line, "model", writes?.has(line) ? true : undefined);
        }
      }
    }
  }

  // Endpoints: the tables any function they reach uses.
  const usesByDecl = new Map<string, DbTableUse[]>();
  const usesByFile = new Map<string, DbTableUse[]>();
  for (const u of uses) {
    if (u.decl) (usesByDecl.get(u.decl) ?? usesByDecl.set(u.decl, []).get(u.decl)!).push(u);
    (usesByFile.get(u.file) ?? usesByFile.set(u.file, []).get(u.file)!).push(u);
  }
  const endpointTables: DbSchema["endpointTables"] = {};
  const tableById = new Map(tables.map((t) => [t.id, t]));
  for (const e of input.api.endpoints) {
    if (!e.handler) continue;
    const found: DbTableUse[] = [];
    for (const u of usesByFile.get(e.handler.file) ?? []) if (u.line >= e.handler.startLine && u.line <= e.handler.endLine) found.push(u);
    if (e.handler.declId) found.push(...(usesByDecl.get(e.handler.declId) ?? []));
    for (const step of e.reach) found.push(...(usesByDecl.get(step.id) ?? []));
    if (found.length === 0) continue;
    const per = new Map<string, { via: Set<DbUseVia>; read: boolean; write: boolean }>();
    for (const u of found) {
      const p = per.get(u.table) ?? per.set(u.table, { via: new Set(), read: false, write: false }).get(u.table)!;
      p.via.add(u.via);
      if (u.access === "write") p.write = true;
      if (u.access === "read") p.read = true;
    }
    endpointTables[e.id] = [...per].map(([table, p]) => ({
      table,
      via: [...p.via].sort(),
      ...(p.write && p.read ? { access: "both" as const } : p.write ? { access: "write" as const } : p.read ? { access: "read" as const } : {}),
    }));
    for (const [table, p] of per) {
      const t = tableById.get(table);
      if (!t) continue;
      (t.endpoints ??= []).push({
        endpoint: e.id,
        label: `${e.method} ${e.path}`,
        via: [...p.via].sort(),
        ...(p.write && p.read ? { access: "both" as const } : p.write ? { access: "write" as const } : p.read ? { access: "read" as const } : {}),
      });
    }
  }
  const counts = new Map<string, { uses: number; files: Set<string> }>();
  for (const u of uses) {
    const c = counts.get(u.table) ?? counts.set(u.table, { uses: 0, files: new Set() }).get(u.table)!;
    c.uses++;
    c.files.add(u.file);
  }
  for (const t of tables) {
    const c = counts.get(t.id);
    if (c) t.usage = { uses: c.uses, files: c.files.size };
  }
  uses.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { uses: uses.slice(0, MAX_USES), endpointTables };
}
