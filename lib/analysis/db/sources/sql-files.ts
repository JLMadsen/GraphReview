/**
 * Plain SQL (DESIGN.md §6.13 §1): migration folders of golang-migrate
 * (`<version>_<name>.up.sql`), dbmate (`-- migrate:up`), goose
 * (`-- +goose Up`), Supabase (`supabase/migrations`), Flyway
 * (`V<version>__<name>.sql`, repeatable `R__` after them) and any
 * `migrations` / `migrate` folder of numbered `.sql` files — each ordered by
 * version or file name; files without one can't be ordered and are reported,
 * not replayed. Declarative files: `schema.sql`, `structure.sql`,
 * `*.schema.sql` and `schema/` folders.
 */
import type { DbFileFacts } from "../read";
import { baseOf, dirOf, migration, type MigrationSet } from "../common";
import type { DbDialect, DbOp, DbTool } from "../types";

type SqlFacts = Extract<DbFileFacts, { kind: "sql" }>;

export interface SqlSchemaFile {
  file: string;
  ops: DbOp[];
  dialect?: DbDialect;
}

const MIGRATION_DIRS = /^(migrations?|migrate|ddl|db_migrations|sql_migrations|changesets?)$/i;
const SCHEMA_DIRS = /^(schema|schemas)$/i;
const SCHEMA_FILES = /^(schema|structure|init|db|database)\.sql$|\.schema\.sql$/i;

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
    const isMigrations = hasUp || flyway || Boolean(markers) || supabase || MIGRATION_DIRS.test(name) || /(^|\/)db\/migrate$/.test(dir);
    if (!isMigrations) {
      // Declarative: a schema folder, or schema-named files.
      const isSchemaDir = SCHEMA_DIRS.test(name);
      for (const f of files) {
        if (!isSchemaDir && !SCHEMA_FILES.test(baseOf(f.file))) continue;
        if (!f.facts.ops.some((op) => op.op === "createTable")) continue;
        schemas.push({ file: f.file, ops: f.facts.ops, ...(f.facts.dialect ? { dialect: f.facts.dialect } : {}) });
      }
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
