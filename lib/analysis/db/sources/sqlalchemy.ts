/**
 * SQLAlchemy, SQLModel and Alembic (DESIGN.md §6.13 §1).
 *
 * Models: declarative classes with `__tablename__` (`Column(…)`,
 * `mapped_column(…)`, `Mapped[…]` annotations, mixins from the repo),
 * SQLModel classes with `table=True` (`Field(…)`), and module-level
 * `Table("name", metadata, Column(…))`. `relationship()` isn't a column.
 *
 * Alembic: revision files (`revision`, `down_revision`) replayed along the
 * `down_revision` chain; `op.*` calls (and `batch_alter_table` blocks) of
 * `upgrade()` become ops, `op.execute` SQL is read as SQL. Two heads, a
 * missing parent or a cycle are shown as order problems.
 */
import { guessDialect, normalizeType, parseSql } from "../sql";
import { asCall, bool, column, dirOf, isNil, last, list, literalText, migration, nameOf, num, obj, str, topoSort, type DeclSet, type MigrationSet, type TableDecl } from "../common";
import { commonRoot } from "./drizzle";
import type { DbCheck, DbCodeFacts, DbColumn, DbFk, DbIndex, DbMigration, DbOp, DV } from "../types";

/** A SQLAlchemy type expression → SQL-ish type. */
export function saType(v: DV | undefined): string | undefined {
  if (!v) return undefined;
  const c = asCall(v);
  const raw = c ? c.name : nameOf(v);
  if (!raw) return undefined;
  const name = last(raw);
  const args = c?.args ?? [];
  const kw = c?.kw ?? {};
  const n0 = num(args[0]) ?? num(kw.length);
  switch (name) {
    case "String":
    case "VARCHAR":
    case "Unicode":
    case "AutoString":
    case "NVARCHAR":
      return n0 ? `varchar(${n0})` : "varchar";
    case "CHAR":
      return n0 ? `char(${n0})` : "char";
    case "Text":
    case "UnicodeText":
    case "TEXT":
    case "CITEXT":
      return name === "CITEXT" ? "citext" : "text";
    case "Integer":
    case "INTEGER":
    case "INT":
      return "integer";
    case "BigInteger":
    case "BIGINT":
      return "bigint";
    case "SmallInteger":
    case "SMALLINT":
      return "smallint";
    case "Boolean":
    case "BOOLEAN":
      return "boolean";
    case "DateTime":
    case "TIMESTAMP":
    case "DATETIME":
      return bool(kw.timezone) ? "timestamptz" : "timestamp";
    case "Date":
    case "DATE":
      return "date";
    case "Time":
      return "time";
    case "Interval":
      return "interval";
    case "Numeric":
    case "DECIMAL":
    case "NUMERIC": {
      const p = num(args[0]) ?? num(kw.precision);
      const s = num(args[1]) ?? num(kw.scale);
      return p !== undefined ? `numeric(${p}${s !== undefined ? `,${s}` : ""})` : "numeric";
    }
    case "Float":
    case "FLOAT":
    case "DOUBLE_PRECISION":
    case "Double":
      return "double precision";
    case "REAL":
      return "real";
    case "JSON":
      return "json";
    case "JSONB":
      return "jsonb";
    case "UUID":
    case "Uuid":
    case "GUID":
      return "uuid";
    case "LargeBinary":
    case "BYTEA":
    case "BLOB":
      return "bytea";
    case "INET":
      return "inet";
    case "Enum":
    case "ENUM":
      return str(kw.name) ?? "enum";
    case "ARRAY": {
      const inner = saType(args[0]);
      return inner ? `${inner}[]` : "array";
    }
    case "TSVECTOR":
      return "tsvector";
    default:
      return /^[A-Z]/.test(name) ? normalizeType(name) : undefined;
  }
}

/** Enum values of `sa.Enum("a", "b", name="x")` / `postgresql.ENUM(…)`. */
function enumOf(v: DV | undefined): { name: string; values: string[] } | undefined {
  const c = asCall(v);
  if (!c || !/^(Enum|ENUM)$/.test(last(c.name))) return undefined;
  const name = str(c.kw.name);
  if (!name) return undefined;
  return { name, values: c.args.map((a) => str(a)).filter((x): x is string => x !== undefined) };
}

