/**
 * Plain SQL (DESIGN.md §6.13 §1): migration folders of golang-migrate
 * (`<version>_<name>.up.sql`), dbmate (`-- migrate:up`), goose
 * (`-- +goose Up`), Supabase (`supabase/migrations`), Flyway
 * (`V<version>__<name>.sql`, repeatable `R__` after them) and any
 * `migrations` / `migrate` folder of numbered `.sql` files — each ordered by
 * version or file name; files without one can't be ordered and are reported,
 * not replayed. A `migrations` folder where no file carries a version is read
 * by content, like any other folder.
 *
 * Outside migration folders a `.sql` file is read by what it holds
 * (2026-10-11), whatever its name: one that is mostly CREATE TABLE is a
 * schema file; one beside it that is mostly ALTER / DROP / CREATE INDEX /
 * RENAME is that schema's change log, read in line order, each comment-led
 * block one entry. Which convention the pair follows is decided by a trial
 * replay of the changes onto the creates, never guessed:
 *   A  every change applies cleanly → the schema is creates + changes;
 *   B  every change is already in the creates → the creates are the schema,
 *      the changes only fill the tables' history;
 *   mixed → the creates as written, the changes as history, and an order
 *      problem naming what didn't fit.
 * A folder with several schema or change files that can't be paired one to
 * one keeps its schema files as written and says so. Named schema files
 * (`schema.sql`, `structure.sql`, `*.schema.sql`, `schema/`) count even under
 * a test path; content-detected ones don't.
 */
import type { DbFileFacts } from "../read";
import { baseOf, dirOf, migration, type MigrationSet } from "../common";
import { SchemaState } from "../replay";
import type { DbDialect, DbMigration, DbOp, DbTool } from "../types";
import { TEST_PATH } from "./sql-in-code";

type SqlFacts = Extract<DbFileFacts, { kind: "sql" }>;

export interface SqlSchemaFile {
  file: string;
  ops: DbOp[];
  dialect?: DbDialect;
  problems?: string[];
}

const MIGRATION_DIRS = /^(migrations?|migrate|ddl|db_migrations|sql_migrations|changesets?)$/i;
const SCHEMA_DIRS = /^(schema|schemas)$/i;
const SCHEMA_FILES = /^(schema|structure|init|db|database)\.sql$|\.schema\.sql$/i;

/** Statements that change a schema rather than declare one. */
const CHANGE_OPS = new Set<DbOp["op"]>(["addColumn", "dropColumn", "alterColumn", "renameColumn", "renameTable", "dropTable", "dropIndex", "dropConstraint", "addCheck", "alterEnum", "dropEnum"]);

/** `1.2.3` / `1_2` / `20240101120000` → comparable number parts. */
function versionParts(v: string): number[] {
  return v.split(/[._]/).map((x) => Number(x)).filter((x) => Number.isFinite(x));
}
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** What a loose `.sql` file is, by its statements. */
export function classifySql(ops: readonly DbOp[]): "schema" | "changes" | "other" {
  const creates = ops.filter((op) => op.op === "createTable" && !op.view).length;
  const changes = ops.filter((op) => CHANGE_OPS.has(op.op)).length;
  const indexes = ops.filter((op) => op.op === "createIndex").length;
  if (creates > 0 && creates >= changes) return "schema";
  if (changes > 0 || indexes > 0) return "changes";
  return "other";
}

/**
 * A change log's entries: each comment-led block (`-- 2024-03: add email`)
 * is one, in line order; statements before the first comment are one too.
 * Ids are the file and the block's position, so appending keeps them.
 */
