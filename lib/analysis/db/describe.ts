/**
 * The schema catalog and change in words, for the places that hand them to
 * a model or an agent: the review's per-component "Tables this code
 * touches" and intent check, the PR chat and the MCP server.
 */
import { splitName } from "./replay";
import type { Database, DbChange, DbColumn, DbColumnDelta, DbFinding, DbSchema, DbTable, DbTableChange } from "./types";

/** `orders`, `billing.invoices`. */
export function dbTableLabel(t: Pick<DbTable, "schema" | "name">): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

const refName = (ref: string) => {
  const bare = ref.includes(":") ? ref.slice(ref.lastIndexOf(":") + 1) : ref;
  return splitName(bare).schema ? bare : splitName(bare).name;
};

export function describeDbFinding(f: DbFinding): string {
  return `${f.summary} (${f.file}${f.line ? `:${f.line}` : ""})`;
}

export function schemaChangeSummary(change: DbChange): string {
  const c = change.counts;
  if (change.tables.length === 0 && change.enums.length === 0 && change.migrations.length === 0) return `No schema change (${change.total} tables).`;
  const parts = [`${c.added} table(s) added`, `${c.removed} removed`, `${c.renamed} renamed`, `${c.changed} changed`];
  return `${parts.join(", ")} — of ${change.total}; ${c.migrations} new migration(s); ${c.findings} certain finding(s) (${c.destructive} destructive).`;
}

function columnText(c: DbColumn, enums?: Map<string, string[]>): string {
  const parts = [c.name, c.type || "?"];
  if (c.primary) parts.push("PK");
  parts.push(c.nullable ? "NULL" : "NOT NULL");
  if (c.default !== undefined) parts.push(`DEFAULT ${c.default}`);
  if (c.generated) parts.push(`generated ${c.generated}`);
  if (c.unique) parts.push("UNIQUE");
  if (c.enum && enums?.has(c.enum)) parts.push(`one of ${enums.get(c.enum)!.join(" | ")}`);
  return parts.join(" ");
}

function deltaText(d: DbColumnDelta): string {
  if (d.status === "added") return `+ ${columnText(d.after!)} (new)`;
  if (d.status === "removed") return `− ${columnText(d.before!)} (dropped)`;
  const changes = (d.aspects ?? []).map((a) => {
    const b = d.before!;
    const x = d.after!;
    if (a === "type") return `type ${b.type} → ${x.type}`;
    if (a === "nullable") return x.nullable ? "now nullable" : "now NOT NULL";
    if (a === "default") return `default ${b.default ?? "none"} → ${x.default ?? "none"}`;
    if (a === "unique") return x.unique ? "now unique" : "no longer unique";
    return x.primary ? "now primary key" : "no longer primary key";
  });
  if (d.status === "renamed") return `~ ${d.from} → ${d.name}${changes.length ? `; ${changes.join("; ")}` : ""}`;
  return `~ ${d.name}: ${changes.join("; ")}`;
}

/** "change orders: + status text NOT NULL; ~ total type …" — one line per changed table. */
export function describeTableChange(c: DbTableChange, max = 8): string {
  const name = dbTableLabel(c.table);
  const at = ` (${c.table.definedAt.file})`;
  if (c.status === "added") return `new table ${name} (${c.table.columns.map((x) => `${x.name} ${x.type}`).slice(0, max).join(", ")}${c.table.columns.length > max ? ", …" : ""})${at}`;
  if (c.status === "removed") return `table ${name} removed${at}`;
  const parts = c.columns.slice(0, max).map(deltaText);
  if (c.columns.length > max) parts.push(`+${c.columns.length - max} more`);
  if (c.indexes.added.length) parts.push(`index added (${c.indexes.added.map((i) => i.columns.join(", ")).join("; ")})`);
  if (c.indexes.removed.length) parts.push(`index removed (${c.indexes.removed.map((i) => i.columns.join(", ")).join("; ")})`);
  if (c.fks.added.length) parts.push(`FK added (${c.fks.added.map((f) => `${f.columns.join(", ")} → ${refName(f.refTable)}`).join("; ")})`);
  if (c.fks.removed.length) parts.push(`FK removed (${c.fks.removed.map((f) => `${f.columns.join(", ")} → ${refName(f.refTable)}`).join("; ")})`);
  const head = c.status === "renamed" ? `table ${c.renamedFrom} renamed to ${name} (${c.renamedVia === "migration" ? "by a migration" : "same columns"})` : `table ${name} changed`;
  return `${head}${parts.length ? `: ${parts.join("; ")}` : ""}${at}`;
}