/** A `Mapped[…]` / plain annotation → type and nullability. */
function annotation(ann: string | undefined): { type?: string; nullable?: boolean } {
  if (!ann) return {};
  let inner = ann.replace(/^(Mapped|sa_orm\.Mapped|orm\.Mapped)\[(.*)\]$/, "$2").trim();
  let nullable = false;
  const opt = /^Optional\[(.*)\]$/.exec(inner);
  if (opt) {
    inner = opt[1];
    nullable = true;
  }
  if (/\|\s*None\b|\bNone\s*\|/.test(inner)) {
    inner = inner.replace(/\s*\|\s*None\b|\bNone\s*\|\s*/g, "").trim();
    nullable = true;
  }
  const map: Record<string, string> = {
    int: "integer",
    str: "varchar",
    bool: "boolean",
    float: "double precision",
    datetime: "timestamp",
    "datetime.datetime": "timestamp",
    date: "date",
    "datetime.date": "date",
    Decimal: "numeric",
    "decimal.Decimal": "numeric",
    UUID: "uuid",
    "uuid.UUID": "uuid",
    bytes: "bytea",
    dict: "json",
    list: "json",
  };
  const type = map[inner] ?? map[inner.replace(/\[.*$/, "")] ?? (/^(dict|Dict|list|List)\b/.test(inner) ? "json" : undefined);
  return { ...(type ? { type } : {}), nullable };
}

const COLUMN_CALLS = /(^|\.)(Column|mapped_column)$/;

interface ColumnRead {
  col: DbColumn;
  fk?: DbFk;
  index?: true;
  enum?: { name: string; values: string[] };
}

/** `Column("name", Type, ForeignKey("t.id"), primary_key=True, …)` / `mapped_column(…)` / SQLModel `Field(…)`. */
function readColumn(attrName: string | undefined, v: DV | undefined, ann: string | undefined, source: "model" | "migration"): ColumnRead | null {
  const c = asCall(v);
  const a = annotation(ann);
  if (!c) {
    // `id: Mapped[int]` with no value is a mapped column too.
    if (!v && ann && /Mapped\[/.test(ann) && !/relationship|WriteOnlyMapped|DynamicMapped/.test(ann) && attrName && !/^(List|list|Set|set)\[/.test(ann.replace(/^Mapped\[|\]$/g, ""))) {
      return { col: column(attrName, a.type ?? "varchar", a.nullable ?? false, source) };
    }
    return null;
  }
  const fn = last(c.name);
  const isField = fn === "Field";
  if (!COLUMN_CALLS.test(c.name) && !isField) return null;
  const kw = c.kw;
  if (isField && kw.sa_column) return readColumn(attrName, kw.sa_column, ann, source);
  let name = attrName;
  let type: string | undefined;
  let fk: DbFk | undefined;
  let en: ColumnRead["enum"];
  for (const arg of c.args) {
    if (str(arg) !== undefined && name === attrName && type === undefined && !fk) {
      name = str(arg);
      continue;
    }
    const ac = asCall(arg);
    if (ac && last(ac.name) === "ForeignKey") {
      const target = str(ac.args[0]) ?? nameOf(ac.args[0]) ?? "";
      const parts = target.split(".");
      const ondelete = str(ac.kw.ondelete);
      fk = { columns: [], refTable: parts.slice(0, -1).join(".") || target, refColumns: [parts[parts.length - 1]], ...(ondelete ? { onDelete: ondelete.toUpperCase() } : {}) };
      continue;
    }
    const t = saType(arg);
    if (t && !type) {
      type = t;
      en = enumOf(arg);
    }
  }
  if (isField) {
    const fkTarget = str(kw.foreign_key);
    if (fkTarget) {
      const parts = fkTarget.split(".");
      const ondelete = str(kw.ondelete);
      fk = { columns: [], refTable: parts.slice(0, -1).join("."), refColumns: [parts[parts.length - 1]], ...(ondelete ? { onDelete: ondelete.toUpperCase() } : {}) };
    }
    const max = num(kw.max_length);
    if (max && (!a.type || a.type === "varchar")) type = `varchar(${max})`;
  }
  if (type === undefined && kw.type_) type = saType(kw.type_);
  if (!name) return null;
  const primary = bool(kw.primary_key) ?? false;
  // Column(): nullable unless it's the key or says otherwise. mapped_column / Field: from the annotation.
  let nullable = bool(kw.nullable) ?? (fn === "Column" ? !primary : (a.nullable ?? !primary));
  if (primary) nullable = false;
  const col = column(name, type ?? a.type ?? (fk ? "integer" : "varchar"), nullable, source);
  if (primary) col.primary = true;
  if (bool(kw.unique)) col.unique = true;
  const server = kw.server_default;
  if (server !== undefined && !isNil(server)) col.default = literalText(asCall(server) && /text$/.test(asCall(server)!.name) ? asCall(server)!.args[0] : server);
  else if (source === "model" && kw.default !== undefined && !isNil(kw.default) && !isField) col.default = `${literalText(kw.default)} (in Python)`;
  if (en) col.enum = en.name;
  if (fk) fk.columns = [name];
  return { col, ...(fk ? { fk } : {}), ...(bool(kw.index) ? { index: true as const } : {}), ...(en ? { enum: en } : {}) };
}

type PyClass = NonNullable<DbCodeFacts["classes"]>[number];

/** Constraints in a create_table / Table(…) argument list. */
function constraintArgs(args: DV[], into: { pk: string[]; fks: DbFk[]; indexes: DbIndex[]; checks: DbCheck[] }): void {
  for (const a of args) {
    const c = asCall(a);
    if (!c) continue;
    const name = last(c.name);
    const cols = c.args.flatMap((x) => ("list" in x ? list(x) : [x])).map((x) => str(x)).filter((x): x is string => Boolean(x));
    if (name === "PrimaryKeyConstraint") into.pk = cols;
    else if (name === "UniqueConstraint") into.indexes.push({ ...(str(c.kw.name) ? { name: str(c.kw.name)! } : {}), columns: cols, unique: true });
    else if (name === "ForeignKeyConstraint") {
      const local = list(c.args[0]).map((x) => str(x) ?? "").filter(Boolean);
      const remote = list(c.args[1]).map((x) => str(x) ?? "").filter(Boolean);
      const refTable = remote[0]?.split(".").slice(0, -1).join(".") ?? "?";
      const ondelete = str(c.kw.ondelete);
      into.fks.push({ ...(str(c.kw.name) ? { name: str(c.kw.name)! } : {}), columns: local, refTable, refColumns: remote.map((r) => r.split(".").pop() ?? r), ...(ondelete ? { onDelete: ondelete.toUpperCase() } : {}) });
    } else if (name === "CheckConstraint") into.checks.push({ ...(str(c.kw.name) ? { name: str(c.kw.name)! } : {}), expr: str(c.args[0]) ?? "check" });
    else if (name === "Index") into.indexes.push({ ...(str(c.args[0]) ? { name: str(c.args[0])! } : {}), columns: c.args.slice(1).map((x) => str(x) ?? nameOf(x)?.split(".").pop() ?? "").filter(Boolean), ...(bool(c.kw.unique) ? { unique: true as const } : {}) });
  }
}

/** SQLAlchemy / SQLModel models. */
export function sqlalchemyModels(code: ReadonlyArray<{ file: string; facts: DbCodeFacts }>): DeclSet[] {
  const classes = code.flatMap(({ file, facts }) => (facts.classes ?? []).map((cls) => ({ file, cls })));
  const byName = new Map<string, { file: string; cls: PyClass }>();
  for (const c of classes) if (!byName.has(c.cls.name)) byName.set(c.cls.name, c);
  const tableAttr = (cls: PyClass) => cls.attrs.find((a) => a.name === "__tablename__");
  const out: Record<"sqlalchemy" | "sqlmodel", TableDecl[]> = { sqlalchemy: [], sqlmodel: [] };
  const enums: DeclSet["enums"] = [];
  for (const { file, cls } of classes) {
    const tn = tableAttr(cls);
    const isSqlModel = bool(cls.kw?.table) === true && cls.bases.some((b) => /SQLModel$/.test(b) || byName.has(last(b)));
    if (!tn && !isSqlModel) continue;
    // A `__tablename__` that isn't a literal (a `declared_attr`) can't be read.
    const name = tn ? str(tn.value) : cls.name.toLowerCase();
    if (!name) continue;
    const tool = isSqlModel ? "sqlmodel" : "sqlalchemy";
    const decl: TableDecl = { name, columns: [], pk: [], fks: [], indexes: [], checks: [], file, line: cls.line, model: { tool, name: cls.name, file, line: cls.line, decl: `${file}#${cls.name}` }, fields: [], relations: [] };
    // Mixin and base-class columns first (`TimestampMixin`, an abstract `Base` with `id`).
    const attrs: PyClass["attrs"] = [];
    const seen = new Set<PyClass>();
    const visit = (c: PyClass, depth: number) => {
      if (seen.has(c) || depth > 5) return;
      seen.add(c);
      for (const b of c.bases) {
        const base = byName.get(last(b));
        if (base && base.cls !== c && (!tableAttr(base.cls) || base.cls === cls)) visit(base.cls, depth + 1);
      }
      attrs.push(...c.attrs);
    };
    visit(cls, 0);
    const byAttr = new Map<string, (typeof attrs)[number]>();
    for (const a of attrs) byAttr.set(a.name, a); // a subclass's attribute wins
    for (const a of byAttr.values()) {
      if (a.name.startsWith("__")) {
        if (a.name === "__table_args__") {
          const items = a.value && "list" in a.value ? a.value.list : a.value ? [a.value] : [];
          for (const item of items) {
            const schema = str(obj(item).schema);
            if (schema && !decl.name.includes(".")) decl.name = `${schema}.${decl.name}`;
          }
          constraintArgs(items, decl);
        }
        continue;
      }
      const vc = asCall(a.value);
      if (vc && /(^|\.)(relationship|association_proxy|column_property|synonym|Relationship|backref)$/.test(vc.name)) {
        decl.relations!.push(a.name);
        continue;
      }
      if (a.ann && /^(List|list|Optional|Set)\[["']?[A-Z]/.test(a.ann) && !vc && isSqlModel) {
        decl.relations!.push(a.name);
        continue;
      }
      let r = readColumn(a.name, a.value, a.ann, "model");
      // SQLModel: a plain annotated attribute is a column.
      if (!r && isSqlModel && a.ann && !a.ann.includes("Relationship") && !/^(List|list)\[/.test(a.ann)) {
        const t = annotation(a.ann);
        if (t.type) r = { col: column(a.name, t.type, t.nullable ?? false, "model") };
      }
      if (!r) continue;
      if (r.fk) r.fk.inferred = true;
      decl.columns.push(r.col);
      decl.fields!.push({ field: a.name, column: r.col.name, line: a.line });
      if (r.col.primary) decl.pk.push(r.col.name);
      if (r.fk) decl.fks.push(r.fk);
      if (r.index) decl.indexes.push({ columns: [r.col.name] });
      if (r.enum) enums.push({ ...r.enum, file, line: a.line });
    }
    out[tool].push(decl);
  }
  // Core tables: `orders = Table("orders", metadata, Column(…), …)`.
  for (const { file, facts } of code) {
    for (const a of facts.assigns ?? []) {
      const c = asCall(a.value);
      if (!c || last(c.name) !== "Table") continue;
      const name = str(c.args[0]);
      if (!name) continue;
      const schema = str(c.kw.schema);
      const decl: TableDecl = { name: schema ? `${schema}.${name}` : name, columns: [], pk: [], fks: [], indexes: [], checks: [], file, line: a.line, model: { tool: "sqlalchemy", name: a.name, file, line: a.line, decl: `${file}#${a.name}` }, fields: [] };
      for (const arg of c.args.slice(1)) {
        const r = readColumn(undefined, arg, undefined, "model");
        if (!r) continue;
        if (r.fk) r.fk.inferred = true;
        decl.columns.push(r.col);
        decl.fields!.push({ field: r.col.name, column: r.col.name });
        if (r.col.primary) decl.pk.push(r.col.name);
        if (r.fk) decl.fks.push(r.fk);
        if (r.enum) enums.push({ ...r.enum, file, line: a.line });
      }
      constraintArgs(c.args.slice(1), decl);
      out.sqlalchemy.push(decl);
    }
  }
  const sets: DeclSet[] = [];
  for (const tool of ["sqlalchemy", "sqlmodel"] as const) {
    if (out[tool].length === 0) continue;
    sets.push({ tool, kind: "model", root: commonRoot(out[tool].map((t) => t.file)), files: [...new Set(out[tool].map((t) => t.file))], tables: out[tool], enums: tool === "sqlalchemy" ? enums : [] });
  }
  return sets;
}

// ---------------------------------------------------------------------------
// Alembic
// ---------------------------------------------------------------------------

type UpgradeCall = NonNullable<DbCodeFacts["upgrade"]>[number];

/** One `op.*` call → ops. */
function alembicOps(call: UpgradeCall): DbOp[] {
  const { m, args, line } = call;
  const kw = call.kw ?? {};
  const batch = call.batch;
  const q = (t: string | undefined, schema?: DV) => (t && str(schema) ? `${str(schema)}.${t}` : t);
  // Inside a batch block the table is the block's; arguments shift left by one.
  const tableArg = (i: number, key: string) => (batch ? (batch.schema ? `${batch.schema}.${batch.table}` : batch.table) : q(str(kw[key] ?? args[i]), kw.schema));
  const shift = batch ? -1 : 0;
  const at = (i: number) => args[i + shift];
  switch (m) {
    case "create_table": {
      const name = q(str(args[0]), kw.schema);
      if (!name) break;
      const into = { pk: [] as string[], fks: [] as DbFk[], indexes: [] as DbIndex[], checks: [] as DbCheck[] };
      const columns: DbColumn[] = [];
      const enums: DbOp[] = [];
      for (const a of args.slice(1)) {
        const r = readColumn(undefined, a, undefined, "migration");
        if (!r) continue;
        columns.push(r.col);
        if (r.col.primary) into.pk.push(r.col.name);
        if (r.fk) into.fks.push(r.fk);
        if (r.enum) enums.push({ op: "createEnum", name: r.enum.name, values: r.enum.values, line });
      }
      constraintArgs(args.slice(1), into);
      for (const c of columns) if (into.pk.includes(c.name)) {
        c.primary = true;
        c.nullable = false;
      }
      return [...enums, { op: "createTable", table: name, columns, pk: into.pk, fks: into.fks, indexes: into.indexes, checks: into.checks, line }];
    }
    case "drop_table": {
      const name = q(str(args[0]), kw.schema);
      return name ? [{ op: "dropTable", table: name, line }] : [];
    }
    case "rename_table": {
      const from = q(str(args[0]), kw.schema);
      const to = str(args[1]);
      return from && to ? [{ op: "renameTable", table: from, to, line }] : [];
    }
    case "add_column": {
      const t = tableArg(0, "table_name");
      const r = readColumn(undefined, at(1), undefined, "migration");
      if (!t || !r) break;
      return [...(r.enum ? [{ op: "createEnum" as const, name: r.enum.name, values: r.enum.values, line }] : []), { op: "addColumn", table: t, column: r.col, ...(r.fk ? { fk: r.fk } : {}), line }];
    }
    case "drop_column": {
      const t = tableArg(0, "table_name");
      const col = str(at(1)) ?? str(kw.column_name);
      return t && col ? [{ op: "dropColumn", table: t, column: col, line }] : [];
    }
    case "alter_column": {
      const t = tableArg(0, "table_name");
      const col = str(at(1)) ?? str(kw.column_name);
      if (!t || !col) break;
      const ops: DbOp[] = [];
      const type = kw.type_ ? saType(kw.type_) : undefined;
      const nullable = bool(kw.nullable);
      const server = kw.server_default;
      const def = server === undefined ? undefined : isNil(server) || bool(server) === false ? null : literalText(asCall(server) && /text$/.test(asCall(server)!.name) ? asCall(server)!.args[0] : server);
      if (type !== undefined || nullable !== undefined || def !== undefined) ops.push({ op: "alterColumn", table: t, column: col, ...(type ? { type } : {}), ...(nullable !== undefined ? { nullable } : {}), ...(def !== undefined ? { default: def } : {}), line });
      const rename = str(kw.new_column_name);
      if (rename) ops.push({ op: "renameColumn", table: t, column: col, to: rename, line });
      return ops;
    }
    case "create_index": {
      const name = str(args[0]) ?? str(kw.index_name);
      const t = batch ? tableArg(0, "table_name") : q(str(args[1]) ?? str(kw.table_name), kw.schema);
      const cols = list(batch ? args[1] : (args[2] ?? kw.columns)).map((x) => str(x) ?? nameOf(x)?.split(".").pop() ?? "").filter(Boolean);
      if (!t) break;
      return [{ op: "createIndex", table: t, index: { ...(name ? { name } : {}), columns: cols, ...(bool(kw.unique) ? { unique: true as const } : {}) }, ...(bool(kw.postgresql_concurrently) ? { concurrently: true as const } : {}), line }];
    }
    case "drop_index": {
      const name = str(args[0]) ?? str(kw.index_name);
      const t = batch ? tableArg(0, "table_name") : q(str(kw.table_name) ?? str(args[1]), kw.schema);
      return name ? [{ op: "dropIndex", name, ...(t ? { table: t } : {}), line }] : [];
    }
    case "create_foreign_key": {
      const name = str(args[0]);
      const src = batch ? tableArg(0, "source_table") : q(str(args[1]) ?? str(kw.source_table), kw.source_schema);
      const ref = str(at(2)) ?? str(kw.referent_table);
      const local = list(at(3) ?? kw.local_cols).map((x) => str(x) ?? "").filter(Boolean);
      const remote = list(at(4) ?? kw.remote_cols).map((x) => str(x) ?? "").filter(Boolean);
      if (!src || !ref) break;
      const ondelete = str(kw.ondelete);
      return [{ op: "addFk", table: src, fk: { ...(name ? { name } : {}), columns: local, refTable: ref, refColumns: remote, ...(ondelete ? { onDelete: ondelete.toUpperCase() } : {}) }, line }];
    }
    case "drop_constraint": {
      const name = str(args[0]) ?? str(kw.constraint_name);
      const t = batch ? tableArg(0, "table_name") : q(str(args[1]) ?? str(kw.table_name), kw.schema);
      return name && t ? [{ op: "dropConstraint", table: t, name, line }] : [];
    }
    case "create_unique_constraint": {
      const name = str(args[0]);
      const t = batch ? tableArg(0, "table_name") : q(str(args[1]) ?? str(kw.table_name), kw.schema);
      const cols = list(at(2) ?? kw.columns).map((x) => str(x) ?? "").filter(Boolean);
      return t ? [{ op: "createIndex", table: t, index: { ...(name ? { name } : {}), columns: cols, unique: true }, line }] : [];
    }
    case "create_primary_key": {
      const t = batch ? tableArg(0, "table_name") : q(str(args[1]) ?? str(kw.table_name), kw.schema);
      const cols = list(at(2) ?? kw.columns).map((x) => str(x) ?? "").filter(Boolean);
      return t ? [{ op: "addPk", table: t, columns: cols, line }] : [];
    }
    case "create_check_constraint": {
      const name = str(args[0]);
      const t = batch ? tableArg(0, "table_name") : q(str(args[1]) ?? str(kw.table_name), kw.schema);
      return t ? [{ op: "addCheck", table: t, check: { ...(name ? { name } : {}), expr: str(at(2)) ?? literalText(at(2)) ?? "check" }, line }] : [];
    }
    case "execute": {
      const a = args[0];
      const text = str(a) ?? (asCall(a) ? str(asCall(a)!.args[0]) : undefined);
      return text ? parseSql(text).map((op) => ({ ...op, line })) : [{ op: "opaque", text: "op.execute(…)", line }];
    }
    case "create_enum": {
      const v = args[0];
      if (v && "chain" in v) {
        const first = v.chain[0];
        const name = str(first.kw?.name);
        if (name) return [{ op: "createEnum", name, values: first.args.map((x) => str(x)).filter((x): x is string => x !== undefined), line }];
      }
      break;
    }
    case "batch_alter_table":
    case "get_bind":
    case "get_context":
    case "f":
      return [];
    default:
      break;
  }
  const t = batch ? batch.table : str(args[0]);
  return [{ op: "opaque", text: `op.${m}(${t ? `"${t}"` : "…"})`, line, ...(batch && t ? { table: t } : {}) }];
}

/** Alembic revision chains, one per versions folder. */
export function alembicMigrations(code: ReadonlyArray<{ file: string; facts: DbCodeFacts }>): MigrationSet[] {
  const revisions: Array<{ file: string; id: string; down: string[]; calls: UpgradeCall[]; line: number; hints: string[] }> = [];
  for (const { file, facts } of code) {
    const rev = facts.assigns?.find((a) => a.name === "revision");
    const id = str(rev?.value);
    if (!rev || !id || !facts.assigns?.some((a) => a.name === "down_revision")) continue;
    const downV = facts.assigns.find((a) => a.name === "down_revision")!.value;
    const down = "list" in downV ? list(downV).map((x) => str(x)).filter((x): x is string => Boolean(x)) : str(downV) ? [str(downV)!] : [];
    revisions.push({ file, id, down, calls: facts.upgrade ?? [], line: rev.line, hints: facts.hints ?? [] });
  }
  const byFolder = new Map<string, typeof revisions>();
  for (const r of revisions) (byFolder.get(dirOf(r.file)) ?? byFolder.set(dirOf(r.file), []).get(dirOf(r.file))!).push(r);
  const sets: MigrationSet[] = [];
  for (const [root, revs] of byFolder) {
    const problems: string[] = [];
    const ids = new Set(revs.map((r) => r.id));
    for (const r of revs) for (const d of r.down) if (!ids.has(d)) problems.push(`Revision ${r.id} (${r.file}) follows ${d}, which isn't in ${root}.`);
    const { order, cyclic } = topoSort(revs, (r) => r.id, (r) => r.down);
    if (cyclic.length) problems.push(`The revisions form a cycle (${cyclic.map((r) => r.id).join(", ")}) — not replayed.`);
    const parents = new Set(revs.flatMap((r) => r.down));
    const heads = revs.filter((r) => !parents.has(r.id));
    if (heads.length > 1) problems.push(`${heads.length} heads (${heads.map((h) => h.id).join(", ")}) — the branches need a merge revision; their relative order is unknown, replayed in dependency order.`);
    const roots = revs.filter((r) => r.down.length === 0);
    if (roots.length > 1) problems.push(`${roots.length} base revisions (${roots.map((r) => r.id).join(", ")}).`);
    const migrations: DbMigration[] = order.map((r, i) => ({
      ...migration(`${r.file}`, r.id, r.file, r.line, "alembic", r.calls.flatMap((c) => {
        try {
          return alembicOps(c);
        } catch {
          return [{ op: "opaque" as const, text: `op.${c.m}(…)`, line: c.line }];
        }
      })),
      order: i,
    }));
    const hint = revs.flatMap((r) => r.hints)[0] as MigrationSet["dialect"] | undefined;
    const sqlText = revs.flatMap((r) => r.calls.filter((c) => c.m === "execute").map((c) => str(c.args[0]) ?? ""));
    const usesPg = revs.some((r) => r.calls.some((c) => JSON.stringify(c.args).includes("postgresql.")));
    const guessed = usesPg ? "postgresql" : guessDialect(sqlText);
    sets.push({ tool: "alembic", root, family: "sqlalchemy", migrations, problems, ...(hint ? { dialect: hint } : guessed ? { dialect: guessed, dialectGuessed: true as const } : {}) });
  }
  return sets;
}
