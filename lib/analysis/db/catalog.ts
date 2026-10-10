/**
 * The schema catalog of one analysed tree (DESIGN.md §6.13 §3): every
 * source's resolver, the databases they make up, migrations replayed and
 * merged with schema files and models (each table and column labelled with
 * its best source), drift between them, and the code's links to the tables
 * (./link.ts). Runs at the end of `analyzeTree`, beside the API and infra
 * catalogs. A resolver that throws costs only its own sources.
 */
import type { ApiCatalog } from "../api/types";
import type { SymbolFacts } from "../ir";
import type { SymbolGraph } from "../symbols";
import { baseOf, dirOf, sharedDepth, type DeclSet, type MigrationSet, type TableDecl } from "./common";
import { linkTables } from "./link";
import type { DbFileFacts } from "./read";
import { SchemaState, splitName, tableKey, type TableState } from "./replay";
import { resolveDjango } from "./sources/django";
import { resolveDrizzle } from "./sources/drizzle";
import { resolvePrisma } from "./sources/prisma";
import { resolveSqlFiles } from "./sources/sql-files";
import { alembicMigrations, sqlalchemyModels } from "./sources/sqlalchemy";
import { typeormEntities, typeormMigrations } from "./sources/typeorm";
import { guessDialect } from "./sql";
import {
  EMPTY_DB_SCHEMA,
  type Database,
  type DbCodeFacts,
  type DbColumn,
  type DbDialect,
  type DbOp,
  type DbSchema,
  type DbSourceKind,
  type DbSourceRef,
  type DbTable,
  type DbTool,
} from "./types";

export interface BuildDbSchemaInput {
  /** `.sql`, `.prisma`, Drizzle journals, Prisma lock files, as read. */
  dbFiles: ReadonlyArray<{ file: string; facts: DbFileFacts }>;
  /** Code files' database facts (../syntax/db.mjs, or the lexical SQL scan). */
  code: ReadonlyArray<{ file: string; facts: DbCodeFacts; symbols?: SymbolFacts }>;
  symbols: SymbolGraph;
  api: ApiCatalog;
}

function run<T>(name: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    console.warn(`[db] ${name} failed: ${(error as Error).message}`);
    return fallback;
  }
}

/** Which migration families a declarative source can belong to, best first. */
const FAMILIES: Record<DbTool, string[]> = {
  prisma: ["prisma"],
  drizzle: ["drizzle"],
  typeorm: ["typeorm", "sql"],
  django: ["django"],
  sqlalchemy: ["sqlalchemy", "sql"],
  sqlmodel: ["sqlalchemy", "sql"],
  alembic: ["sqlalchemy"],
  "golang-migrate": ["sql"],
  dbmate: ["sql"],
  goose: ["sql"],
  supabase: ["sql"],
  flyway: ["sql"],
  sql: ["sql", "typeorm", "sqlalchemy", "prisma", "drizzle", "django"],
};

/** Bookkeeping tables of the migration tools themselves — never "a table no model maps". */
const SYSTEM_TABLES = /^(_prisma_migrations|__drizzle_migrations|django_migrations|alembic_version|schema_migrations|flyway_schema_history|goose_db_version|typeorm_metadata|migrations)$/i;

interface DbBuild {
  id: string;
  name: string;
  set?: MigrationSet;
  decls: DeclSet[];
}

const RANK: Record<DbSourceKind, number> = { migration: 0, schema: 1, model: 2 };

function cloneColumn(c: DbColumn, source: DbSourceKind): DbColumn {
  return { ...c, source };
}

function fromDecl(t: TableDecl, kind: DbSourceKind): TableState {
  const { schema, name } = splitName(t.name);
  return {
    ...(schema ? { schema } : {}),
    name,
    columns: t.columns.map((c) => cloneColumn(c, kind)),
    pk: [...t.pk],
    indexes: t.indexes.map((i) => ({ ...i })),
    fks: t.fks.map((f) => ({ ...f })),
    checks: t.checks.map((c) => ({ ...c })),
    history: [],
    definedAt: { file: t.file, line: t.line },
    ...(t.view ? { view: true as const } : {}),
  };
}

const lc = (s: string) => s.toLowerCase();