/** The whole change, findings first — for the intent check, the chat and MCP. */
export function describeSchemaChange(change: DbChange, max = 25): string[] {
  const lines = [schemaChangeSummary(change)];
  for (const f of change.findings) lines.push(`finding: ${describeDbFinding(f)}`);
  for (const c of change.tables.slice(0, max)) lines.push(describeTableChange(c));
  if (change.tables.length > max) lines.push(`(${change.tables.length - max} more table changes)`);
  for (const e of change.enums) lines.push(`enum ${e.name} ${e.status}${e.added.length ? `: + ${e.added.join(", ")}` : ""}${e.removed.length ? ` − ${e.removed.join(", ")}` : ""}`);
  if (change.migrations.length) lines.push(`New migrations: ${change.migrations.map((m) => m.file).slice(0, 12).join(", ")}${change.migrations.length > 12 ? ", …" : ""}`);
  for (const d of change.drift.slice(0, 10)) lines.push(`drift on ${d.tableName}: ${d.drift.text}`);
  return lines;
}

/** Rows matching a text query (table, column, model, file), for `list_tables`. */
export function filterTables(schema: DbSchema, query?: string): Array<{ table: DbTable; db: Database }> {
  const q = query?.trim().toLowerCase();
  return schema.databases.flatMap((db) =>
    db.tables
      .filter((t) => !q || [dbTableLabel(t), t.definedAt.file, ...t.models.map((m) => m.name), ...t.columns.map((c) => c.name)].some((x) => x.toLowerCase().includes(q)))
      .map((table) => ({ table, db })),
  );
}

/** One line per table: name, columns, source, models, endpoints. */
export function describeTable(t: DbTable, db?: Database): string {
  const parts = [`${dbTableLabel(t)}${t.view ? " (view)" : ""}`];
  parts.push(t.columns.map((c) => `${c.name} ${c.type}${c.primary ? " PK" : ""}${c.nullable ? "" : " NOT NULL"}`).slice(0, 30).join(", ") + (t.columns.length > 30 ? ", …" : ""));
  if (t.fks.length) parts.push(`FKs: ${t.fks.map((f) => `${f.columns.join(",")} → ${refName(f.refTable)}${f.inferred ? " (from ORM)" : ""}`).join("; ")}`);
  parts.push(`from ${t.source}${db ? ` (${db.name}${db.dialect ? `, ${db.dialect}` : ""})` : ""}, ${t.definedAt.file}:${t.definedAt.line}`);
  if (t.models.length) parts.push(`models: ${t.models.map((m) => `${m.name} (${m.file})`).join(", ")}`);
  if (t.endpoints?.length) parts.push(`used by: ${t.endpoints.slice(0, 8).map((e) => `${e.label}${e.via.length === 1 && e.via[0] === "sql" ? " (SQL text)" : ""}`).join(", ")}`);
  if (t.drift.length) parts.push(`drift: ${t.drift.map((d) => d.text).join("; ")}`);
  return parts.join(" — ");
}

/** A table for the review prompt (lib/ai/review.ts's `ReviewTable`). */
export interface ReviewTableText {
  name: string;
  changed: boolean;
  header: string;
  columns: Array<{ text: string; changed: boolean }>;
  notes: string[];
}

/**
 * The tables one component's change touches (DESIGN.md §6.13 §6): those its
 * changed files use (any of the three ways), whose models or migrations are
 * among them, and the tables the PR's migrations in them change.
 */
export function tablesTouching(head: DbSchema | undefined, change: DbChange | undefined, paths: ReadonlySet<string>): string[] {
  const ids = new Set<string>();
  for (const u of head?.uses ?? []) if (paths.has(u.file)) ids.add(u.table);
  for (const db of head?.databases ?? []) {
    for (const t of db.tables) if (t.models.some((m) => paths.has(m.file)) || t.history.some((h) => paths.has(h.file)) || paths.has(t.definedAt.file)) ids.add(t.id);
  }
  for (const c of change?.tables ?? []) {
    if (c.migrations.some((m) => paths.has(m.split("#")[0])) || paths.has(c.table.definedAt.file) || c.table.models.some((m) => paths.has(m.file))) ids.add(c.id);
  }
  return [...ids];
}

