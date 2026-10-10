/**
 * Drizzle (DESIGN.md §6.13 §1): `pgTable` / `mysqlTable` / `sqliteTable`
 * declarations (and `pgSchema("s").table`, `pgEnum`) as a declarative
 * schema, and the generated migrations — `<out>/NNNN_name.sql` in the order
 * of `<out>/meta/_journal.json`.
 */
import type { DbFileFacts } from "../read";
import { column, dirOf, list, literalText, migration, nameOf, num, obj, str, bool, type DeclSet, type MigrationSet, type TableDecl } from "../common";
import type { DbCodeFacts, DbColumn, DbDialect, DbFk, DbIndex, DV } from "../types";

type Step = { name: string; args: DV[] };

function steps(v: DV | undefined): Step[] {
  if (!v) return [];
  if ("chain" in v) return v.chain;
  if ("call" in v) return [{ name: v.call, args: v.args }];
  return [];
}

function builderDialect(builder: string): DbDialect | undefined {
  if (/^(pg|schema\.)/.test(builder)) return builder.startsWith("schema.") ? undefined : "postgresql";
  if (/^mysql|^singlestore/.test(builder)) return "mysql";
  if (/^sqlite/.test(builder)) return "sqlite";
  return undefined;
}

export function journalDialect(d: string | undefined): DbDialect | undefined {
  if (!d) return undefined;
  if (/postgres|pg/.test(d)) return "postgresql";
  if (/mysql|singlestore/.test(d)) return "mysql";
  if (/sqlite|turso/.test(d)) return "sqlite";
  return undefined;
}

/** A column builder's type: `varchar("x", { length: 50 })` → `varchar(50)`. */
function columnType(head: Step, enums: Map<string, string>, dialect: DbDialect | undefined): string {
  const name = head.name.replace(/^.*\./, "");
  const opts = obj(head.args.find((a) => "obj" in a));
  const mode = str(opts.mode);
  if (enums.has(head.name)) return enums.get(head.name)!;
  switch (name) {
    case "varchar":
    case "char": {
      const length = num(opts.length);
      return length ? `${name}(${length})` : name;
    }
    case "numeric":
    case "decimal": {
      const p = num(opts.precision);
      const s = num(opts.scale);
      return p !== undefined ? `numeric(${p}${s !== undefined ? `,${s}` : ""})` : "numeric";
    }
    case "timestamp":
      return bool(opts.withTimezone) ? "timestamptz" : num(opts.precision) !== undefined ? `timestamp(${num(opts.precision)})` : "timestamp";
    case "doublePrecision":
      return "double precision";
    case "int":
      return "integer";
    case "integer":
      return dialect === "sqlite" && mode === "boolean" ? "integer (boolean)" : dialect === "sqlite" && mode && /timestamp/.test(mode) ? "integer (timestamp)" : "integer";
    case "bigint":
    case "bigserial":
    case "smallint":
    case "serial":
    case "smallserial":
    case "text":
    case "boolean":
    case "date":
    case "time":
    case "json":
    case "jsonb":
    case "uuid":
    case "real":
    case "blob":
    case "datetime":
    case "tinyint":
    case "mediumint":
    case "float":
    case "double":
    case "interval":
    case "inet":
    case "bytea":
      return name === "bytea" ? "bytea" : name;
    default:
      return name;
  }
}

/** `t.email` / `users.id` → `email` / [`users`, `id`]. */
const ref = (v: DV | undefined): string[] => (nameOf(v) ?? "").split(".");