function buildDatabase(build: DbBuild, hints: readonly DbDialect[]): Database {
  const sources: DbSourceRef[] = [];
  const tools = new Set<DbTool>();
  const problems = [...(build.set?.problems ?? [])];
  // 1. Migrations, replayed.
  const state = new SchemaState("migration", true);
  const migrations = build.set?.migrations ?? [];
  for (const m of migrations) for (const op of m.ops) state.apply(op, { id: m.id, name: m.name, file: m.file });
  if (build.set) {
    tools.add(build.set.tool);
    sources.push({ tool: build.set.tool, kind: "migration", path: build.set.root, files: new Set(migrations.map((m) => m.file)).size });
  }
  const hasMigrations = migrations.length > 0;
  // 2. Declarative files and models, by rank.
  const declared = new Map<string, Array<{ decl: TableDecl; set: DeclSet }>>();
  const enumDecls: DeclSet["enums"] = [];
  for (const set of build.decls) {
    tools.add(set.tool);
    sources.push({ tool: set.tool, kind: set.kind, path: set.root || (set.files.length === 1 ? set.files[0] : "(repo root)"), files: set.files.length });
    for (const t of set.tables) {
      const key = tableKey(t.name);
      (declared.get(key) ?? declared.set(key, []).get(key)!).push({ decl: t, set });
    }
    enumDecls.push(...set.enums);
  }
  for (const list of declared.values()) list.sort((a, b) => RANK[a.set.kind] - RANK[b.set.kind]);

  // 3. Merge: the best source defines the table; lower ones add what it lacks and are compared for drift.
  const keys = new Set([...state.tables.keys(), ...declared.keys()]);
  const exactKind: DbSourceKind | undefined = hasMigrations ? "migration" : build.decls.some((d) => d.kind === "schema") ? "schema" : undefined;
  const tables: DbTable[] = [];
  for (const key of keys) {
    const migrated = state.tables.get(key);
    const decls = declared.get(key) ?? [];
    const best: TableState = migrated ?? fromDecl(decls[0].decl, decls[0].set.kind);
    const bestKind: DbSourceKind = migrated ? "migration" : decls[0].set.kind;
    const table: DbTable = {
      id: "",
      database: build.id,
      ...(best.schema ? { schema: best.schema } : {}),
      name: best.name,
      columns: best.columns.map((c) => ({ ...c })),
      pk: [...best.pk],
      indexes: best.indexes.map((i) => ({ ...i })),
      fks: best.fks.map((f) => ({ ...f, ...(bestKind === "model" ? { inferred: true as const } : {}) })),
      checks: best.checks.map((c) => ({ ...c })),
      source: bestKind,
      sources: [...new Set([...(migrated ? ["migration" as const] : []), ...decls.map((d) => d.set.kind)])],
      definedAt: best.definedAt,
      history: best.history,
      models: [],
      drift: [],
      ...(best.view ? { view: true as const } : {}),
    };
    const exact = exactKind === "migration" ? migrated : exactKind === "schema" ? decls.find((d) => d.set.kind === "schema")?.decl : undefined;
    const exactCols = exact ? new Set(exact.columns.map((c) => lc(c.name))) : undefined;
    for (const { decl, set } of decls) {
      if (decl.model) table.models.push(decl.model);
      for (const f of decl.fields ?? []) {
        const col = table.columns.find((c) => lc(c.name) === lc(f.column));
        if (col && f.field !== col.name && !col.modelField) col.modelField = f.field;
      }
      if (set.kind !== bestKind || decl !== decls[0]?.decl || migrated) {
        for (const c of decl.columns) if (!table.columns.some((x) => lc(x.name) === lc(c.name))) table.columns.push(cloneColumn(c, set.kind));
        for (const fk of decl.fks) {
          if (!table.fks.some((x) => x.columns.join(",").toLowerCase() === fk.columns.join(",").toLowerCase())) table.fks.push({ ...fk, ...(set.kind === "model" ? { inferred: true as const } : {}) });
        }
        if (bestKind !== "migration") for (const i of decl.indexes) if (!table.indexes.some((x) => x.columns.join(",").toLowerCase() === i.columns.join(",").toLowerCase())) table.indexes.push({ ...i });
      }
      // Drift: a lower source against the exact one.
      if (!exactKind || RANK[set.kind] <= RANK[exactKind] || decl.view) continue;
      const what = set.kind === "schema" ? (set.tool === "prisma" ? "schema.prisma" : `the ${set.tool} schema`) : `model ${decl.model?.name ?? decl.name}`;
      const against = exactKind === "migration" ? "the migrations" : "the schema file";
      if (!exact) {
        if (decl.unmanaged) continue;
        table.drift.push({ kind: "model-no-table", text: `${what} declares this table; ${against} don't create it`, file: decl.file, line: decl.line });
        continue;
      }
      const declCols = new Set(decl.columns.map((c) => lc(c.name)));
      for (const f of decl.fields ?? []) {
        if (!exactCols!.has(lc(f.column))) table.drift.push({ kind: "field-no-column", column: f.column, text: `${set.kind === "schema" ? "field" : "model field"} ${f.field}${f.column !== f.field ? ` (column ${f.column})` : ""} has no column in ${against}`, file: decl.file, ...(f.line ? { line: f.line } : {}) });
      }
      for (const c of exact.columns) {
        if (!declCols.has(lc(c.name))) table.drift.push({ kind: "column-no-field", column: c.name, text: `column ${c.name} is in ${against} but ${what} doesn't map it`, file: decl.file, line: decl.line });
      }
    }
    if (exactKind && exact && !table.view && !SYSTEM_TABLES.test(table.name)) {
      const complete = build.decls.find((d) => d.complete && RANK[d.kind] > RANK[exactKind]);
      if (complete && !decls.some((d) => d.set === complete)) {
        table.drift.push({ kind: "table-no-model", text: `${exactKind === "migration" ? "the migrations create" : "the schema file declares"} this table; ${complete.tool === "prisma" ? "schema.prisma" : `the ${complete.tool} schema`} has no model for it`, file: table.definedAt.file, line: table.definedAt.line });
      }
    }
    tables.push(table);
  }

  // 4. Ids, references and enums.
  const id = (t: { schema?: string; name: string }) => `${build.id}:${tableKey(t.schema ? `${t.schema}.${t.name}` : t.name)}`;
  const byKey = new Map<string, DbTable>();
  for (const t of tables) {
    t.id = id(t);
    byKey.set(tableKey(t.schema ? `${t.schema}.${t.name}` : t.name), t);
  }
  for (const t of tables) for (const fk of t.fks) {
    const target = byKey.get(tableKey(fk.refTable));
    if (target) fk.refTable = target.id;
  }
  const enums = state.enumList(build.id, "migration");
  for (const e of enumDecls) {
    const eid = `${build.id}:${tableKey(e.name)}`;
    if (!enums.some((x) => x.id === eid)) enums.push({ id: eid, name: e.name, values: [...e.values], file: e.file, line: e.line, source: build.decls.find((d) => d.enums.includes(e))?.kind ?? "model" });
  }
  const enumByName = new Map(enums.map((e) => [tableKey(e.name), e.id]));
  for (const t of tables) for (const c of t.columns) {
    const e = enumByName.get(tableKey(c.enum ?? c.type.replace(/\[\]$/, "")));
    if (e) c.enum = e;
    else if (c.enum && !c.enum.includes(":")) delete c.enum;
  }
  tables.sort((a, b) => (a.schema ?? "").localeCompare(b.schema ?? "") || a.name.localeCompare(b.name));

  // 5. Dialect: declared, else what the code names, else guessed from the SQL.
  let dialect = build.set && !build.set.dialectGuessed ? build.set.dialect : undefined;
  dialect ??= build.decls.filter((d) => d.tool !== "sql").map((d) => d.dialect).find(Boolean);
  let dialectGuessed = false;
  const sqlFileDialect = build.decls.filter((d) => d.tool === "sql").map((d) => d.dialect).find(Boolean);
  if (!dialect && hints.length === 1) dialect = hints[0];
  if (!dialect && (build.set?.dialect || sqlFileDialect)) {
    dialect = build.set?.dialect ?? sqlFileDialect;
    dialectGuessed = true;
  }
  if (!dialect) {
    const texts = migrations.flatMap((m) => m.ops.map((op) => ("text" in op ? op.text : "") + (op.op === "createTable" ? op.columns.map((c) => c.type).join(" ") : "")));
    const g = guessDialect(texts);
    if (g) {
      dialect = g;
      dialectGuessed = true;
    }
  }
  return {
    id: build.id,
    name: build.name,
    ...(dialect ? { dialect } : {}),
    ...(dialectGuessed ? { dialectGuessed: true as const } : {}),
    tools: [...tools],
    sources,
    tables,
    enums,
    migrations,
    opaque: state.opaque,
    orderProblems: problems,
  };
}

