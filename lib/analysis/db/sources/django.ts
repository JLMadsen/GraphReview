/**
 * Django (DESIGN.md §6.13 §1): `models.Model` classes as models (table
 * `<app>_<model>` unless `Meta.db_table`, a ForeignKey `x` is column `x_id`,
 * an implicit `id`), and `<app>/migrations/NNNN_*.py` replayed in the order
 * of their `dependencies` graph across apps. Operations become schema ops;
 * `RunSQL` is read as SQL; `RunPython` and anything unknown is opaque.
 */
import { parseSql } from "../sql";
import { asCall, baseOf, bool, column, dirOf, isNil, last, list, literalText, migration, nameOf, num, obj, str, topoSort, type DeclSet, type MigrationSet, type TableDecl } from "../common";
import { commonRoot } from "./drizzle";
import type { DbCheck, DbCodeFacts, DbColumn, DbFk, DbIndex, DbMigration, DbOp, DV } from "../types";

type ModelKey = string; // `<app>.<model lower>`

interface ModelInfo {
  table: string;
  pkType: string;
  /** Field name → column name. */
  columns: Map<string, string>;
  /** Field name → join table, for many-to-many fields. */
  m2m: Map<string, string>;
  /** `managed = False`: Django doesn't create or change its table. */
  unmanaged?: true;
}

/** The SQL-ish type of a Django field call. */
function fieldType(fn: string, kw: Record<string, DV>, args: DV[]): string {
  const maxLength = num(kw.max_length);
  switch (fn) {
    case "AutoField":
      return "integer";
    case "BigAutoField":
      return "bigint";
    case "SmallAutoField":
      return "smallint";
    case "CharField":
      return maxLength ? `varchar(${maxLength})` : "varchar";
    case "SlugField":
      return `varchar(${maxLength ?? 50})`;
    case "EmailField":
      return `varchar(${maxLength ?? 254})`;
    case "URLField":
      return `varchar(${maxLength ?? 200})`;
    case "FileField":
    case "ImageField":
    case "FilePathField":
      return `varchar(${maxLength ?? 100})`;
    case "TextField":
      return "text";
    case "IntegerField":
    case "PositiveIntegerField":
      return "integer";
    case "BigIntegerField":
    case "PositiveBigIntegerField":
      return "bigint";
    case "SmallIntegerField":
    case "PositiveSmallIntegerField":
      return "smallint";
    case "BooleanField":
    case "NullBooleanField":
      return "boolean";
    case "DateField":
      return "date";
    case "DateTimeField":
      return "timestamptz";
    case "TimeField":
      return "time";
    case "DurationField":
      return "interval";
    case "DecimalField": {
      const p = num(kw.max_digits);
      const s = num(kw.decimal_places);
      return p !== undefined ? `numeric(${p},${s ?? 0})` : "numeric";
    }
    case "FloatField":
      return "double precision";
    case "UUIDField":
      return "uuid";
    case "JSONField":
      return "jsonb";
    case "BinaryField":
      return "bytea";
    case "GenericIPAddressField":
    case "IPAddressField":
      return "inet";
    case "ArrayField": {
      const inner = asCall(kw.base_field ?? args[0]);
      return inner ? `${fieldType(last(inner.name), inner.kw, inner.args)}[]` : "array";
    }
    default:
      return fn.replace(/Field$/, "").toLowerCase() || "unknown";
  }
}

const RELATION_FIELDS = new Set(["ForeignKey", "OneToOneField", "ParentalKey"]);

/** `"app.Model"`, `"Model"`, `Model`, `settings.AUTH_USER_MODEL` → a model key. */
function targetKey(v: DV | undefined, app: string, self: string): ModelKey | undefined {
  const raw = nameOf(v);
  if (!raw) return undefined;
  if (/AUTH_USER_MODEL$/.test(raw)) return "auth.user";
  if (raw === "self") return `${app}.${self.toLowerCase()}`;
  const parts = raw.split(".");
  if (parts.length >= 2 && !/^[A-Z]/.test(parts[parts.length - 2])) return `${parts[parts.length - 2].toLowerCase()}.${parts[parts.length - 1].toLowerCase()}`;
  return `${app}.${parts[parts.length - 1].toLowerCase()}`;
}