export function changeLogMigrations(file: string, facts: SqlFacts, order0: number, tool: DbTool = "sql", historyOnly = false): DbMigration[] {
  const starts = (facts.blocks ?? []).map((b) => b.line).sort((a, b) => a - b);
  const blockOf = (line: number) => {
    let n = 0;
    for (const s of starts) if (s <= line) n++;
    return n;
  };
  const byBlock = new Map<number, DbOp[]>();
  for (const op of facts.ops) {
    const n = blockOf(op.line);
    (byBlock.get(n) ?? byBlock.set(n, []).get(n)!).push(op);
  }
  const out: DbMigration[] = [];
  for (const [n, ops] of [...byBlock].sort((a, b) => a[0] - b[0])) {
    const title = n > 0 ? facts.blocks?.find((b) => b.line === starts[n - 1])?.title : undefined;
    out.push({
      ...migration(`${file}#${n}`, `${baseOf(file)} #${n}${title ? ` — ${title}` : ""}`, file, ops[0]?.line ?? 1, tool, ops),
      order: order0 + out.length,
      ...(historyOnly ? { historyOnly: true as const } : {}),
    });
  }
  return out;
}

/** A schema file and its change log, the convention found by a trial replay. */
function pairSet(dir: string, schema: { file: string; facts: SqlFacts }, changes: { file: string; facts: SqlFacts }): MigrationSet {
  const state = new SchemaState("migration", false);
  const ctx = { id: schema.file, name: baseOf(schema.file), file: schema.file };
  for (const op of schema.facts.ops) state.apply(op, ctx);
  let clean = 0;
  const reflected: string[] = [];
  const conflicts: string[] = [];
  for (const op of changes.facts.ops) {
    const r = state.check(op);
    if (!r) {
      clean++;
      state.apply(op, { id: changes.file, name: baseOf(changes.file), file: changes.file });
    } else if (r.kind === "reflected") reflected.push(`${baseOf(changes.file)}:${op.line} ${r.text} (in ${baseOf(schema.file)})`);
    else conflicts.push(`${baseOf(changes.file)}:${op.line} ${r.text}`);
  }
  const caseA = conflicts.length === 0 && reflected.length === 0;
  const caseB = clean === 0 && conflicts.length === 0 && reflected.length > 0;
  const problems: string[] = [];
  if (!caseA && !caseB) {
    const listed = [...reflected, ...conflicts];
    problems.push(
      `${baseOf(changes.file)} neither applies cleanly to ${baseOf(schema.file)} nor is already in it (${clean} statement(s) apply, ${reflected.length} are already there, ${conflicts.length} don't fit): ${listed.slice(0, 5).join("; ")}${listed.length > 5 ? `; +${listed.length - 5} more` : ""}. The schema is ${baseOf(schema.file)} as written; ${baseOf(changes.file)} only fills table history.`,
    );
  }
  const head: DbMigration = { ...migration(schema.file, baseOf(schema.file), schema.file, schema.facts.ops[0]?.line ?? 1, "sql", schema.facts.ops), order: 0 };
  const dialect = schema.facts.dialect ?? changes.facts.dialect;
  return {
    tool: "sql",
    root: dir,
    family: "sql",
    migrations: [head, ...changeLogMigrations(changes.file, changes.facts, 1, "sql", !caseA)],
    problems,
    ...(dialect ? { dialect, dialectGuessed: true as const } : {}),
  };
}

