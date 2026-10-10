/**
 * Replaying migrations (DESIGN.md §6.13 §1): every source's operations are
 * applied in order to an in-memory schema — tables, columns, indexes,
 * foreign keys, checks and enums — and each table keeps the history of what
 * touched it. Declarative schema files go through the same engine as one
 * step, without a history.
 *
 * Names are matched case-insensitively, and Postgres's default `public`
 * schema is the same as no schema.
 */
import type { DbCheck, DbColumn, DbEnum, DbFk, DbIndex, DbMigrationRef, DbOp, DbOpaque, DbSourceKind } from "./types";

export interface TableState {
  schema?: string;
  name: string;
  columns: DbColumn[];
  pk: string[];
  indexes: DbIndex[];
  fks: DbFk[];
  checks: DbCheck[];
  history: DbMigrationRef[];
  definedAt: { file: string; line: number };
  view?: true;
}

export interface EnumState {
  schema?: string;
  name: string;
  values: string[];
  file: string;
  line: number;
}

const lc = (s: string) => s.toLowerCase();

/** `public.orders` / `"Orders"` → `{ schema?, name }`, the default schema dropped. */
export function splitName(qualified: string): { schema?: string; name: string } {
  const parts = qualified.split(".").filter(Boolean);
  const name = parts[parts.length - 1] ?? qualified;
  const schema = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  if (!schema || lc(schema) === "public" || lc(schema) === "dbo" || lc(schema) === "main") return { name };
  return { schema, name };
}

export function tableKey(qualified: string): string {
  const { schema, name } = splitName(qualified);
  return lc(schema ? `${schema}.${name}` : name);
}

const sameName = (a: string, b: string) => lc(a) === lc(b);

/** What one op did, in words, for a table's history. */
export function describeOp(op: DbOp): string {
  switch (op.op) {
    case "createTable":
      return op.view ? "create view" : `create table (${op.columns.length} column${op.columns.length === 1 ? "" : "s"})`;
    case "dropTable":
      return op.view ? "drop view" : "drop table";
    case "renameTable":
      return `rename table to ${splitName(op.to).name}`;
    case "addColumn":
      return `add column ${op.column.name} ${op.column.type}${op.column.nullable ? "" : " NOT NULL"}${op.column.default !== undefined ? ` DEFAULT ${op.column.default}` : ""}`;
    case "dropColumn":
      return `drop column ${op.column}`;
    case "alterColumn": {
      const parts: string[] = [];
      if (op.type) parts.push(`type ${op.type}`);
      if (op.nullable === false) parts.push("NOT NULL");
      if (op.nullable === true) parts.push("nullable");
      if (op.default === null) parts.push("drop default");
      else if (op.default !== undefined) parts.push(`default ${op.default}`);
      return `alter column ${op.column}${parts.length ? `: ${parts.join(", ")}` : ""}`;
    }
    case "renameColumn":
      return `rename column ${op.column} to ${op.to}`;
    case "createIndex":
      return `create ${op.index.unique ? "unique " : ""}index${op.index.name ? ` ${op.index.name}` : ""} (${op.index.columns.join(", ")})${op.concurrently ? " concurrently" : ""}`;
    case "dropIndex":
      return `drop index ${op.name}`;
    case "addFk":
      return `add foreign key (${op.fk.columns.join(", ")}) → ${splitName(op.fk.refTable).name}`;
    case "addPk":
      return `add primary key (${op.columns.join(", ")})`;
    case "addCheck":
      return `add check ${op.check.name ?? ""}`.trim();
    case "dropConstraint":
      return `drop constraint ${op.name}`;
    case "createEnum":
      return `create enum ${op.name}`;
    case "alterEnum":
      return op.add ? `add enum value ${op.add.join(", ")}` : `rename enum value ${op.rename?.join(" → ")}`;
    case "dropEnum":
      return `drop enum ${op.name}`;
    case "opaque":
      return op.text;
  }
}