const defaultTable = (key: ModelKey) => key.replace(".", "_");

interface FieldResult {
  column?: DbColumn;
  fk?: DbFk;
  index?: DbIndex;
  /** A many-to-many field: its join table. */
  m2m?: { table: string; columns: DbColumn[]; fks: DbFk[] };
}

/** One field → its column (and FK, index or join table). */
function readField(
  name: string,
  v: DV | undefined,
  app: string,
  model: string,
  modelTable: string,
  lookup: (key: ModelKey) => { table: string; pkType: string },
  source: "model" | "migration",
): FieldResult | null {
  const c = asCall(v);
  if (!c) return null;
  const fn = last(c.name);
  if (!/Field$|^ForeignKey$|^ParentalKey$|^ParentalManyToManyField$/.test(fn)) return null;
  const kw = c.kw;
  if (fn === "ManyToManyField" || fn === "ParentalManyToManyField") {
    if (kw.through) return {}; // the through model is a table of its own
    const target = targetKey(kw.to ?? c.args[0], app, model);
    if (!target) return {};
    const t = lookup(target);
    const table = str(kw.db_table) ?? `${modelTable}_${name}`;
    const fromCol = `${model.toLowerCase()}_id`;
    const toModel = target.split(".")[1];
    const toCol = toModel === model.toLowerCase() ? `to_${toModel}_id` : `${toModel}_id`;
    const self = lookup(`${app}.${model.toLowerCase()}`);
    return {
      m2m: {
        table,
        columns: [
          column("id", "bigint", false, source, { primary: true, generated: "identity" }),
          column(toModel === model.toLowerCase() ? `from_${toModel}_id` : fromCol, self.pkType, false, source),
          column(toCol, t.pkType, false, source),
        ],
        fks: [
          { columns: [toModel === model.toLowerCase() ? `from_${toModel}_id` : fromCol], refTable: modelTable, refColumns: ["id"] },
          { columns: [toCol], refTable: t.table, refColumns: ["id"] },
        ],
      },
    };
  }
  const nullable = bool(kw.null) ?? false;
  const extra: Partial<DbColumn> = {};
  if (bool(kw.primary_key)) extra.primary = true;
  if (bool(kw.unique) || fn === "OneToOneField") extra.unique = true;
  if (kw.default !== undefined && !isNil(kw.default)) extra.default = literalText(kw.default);
  if (kw.db_default !== undefined) extra.default = literalText(kw.db_default);
  if (/AutoField$/.test(fn)) extra.generated = "identity";
  if (RELATION_FIELDS.has(fn)) {
    const target = targetKey(kw.to ?? c.args[0], app, model);
    const t = target ? lookup(target) : { table: "?", pkType: "bigint" };
    const colName = str(kw.db_column) ?? `${name}_id`;
    const col = column(colName, t.pkType, nullable, source, extra);
    const onDelete = nameOf(kw.on_delete ?? c.args[1]);
    return {
      column: col,
      fk: { columns: [colName], refTable: t.table, refColumns: [str(kw.to_field) ?? "id"], ...(onDelete ? { onDelete: last(onDelete).replace(/_/g, " ") } : {}), ...(source === "model" ? { inferred: true as const } : {}) },
      ...(bool(kw.db_index) === false || extra.unique ? {} : { index: { columns: [colName] } }),
    };
  }
  const colName = str(kw.db_column) ?? name;
  const col = column(colName, fieldType(fn, kw, c.args), nullable, source, extra);
  if (col.primary) col.nullable = false;
  return { column: col, ...(bool(kw.db_index) ? { index: { columns: [colName] } } : {}) };
}