export function resolveSqlFiles(dbFiles: ReadonlyArray<{ file: string; facts: DbFileFacts }>, claimed: ReadonlySet<string>): { migrations: MigrationSet[]; schemas: SqlSchemaFile[] } {
  const free = dbFiles.filter((f): f is { file: string; facts: SqlFacts } => f.facts.kind === "sql" && !claimed.has(f.file));
  const byDir = new Map<string, Array<{ file: string; facts: SqlFacts }>>();
  for (const f of free) (byDir.get(dirOf(f.file)) ?? byDir.set(dirOf(f.file), []).get(dirOf(f.file))!).push(f);
  const migrations: MigrationSet[] = [];
  const schemas: SqlSchemaFile[] = [];
  for (const [dir, files] of byDir) {
    const name = baseOf(dir);
    const hasUp = files.some((f) => /\.up\.sql$/i.test(f.file));
    const flyway = files.some((f) => /^V\d[\w.]*__/.test(baseOf(f.file)));
    const markers = files.find((f) => f.facts.markers)?.facts.markers;
    const supabase = /(^|\/)supabase\/migrations$/.test(dir);
    const toolFolder = hasUp || flyway || Boolean(markers) || supabase;
    // A `migrations` folder whose files carry no version can't be ordered by name: it is read by content instead.
    const versioned = files.some((f) => /^\d/.test(baseOf(f.file)));
    const isMigrations = toolFolder || ((MIGRATION_DIRS.test(name) || /(^|\/)db\/migrate$/.test(dir)) && versioned);
    if (!isMigrations) {
      // By content: schema files, and change logs beside them.
      const isSchemaDir = SCHEMA_DIRS.test(name);
      const named = (f: { file: string }) => isSchemaDir || SCHEMA_FILES.test(baseOf(f.file));
      const read = files.filter((f) => named(f) || !TEST_PATH.test(f.file));
      const schemaFiles = read.filter((f) => classifySql(f.facts.ops) === "schema" || (named(f) && f.facts.ops.some((op) => op.op === "createTable")));
      const changeFiles = read.filter((f) => !schemaFiles.includes(f) && classifySql(f.facts.ops) === "changes");
      if (changeFiles.length > 0 && schemaFiles.length === 1 && changeFiles.length === 1) {
        migrations.push(pairSet(dir, schemaFiles[0], changeFiles[0]));
        continue;
      }
      const problem =
        changeFiles.length > 0 && schemaFiles.length > 0
          ? `${dir || "(repo root)"} has ${schemaFiles.length} schema file(s) (${schemaFiles.map((f) => baseOf(f.file)).join(", ")}) and ${changeFiles.length} change file(s) (${changeFiles.map((f) => baseOf(f.file)).join(", ")}): which changes go with which schema is unknown, so the schema files are read as written and the changes aren't applied.`
          : undefined;
      for (const f of schemaFiles) schemas.push({ file: f.file, ops: f.facts.ops, ...(f.facts.dialect ? { dialect: f.facts.dialect } : {}), ...(problem ? { problems: [problem] } : {}) });
      continue;
    }
    const tool: DbTool = hasUp ? "golang-migrate" : flyway ? "flyway" : markers === "dbmate" ? "dbmate" : markers === "goose" ? "goose" : supabase ? "supabase" : "sql";
    const problems: string[] = [];
    const keyed = files.flatMap((f) => {
      const b = baseOf(f.file);
      if (flyway) {
        const v = /^V(\d[\d._]*)__/.exec(b);
        if (v) return [{ f, key: versionParts(v[1].replace(/[._]$/, "")), repeatable: false }];
        if (/^R__/.test(b)) return [{ f, key: [Number.MAX_SAFE_INTEGER], repeatable: true }];
      }
      const v = /^(\d+)/.exec(b);
      if (v) return [{ f, key: [Number(v[1])], repeatable: false }];
      problems.push(`${f.file} has no version in its name — order unknown, not replayed.`);
      return [];
    });
    keyed.sort((a, b) => compareVersions(a.key, b.key) || (a.f.file < b.f.file ? -1 : a.f.file > b.f.file ? 1 : 0));
    // Two files with the same version can't be ordered against each other.
    for (let i = 1; i < keyed.length; i++) {
      if (!keyed[i].repeatable && compareVersions(keyed[i].key, keyed[i - 1].key) === 0) problems.push(`${baseOf(keyed[i - 1].f.file)} and ${baseOf(keyed[i].f.file)} share version ${keyed[i].key.join(".")} — replayed by name.`);
    }
    const dialect = keyed.map((k) => k.f.facts.dialect).find(Boolean);
    migrations.push({
      tool,
      root: dir,
      family: "sql",
      migrations: keyed.map((k, i) => ({ ...migration(k.f.file, baseOf(k.f.file).replace(/(\.up)?\.sql$/i, ""), k.f.file, 1, tool, k.f.facts.ops), order: i })),
      problems,
      ...(dialect ? { dialect, dialectGuessed: true as const } : {}),
    });
  }
  return { migrations, schemas };
}