/** The table an op is about, when it is about one. */
export function opTable(op: DbOp): string | undefined {
  return "table" in op ? op.table : undefined;
}

export interface MigrationContext {
  id: string;
  name: string;
  file: string;
}

export class SchemaState {
  readonly tables = new Map<string, TableState>();
  readonly enums = new Map<string, EnumState>();
  readonly opaque: DbOpaque[] = [];

  constructor(
    readonly source: DbSourceKind,
    /** Record each op in its table's history (migrations do; a schema file doesn't). */
    readonly recordHistory: boolean,
  ) {}

  table(name: string): TableState | undefined {
    return this.tables.get(tableKey(name));
  }

  private log(t: TableState, op: DbOp, m: MigrationContext): void {
    if (!this.recordHistory) return;
    t.history.push({ migration: m.id, name: m.name, file: m.file, line: op.line, summary: describeOp(op) });
  }

  private column(t: TableState, name: string): DbColumn | undefined {
    return t.columns.find((c) => sameName(c.name, name));
  }

  /** Applies one op; ops on tables it doesn't know are kept as opaque (a table made outside the history). */
  apply(op: DbOp, m: MigrationContext): void {
    const keep = (text: string) => {
      if (this.opaque.length < 400) this.opaque.push({ migration: m.id, file: m.file, line: op.line, text });
    };
    switch (op.op) {
      case "createTable": {
        const key = tableKey(op.table);
        if (this.tables.has(key) && op.ifNotExists) return;
        const { schema, name } = splitName(op.table);
        const columns = op.columns.map((c) => ({ ...c, source: this.source }));
        const t: TableState = {
          ...(schema ? { schema } : {}),
          name,
          columns,
          pk: [...op.pk],
          indexes: op.indexes.map((i) => ({ ...i, columns: [...i.columns] })),
          fks: op.fks.map((f) => ({ ...f })),
          checks: op.checks.map((c) => ({ ...c })),
          history: [],
          definedAt: { file: m.file, line: op.line },
          ...(op.view ? { view: true as const } : {}),
        };
        this.tables.set(key, t);
        this.log(t, op, m);
        return;
      }
      case "dropTable": {
        const key = tableKey(op.table);
        if (!this.tables.delete(key)) return;
        return;
      }
      case "renameTable": {
        const key = tableKey(op.table);
        const t = this.tables.get(key);
        if (!t) return keep(describeOp(op));
        this.tables.delete(key);
        const next = splitName(op.to);
        // `ALTER TABLE s.a RENAME TO b` keeps the schema.
        t.name = next.name;
        if (next.schema) t.schema = next.schema;
        this.tables.set(tableKey(t.schema ? `${t.schema}.${t.name}` : t.name), t);
        // References to the old name follow it.
        for (const other of this.tables.values()) for (const fk of other.fks) if (tableKey(fk.refTable) === key) fk.refTable = t.schema ? `${t.schema}.${t.name}` : t.name;
        this.log(t, op, m);
        return;
      }
      default:
        break;
    }
    if (op.op === "createEnum") {
      const { schema, name } = splitName(op.name);
      this.enums.set(tableKey(op.name), { ...(schema ? { schema } : {}), name, values: [...op.values], file: m.file, line: op.line });
      return;
    }
    if (op.op === "alterEnum") {
      const e = this.enums.get(tableKey(op.name));
      if (!e) return keep(describeOp(op));
      if (op.add) for (const v of op.add) if (!e.values.includes(v)) e.values.push(v);
      if (op.rename) e.values = e.values.map((v) => (v === op.rename![0] ? op.rename![1] : v));
      return;
    }
    if (op.op === "dropEnum") {
      this.enums.delete(tableKey(op.name));
      return;
    }
    if (op.op === "opaque") {
      keep(op.text);
      const t = op.table ? this.table(op.table) : undefined;
      if (t) this.log(t, op, m);
      return;
    }
    if (op.op === "dropIndex") {
      const candidates = op.table ? [this.table(op.table)].filter((t): t is TableState => Boolean(t)) : [...this.tables.values()];
      for (const t of candidates) {
        const i = t.indexes.findIndex((x) => x.name && sameName(x.name, splitName(op.name).name));
        if (i >= 0) {
          t.indexes.splice(i, 1);
          this.log(t, op, m);
          return;
        }
      }
      return;
    }
    const t = this.table(op.table);
    if (!t) return keep(`${describeOp(op)} on ${op.table}`);
    switch (op.op) {
      case "addColumn": {
        const existing = this.column(t, op.column.name);
        const col = { ...op.column, source: this.source };
        if (existing) Object.assign(existing, col);
        else t.columns.push(col);
        if (col.primary && !t.pk.some((p) => sameName(p, col.name))) t.pk = [col.name];
        if (op.fk) t.fks.push({ ...op.fk });
        break;
      }
      case "dropColumn": {
        t.columns = t.columns.filter((c) => !sameName(c.name, op.column));
        t.pk = t.pk.filter((p) => !sameName(p, op.column));
        t.indexes = t.indexes.filter((i) => !i.columns.some((c) => sameName(c, op.column)));
        t.fks = t.fks.filter((f) => !f.columns.some((c) => sameName(c, op.column)));
        break;
      }
      case "alterColumn": {
        const c = this.column(t, op.column);
        if (!c) return keep(`${describeOp(op)} on ${op.table}`);
        if (op.type) c.type = op.type;
        if (op.nullable !== undefined) c.nullable = op.nullable;
        if (op.default === null) delete c.default;
        else if (op.default !== undefined) c.default = op.default;
        break;
      }
      case "renameColumn": {
        const c = this.column(t, op.column);
        if (!c) return keep(`${describeOp(op)} on ${op.table}`);
        c.name = op.to;
        const rename = (list: string[]) => list.map((x) => (sameName(x, op.column) ? op.to : x));
        t.pk = rename(t.pk);
        for (const i of t.indexes) i.columns = rename(i.columns);
        for (const f of t.fks) f.columns = rename(f.columns);
        for (const other of this.tables.values()) for (const f of other.fks) if (tableKey(f.refTable) === tableKey(t.schema ? `${t.schema}.${t.name}` : t.name)) f.refColumns = rename(f.refColumns);
        break;
      }
      case "createIndex":
        t.indexes = t.indexes.filter((i) => !(i.name && op.index.name && sameName(i.name, op.index.name)));
        t.indexes.push({ ...op.index, columns: [...op.index.columns] });
        break;
      case "addFk":
        t.fks.push({ ...op.fk });
        break;
      case "addPk":
        t.pk = [...op.columns];
        for (const c of t.columns) if (op.columns.some((p) => sameName(p, c.name))) {
          c.primary = true;
          c.nullable = false;
        }
        break;
      case "addCheck":
        t.checks.push({ ...op.check });
        break;
      case "dropConstraint": {
        if (op.name === "PRIMARY" || /_pkey$/i.test(op.name)) {
          if (op.name === "PRIMARY" || t.pk.length) {
            for (const c of t.columns) if (t.pk.some((p) => sameName(p, c.name))) delete c.primary;
            t.pk = [];
          }
        }
        t.fks = t.fks.filter((f) => !(f.name && sameName(f.name, op.name)));
        t.checks = t.checks.filter((c) => !(c.name && sameName(c.name, op.name)));
        t.indexes = t.indexes.filter((i) => !(i.name && sameName(i.name, op.name)));
        break;
      }
    }
    this.log(t, op, m);
  }

  /** Plain copies of the enums. */
  enumList(databaseId: string, source: DbSourceKind): DbEnum[] {
    return [...this.enums.values()].map((e) => ({
      id: `${databaseId}:${lc(e.schema ? `${e.schema}.${e.name}` : e.name)}`,
      name: e.schema ? `${e.schema}.${e.name}` : e.name,
      values: [...e.values],
      file: e.file,
      line: e.line,
      source,
    }));
  }
}
