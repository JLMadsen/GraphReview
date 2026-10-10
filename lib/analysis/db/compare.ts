/**
 * What a change does to the schema (DESIGN.md §6.13 §5): the base's catalog
 * (the merge-base) against the head's — tables added, removed, renamed (an
 * explicit RENAME, or a removed and an added table with matching columns),
 * columns added / dropped / retyped / renamed, nullability and defaults,
 * indexes, FKs, checks and enums; the migrations the PR adds; the drift it
 * introduces. And the certain findings, only from the migrations the PR adds:
 *
 *   drop-table / drop-column   data loss
 *   not-null-no-default        a NOT NULL column without a default on a table that has rows
 *   type-narrowing             `text → varchar(50)`, `bigint → integer`, less precision
 *   rename-column / -table     breaks the old code during a rolling deploy
 *   index-not-concurrent       Postgres CREATE INDEX on an existing table, without CONCURRENTLY
 *   fk-no-index                Postgres FK whose columns no index covers
 *
 * A missing down migration is not a finding (Prisma and Django have none).
 */
import { opTable, splitName, tableKey } from "./replay";
import { normalizeType, typeNarrowing } from "./sql";
import {
  DESTRUCTIVE_RULES,
  type Database,
  type DbChange,
  type DbCheck,
  type DbColumn,
  type DbColumnDelta,
  type DbDriftDelta,
  type DbEnumChange,
  type DbFinding,
  type DbFindingRule,
  type DbFk,
  type DbIndex,
  type DbMigration,
  type DbSchema,
  type DbTable,
  type DbTableChange,
} from "./types";

const lc = (s: string) => s.toLowerCase();
const indexSig = (i: DbIndex) => `${i.unique ? "u" : ""}(${i.columns.map(lc).join(",")})${i.where ? ` where ${i.where}` : ""}`;
const fkSig = (f: DbFk) => `(${f.columns.map(lc).join(",")})→${lc(f.refTable)}(${f.refColumns.map(lc).join(",")})`;
const checkSig = (c: DbCheck) => `${c.name ?? ""}|${c.expr}`;

function diffList<T>(before: readonly T[], after: readonly T[], sig: (x: T) => string): { added: T[]; removed: T[] } {
  const b = new Set(before.map(sig));
  const a = new Set(after.map(sig));
  return { added: after.filter((x) => !b.has(sig(x))), removed: before.filter((x) => !a.has(sig(x))) };
}

function columnAspects(b: DbColumn, a: DbColumn): NonNullable<DbColumnDelta["aspects"]> {
  const aspects: NonNullable<DbColumnDelta["aspects"]> = [];
  if (normalizeType(b.type) !== normalizeType(a.type) && b.type && a.type) aspects.push("type");
  if (b.nullable !== a.nullable) aspects.push("nullable");
  if ((b.default ?? "").trim() !== (a.default ?? "").trim()) aspects.push("default");
  if (Boolean(b.unique) !== Boolean(a.unique)) aspects.push("unique");
  if (Boolean(b.primary) !== Boolean(a.primary)) aspects.push("primary");
  return aspects;
}

/**
 * The columns a table's own source defines. A column only a lower source
 * has (a model field the migrations never created) is drift, shown as such —
 * not a column the change added or kept.
 */
const ownColumns = (t: DbTable) => t.columns.filter((c) => c.source === t.source);

function compareTables(before: DbTable, after: DbTable, columnRenames: Map<string, string>): Omit<DbTableChange, "id" | "status" | "table" | "migrations"> {
  const columns: DbColumnDelta[] = [];
  const beforeCols = new Map(ownColumns(before).map((c) => [lc(c.name), c]));
  const matched = new Set<string>();
  for (const a of ownColumns(after)) {
    // A column renamed by the PR's migrations is the same column under its new name.
    const from = [...columnRenames].find(([, to]) => lc(to) === lc(a.name))?.[0];
    const b = beforeCols.get(lc(a.name)) ?? (from ? beforeCols.get(lc(from)) : undefined);
    if (!b) {
      columns.push({ name: a.name, status: "added", after: a });
      continue;
    }
    matched.add(lc(b.name));
    const aspects = columnAspects(b, a);
    if (lc(b.name) !== lc(a.name)) columns.push({ name: a.name, status: "renamed", from: b.name, before: b, after: a, ...(aspects.length ? { aspects } : {}) });
    else if (aspects.length) columns.push({ name: a.name, status: "changed", before: b, after: a, aspects });
  }
  for (const b of ownColumns(before)) if (!matched.has(lc(b.name))) columns.push({ name: b.name, status: "removed", before: b });
  return {
    columns,
    indexes: diffList(before.indexes, after.indexes, indexSig),
    fks: diffList(before.fks, after.fks, fkSig),
    checks: diffList(before.checks, after.checks, checkSig),
  };
}

