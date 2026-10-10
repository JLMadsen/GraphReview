/**
 * TypeORM (DESIGN.md §6.13 §1): `@Entity` classes as models (default naming:
 * the class name in snake_case, properties as named, a relation's join
 * column `<relation>Id`), and migration classes — `up(queryRunner)` with
 * `queryRunner.query(sql)` and the `createTable` / `addColumn` / … API —
 * ordered by the timestamp in the class (or file) name.
 */
import { guessDialect, parseSql } from "../sql";
import { asCall, bool, column, dirOf, last, list, literalText, migration, nameOf, num, obj, snakeCase, str, type DeclSet, type MigrationSet, type TableDecl } from "../common";
import { commonRoot } from "./drizzle";
import type { DbCodeFacts, DbColumn, DbDecoratorFact, DbFk, DbIndex, DbOp, DV } from "../types";

const COLUMN_DECORATORS = new Set(["Column", "PrimaryColumn", "PrimaryGeneratedColumn", "CreateDateColumn", "UpdateDateColumn", "DeleteDateColumn", "VersionColumn", "ObjectIdColumn", "ViewColumn"]);
const JOIN_RELATIONS = new Set(["ManyToOne", "OneToOne"]);
const OTHER_RELATIONS = new Set(["OneToMany", "ManyToMany", "RelationId"]);

function tsType(type: string | undefined): string {
  const t = (type ?? "").replace(/\s*\|\s*(null|undefined)\b/g, "").trim();
  if (/^string\b/.test(t)) return "varchar";
  if (/^number\b/.test(t)) return "integer";
  if (/^boolean\b/.test(t)) return "boolean";
  if (/^Date\b/.test(t)) return "timestamp";
  if (/^bigint\b/.test(t)) return "bigint";
  return t ? "varchar" : "";
}

/** A TypeORM column type with its length / precision: `varchar(50)`, `numeric(10,2)`. */
function typeWith(type: string, opts: Record<string, DV>): string {
  let t = type.toLowerCase();
  if (t === "int" || t === "int4") t = "integer";
  const length = num(opts.length) ?? (str(opts.length) ? Number(str(opts.length)) : undefined);
  const precision = num(opts.precision);
  const scale = num(opts.scale);
  if (length && /char/.test(t)) t = `${t}(${length})`;
  else if (precision !== undefined && /numeric|decimal/.test(t)) t = `numeric(${precision}${scale !== undefined ? `,${scale}` : ""})`;
  if (bool(opts.array)) t = `${t}[]`;
  return t;
}

function entityName(decorators: DbDecoratorFact[], className: string): { name: string; view?: true } | null {
  const d = decorators.find((x) => last(x.name) === "Entity" || last(x.name) === "ViewEntity" || last(x.name) === "ChildEntity");
  if (!d) return null;
  const first = d.args[0];
  const o = obj(first ?? d.args[1]);
  const name = str(first) ?? str(o.name) ?? snakeCase(className);
  const schema = str(o.schema);
  return { name: schema ? `${schema}.${name}` : name, ...(last(d.name) === "ViewEntity" ? { view: true as const } : {}) };
}

