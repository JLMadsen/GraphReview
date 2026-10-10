// One object for the places the schema shows (DESIGN.md §6.13): the Data
// view's canvas and list, the table explainer, the left column's Schema
// section, the API explainer's "touches" and the PR map's ⛁ badge. Rows are
// the analysed commit's catalog with the selected diff's change laid over
// it — added, renamed and changed tables as they are at the head, removed
// ones kept and marked.

import type { DbChange, DbFinding, DbSchema, DbSourceKind, DbTable, DbTableChange, DbTableStatus } from "./db-types";

export interface DbRow {
  table: DbTable;
  change?: DbTableChange;
  findings: DbFinding[];
}

export function buildDbRows(schema: DbSchema | null, change: DbChange | undefined): DbRow[] {
  const rows = new Map<string, DbRow>();
  for (const db of schema?.databases ?? []) for (const t of db.tables) rows.set(t.id, { table: t, findings: [] });
  const byKey = new Map((change?.findings ?? []).map((f) => [f.key, f]));
  for (const c of change?.tables ?? []) {
    const findings = (c.findings ?? []).map((k) => byKey.get(k)).filter((f): f is DbFinding => Boolean(f));
    // The table as the head has it (its columns, its history with the PR's
    // migrations), with what only the analysed catalog knows: its component,
    // endpoints and usage.
    const own = rows.get(c.id)?.table;
    const table = own && c.status !== "removed" ? { ...c.table, component: own.component, endpoints: own.endpoints, usage: own.usage } : c.table;
    rows.set(c.id, { table, change: c, findings });
    if (c.before && c.before.id !== c.id) rows.delete(c.before.id);
  }
  return [...rows.values()];
}

export const STATUS_STYLES: Record<DbTableStatus, { word: string; mark: string; className: string; title: string }> = {
  added: { word: "new", mark: "+", className: "text-success", title: "This change adds the table" },
  removed: { word: "removed", mark: "−", className: "text-destructive", title: "This change drops the table" },
  renamed: { word: "renamed", mark: "→", className: "text-warning", title: "The same table under a new name" },
  changed: { word: "changed", mark: "~", className: "text-warning", title: "Its columns, indexes or keys change" },
};

export const SOURCE_LABELS: Record<DbSourceKind, { short: string; title: string }> = {
  migration: { short: "mig", title: "From the migrations, replayed in order — exact" },
  schema: { short: "schema", title: "From a declarative schema file (schema.prisma, Drizzle tables, schema.sql) — exact" },
  model: { short: "model", title: "From an ORM model — inferred with the framework's naming rules" },
};

/** The table a FK points at, by id or name. */
export const refLabel = (ref: string) => {
  const bare = ref.includes(":") ? ref.slice(ref.lastIndexOf(":") + 1) : ref;
  return bare.replace(/^public\./, "");
};

export const tableLabel = (t: Pick<DbTable, "schema" | "name">) => (t.schema ? `${t.schema}.${t.name}` : t.name);

/**
 * The box a table goes in on the "All tables" canvas: its owning component,
 * else its Postgres schema, else a common name prefix (`auth_user` → `auth`)
 * shared by at least one other table.
 */
export function groupTables(tables: readonly DbTable[]): Map<string, { label: string; ids: string[] }> {
  const groups = new Map<string, { label: string; ids: string[] }>();
  const add = (key: string, label: string, id: string) => (groups.get(key) ?? groups.set(key, { label, ids: [] }).get(key)!).ids.push(id);
  const prefixOf = (name: string) => /^([a-z0-9]+)[_.]/i.exec(name)?.[1]?.toLowerCase();
  const prefixCounts = new Map<string, number>();
  for (const t of tables) {
    const p = prefixOf(t.name);
    if (p) prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
  }
  for (const t of tables) {
    if (t.component) add(`c:${t.component.id}`, t.component.name, t.id);
    else if (t.schema) add(`s:${t.schema}`, `schema ${t.schema}`, t.id);
    else {
      const p = prefixOf(t.name);
      if (p && (prefixCounts.get(p) ?? 0) > 1) add(`p:${p}`, `${p}_*`, t.id);
    }
  }
  return groups;
}

/** Tables each file reaches (uses, models, migrations) — for the PR map's ⛁ badge. */
export function tablesByFile(schema: DbSchema | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (file: string, id: string) => (out.get(file) ?? out.set(file, new Set()).get(file)!).add(id);
  for (const u of schema?.uses ?? []) add(u.file, u.table);
  for (const db of schema?.databases ?? []) {
    for (const t of db.tables) {
      for (const m of t.models) add(m.file, t.id);
      for (const h of t.history) add(h.file, t.id);
    }
  }
  return out;
}

/** Whether the diff changed the schema — the left column's section (and its kin) show only then. */
export const schemaChanged = (change: DbChange | undefined): change is DbChange =>
  Boolean(change && (change.tables.length > 0 || change.enums.length > 0 || change.migrations.length > 0 || change.findings.length > 0));

/** Per endpoint id, the tables it reaches — for the API explainer's "touches". */
export function endpointTouches(schema: DbSchema | null): Map<string, Array<{ id: string; name: string; sqlOnly: boolean; access?: string }>> {
  const names = new Map((schema?.databases ?? []).flatMap((d) => d.tables.map((t) => [t.id, tableLabel(t)] as const)));
  const out = new Map<string, Array<{ id: string; name: string; sqlOnly: boolean; access?: string }>>();
  for (const [endpoint, list] of Object.entries(schema?.endpointTables ?? {})) {
    out.set(
      endpoint,
      list.map((t) => ({ id: t.table, name: names.get(t.table) ?? refLabel(t.table), sqlOnly: t.via.length === 1 && t.via[0] === "sql", ...(t.access ? { access: t.access } : {}) })),
    );
  }
  return out;
}