const hasDeltas = (c: Pick<DbTableChange, "columns" | "indexes" | "fks" | "checks">) =>
  c.columns.length > 0 || c.indexes.added.length + c.indexes.removed.length + c.fks.added.length + c.fks.removed.length + c.checks.added.length + c.checks.removed.length > 0;

/** Explicit renames in the PR's migrations: table id → new table id, and per new table id its column renames (old → new). */
function explicitRenames(db: Database, migrations: readonly DbMigration[]): { tables: Map<string, string>; columns: Map<string, Map<string, string>> } {
  const tables = new Map<string, string>();
  const columns = new Map<string, Map<string, string>>();
  const idOf = (name: string) => `${db.id}:${tableKey(name)}`;
  const current = (id: string) => {
    for (const [from, to] of tables) if (to === id) return from;
    return id;
  };
  for (const m of migrations) {
    const created = new Set<string>();
    for (const op of m.ops) {
      if (op.op === "createTable") created.add(idOf(op.table));
      if (op.op === "renameTable") {
        const from = idOf(op.table);
        // A SQLite rebuild (`new_X` renamed to `X`) isn't a rename.
        if (created.has(from)) continue;
        const original = current(from);
        tables.delete(original);
        tables.set(original, idOf(op.to));
        const cols = columns.get(from);
        if (cols) {
          columns.delete(from);
          columns.set(idOf(op.to), cols);
        }
      }
      if (op.op === "renameColumn") {
        const t = idOf(op.table);
        const cols = columns.get(t) ?? columns.set(t, new Map()).get(t)!;
        const original = [...cols].find(([, to]) => lc(to) === lc(op.column))?.[0] ?? op.column;
        cols.set(original, op.to);
      }
    }
  }
  return { tables, columns };
}