/** The model tables of the entity classes. */
export function typeormEntities(code: ReadonlyArray<{ file: string; facts: DbCodeFacts }>): DeclSet | null {
  const classes = code.flatMap(({ file, facts }) => (facts.entities ?? []).map((e) => ({ file, e })));
  const byName = new Map(classes.map((c) => [c.e.name, c]));
  const tables: TableDecl[] = [];
  const tableOfClass = new Map<string, string>();
  for (const { e } of classes) {
    const n = entityName(e.decorators, e.name);
    if (n) tableOfClass.set(e.name, n.name);
  }
  if (tableOfClass.size === 0) return null;
  const pendingFks: Array<{ decl: TableDecl; col: DbColumn; target: string; onDelete?: string; refColumn?: string }> = [];
  for (const { file, e } of classes) {
    const n = entityName(e.decorators, e.name);
    if (!n) continue;
    const decl: TableDecl = { name: n.name, columns: [], pk: [], fks: [], indexes: [], checks: [], file, line: e.line, model: { tool: "typeorm", name: e.name, file, line: e.line, decl: `${file}#${e.name}` }, fields: [], relations: [], ...(n.view ? { view: true as const } : {}) };
    // Properties of the class and its repo base classes (an abstract `BaseEntity` with the id and timestamps).
    const props = [...e.props];
    let parent = e.extends ? byName.get(e.extends.replace(/<.*$/, "")) : undefined;
    for (let depth = 0; parent && depth < 5; depth++) {
      props.unshift(...parent.e.props);
      parent = parent.e.extends ? byName.get(parent.e.extends.replace(/<.*$/, "")) : undefined;
    }
    for (const p of props) {
      const colDec = p.decorators.find((d) => COLUMN_DECORATORS.has(last(d.name)));
      const relDec = p.decorators.find((d) => JOIN_RELATIONS.has(last(d.name)));
      if (colDec) {
        const kind = last(colDec.name);
        const firstStr = str(colDec.args[0]);
        const o = obj(colDec.args.find((a) => "obj" in a));
        let type = str(o.type) ?? (kind === "PrimaryGeneratedColumn" ? (firstStr === "uuid" ? "uuid" : "integer") : firstStr) ?? (kind.endsWith("DateColumn") ? "timestamp" : kind === "VersionColumn" ? "integer" : tsType(p.type));
        if (o.enum) type = "enum";
        const name = str(o.name) ?? p.name;
        const col: DbColumn = column(name, typeWith(type, o), bool(o.nullable) ?? false, "model");
        if (kind === "PrimaryGeneratedColumn") col.generated = firstStr === "uuid" ? "uuid" : firstStr === "identity" ? "identity" : "increment";
        if (kind === "PrimaryColumn" || kind === "PrimaryGeneratedColumn" || bool(o.primary)) {
          col.primary = true;
          col.nullable = false;
          decl.pk.push(name);
        }
        if (bool(o.unique)) col.unique = true;
        if (o.default !== undefined) col.default = literalText(o.default && "fn" in o.default ? o.default.fn : o.default);
        if (kind === "CreateDateColumn" || kind === "UpdateDateColumn") col.default = "now()";
        if (kind === "DeleteDateColumn") col.nullable = true;
        decl.columns.push(col);
        decl.fields!.push({ field: p.name, column: name, line: p.line });
        if (p.decorators.some((d) => last(d.name) === "Index")) decl.indexes.push({ columns: [name] });
        continue;
      }
      if (relDec) {
        decl.relations!.push(p.name);
        const join = p.decorators.find((d) => last(d.name) === "JoinColumn");
        const isOneToOne = last(relDec.name) === "OneToOne";
        if (isOneToOne && !join) continue; // the inverse side
        const target = relDec.args[0] && "fn" in relDec.args[0] ? nameOf(relDec.args[0].fn) : nameOf(relDec.args[0]);
        const opts = obj(relDec.args.find((a) => "obj" in a));
        const jo = obj(join?.args[0]);
        const refColumn = str(jo.referencedColumnName);
        const name = str(jo.name) ?? `${p.name}${refColumn ? refColumn[0].toUpperCase() + refColumn.slice(1) : "Id"}`;
        const col: DbColumn = column(name, "", bool(opts.nullable) ?? true, "model", isOneToOne ? { unique: true } : {});
        decl.columns.push(col);
        decl.fields!.push({ field: p.name, column: name, line: p.line });
        if (target) pendingFks.push({ decl, col, target, ...(str(opts.onDelete) ? { onDelete: str(opts.onDelete)!.toUpperCase() } : {}), ...(refColumn ? { refColumn } : {}) });
        continue;
      }
      if (p.decorators.some((d) => OTHER_RELATIONS.has(last(d.name)))) decl.relations!.push(p.name);
    }
    for (const d of e.decorators) {
      const dn = last(d.name);
      if (dn !== "Index" && dn !== "Unique") continue;
      const cols = list(d.args.find((a) => "list" in a)).map((v) => str(v)).filter((v): v is string => Boolean(v));
      if (cols.length === 0) continue;
      const name = str(d.args[0]);
      const opts = obj(d.args.find((a) => "obj" in a));
      const mapped = cols.map((c) => decl.fields!.find((f) => f.field === c)?.column ?? c);
      decl.indexes.push({ ...(name ? { name } : {}), columns: mapped, ...(dn === "Unique" || bool(opts.unique) ? { unique: true as const } : {}) });
    }
    tables.push(decl);
  }
  // Foreign keys once every table is known: the join column takes the target's primary key type.
  const declOf = new Map(tables.map((t) => [t.model!.name, t]));
  for (const { decl, col, target, onDelete, refColumn } of pendingFks) {
    const t = declOf.get(target);
    const refCol = refColumn ?? t?.pk[0] ?? "id";
    const refType = t?.columns.find((c) => c.name === refCol)?.type;
    col.type = refType ?? "integer";
    const fk: DbFk = { columns: [col.name], refTable: t?.name ?? snakeCase(target), refColumns: [refCol], inferred: true, ...(onDelete ? { onDelete } : {}) };
    decl.fks.push(fk);
  }
  return { tool: "typeorm", kind: "model", root: commonRoot(tables.map((t) => t.file)), files: [...new Set(tables.map((t) => t.file))], tables, enums: [] };
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/** `new TableColumn({ … })` / a plain object → a column. */
function tableColumn(v: DV | undefined): { col: DbColumn; fk?: DbFk } | null {
  const c = asCall(v);
  const o = c ? obj(c.args[0]) : obj(v);
  const name = str(o.name);
  if (!name) return null;
  const col: DbColumn = column(name, typeWith(str(o.type) ?? "", o), bool(o.isNullable) ?? false, "migration");
  if (bool(o.isPrimary)) {
    col.primary = true;
    col.nullable = false;
  }
  if (bool(o.isGenerated)) col.generated = str(o.generationStrategy) ?? "increment";
  if (bool(o.isUnique)) col.unique = true;
  if (o.default !== undefined) col.default = str(o.default) ?? literalText(o.default);
  return { col };
}

function tableName(v: DV | undefined): string | undefined {
  const s = str(v);
  if (s) return s;
  const c = asCall(v);
  return c ? str(obj(c.args[0]).name) : undefined;
}

function fkOf(v: DV | undefined): DbFk | null {
  const c = asCall(v);
  const o = c ? obj(c.args[0]) : obj(v);
  const refTable = str(o.referencedTableName);
  if (!refTable) return null;
  return {
    ...(str(o.name) ? { name: str(o.name)! } : {}),
    columns: list(o.columnNames).map((x) => str(x) ?? "").filter(Boolean),
    refTable,
    refColumns: list(o.referencedColumnNames).map((x) => str(x) ?? "").filter(Boolean),
    ...(str(o.onDelete) ? { onDelete: str(o.onDelete)!.toUpperCase() } : {}),
  };
}

function indexOf(v: DV | undefined): DbIndex | null {
  const c = asCall(v);
  const o = c ? obj(c.args[0]) : obj(v);
  const columns = list(o.columnNames).map((x) => str(x) ?? "").filter(Boolean);
  if (columns.length === 0) return null;
  return { ...(str(o.name) ? { name: str(o.name)! } : {}), columns, ...(bool(o.isUnique) ? { unique: true as const } : {}), ...(str(o.where) ? { where: str(o.where)! } : {}) };
}

/** One `queryRunner.<m>(…)` call → ops. */
function callOps(call: { m: string; args: DV[]; line: number }): DbOp[] {
  const { m, args, line } = call;
  const t = tableName(args[0]);
  switch (m) {
    case "query": {
      const sql = args[0] && ("s" in args[0] ? args[0].s : "t" in args[0] ? args[0].t : undefined);
      return sql ? parseSql(sql, line) : [{ op: "opaque", text: "queryRunner.query(…)", line }];
    }
    case "createTable": {
      const c = asCall(args[0]);
      const o = c ? obj(c.args[0]) : obj(args[0]);
      const name = str(o.name);
      if (!name) break;
      const cols = list(o.columns).map((x) => tableColumn(x)?.col).filter((x): x is DbColumn => Boolean(x));
      return [{
        op: "createTable",
        table: name,
        columns: cols,
        pk: cols.filter((x) => x.primary).map((x) => x.name),
        fks: list(o.foreignKeys).map(fkOf).filter((x): x is DbFk => Boolean(x)),
        indexes: [...list(o.indices), ...list(o.uniques).map((u) => ({ obj: { ...obj(u), isUnique: { b: true } } }) as DV)].map(indexOf).filter((x): x is DbIndex => Boolean(x)),
        checks: [],
        ...(bool(args[1]) ? { ifNotExists: true as const } : {}),
        line,
      }];
    }
    case "dropTable":
      return t ? [{ op: "dropTable", table: t, line }] : [];
    case "renameTable": {
      const to = str(args[1]);
      return t && to ? [{ op: "renameTable", table: t, to, line }] : [];
    }
    case "addColumn": {
      const c = tableColumn(args[1]);
      return t && c ? [{ op: "addColumn", table: t, column: c.col, line }] : [];
    }
    case "addColumns":
      return t ? list(args[1]).map((x) => tableColumn(x)).filter((x): x is { col: DbColumn } => Boolean(x)).map((c) => ({ op: "addColumn" as const, table: t, column: c.col, line })) : [];
    case "dropColumn": {
      const col = str(args[1]) ?? tableColumn(args[1])?.col.name;
      return t && col ? [{ op: "dropColumn", table: t, column: col, line }] : [];
    }
    case "dropColumns":
      return t ? list(args[1]).map((x) => str(x) ?? tableColumn(x)?.col.name).filter((x): x is string => Boolean(x)).map((col) => ({ op: "dropColumn" as const, table: t, column: col, line })) : [];
    case "renameColumn": {
      const from = str(args[1]) ?? tableColumn(args[1])?.col.name;
      const to = str(args[2]) ?? tableColumn(args[2])?.col.name;
      return t && from && to ? [{ op: "renameColumn", table: t, column: from, to, line }] : [];
    }
    case "changeColumn": {
      const from = str(args[1]) ?? tableColumn(args[1])?.col.name;
      const next = tableColumn(args[2]);
      if (!t || !from || !next) break;
      const ops: DbOp[] = [];
      if (from.toLowerCase() !== next.col.name.toLowerCase()) ops.push({ op: "renameColumn", table: t, column: from, to: next.col.name, line });
      ops.push({ op: "alterColumn", table: t, column: next.col.name, type: next.col.type || undefined, nullable: next.col.nullable, ...(next.col.default !== undefined ? { default: next.col.default } : {}), line });
      return ops;
    }
    case "createIndex": {
      const index = indexOf(args[1]);
      return t && index ? [{ op: "createIndex", table: t, index, line }] : [];
    }
    case "createIndices":
      return t ? list(args[1]).map(indexOf).filter((x): x is DbIndex => Boolean(x)).map((index) => ({ op: "createIndex" as const, table: t, index, line })) : [];
    case "dropIndex": {
      const name = str(args[1]) ?? indexOf(args[1])?.name;
      return name ? [{ op: "dropIndex", name, ...(t ? { table: t } : {}), line }] : [];
    }
    case "createForeignKey": {
      const fk = fkOf(args[1]);
      return t && fk ? [{ op: "addFk", table: t, fk, line }] : [];
    }
    case "createForeignKeys":
      return t ? list(args[1]).map(fkOf).filter((x): x is DbFk => Boolean(x)).map((fk) => ({ op: "addFk" as const, table: t, fk, line })) : [];
    case "dropForeignKey": {
      const name = str(args[1]) ?? fkOf(args[1])?.name;
      return t && name ? [{ op: "dropConstraint", table: t, name, line }] : [];
    }
    case "createPrimaryKey":
      return t ? [{ op: "addPk", table: t, columns: list(args[1]).map((x) => str(x) ?? "").filter(Boolean), line }] : [];
    case "createUniqueConstraint": {
      const index = indexOf(args[1]);
      return t && index ? [{ op: "createIndex", table: t, index: { ...index, unique: true }, line }] : [];
    }
    default:
      break;
  }
  return [{ op: "opaque", text: `queryRunner.${m}(${t ? `"${t}"` : "…"})`, line, ...(t ? { table: t } : {}) }];
}

/** TypeORM migration classes, grouped by folder, ordered by their timestamp. */
export function typeormMigrations(code: ReadonlyArray<{ file: string; facts: DbCodeFacts }>): MigrationSet[] {
  const byFolder = new Map<string, Array<{ file: string; cls: NonNullable<DbCodeFacts["migrations"]>[number] }>>();
  for (const { file, facts } of code) for (const cls of facts.migrations ?? []) if (cls.up) (byFolder.get(dirOf(file)) ?? byFolder.set(dirOf(file), []).get(dirOf(file))!).push({ file, cls });
  const sets: MigrationSet[] = [];
  for (const [root, list] of byFolder) {
    const problems: string[] = [];
    const stamped = list.map((m) => {
      const ts = /(\d{13})$/.exec(m.cls.name)?.[1] ?? /(^|\/)(\d{10,14})[-_.]/.exec(m.file)?.[2];
      return { ...m, ts };
    });
    const ordered = stamped.filter((m) => m.ts).sort((a, b) => Number(a.ts) - Number(b.ts) || a.cls.name.localeCompare(b.cls.name));
    for (const m of stamped) if (!m.ts) problems.push(`${m.cls.name} (${m.file}) has no timestamp in its name — order unknown, not replayed.`);
    const migrations = ordered.map((m, i) => {
      const ops = m.cls.calls.flatMap((c) => {
        try {
          return callOps(c);
        } catch {
          return [{ op: "opaque" as const, text: `queryRunner.${c.m}(…)`, line: c.line }];
        }
      });
      return { ...migration(`${m.file}#${m.cls.name}`, m.cls.name, m.file, m.cls.line, "typeorm", ops), order: i };
    });
    const sqlText = list.flatMap((m) => m.cls.calls.filter((c) => c.m === "query").map((c) => (c.args[0] && "s" in c.args[0] ? c.args[0].s : "")));
    sets.push({ tool: "typeorm", root, family: "typeorm", migrations, problems, ...guess(sqlText) });
  }
  return sets;
}

function guess(texts: string[]): { dialect?: MigrationSet["dialect"]; dialectGuessed?: true } {
  const d = guessDialect(texts);
  return d ? { dialect: d, dialectGuessed: true } : {};
}