const appOfModelFile = (file: string) => {
  const dir = dirOf(file);
  return baseOf(file) === "models.py" ? baseOf(dir) : baseOf(dir) === "models" ? baseOf(dirOf(dir)) : baseOf(dir);
};

type PyClass = NonNullable<DbCodeFacts["classes"]>[number];

const isMigrationClass = (cls: PyClass) => cls.name === "Migration" && cls.bases.some((b) => /(^|\.)Migration$/.test(b));

/** Django models and migrations. */
export function resolveDjango(code: ReadonlyArray<{ file: string; facts: DbCodeFacts }>): { migrations: MigrationSet[]; decls: DeclSet[] } {
  // --- Migrations ---------------------------------------------------------
  const found: Array<{ file: string; app: string; name: string; cls: PyClass }> = [];
  for (const { file, facts } of code) {
    if (!/\/migrations\/[^/]+\.py$/.test(`/${file}`) || baseOf(file) === "__init__.py") continue;
    const cls = facts.classes?.find(isMigrationClass);
    if (!cls) continue;
    found.push({ file, app: baseOf(dirOf(dirOf(file))), name: baseOf(file).replace(/\.py$/, ""), cls });
  }
  // --- Models -------------------------------------------------------------
  const classes = code.flatMap(({ file, facts }) => (facts.classes ?? []).filter((c) => !isMigrationClass(c)).map((cls) => ({ file, cls })));
  const byName = new Map<string, { file: string; cls: PyClass }>();
  for (const c of classes) if (!byName.has(c.cls.name)) byName.set(c.cls.name, c);
  const isDjangoModel = (cls: PyClass, depth = 0): boolean =>
    depth < 6 && cls.bases.some((b) => /(^|\.)models\.Model$|^(AbstractUser|AbstractBaseUser|TimeStampedModel)$/.test(b) || (byName.has(last(b)) && byName.get(last(b))!.cls !== cls && isDjangoModel(byName.get(last(b))!.cls, depth + 1)));
  const models = classes.filter((c) => isDjangoModel(c.cls) && c.cls.attrs.some((a) => asCall(a.value) && /Field$|^ForeignKey$/.test(last(asCall(a.value)!.name))) || (isDjangoModel(c.cls) && c.cls.meta));
  if (found.length === 0 && models.length === 0) return { migrations: [], decls: [] };

  const state = new Map<ModelKey, ModelInfo>();
  const lookup = (key: ModelKey) => {
    const m = state.get(key);
    return m ? { table: m.table, pkType: m.pkType } : { table: defaultTable(key), pkType: key === "auth.user" ? "integer" : "bigint" };
  };

  // Model tables (rank 3). Their names go in the lookup first, so FKs point at `db_table`s.
  const declTables: TableDecl[] = [];
  const modelEntries = models.map(({ file, cls }) => {
    const app = appOfModelFile(file);
    const abstract = bool(cls.meta?.abstract) ?? false;
    const proxy = bool(cls.meta?.proxy) ?? false;
    const table = str(cls.meta?.db_table) ?? `${app}_${cls.name.toLowerCase()}`;
    return { file, cls, app, abstract, proxy, table };
  });
  for (const m of modelEntries) if (!m.abstract && !m.proxy) state.set(`${m.app}.${m.cls.name.toLowerCase()}`, { table: m.table, pkType: "bigint", columns: new Map(), m2m: new Map() });
  for (const m of modelEntries) {
    if (m.abstract || m.proxy) continue;
    const decl: TableDecl = { name: m.table, columns: [], pk: [], fks: [], indexes: [], checks: [], file: m.file, line: m.cls.line, model: { tool: "django", name: m.cls.name, file: m.file, line: m.cls.line, decl: `${m.file}#${m.cls.name}` }, fields: [], relations: [], ...(bool(m.cls.meta?.managed) === false ? { unmanaged: true as const } : {}) };
    // Fields of abstract bases first, then the class's own.
    const attrs: PyClass["attrs"] = [];
    const visit = (cls: PyClass, depth: number) => {
      for (const b of cls.bases) {
        const base = byName.get(last(b));
        if (base && depth < 5 && base.cls !== cls && bool(base.cls.meta?.abstract)) visit(base.cls, depth + 1);
      }
      attrs.push(...cls.attrs);
    };
    visit(m.cls, 0);
    for (const b of m.cls.bases) {
      const base = byName.get(last(b));
      if (base && !bool(base.cls.meta?.abstract) && isDjangoModel(base.cls)) {
        const parentKey = `${appOfModelFile(base.file)}.${base.cls.name.toLowerCase()}`;
        const ptr = `${base.cls.name.toLowerCase()}_ptr_id`;
        decl.columns.push(column(ptr, "bigint", false, "model", { primary: true }));
        decl.pk = [ptr];
        decl.fks.push({ columns: [ptr], refTable: lookup(parentKey).table, refColumns: ["id"], inferred: true });
      }
    }
    for (const a of attrs) {
      const r = readField(a.name, a.value, m.app, m.cls.name, m.table, lookup, "model");
      if (!r) continue;
      if (r.m2m) {
        decl.relations!.push(a.name);
        declTables.push({ name: r.m2m.table, columns: r.m2m.columns, pk: ["id"], fks: r.m2m.fks.map((f) => ({ ...f, inferred: true })), indexes: [], checks: [], file: m.file, line: a.line });
        continue;
      }
      if (!r.column) {
        decl.relations!.push(a.name);
        continue;
      }
      if (decl.columns.some((c) => c.name === r.column!.name)) continue;
      decl.columns.push(r.column);
      decl.fields!.push({ field: a.name, column: r.column.name, line: a.line });
      if (r.column.primary) decl.pk = [r.column.name];
      if (r.fk) decl.fks.push(r.fk);
      if (r.index) decl.indexes.push(r.index);
    }
    if (decl.pk.length === 0) {
      decl.columns.unshift(column("id", "bigint", false, "model", { primary: true, generated: "identity" }));
      decl.fields!.unshift({ field: "id", column: "id" });
      decl.pk = ["id"];
    }
    for (const idx of list(m.cls.meta?.indexes)) {
      const c = asCall(idx);
      if (!c) continue;
      const fields = list(c.kw.fields).map((v) => str(v)?.replace(/^-/, "")).filter((v): v is string => Boolean(v));
      decl.indexes.push({ ...(str(c.kw.name) ? { name: str(c.kw.name)! } : {}), columns: fields.map((f) => decl.fields!.find((x) => x.field === f)?.column ?? f) });
    }
    for (const cons of list(m.cls.meta?.constraints)) {
      const c = asCall(cons);
      if (!c) continue;
      if (last(c.name) === "UniqueConstraint") {
        const fields = list(c.kw.fields).map((v) => str(v)).filter((v): v is string => Boolean(v));
        decl.indexes.push({ ...(str(c.kw.name) ? { name: str(c.kw.name)! } : {}), columns: fields.map((f) => decl.fields!.find((x) => x.field === f)?.column ?? f), unique: true });
      }
    }
    const pk = decl.columns.find((c) => c.primary);
    const info = state.get(`${m.app}.${m.cls.name.toLowerCase()}`)!;
    if (pk) info.pkType = pk.type;
    declTables.push(decl);
  }
  const decls: DeclSet[] = declTables.length
    ? [{ tool: "django", kind: "model", root: commonRoot(declTables.map((t) => t.file)), files: [...new Set(declTables.map((t) => t.file))], tables: declTables, enums: [] }]
    : [];

  if (found.length === 0) return { migrations: [], decls };

  // --- Order: the dependency graph across apps -----------------------------
  const problems: string[] = [];
  const keyOf = (m: { app: string; name: string }) => `${m.app}.${m.name}`;
  const byKey = new Map(found.map((m) => [keyOf(m), m]));
  // A squashed migration stands in for the ones it replaces.
  const replacedBy = new Map<string, string>();
  for (const m of found) {
    for (const r of list(m.cls.attrs.find((a) => a.name === "replaces")?.value)) {
      const pair = list(r).map((v) => str(v));
      if (pair[0] && pair[1]) replacedBy.set(`${pair[0]}.${pair[1]}`, keyOf(m));
    }
  }
  const active = found.filter((m) => !replacedBy.has(keyOf(m)) || !byKey.has(replacedBy.get(keyOf(m))!));
  const firstOf = (app: string) => active.filter((m) => m.app === app).map((m) => m.name).sort()[0];
  const lastOf = (app: string) => active.filter((m) => m.app === app).map((m) => m.name).sort().pop();
  const deps = (m: (typeof found)[number]) =>
    list(m.cls.attrs.find((a) => a.name === "dependencies")?.value).flatMap((d) => {
      const pair = list(d).map((v) => str(v));
      if (!pair[0] || !pair[1]) return [];
      const name = pair[1] === "__first__" ? firstOf(pair[0]) : pair[1] === "__latest__" ? lastOf(pair[0]) : pair[1];
      if (!name) return [];
      const key = `${pair[0]}.${name}`;
      return [replacedBy.get(key) ?? key];
    });
  const { order, cyclic } = topoSort(active, keyOf, deps);
  if (cyclic.length) problems.push(`The migration dependencies form a cycle (${cyclic.map(keyOf).slice(0, 4).join(", ")}${cyclic.length > 4 ? ", …" : ""}) — those aren't replayed.`);
  // Two leaf migrations in one app: `makemigrations --merge` hasn't been run.
  const dependedOn = new Set(active.flatMap(deps));
  for (const app of new Set(active.map((m) => m.app))) {
    const leaves = active.filter((m) => m.app === app && !dependedOn.has(keyOf(m)));
    if (leaves.length > 1) problems.push(`App ${app} has ${leaves.length} leaf migrations (${leaves.map((l) => l.name).join(", ")}) — they need a merge migration; replayed in dependency order.`);
  }

  // --- Replay into ops, with the model → table map kept up to date ---------
  state.clear();
  const migrations: DbMigration[] = order.map((m, i) => {
    const ops: DbOp[] = [];
    const operations = m.cls.attrs.find((a) => a.name === "operations");
    const at = operations?.line ?? m.cls.line;
    for (const operation of list(operations?.value)) {
      try {
        ops.push(...operationOps(operation, m.app, state, lookup).map((o) => ({ ...o, line: at })));
      } catch {
        ops.push({ op: "opaque", text: `migrations.${asCall(operation)?.name ?? "?"}`, line: at });
      }
    }
    return { ...migration(m.file, `${m.app}.${m.name}`, m.file, m.cls.line, "django", ops), order: i };
  });
  const root = commonRoot(found.map((m) => m.file));
  return { migrations: [{ tool: "django", root, family: "django", migrations, problems }], decls };
}