/** The certain findings of the PR's migrations, against the base schema. */
function findingsFor(db: Database, baseDb: Database | undefined, migrations: readonly DbMigration[], head: Database): DbFinding[] {
  const out: DbFinding[] = [];
  const pg = head.dialect === "postgresql";
  // What exists before the PR: base tables with their columns (types kept, so a later ALTER compares to the right one).
  const existing = new Map<string, Map<string, DbColumn>>();
  for (const t of baseDb?.tables ?? []) existing.set(tableKey(t.schema ? `${t.schema}.${t.name}` : t.name), new Map(t.columns.map((c) => [lc(c.name), { ...c }])));
  const created = new Set<string>();
  const add = (rule: DbFindingRule, tableName: string, m: DbMigration, line: number, summary: string, rationale: string, column?: string) => {
    const table = `${db.id}:${tableKey(tableName)}`;
    const key = `${rule}|${table}|${column ?? ""}|${m.id}`;
    if (out.some((f) => f.key === key)) return;
    out.push({ key, rule, table, ...(column ? { column } : {}), migration: m.id, file: m.file, line, summary, rationale });
  };
  const nm = (name: string) => splitName(name).name;
  const addedFks: Array<{ table: string; fk: DbFk; m: DbMigration; line: number }> = [];
  for (const m of migrations) {
    // SQLite-style rebuilds: `CREATE TABLE new_X …; DROP TABLE X; ALTER TABLE new_X RENAME TO X`.
    const renamedTo = new Map<string, string>();
    for (const op of m.ops) if (op.op === "renameTable") renamedTo.set(tableKey(op.to), tableKey(op.table));
    const createdHere = new Map<string, DbColumn[]>();
    for (const op of m.ops) {
      const key = opTable(op) ? tableKey(opTable(op)!) : "";
      const isExisting = existing.has(key) && !created.has(key);
      switch (op.op) {
        case "createTable":
          created.add(key);
          createdHere.set(key, op.columns);
          for (const fk of op.fks) addedFks.push({ table: op.table, fk, m, line: op.line });
          break;
        case "dropTable": {
          if (!isExisting || op.view) break;
          const rebuiltFrom = renamedTo.get(key);
          const rebuilt = rebuiltFrom ? createdHere.get(rebuiltFrom) : undefined;
          if (rebuilt) {
            const before = existing.get(key)!;
            const after = new Set(rebuilt.map((c) => lc(c.name)));
            for (const c of before.values()) if (!after.has(lc(c.name))) add("drop-column", op.table, m, op.line, `Drops column ${nm(op.table)}.${c.name}`, `${m.name} rebuilds ${nm(op.table)} without ${c.name}: the data in that column is lost.`, c.name);
            for (const c of rebuilt) {
              if (!before.has(lc(c.name)) && !c.nullable && c.default === undefined && !c.generated && !c.primary) {
                add("not-null-no-default", op.table, m, op.line, `Adds NOT NULL column ${nm(op.table)}.${c.name} without a default`, `${m.name} rebuilds ${nm(op.table)} with a new NOT NULL column ${c.name} and no default: copying the existing rows fails unless the copy fills it.`, c.name);
              }
            }
            break;
          }
          add("drop-table", op.table, m, op.line, `Drops table ${nm(op.table)}`, `${m.name} drops ${nm(op.table)}, which exists before this change: its data is lost, and rolling the code back doesn't bring it back.`);
          existing.delete(key);
          break;
        }
        case "renameTable": {
          const toKey = tableKey(op.to);
          if (created.has(key)) {
            // The rebuilt copy takes the old name.
            created.delete(key);
            if (existing.has(toKey)) existing.set(toKey, new Map((createdHere.get(key) ?? []).map((c) => [lc(c.name), c])));
            break;
          }
          if (isExisting) {
            add("rename-table", op.table, m, op.line, `Renames table ${nm(op.table)} to ${nm(op.to)}`, `During a rolling deploy the old code still uses ${nm(op.table)} until it is replaced, and fails once ${m.name} has run. Consider a view under the old name, or a separate rename after the deploy.`);
            existing.set(toKey, existing.get(key)!);
            existing.delete(key);
          }
          break;
        }
        case "addColumn": {
          if (op.fk) addedFks.push({ table: op.table, fk: op.fk, m, line: op.line });
          if (!isExisting) break;
          const c = op.column;
          if (!c.nullable && c.default === undefined && !c.generated) {
            add("not-null-no-default", op.table, m, op.line, `Adds NOT NULL column ${nm(op.table)}.${c.name} without a default`, `${nm(op.table)} exists before this change, so it may have rows: adding ${c.name} NOT NULL with no default fails on a non-empty table (or needs a backfill first), and old code that inserts rows without it breaks.`, c.name);
          }
          existing.get(key)!.set(lc(c.name), { ...c });
          break;
        }
        case "dropColumn": {
          if (isExisting && existing.get(key)!.has(lc(op.column))) {
            add("drop-column", op.table, m, op.line, `Drops column ${nm(op.table)}.${op.column}`, `${m.name} drops ${op.column} from ${nm(op.table)}: the data in it is lost, and code still reading it fails.`, op.column);
            existing.get(key)!.delete(lc(op.column));
          }
          break;
        }
        case "alterColumn": {
          const col = isExisting ? existing.get(key)!.get(lc(op.column)) : undefined;
          if (!col) break;
          if (op.type) {
            const why = typeNarrowing(col.type, op.type);
            if (why) add("type-narrowing", op.table, m, op.line, `Narrows ${nm(op.table)}.${op.column}: ${normalizeType(col.type)} → ${normalizeType(op.type)}`, `${why}: existing values that don't fit make ${m.name} fail, or are cut.`, op.column);
            col.type = op.type;
          }
          if (op.nullable === false && col.nullable && (op.default ?? col.default) == null) {
            add("not-null-no-default", op.table, m, op.line, `Makes ${nm(op.table)}.${op.column} NOT NULL without a default`, `Existing rows with no value make ${m.name} fail unless they are backfilled first, and code that writes it as null breaks.`, op.column);
          }
          if (op.nullable !== undefined) col.nullable = op.nullable;
          if (op.default === null) delete col.default;
          else if (op.default !== undefined) col.default = op.default;
          break;
        }
        case "renameColumn": {
          const cols = isExisting ? existing.get(key)! : undefined;
          const col = cols?.get(lc(op.column));
          if (cols && col) {
            add("rename-column", op.table, m, op.line, `Renames column ${nm(op.table)}.${op.column} to ${op.to}`, `During a rolling deploy the old code still reads and writes ${op.column} until it is replaced, and fails once ${m.name} has run. Consider adding the new column, copying, and dropping the old one in a later release.`, op.column);
            cols.delete(lc(op.column));
            cols.set(lc(op.to), { ...col, name: op.to });
          }
          break;
        }
        case "createIndex":
          if (pg && isExisting && !op.concurrently) {
            add("index-not-concurrent", op.table, m, op.line, `Creates index ${op.index.name ?? `on (${op.index.columns.join(", ")})`} on ${nm(op.table)} without CONCURRENTLY`, `On Postgres, CREATE INDEX without CONCURRENTLY blocks writes to ${nm(op.table)} until the index is built — long on a big table.`, op.index.columns.join(","));
          }
          break;
        case "addFk":
          addedFks.push({ table: op.table, fk: op.fk, m, line: op.line });
          break;
        default:
          break;
      }
    }
  }
  if (pg) {
    for (const { table, fk, m, line } of addedFks) {
      const t = head.tables.find((x) => x.id === `${db.id}:${tableKey(table)}`);
      if (!t || fk.columns.length === 0) continue;
      const cols = fk.columns.map(lc);
      const leads = (list: readonly string[]) => cols.every((c, i) => lc(list[i] ?? "") === c);
      const covered = t.indexes.some((i) => leads(i.columns)) || leads(t.pk) || (cols.length === 1 && t.columns.some((c) => lc(c.name) === cols[0] && (c.unique || c.primary)));
      if (!covered) {
        const ref = fk.refTable.includes(":") ? fk.refTable.slice(fk.refTable.lastIndexOf(":") + 1) : fk.refTable;
        add("fk-no-index", table, m, line, `Foreign key ${nm(table)}(${fk.columns.join(", ")}) → ${nm(ref)} has no index`, `No index covers ${fk.columns.join(", ")} on ${nm(table)}: deleting or updating a ${nm(ref)} row scans ${nm(table)} (and locks it while it does), and joins on it are slow.`, fk.columns.join(","));
      }
    }
  }
  return out;
}