/** Full definitions of `ids` with the change marked, changed tables first. */
export function reviewTables(ids: readonly string[], head: DbSchema | undefined, change: DbChange | undefined, paths: ReadonlySet<string>): ReviewTableText[] {
  const byId = new Map((head?.databases ?? []).flatMap((db) => db.tables.map((t) => [t.id, { t, db }] as const)));
  const changes = new Map((change?.tables ?? []).map((c) => [c.id, c]));
  const out: ReviewTableText[] = [];
  for (const id of ids) {
    const c = changes.get(id);
    const found = byId.get(id);
    const t = found?.t ?? c?.table;
    if (!t) continue;
    const db = found?.db ?? head?.databases.find((d) => d.id === t.database);
    const enums = new Map((db?.enums ?? []).map((e) => [e.id, e.values]));
    const enumChanges = (change?.enums ?? []).filter((e) => t.columns.some((col) => col.enum === e.id));
    const status = c ? (c.status === "added" ? "new in this change" : c.status === "removed" ? "REMOVED by this change" : c.status === "renamed" ? `renamed from ${c.renamedFrom} by this change` : "changed by this change") : "unchanged";
    const models = t.models.map((m) => `${m.tool} ${m.name} (${m.file})`).join(", ");
    const header = `${dbTableLabel(t)} — ${status}; ${db?.dialect ?? "dialect unknown"}; from ${t.source} (${t.definedAt.file})${models ? `; model ${models}` : ""}`;
    const deltaByName = new Map((c?.columns ?? []).map((d) => [d.name.toLowerCase(), d]));
    const columns: ReviewTableText["columns"] = [];
    if (c?.status === "removed") for (const col of t.columns) columns.push({ text: `− ${columnText(col, enums)}`, changed: true });
    else {
      for (const col of t.columns) {
        const d = deltaByName.get(col.name.toLowerCase());
        if (d && d.status !== "removed" && c?.status !== "added") columns.push({ text: deltaText(d), changed: true });
        else if (c?.status === "added") columns.push({ text: `+ ${columnText(col, enums)}`, changed: true });
        else if (col.source !== t.source) {
          // Only the model / schema file has it: drift, not a column the database has.
          if (d?.status !== "removed") columns.push({ text: `? ${columnText(col, enums)} — only in the ${col.source}, no ${t.source === "migration" ? "migrated" : "declared"} column`, changed: false });
        } else columns.push({ text: `  ${columnText(col, enums)}`, changed: false });
      }
      for (const d of c?.columns ?? []) if (d.status === "removed") columns.push({ text: deltaText(d), changed: true });
    }
    const notes: string[] = [];
    if (t.pk.length > 1) notes.push(`primary key (${t.pk.join(", ")})`);
    if (t.indexes.length) notes.push(`indexes: ${t.indexes.map((i) => `${i.unique ? "unique " : ""}(${i.columns.join(", ")})`).join("; ")}`);
    if (t.fks.length) notes.push(`references: ${t.fks.map((f) => `${f.columns.join(", ")} → ${refName(f.refTable)}${f.onDelete ? ` ON DELETE ${f.onDelete}` : ""}`).join("; ")}`);
    for (const e of enumChanges) notes.push(`enum ${e.name}: ${e.added.length ? `new values ${e.added.join(", ")}` : ""}${e.removed.length ? ` removed values ${e.removed.join(", ")}` : ""}`.trim());
    if (c?.indexes.added.length) notes.push(`+ index (${c.indexes.added.map((i) => i.columns.join(", ")).join("; ")})`);
    if (c?.indexes.removed.length) notes.push(`− index (${c.indexes.removed.map((i) => i.columns.join(", ")).join("; ")})`);
    for (const d of t.drift) notes.push(`drift: ${d.text}`);
    const here = (head?.uses ?? []).filter((u) => u.table === id && paths.has(u.file)).slice(0, 6);
    if (here.length) notes.push(`used in this component: ${here.map((u) => `${u.file}:${u.line}${u.access ? ` (${u.access})` : ""}${u.via === "sql" ? " [SQL text]" : ""}`).join(", ")}`);
    out.push({ name: dbTableLabel(t), changed: Boolean(c) || enumChanges.length > 0, header, columns, notes });
  }
  return out.sort((a, b) => Number(b.changed) - Number(a.changed) || a.name.localeCompare(b.name));
}

/** The schema findings about `ids` or files in `paths` — passed to the review as already reported. */
export function schemaFindingsTouching(change: DbChange | undefined, ids: readonly string[], paths: ReadonlySet<string>): DbFinding[] {
  const set = new Set(ids);
  return (change?.findings ?? []).filter((f) => set.has(f.table) || paths.has(f.file));
}