/** One Django migration operation → ops. */
function operationOps(v: DV, app: string, state: Map<ModelKey, ModelInfo>, lookup: (key: ModelKey) => { table: string; pkType: string }): DbOp[] {
  const c = asCall(v);
  if (!c) return [];
  const name = last(c.name);
  const kw = c.kw;
  const arg = (i: number, key: string) => kw[key] ?? c.args[i];
  const line = 0;
  const modelKey = (m: string | undefined) => (m ? `${app}.${m.toLowerCase()}` : "");
  const info = (m: string | undefined) => state.get(modelKey(m));
  const table = (m: string | undefined) => info(m)?.table ?? defaultTable(modelKey(m));
  const opaque = (text: string, t?: string): DbOp => ({ op: "opaque", text, line, ...(t ? { table: t } : {}) });
  // Operations on an unmanaged model change Django's state only, never the database.
  const subject = str(arg(0, name === "CreateModel" || name === "DeleteModel" || name === "AlterModelTable" || /Together$/.test(name) ? "name" : name === "RenameModel" ? "old_name" : "model_name"));
  if (name !== "CreateModel" && info(subject)?.unmanaged) {
    if (name === "DeleteModel") state.delete(modelKey(subject));
    return [];
  }
  switch (name) {
    case "CreateModel": {
      const model = str(arg(0, "name"));
      if (!model) break;
      const options = obj(arg(2, "options"));
      if (bool(options.proxy) || bool(options.abstract)) return [];
      if (bool(options.managed) === false) {
        state.set(modelKey(model), { table: str(options.db_table) ?? defaultTable(modelKey(model)), pkType: "bigint", columns: new Map(), m2m: new Map(), unmanaged: true });
        return [];
      }
      const t = str(options.db_table) ?? defaultTable(modelKey(model));
      const m: ModelInfo = { table: t, pkType: "bigint", columns: new Map(), m2m: new Map() };
      state.set(modelKey(model), m);
      const columns: DbColumn[] = [];
      const fks: DbFk[] = [];
      const indexes: DbIndex[] = [];
      const extra: DbOp[] = [];
      for (const f of list(arg(1, "fields"))) {
        const pair = list(f);
        const fname = str(pair[0]);
        if (!fname) continue;
        const r = readField(fname, pair[1], app, model, t, lookup, "migration");
        if (!r) continue;
        if (r.m2m) {
          m.m2m.set(fname, r.m2m.table);
          extra.push({ op: "createTable", table: r.m2m.table, columns: r.m2m.columns, pk: ["id"], fks: r.m2m.fks, indexes: [], checks: [], line });
          continue;
        }
        if (!r.column) continue;
        columns.push(r.column);
        m.columns.set(fname, r.column.name);
        if (r.column.primary) m.pkType = r.column.type;
        if (r.fk) fks.push(r.fk);
        if (r.index) indexes.push(r.index);
      }
      for (const u of list(options.unique_together)) {
        const cols = (list(u).length && "list" in list(u)[0] ? list(list(u)[0]) : list(u)).map((x) => str(x)).filter((x): x is string => Boolean(x));
        if (cols.length) indexes.push({ columns: cols.map((x) => m.columns.get(x) ?? x), unique: true });
      }
      for (const idx of list(options.indexes)) {
        const ic = asCall(idx);
        if (ic) indexes.push({ ...(str(ic.kw.name) ? { name: str(ic.kw.name)! } : {}), columns: list(ic.kw.fields).map((x) => str(x)?.replace(/^-/, "") ?? "").filter(Boolean).map((x) => m.columns.get(x) ?? x) });
      }
      const checks: DbCheck[] = [];
      for (const cons of list(options.constraints)) {
        const cc = asCall(cons);
        if (!cc) continue;
        if (last(cc.name) === "UniqueConstraint") indexes.push({ ...(str(cc.kw.name) ? { name: str(cc.kw.name)! } : {}), columns: list(cc.kw.fields).map((x) => str(x) ?? "").filter(Boolean).map((x) => m.columns.get(x) ?? x), unique: true });
        else if (last(cc.name) === "CheckConstraint") checks.push({ ...(str(cc.kw.name) ? { name: str(cc.kw.name)! } : {}), expr: literalText(cc.kw.check ?? cc.kw.condition) ?? "check" });
      }
      return [{ op: "createTable", table: t, columns, pk: columns.filter((x) => x.primary).map((x) => x.name), fks, indexes, checks, line }, ...extra];
    }
    case "DeleteModel": {
      const model = str(arg(0, "name"));
      const t = table(model);
      const m = info(model);
      state.delete(modelKey(model));
      return [{ op: "dropTable", table: t, line }, ...[...(m?.m2m.values() ?? [])].map((j) => ({ op: "dropTable" as const, table: j, line }))];
    }
    case "RenameModel": {
      const from = str(arg(0, "old_name"));
      const to = str(arg(1, "new_name"));
      if (!from || !to) break;
      const m = info(from);
      const old = table(from);
      state.delete(modelKey(from));
      const defaultName = old === defaultTable(modelKey(from));
      const next = defaultName ? defaultTable(modelKey(to)) : old;
      state.set(modelKey(to), { table: next, pkType: m?.pkType ?? "bigint", columns: m?.columns ?? new Map(), m2m: m?.m2m ?? new Map() });
      return defaultName ? [{ op: "renameTable", table: old, to: next, line }] : [];
    }
    case "AlterModelTable": {
      const model = str(arg(0, "name"));
      const to = str(arg(1, "table"));
      const m = info(model);
      if (!model || !to) break;
      const old = table(model);
      if (m) m.table = to;
      return old !== to ? [{ op: "renameTable", table: old, to, line }] : [];
    }
    case "AddField":
    case "AlterField": {
      const model = str(arg(0, "model_name"));
      const fname = str(arg(1, "name"));
      if (!model || !fname) break;
      const t = table(model);
      const m = info(model);
      const r = readField(fname, arg(2, "field"), app, model, t, lookup, "migration");
      if (!r) return [opaque(`${name} ${model}.${fname}`, t)];
      if (r.m2m) {
        if (name === "AlterField") return [];
        m?.m2m.set(fname, r.m2m.table);
        return [{ op: "createTable", table: r.m2m.table, columns: r.m2m.columns, pk: ["id"], fks: r.m2m.fks, indexes: [], checks: [], line }];
      }
      if (!r.column) return [];
      m?.columns.set(fname, r.column.name);
      // `preserve_default=False`: the default only fills existing rows, then goes.
      if (name === "AddField") {
        const ops: DbOp[] = [{ op: "addColumn", table: t, column: r.column, ...(r.fk ? { fk: r.fk } : {}), line }];
        if (bool(kw.preserve_default) === false && r.column.default !== undefined) ops.push({ op: "alterColumn", table: t, column: r.column.name, default: null, line });
        if (r.index) ops.push({ op: "createIndex", table: t, index: r.index, line });
        return ops;
      }
      return [{ op: "alterColumn", table: t, column: r.column.name, type: r.column.type, nullable: r.column.nullable, ...(r.column.default !== undefined ? { default: r.column.default } : {}), line }];
    }
    case "RemoveField": {
      const model = str(arg(0, "model_name"));
      const fname = str(arg(1, "name"));
      if (!model || !fname) break;
      const m = info(model);
      const join = m?.m2m.get(fname);
      if (join) {
        m!.m2m.delete(fname);
        return [{ op: "dropTable", table: join, line }];
      }
      const col = m?.columns.get(fname) ?? fname;
      m?.columns.delete(fname);
      return [{ op: "dropColumn", table: table(model), column: col, line }];
    }
    case "RenameField": {
      const model = str(arg(0, "model_name"));
      const from = str(arg(1, "old_name"));
      const to = str(arg(2, "new_name"));
      if (!model || !from || !to) break;
      const m = info(model);
      const oldCol = m?.columns.get(from) ?? from;
      // A FK column `x_id` renames to `y_id`; an explicit db_column doesn't change.
      const newCol = oldCol === from ? to : oldCol === `${from}_id` ? `${to}_id` : oldCol;
      m?.columns.delete(from);
      m?.columns.set(to, newCol);
      return newCol !== oldCol ? [{ op: "renameColumn", table: table(model), column: oldCol, to: newCol, line }] : [];
    }
    case "AddIndex":
    case "AddIndexConcurrently": {
      const model = str(arg(0, "model_name"));
      const ic = asCall(arg(1, "index"));
      if (!model || !ic) break;
      const m = info(model);
      const cols = list(ic.kw.fields).map((x) => str(x)?.replace(/^-/, "") ?? "").filter(Boolean).map((x) => m?.columns.get(x) ?? x);
      return [{ op: "createIndex", table: table(model), index: { ...(str(ic.kw.name) ? { name: str(ic.kw.name)! } : {}), columns: cols, ...(last(ic.name) === "UniqueIndex" ? { unique: true as const } : {}) }, ...(name === "AddIndexConcurrently" ? { concurrently: true as const } : {}), line }];
    }
    case "RemoveIndex":
    case "RemoveIndexConcurrently": {
      const idx = str(arg(1, "name"));
      return idx ? [{ op: "dropIndex", name: idx, table: table(str(arg(0, "model_name"))), line }] : [];
    }
    case "AddConstraint": {
      const model = str(arg(0, "model_name"));
      const cc = asCall(arg(1, "constraint"));
      if (!model || !cc) break;
      const m = info(model);
      if (last(cc.name) === "UniqueConstraint") {
        return [{ op: "createIndex", table: table(model), index: { ...(str(cc.kw.name) ? { name: str(cc.kw.name)! } : {}), columns: list(cc.kw.fields).map((x) => str(x) ?? "").filter(Boolean).map((x) => m?.columns.get(x) ?? x), unique: true }, line }];
      }
      if (last(cc.name) === "CheckConstraint") return [{ op: "addCheck", table: table(model), check: { ...(str(cc.kw.name) ? { name: str(cc.kw.name)! } : {}), expr: literalText(cc.kw.check ?? cc.kw.condition) ?? "check" }, line }];
      return [opaque(`AddConstraint ${model}`, table(model))];
    }
    case "RemoveConstraint": {
      const cons = str(arg(1, "name"));
      return cons ? [{ op: "dropConstraint", table: table(str(arg(0, "model_name"))), name: cons, line }] : [];
    }
    case "AlterUniqueTogether":
    case "AlterIndexTogether": {
      const model = str(arg(0, "name"));
      if (!model) break;
      const m = info(model);
      const value = arg(1, name === "AlterUniqueTogether" ? "unique_together" : "index_together");
      const groups = list(value).length && list(value).every((x) => "list" in x) ? list(value) : [value];
      return groups
        .map((g) => list(g).map((x) => str(x) ?? "").filter(Boolean).map((x) => m?.columns.get(x) ?? x))
        .filter((cols) => cols.length)
        .map((cols) => ({ op: "createIndex" as const, table: table(model), index: { name: `${table(model)}_${cols.join("_")}_${name === "AlterUniqueTogether" ? "uniq" : "idx"}`, columns: cols, ...(name === "AlterUniqueTogether" ? { unique: true as const } : {}) }, line }));
    }
    case "RunSQL": {
      const sql = arg(0, "sql");
      const texts = "list" in (sql ?? { x: "" }) ? list(sql).map((x) => str(x) ?? str(list(x)[0]) ?? "") : [str(sql) ?? ""];
      return texts.filter(Boolean).flatMap((t) => parseSql(t).map((op) => ({ ...op, line })));
    }
    case "SeparateDatabaseAndState":
      return list(kw.database_operations).flatMap((o) => operationOps(o, app, state, lookup));
    case "RunPython":
      return [opaque(`RunPython(${nameOf(c.args[0]) ?? "…"})`)];
    case "AlterModelOptions":
    case "AlterModelManagers":
    case "AlterOrderWithRespectTo":
      return [];
    default:
      break;
  }
  return [opaque(`${name}(${str(c.args[0]) ?? str(kw.name) ?? str(kw.model_name) ?? ""})`)];
}