export function compareSchemas(base: DbSchema | undefined, head: DbSchema | undefined): DbChange {
  const tables: DbTableChange[] = [];
  const enums: DbEnumChange[] = [];
  const newMigrations: DbMigration[] = [];
  const drift: DbDriftDelta[] = [];
  const findings: DbFinding[] = [];
  const baseDbs = new Map((base?.databases ?? []).map((d) => [d.id, d]));
  const headDbs = new Map((head?.databases ?? []).map((d) => [d.id, d]));
  for (const id of new Set([...baseDbs.keys(), ...headDbs.keys()])) {
    const b = baseDbs.get(id);
    const h = headDbs.get(id);
    const empty: Database = { id, name: id, tools: [], sources: [], tables: [], enums: [], migrations: [], opaque: [], orderProblems: [] };
    const before = b ?? empty;
    const after = h ?? empty;
    const baseMigrationIds = new Set(before.migrations.map((m) => m.id));
    const added = after.migrations.filter((m) => !baseMigrationIds.has(m.id));
    newMigrations.push(...added);
    const renames = explicitRenames(after, added);
    const baseById = new Map(before.tables.map((t) => [t.id, t]));
    const headById = new Map(after.tables.map((t) => [t.id, t]));
    const matchedBase = new Set<string>();
    const addedTables: DbTable[] = [];
    const touchedBy = (t: DbTable) => [...new Set(t.history.filter((r) => added.some((m) => m.id === r.migration)).map((r) => r.migration))];
    for (const t of after.tables) {
      const renamedFrom = [...renames.tables].find(([, to]) => to === t.id)?.[0];
      const prev = baseById.get(t.id) ?? (renamedFrom ? baseById.get(renamedFrom) : undefined);
      if (!prev) {
        addedTables.push(t);
        continue;
      }
      matchedBase.add(prev.id);
      const deltas = compareTables(prev, t, renames.columns.get(t.id) ?? new Map());
      if (prev.id !== t.id) tables.push({ id: t.id, status: "renamed", table: t, before: prev, renamedFrom: prev.name, renamedVia: "migration", ...deltas, migrations: touchedBy(t) });
      else if (hasDeltas(deltas)) tables.push({ id: t.id, status: "changed", table: t, before: prev, ...deltas, migrations: touchedBy(t) });
    }
    const removed = before.tables.filter((t) => !matchedBase.has(t.id) && !headById.has(t.id));
    // A removed and an added table with the same columns: renamed.
    for (const a of [...addedTables]) {
      const names = new Set(a.columns.map((c) => lc(c.name)));
      const match = removed.find((r) => r.columns.length >= 2 && r.columns.length === a.columns.length && r.columns.every((c) => names.has(lc(c.name))));
      if (!match) continue;
      removed.splice(removed.indexOf(match), 1);
      addedTables.splice(addedTables.indexOf(a), 1);
      tables.push({ id: a.id, status: "renamed", table: a, before: match, renamedFrom: match.name, renamedVia: "matching columns", ...compareTables(match, a, new Map()), migrations: touchedBy(a) });
    }
    for (const t of addedTables) tables.push({ id: t.id, status: "added", table: t, columns: t.columns.map((c) => ({ name: c.name, status: "added" as const, after: c })), indexes: { added: t.indexes, removed: [] }, fks: { added: t.fks, removed: [] }, checks: { added: t.checks, removed: [] }, migrations: touchedBy(t) });
    for (const t of removed) {
      const dropping = added.filter((m) => m.ops.some((op) => op.op === "dropTable" && `${id}:${tableKey(op.table)}` === t.id)).map((m) => m.id);
      tables.push({ id: t.id, status: "removed", table: t, columns: t.columns.map((c) => ({ name: c.name, status: "removed" as const, before: c })), indexes: { added: [], removed: t.indexes }, fks: { added: [], removed: t.fks }, checks: { added: [], removed: t.checks }, migrations: dropping });
    }
    // Enums.
    const baseEnums = new Map(before.enums.map((e) => [e.id, e]));
    const headEnums = new Map(after.enums.map((e) => [e.id, e]));
    for (const e of after.enums) {
      const p = baseEnums.get(e.id);
      if (!p) enums.push({ id: e.id, status: "added", name: e.name, added: e.values, removed: [] });
      else {
        const addedValues = e.values.filter((v) => !p.values.includes(v));
        const removedValues = p.values.filter((v) => !e.values.includes(v));
        if (addedValues.length || removedValues.length) enums.push({ id: e.id, status: "changed", name: e.name, added: addedValues, removed: removedValues });
      }
    }
    for (const e of before.enums) if (!headEnums.has(e.id)) enums.push({ id: e.id, status: "removed", name: e.name, added: [], removed: e.values });
    // Drift the PR introduces.
    for (const t of after.tables) {
      const prev = baseById.get(t.id);
      const had = new Set((prev?.drift ?? []).map((d) => `${d.kind}|${d.column ?? ""}`));
      for (const d of t.drift) if (!had.has(`${d.kind}|${d.column ?? ""}`)) drift.push({ table: t.id, tableName: t.name, drift: d });
    }
    if (added.length && h) findings.push(...findingsFor(after, b, added, h));
  }
  // Findings point at their table's change.
  for (const f of findings) {
    const c = tables.find((t) => t.id === f.table || t.before?.id === f.table);
    if (c) (c.findings ??= []).push(f.key);
  }
  const order: Record<DbTableChange["status"], number> = { removed: 0, renamed: 1, changed: 2, added: 3 };
  tables.sort((a, b) => Number(Boolean(b.findings?.length)) - Number(Boolean(a.findings?.length)) || order[a.status] - order[b.status] || a.table.name.localeCompare(b.table.name));
  return {
    tables,
    enums,
    migrations: newMigrations,
    drift,
    findings,
    counts: {
      added: tables.filter((t) => t.status === "added").length,
      removed: tables.filter((t) => t.status === "removed").length,
      renamed: tables.filter((t) => t.status === "renamed").length,
      changed: tables.filter((t) => t.status === "changed").length,
      migrations: newMigrations.length,
      findings: findings.length,
      destructive: findings.filter((f) => DESTRUCTIVE_RULES.has(f.rule)).length,
    },
    total: (head?.databases ?? []).reduce((n, d) => n + d.tables.length, 0),
  };
}

/** Whether the change touched the schema at all (the left column's Schema section shows only then). */
export function schemaChanged(change: DbChange | undefined): boolean {
  return Boolean(change && (change.tables.length > 0 || change.enums.length > 0 || change.migrations.length > 0 || change.findings.length > 0 || change.drift.length > 0));
}