/** Drizzle tables and enums from the code, plus the out-folders' migrations. */
export function resolveDrizzle(
  dbFiles: ReadonlyArray<{ file: string; facts: DbFileFacts }>,
  code: ReadonlyArray<{ file: string; facts: DbCodeFacts }>,
): { migrations: MigrationSet[]; decls: DeclSet[]; claimed: Set<string> } {
  const claimed = new Set<string>();
  const migrations: MigrationSet[] = [];
  const sqlByPath = new Map(dbFiles.filter((f) => f.facts.kind === "sql").map((f) => [f.file, f.facts as Extract<DbFileFacts, { kind: "sql" }>]));
  for (const f of dbFiles) {
    if (f.facts.kind !== "journal") continue;
    const out = dirOf(dirOf(f.file));
    const problems: string[] = [];
    const entries = [...f.facts.entries].sort((a, b) => a.idx - b.idx);
    const list = entries.flatMap((e, i) => {
      const file = `${out ? `${out}/` : ""}${e.tag}.sql`;
      const facts = sqlByPath.get(file);
      if (!facts) {
        problems.push(`The journal lists ${e.tag}, but ${file} isn't in the repo.`);
        return [];
      }
      claimed.add(file);
      return [{ ...migration(file, e.tag, file, 1, "drizzle", facts.ops), order: i }];
    });
    // SQL files in the out-folder that the journal doesn't list can't be ordered.
    for (const [path] of sqlByPath) {
      if (dirOf(path) === out && !claimed.has(path)) {
        claimed.add(path);
        problems.push(`${path} isn't in meta/_journal.json — not replayed.`);
      }
    }
    const dialect = journalDialect(f.facts.dialect);
    const guessed = list.map((m) => sqlByPath.get(m.file)?.dialect).find(Boolean);
    migrations.push({ tool: "drizzle", root: out, family: "drizzle", migrations: list, problems, ...(dialect ? { dialect } : guessed ? { dialect: guessed, dialectGuessed: true as const } : {}) });
  }

  // Tables: every file's table builders. Enums first: a column built from an enum takes its name.
  const enums = new Map<string, string>();
  const enumDecls: DeclSet["enums"] = [];
  for (const { file, facts } of code) {
    for (const t of facts.tables ?? []) {
      if (!/Enum$/.test(t.builder) && t.builder !== "schema.enum") continue;
      const name = str(t.args[0]);
      if (!name) continue;
      enums.set(t.local, t.schema ? `${t.schema}.${name}` : name);
      enumDecls.push({ name: t.schema ? `${t.schema}.${name}` : name, values: list(t.args[1]).map((v) => str(v)).filter((v): v is string => v !== undefined), file, line: t.line });
    }
  }
  const tableNames = new Map<string, { table: string; keys: Map<string, string> }>();
  const pending: Array<{ decl: TableDecl; columns: Record<string, DV>; extra?: DV; local: string; dialect?: DbDialect }> = [];
  let dialect: DbDialect | undefined;
  for (const { file, facts } of code) {
    for (const t of facts.tables ?? []) {
      if (/Enum$/.test(t.builder) || t.builder === "schema.enum" || /View$/.test(t.builder) || t.builder === "schema.view") continue;
      const name = str(t.args[0]);
      const columns = obj(t.args[1]);
      if (!name || !t.args[1] || !("obj" in t.args[1])) continue;
      const d = builderDialect(t.builder);
      dialect ??= d;
      const decl: TableDecl = {
        name: t.schema ? `${t.schema}.${name}` : name,
        columns: [],
        pk: [],
        fks: [],
        indexes: [],
        checks: [],
        file,
        line: t.line,
        model: { tool: "drizzle", name: t.local, file, line: t.line, decl: `${file}#${t.local}` },
        fields: [],
      };
      const keys = new Map<string, string>();
      for (const [key, v] of Object.entries(columns)) {
        const head = steps(v)[0];
        if (!head) continue;
        keys.set(key, str(head.args[0]) ?? key);
      }
      tableNames.set(t.local, { table: decl.name, keys });
      pending.push({ decl, columns, extra: t.args[2], local: t.local, dialect: d });
    }
  }
  const tables: TableDecl[] = [];
  for (const { decl, columns, extra, local, dialect: d } of pending) {
    const keys = tableNames.get(local)!.keys;
    for (const [key, v] of Object.entries(columns)) {
      const chain = steps(v);
      if (chain.length === 0) continue;
      const colName = keys.get(key) ?? key;
      const col: DbColumn = column(colName, columnType(chain[0], enums, d ?? dialect), true, "schema");
      if (enums.has(chain[0].name)) col.enum = enums.get(chain[0].name);
      if (/^(serial|bigserial|smallserial)$/.test(col.type)) {
        col.generated = col.type;
        col.nullable = false;
      }
      for (const s of chain.slice(1)) {
        switch (s.name) {
          case "primaryKey":
            col.primary = true;
            col.nullable = false;
            decl.pk = [colName];
            if (bool(obj(s.args[0]).autoIncrement)) col.generated = "autoincrement";
            break;
          case "notNull":
            col.nullable = false;
            break;
          case "unique":
            col.unique = true;
            break;
          case "default":
            col.default = literalText(s.args[0]);
            break;
          case "defaultNow":
            col.default = "now()";
            break;
          case "defaultRandom":
            col.default = "gen_random_uuid()";
            break;
          case "array":
            col.type = `${col.type}[]`;
            break;
          case "generatedAlwaysAsIdentity":
          case "generatedByDefaultAsIdentity":
            col.generated = "identity";
            col.nullable = false;
            break;
          case "autoincrement":
            col.generated = "autoincrement";
            break;
          case "references": {
            const target = s.args[0] && "fn" in s.args[0] ? ref(s.args[0].fn) : [];
            const opts = obj(s.args[1]);
            const tbl = target.length >= 2 ? tableNames.get(target[0]) : undefined;
            if (tbl) {
              const fk: DbFk = { columns: [colName], refTable: tbl.table, refColumns: [tbl.keys.get(target[1]) ?? target[1]], ...(str(opts.onDelete) ? { onDelete: str(opts.onDelete)!.toUpperCase() } : {}) };
              decl.fks.push(fk);
            }
            break;
          }
        }
      }
      decl.columns.push(col);
      decl.fields!.push({ field: key, column: colName });
    }
    // The third argument: `(t) => ({ … })` or `(t) => [ … ]` of index / unique / primaryKey / foreignKey builders.
    const body = extra && "fn" in extra ? extra.fn : undefined;
    const items = body ? ("obj" in body ? Object.values(body.obj) : "list" in body ? body.list : []) : [];
    const colOf = (v: DV) => {
      const parts = ref(v);
      return keys.get(parts[parts.length - 1]) ?? parts[parts.length - 1];
    };
    for (const item of items) {
      const chain = steps(item);
      if (chain.length === 0) continue;
      const head = chain[0].name.replace(/^.*\./, "");
      const on = chain.find((s) => s.name === "on");
      const idxName = str(chain[0].args[0]);
      if (head === "index" || head === "uniqueIndex" || head === "unique") {
        const index: DbIndex = { ...(idxName ? { name: idxName } : {}), columns: (on?.args ?? []).map(colOf), ...(head !== "index" ? { unique: true as const } : {}) };
        decl.indexes.push(index);
      } else if (head === "primaryKey") {
        const o = obj(chain[0].args[0]);
        decl.pk = (o.columns ? list(o.columns) : chain[0].args).map(colOf);
      } else if (head === "foreignKey") {
        const o = obj(chain[0].args[0]);
        const foreign = list(o.foreignColumns).map((v) => ref(v));
        const tbl = foreign[0] ? tableNames.get(foreign[0][0]) : undefined;
        if (tbl) {
          const onDelete = chain.find((s) => s.name === "onDelete");
          decl.fks.push({ ...(str(o.name) ? { name: str(o.name)! } : {}), columns: list(o.columns).map(colOf), refTable: tbl.table, refColumns: foreign.map((f) => tbl.keys.get(f[1]) ?? f[1]), ...(onDelete && str(onDelete.args[0]) ? { onDelete: str(onDelete.args[0])!.toUpperCase() } : {}) });
        }
      } else if (head === "check") {
        decl.checks.push({ ...(idxName ? { name: idxName } : {}), expr: "check" });
      }
    }
    for (const c of decl.columns) if (decl.pk.includes(c.name)) {
      c.primary = true;
      c.nullable = false;
    }
    tables.push(decl);
  }
  const decls: DeclSet[] = [];
  if (tables.length || enumDecls.length) {
    decls.push({ tool: "drizzle", kind: "schema", root: commonRoot(tables.map((t) => t.file)), files: [...new Set(tables.map((t) => t.file))], tables, enums: enumDecls, ...(dialect ? { dialect } : {}), complete: true });
  }
  return { migrations, decls, claimed };
}

export function commonRoot(files: readonly string[]): string {
  if (files.length === 0) return "";
  let parts = dirOf(files[0]).split("/");
  for (const f of files.slice(1)) {
    const p = dirOf(f).split("/");
    let i = 0;
    while (i < parts.length && i < p.length && parts[i] === p[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join("/");
}