/** Schema files' tables (from `schema.sql`, `structure.sql`, `schema/`) as a declarative source. */
function sqlSchemaDecl(file: string, ops: DbOp[], dialect?: DbDialect): DeclSet {
  const state = new SchemaState("schema", false);
  for (const op of ops) state.apply(op, { id: file, name: baseOf(file), file });
  const tables: TableDecl[] = [...state.tables.values()].map((t) => ({
    name: t.schema ? `${t.schema}.${t.name}` : t.name,
    columns: t.columns,
    pk: t.pk,
    fks: t.fks,
    indexes: t.indexes,
    checks: t.checks,
    file,
    line: t.definedAt.line,
    ...(t.view ? { view: true as const } : {}),
  }));
  return {
    tool: "sql",
    kind: "schema",
    root: dirOf(file),
    files: [file],
    tables,
    enums: [...state.enums.values()].map((e) => ({ name: e.schema ? `${e.schema}.${e.name}` : e.name, values: e.values, file, line: e.line })),
    ...(dialect ? { dialect } : {}),
  };
}

export function buildDbSchema(input: BuildDbSchemaInput): DbSchema {
  const code = input.code.map(({ file, facts }) => ({ file, facts }));
  if (input.dbFiles.length === 0 && !code.some(({ facts }) => facts.entities || facts.migrations || facts.tables || facts.classes || facts.assigns)) {
    return { ...EMPTY_DB_SCHEMA, ...linkTables([], input) };
  }
  const prisma = run("Prisma", () => resolvePrisma(input.dbFiles), { migrations: [], decls: [], claimed: new Set<string>() });
  const drizzle = run("Drizzle", () => resolveDrizzle(input.dbFiles, code), { migrations: [], decls: [], claimed: new Set<string>() });
  const claimed = new Set([...prisma.claimed, ...drizzle.claimed]);
  const sql = run("SQL files", () => resolveSqlFiles(input.dbFiles, claimed), { migrations: [], schemas: [] });
  const typeormDecl = run("TypeORM entities", () => typeormEntities(code), null);
  const typeormSets = run("TypeORM migrations", () => typeormMigrations(code), []);
  const django = run("Django", () => resolveDjango(code), { migrations: [], decls: [] });
  const saDecls = run("SQLAlchemy", () => sqlalchemyModels(code), []);
  const alembic = run("Alembic", () => alembicMigrations(code), []);

  const sets: MigrationSet[] = [...prisma.migrations, ...drizzle.migrations, ...typeormSets, ...django.migrations, ...alembic, ...sql.migrations];
  const decls: DeclSet[] = [
    ...prisma.decls,
    ...drizzle.decls,
    ...(typeormDecl ? [typeormDecl] : []),
    ...django.decls,
    ...saDecls,
    ...run("schema files", () => sql.schemas.map((s) => sqlSchemaDecl(s.file, s.ops, s.dialect)), []),
  ].filter((d) => d.tables.length > 0 || d.enums.length > 0);

  // One database per migration set; each declarative source joins the nearest compatible one.
  const builds: DbBuild[] = sets.map((s) => ({
    id: s.tool === "django" ? "django" : `${s.tool}:${s.root || "."}`,
    name: s.tool === "django" ? "Django" : s.root || "(repo root)",
    set: s,
    decls: [],
  }));
  for (const d of decls) {
    const families = FAMILIES[d.tool];
    let best: DbBuild | undefined;
    let bestScore = -1;
    for (const b of builds) {
      if (!b.set) continue;
      const rank = families.indexOf(b.set.family);
      if (rank < 0) continue;
      const depth = sharedDepth(d.root || ".", b.set.root || ".");
      // The tool's own family always fits; a plain-SQL folder only when it is nearby (or the only one).
      const sameFamily = rank === 0 && b.set.family !== "sql";
      const sqlCount = builds.filter((x) => x.set?.family === "sql").length;
      if (!sameFamily && d.tool !== "sql" && depth === 0 && sqlCount > 1) continue;
      const single = builds.filter((x) => x.set).length === 1;
      if (d.tool === "sql" && !single && b.set.family === "sql" && sharedDepth(dirOf(b.set.root) || ".", d.root || ".") < (dirOf(b.set.root) ? dirOf(b.set.root).split("/").length : 0)) continue;
      if (d.tool === "sql" && !single && b.set.family !== "sql" && depth === 0) continue;
      const score = (families.length - rank) * 100 + depth;
      if (score > bestScore) {
        best = b;
        bestScore = score;
      }
    }
    if (best) best.decls.push(d);
    else {
      const id = `${d.tool}:${d.root || "."}`;
      const existing = builds.find((b) => b.id === id && !b.set);
      if (existing) existing.decls.push(d);
      else builds.push({ id, name: d.kind === "schema" && d.files.length === 1 ? d.files[0] : d.root || "(repo root)", decls: [d] });
    }
  }
  // Ids are unique (two Prisma schemas with the same folder can't happen; a guard anyway).
  const seen = new Set<string>();
  for (const b of builds) {
    while (seen.has(b.id)) b.id = `${b.id}#2`;
    seen.add(b.id);
  }
  const hints = [...new Set(code.flatMap(({ facts }) => facts.hints ?? []))];
  const databases = builds
    .map((b) => run(`database ${b.id}`, () => buildDatabase(b, hints), null))
    .filter((d): d is Database => d !== null && (d.tables.length > 0 || d.migrations.length > 0 || d.orderProblems.length > 0));
  databases.sort((a, b) => b.tables.length - a.tables.length || a.id.localeCompare(b.id));
  const files = new Set([...input.dbFiles.filter((f) => f.facts.kind !== "none").map((f) => f.file), ...databases.flatMap((d) => [...d.migrations.map((m) => m.file), ...d.tables.flatMap((t) => t.models.map((m) => m.file))])]).size;
  return { databases, files, ...run("links", () => linkTables(databases, input), { uses: [], endpointTables: {} }) };
}
