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
import { describeOp, SchemaState, splitName, tableKey, type TableState } from "./replay";
import { resolveDjango } from "./sources/django";
import { resolveDrizzle } from "./sources/drizzle";
import { prismaDecls, resolvePrisma } from "./sources/prisma";
import { changeLogMigrations, resolveSqlFiles } from "./sources/sql-files";
import { ddlOps, resolveSqlInCode, TEST_PATH } from "./sources/sql-in-code";
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
  type DbSourceCandidate,
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
  /**
   * The repo's pinned source file (DESIGN.md §6.13, pinned source): when set,
   * the only database is built from it and auto-detection is skipped.
   */
  pinned?: string;
  /** Every path of the tree — to tell a pinned file that isn't in this commit. */
  allFiles?: ReadonlySet<string>;
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
  "sql-in-code": ["sql"],
};

/** Bookkeeping tables of the migration tools themselves — never "a table no model maps". */
const SYSTEM_TABLES = /^(_prisma_migrations|__drizzle_migrations|django_migrations|alembic_version|schema_migrations|flyway_schema_history|goose_db_version|typeorm_metadata|migrations)$/i;

interface DbBuild {
  id: string;
  name: string;
  set?: MigrationSet;
  decls: DeclSet[];
  /** Order problems of a database without a migration set of its own. */
  problems?: string[];
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

/**
 * `hints` are the dialects the repo's code names (driver imports, URLs,
 * settings). With one database they say its dialect; with several they
 * can't say which is which, so they come after a guess from the SQL itself.
 */
function buildDatabase(build: DbBuild, hints: readonly DbDialect[], onlyDatabase: boolean): Database {
  const sources: DbSourceRef[] = [];
  const tools = new Set<DbTool>();
  const problems = [...(build.set?.problems ?? []), ...(build.problems ?? []), ...build.decls.flatMap((d) => d.problems ?? [])].filter((p, i, all) => all.indexOf(p) === i);
  // 1. Migrations, replayed.
  const state = new SchemaState("migration", true);
  const migrations = build.set?.migrations ?? [];
  for (const m of migrations) {
    const ctx = { id: m.id, name: m.name, file: m.file };
    for (const op of m.ops) {
      // A change log already reflected in the schema before it: history only.
      if (m.historyOnly) {
        state.record(op, ctx);
        continue;
      }
      // A pinned file: a statement that doesn't fit the schema so far is kept opaque and listed.
      if (build.set?.strict) {
        const clash = state.check(op);
        if (clash) {
          problems.push(`${m.file}:${op.line} ${clash.text} — kept as not modelled.`);
          if (state.opaque.length < 400) state.opaque.push({ migration: m.id, file: m.file, line: op.line, text: describeOp(op) });
          continue;
        }
      }
      state.apply(op, ctx);
    }
  }
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
  if (!dialect && onlyDatabase && hints.length === 1) dialect = hints[0];
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
  if (!dialect && hints.length === 1) {
    dialect = hints[0];
    dialectGuessed = true;
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
function sqlSchemaDecl(file: string, ops: DbOp[], dialect?: DbDialect, problems?: string[]): DeclSet {
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
    ...(problems?.length ? { problems } : {}),
  };
}

/** Files holding schema statements, non-test first, then by tables: what the Data view offers to pin. */
function sourceCandidates(input: BuildDbSchemaInput): DbSourceCandidate[] {
  const out: DbSourceCandidate[] = [];
  const add = (file: string, kind: DbSourceCandidate["kind"], ops: readonly DbOp[], models?: number) => {
    const tables = models ?? ops.filter((op) => op.op === "createTable" && !op.view).length;
    const statements = ops.filter((op) => op.op !== "createTable" && op.op !== "opaque").length;
    if (tables === 0 && statements === 0) return;
    out.push({ file, kind, tables, statements, ...(TEST_PATH.test(file) ? { test: true as const } : {}) });
  };
  for (const f of input.dbFiles) {
    if (f.facts.kind === "sql") add(f.file, "sql", f.facts.ops);
    else if (f.facts.kind === "prisma") add(f.file, "prisma", [], f.facts.prisma.blocks.filter((b) => b.kind === "model").length);
  }
  for (const c of input.code) {
    if (!c.facts.ddl?.length) continue;
    add(c.file, "code", c.facts.ddl.flatMap((d) => ddlOps(d.text, d.line)));
  }
  out.sort((a, b) => Number(Boolean(a.test)) - Number(Boolean(b.test)) || b.tables - a.tables || b.statements - a.statements || a.file.localeCompare(b.file));
  return out.slice(0, 60);
}

/**
 * The one database a pinned file makes: `.sql` replayed in line order (each
 * comment-led block one migration; a statement that doesn't fit is opaque
 * and listed), `.prisma` as a Prisma schema, a code file's DDL literals as
 * "SQL in code" reads them. A file missing at this commit is a problem, not
 * an empty schema.
 */
function pinnedBuild(file: string, input: BuildDbSchemaInput, code: ReadonlyArray<{ file: string; facts: DbCodeFacts }>): DbBuild {
  const id = `pinned:${file}`;
  const base: DbBuild = { id, name: file, decls: [] };
  if (input.allFiles && !input.allFiles.has(file)) return { ...base, problems: [`The pinned source file ${file} isn't in this commit.`] };
  const dbFile = input.dbFiles.find((f) => f.file === file);
  if (dbFile?.facts.kind === "sql") {
    const facts = dbFile.facts;
    return {
      ...base,
      set: {
        tool: "sql",
        root: file,
        family: "sql",
        migrations: changeLogMigrations(file, facts, 0),
        problems: [],
        strict: true,
        ...(facts.dialect ? { dialect: facts.dialect, dialectGuessed: true as const } : {}),
      },
    };
  }
  if (dbFile?.facts.kind === "prisma") return { ...base, decls: [prismaDecls([{ file, prisma: dbFile.facts.prisma }])] };
  const facts = code.find((c) => c.file === file);
  if (facts?.facts.ddl?.length) {
    const inCode = resolveSqlInCode([facts], new Set(), { includeTests: true });
    const sets = inCode.migrations;
    const set = sets.length
      ? { ...sets[0], root: file, migrations: sets.flatMap((s) => s.migrations).map((m, i) => ({ ...m, order: i })) }
      : undefined;
    return { ...base, ...(set ? { set } : {}), decls: inCode.decls };
  }
  return { ...base, problems: [`The pinned source file ${file} holds no schema statements this reader understands (CREATE / ALTER TABLE, a Prisma schema, DDL in string literals).`] };
}

export function buildDbSchema(input: BuildDbSchemaInput): DbSchema {
  const code = input.code.map(({ file, facts }) => ({ file, facts }));
  const candidates = run("candidates", () => sourceCandidates(input), []);
  const withCandidates = candidates.length ? { candidates } : {};
  if (input.pinned) {
    const file = input.pinned;
    const hints = [...new Set(code.flatMap(({ facts }) => facts.hints ?? []))];
    const database = run(`pinned ${file}`, () => buildDatabase(pinnedBuild(file, input, code), hints, true), null);
    const databases = database ? [database] : [];
    const missing = Boolean(input.allFiles && !input.allFiles.has(file));
    return {
      databases,
      files: 1,
      pinned: { file, ...(missing ? { missing: true as const } : {}) },
      ...withCandidates,
      ...run("links", () => linkTables(databases, input), { uses: [], endpointTables: {} }),
    };
  }
  if (input.dbFiles.length === 0 && !code.some(({ facts }) => facts.entities || facts.migrations || facts.tables || facts.classes || facts.assigns || facts.ddl)) {
    return { ...EMPTY_DB_SCHEMA, ...withCandidates, ...linkTables([], input) };
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

  const toolSets: MigrationSet[] = [...prisma.migrations, ...drizzle.migrations, ...typeormSets, ...django.migrations, ...alembic, ...sql.migrations];
  // DDL in the app's own literals — not in files another tool reads as migrations (a TypeORM
  // migration's queryRunner.query, Alembic's op.execute, Django's RunSQL).
  const inCode = run("SQL in code", () => resolveSqlInCode(code, new Set(toolSets.flatMap((st) => st.migrations.map((m) => m.file)))), { migrations: [], decls: [] });
  const sets: MigrationSet[] = [...toolSets, ...inCode.migrations];
  const decls: DeclSet[] = [
    ...prisma.decls,
    ...drizzle.decls,
    ...(typeormDecl ? [typeormDecl] : []),
    ...django.decls,
    ...saDecls,
    ...run("schema files", () => sql.schemas.map((s) => sqlSchemaDecl(s.file, s.ops, s.dialect, s.problems)), []),
  ].filter((d) => d.tables.length > 0 || d.enums.length > 0);

  // One database per migration set; each declarative source joins the nearest compatible one.
  const builds: DbBuild[] = sets.map((s) => ({
    id: s.tool === "django" ? "django" : `${s.tool}:${s.root || "."}`,
    name: s.tool === "django" ? "Django" : s.root || "(repo root)",
    set: s,
    decls: [],
  }));
  // A file's loose DDL joins its own migration array's database; loose DDL of files without one is one database.
  let looseInCode: DbBuild | undefined;
  for (const d of inCode.decls) {
    if (d.tables.length === 0 && d.enums.length === 0) continue;
    const own = builds.find((b) => b.set?.tool === "sql-in-code" && (b.set.root === d.root || b.set.root.startsWith(`${d.root}#`)));
    if (own) {
      own.decls.push(d);
      continue;
    }
    if (!looseInCode) {
      looseInCode = { id: `sql-in-code:${d.root}`, name: d.root, decls: [], ...(inCode.problem ? { problems: [inCode.problem] } : {}) };
      builds.push(looseInCode);
    }
    looseInCode.decls.push(d);
  }
  if (looseInCode && looseInCode.decls.length > 1) looseInCode.name = `SQL in code (${looseInCode.decls.length} files)`;
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
      // A .sql schema file joins another tool's migrations only when it sits beside them (a Django app's own dump is another database).
      if (d.tool === "sql" && b.set.family !== "sql" && depth === 0) continue;
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
    .map((b) => run(`database ${b.id}`, () => buildDatabase(b, hints, builds.length === 1), null))
    .filter((d): d is Database => d !== null && (d.tables.length > 0 || d.migrations.length > 0 || d.orderProblems.length > 0));
  databases.sort((a, b) => b.tables.length - a.tables.length || a.id.localeCompare(b.id));
  const files = new Set([...input.dbFiles.filter((f) => f.facts.kind !== "none").map((f) => f.file), ...databases.flatMap((d) => [...d.migrations.map((m) => m.file), ...d.tables.flatMap((t) => t.models.map((m) => m.file))])]).size;
  return { databases, files, ...withCandidates, ...run("links", () => linkTables(databases, input), { uses: [], endpointTables: {} }) };
}
