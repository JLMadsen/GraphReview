"use client";

// One table explained (DESIGN.md §6.13 §7) — opened in place in the Data
// view's list, or in the right column from its canvas: the source it comes
// from, the change's findings, its columns (each with its source, and + − ~
// on a diff), indexes, foreign keys out and in, the migration timeline, the
// models that map it, the endpoints that read or write it (links found only
// in SQL text marked), and drift between models and migrations.

import { useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { ASSESSMENT_VISUALS } from "./review-visuals";
import { SOURCE_LABELS, STATUS_STYLES, refLabel, tableLabel, type DbRow } from "./db-view-model";
import type { Database, DbChange, DbColumn, DbColumnDelta, DbSourceKind, DbTable } from "./db-types";

export interface DbTableDetailProps {
  row: DbRow;
  db?: Database;
  /** Every table by id, for references in and out. */
  tablesById: ReadonlyMap<string, DbTable>;
  change?: DbChange;
  onFocusTable: (id: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onOpenEndpoint?: (endpointId: string) => void;
  /** In the right column: a header with the name and a close button. */
  onClose?: () => void;
  className?: string;
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-[11px] font-medium text-muted-foreground">{children}</p>;
}

export function SourceBadge({ source, className }: { source: DbSourceKind; className?: string }) {
  return (
    <span className={cn("shrink-0 rounded-[3px] border border-border px-1 font-mono text-[10px] leading-4 text-muted-foreground", className)} title={SOURCE_LABELS[source].title}>
      {SOURCE_LABELS[source].short}
    </span>
  );
}

const MARK: Record<DbColumnDelta["status"], { mark: string; className: string }> = {
  added: { mark: "+", className: "text-success" },
  removed: { mark: "−", className: "text-destructive" },
  changed: { mark: "~", className: "text-warning" },
  renamed: { mark: "~", className: "text-warning" },
};

function ColumnRow({ col, delta, tableSource, enumValues, newValues, fkTarget }: { col: DbColumn; delta?: DbColumnDelta; tableSource: DbSourceKind; enumValues?: string[]; newValues?: string[]; fkTarget?: string }) {
  const m = delta ? MARK[delta.status] : undefined;
  const removed = delta?.status === "removed";
  const changed = new Set(delta?.aspects ?? []);
  const before = delta?.before;
  const was = (aspect: string, text: string | undefined) =>
    changed.has(aspect as never) && before ? <span className="mr-1 text-destructive line-through decoration-destructive/50">{text ?? "none"}</span> : null;
  return (
    <tr className={cn("border-b border-border/50 last:border-0", removed && "opacity-70")}>
      <td className={cn("w-4 px-1 py-0.5 text-center", m?.className)}>{m?.mark ?? ""}</td>
      <td className={cn("truncate px-1.5 py-0.5", removed && "line-through")} title={col.modelField ? `${col.name} (field ${col.modelField})` : col.name}>
        {delta?.status === "renamed" && <span className="mr-1 text-destructive line-through decoration-destructive/50">{delta.from}</span>}
        {col.name}
        {col.primary && <span className="ml-1 text-[10px] text-muted-foreground">PK</span>}
      </td>
      <td className="truncate px-1.5 py-0.5 text-muted-foreground" title={col.type}>
        {was("type", before?.type)}
        <span className={cn(changed.has("type") && "text-foreground")}>{col.type || "?"}</span>
        {enumValues && (
          <span className="ml-1 text-muted-foreground/80" title={enumValues.join(" | ")}>
            {enumValues.map((v, i) => (
              <span key={v} className={cn(newValues?.includes(v) && "text-success")}>
                {i ? " | " : ""}
                {v}
              </span>
            ))}
          </span>
        )}
      </td>
      <td className="px-1.5 py-0.5 whitespace-nowrap text-muted-foreground">
        {was("nullable", before?.nullable ? "null" : "not null")}
        <span className={cn(changed.has("nullable") && "text-foreground")}>{col.nullable ? "null" : "not null"}</span>
      </td>
      <td className="truncate px-1.5 py-0.5 text-muted-foreground" title={col.default ?? col.generated ?? ""}>
        {was("default", before?.default)}
        {col.default ?? (col.generated ? <span>{col.generated}</span> : "")}
      </td>
      <td className="px-1.5 py-0.5 text-right whitespace-nowrap">
        {col.unique && <span className="mr-1 text-[10px] text-muted-foreground">unique</span>}
        {fkTarget && <span className="mr-1 text-[10px] text-muted-foreground" title={`references ${fkTarget}`}>→ {fkTarget}</span>}
        {col.source !== tableSource && <SourceBadge source={col.source} />}
      </td>
    </tr>
  );
}

export function DbTableDetail({ row, db, tablesById, change, onFocusTable, onOpenFile, onOpenEndpoint, onClose, className }: DbTableDetailProps) {
  const t = row.table;
  const c = row.change;
  const [allHistory, setAllHistory] = useState(false);
  const concern = ASSESSMENT_VISUALS.concern;
  const deltas = new Map((c?.columns ?? []).map((d) => [d.name.toLowerCase(), d]));
  const enumsById = new Map((db?.enums ?? []).map((e) => [e.id, e]));
  const enumChanges = new Map((change?.enums ?? []).map((e) => [e.id, e]));
  const fkOf = (name: string) => t.fks.find((f) => f.columns.length === 1 && f.columns[0].toLowerCase() === name.toLowerCase());
  const incoming = [...tablesById.values()].flatMap((o) => o.fks.filter((f) => f.refTable === t.id).map((f) => ({ from: o, fk: f })));
  const prMigrations = new Set((change?.migrations ?? []).map((m) => m.id));
  const history = allHistory ? t.history : t.history.slice(-8);
  const columns: Array<{ col: DbColumn; delta?: DbColumnDelta }> = c?.status === "removed" ? t.columns.map((col) => ({ col, delta: { name: col.name, status: "removed" as const, before: col } })) : t.columns.map((col) => ({ col, delta: c?.status === "added" ? { name: col.name, status: "added" as const, after: col } : deltas.get(col.name.toLowerCase()) }));
  if (c && c.status !== "removed" && c.status !== "added") {
    for (const d of c.columns) if (d.status === "removed" && d.before && !t.columns.some((x) => x.name.toLowerCase() === d.name.toLowerCase())) columns.push({ col: d.before, delta: d });
  }
  const style = c ? STATUS_STYLES[c.status] : undefined;

  return (
    <div className={cn("@container space-y-3 text-[11px]", className)}>
      {onClose && (
        <div className="flex items-baseline gap-2">
          <p className={cn("min-w-0 flex-1 truncate font-mono text-[13px] font-medium", c?.status === "removed" && "line-through")}>{tableLabel(t)}</p>
          {style && <span className={cn("font-mono", style.className)}>{style.word}</span>}
          <button type="button" onClick={onClose} aria-label="Close" className="self-center text-muted-foreground hover:text-foreground">
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SourceBadge source={t.source} />
        <button type="button" onClick={() => onOpenFile(t.definedAt.file, t.definedAt.line)} className="min-w-0 truncate font-mono hover:underline" title="Open the file">
          {t.definedAt.file}:{t.definedAt.line}
        </button>
        {t.component && <span className="text-muted-foreground">in {t.component.name}</span>}
        {db && (
          <span className="font-mono text-muted-foreground" title={db.dialectGuessed ? "Dialect guessed from the SQL" : undefined}>
            {db.name}
            {db.dialect ? ` · ${db.dialect}${db.dialectGuessed ? "?" : ""}` : ""}
          </span>
        )}
        {t.view && <span className="text-muted-foreground">view</span>}
        {t.usage && <span className="text-muted-foreground">used in {t.usage.uses} place{t.usage.uses === 1 ? "" : "s"} · {t.usage.files} file{t.usage.files === 1 ? "" : "s"}</span>}
      </div>
      {c?.status === "renamed" && (
        <p className="text-muted-foreground">
          Renamed from <span className="font-mono text-foreground">{c.renamedFrom}</span> — {c.renamedVia === "migration" ? "by a migration" : "a removed table with the same columns"}.
        </p>
      )}

      {row.findings.map((f) => (
        <div key={f.key}>
          <p className="flex items-start gap-1.5 font-medium" style={{ color: concern.text }}>
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            {f.summary}
          </p>
          <p className="mt-0.5 pl-5 leading-relaxed text-muted-foreground">
            {f.rationale}{" "}
            <button type="button" onClick={() => onOpenFile(f.file, f.line)} className="font-mono hover:text-foreground hover:underline">
              {f.file}
              {f.line ? `:${f.line}` : ""}
            </button>
          </p>
        </div>
      ))}

      <div>
        <Label>
          Columns <span className="font-mono">{t.columns.length}</span>
        </Label>
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full table-fixed font-mono text-[11px]">
            <colgroup>
              <col className="w-4" />
              <col className="w-[26%]" />
              <col className="w-[28%]" />
              <col className="w-[13%]" />
              <col />
              <col className="w-[22%]" />
            </colgroup>
            <tbody>
              {columns.map(({ col, delta }) => {
                const e = col.enum ? enumsById.get(col.enum) : undefined;
                const fk = fkOf(col.name);
                return (
                  <ColumnRow
                    key={`${delta?.status ?? ""}:${col.name}`}
                    col={col}
                    delta={delta}
                    tableSource={t.source}
                    enumValues={e?.values}
                    newValues={e ? enumChanges.get(e.id)?.added : undefined}
                    fkTarget={fk ? refLabel(fk.refTable) : undefined}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {(t.indexes.length > 0 || (c?.indexes.removed.length ?? 0) > 0) && (
        <div>
          <Label>Indexes</Label>
          <ul className="space-y-0.5 font-mono">
            {t.indexes.map((i, n) => {
              const added = c?.indexes.added.some((x) => x.columns.join() === i.columns.join() && Boolean(x.unique) === Boolean(i.unique));
              return (
                <li key={`${i.name ?? ""}${n}`} className="flex min-w-0 gap-1.5">
                  <span className={cn("w-3 shrink-0", added && "text-success")}>{added ? "+" : ""}</span>
                  <span className="min-w-0 truncate">
                    {i.unique ? "unique " : ""}({i.columns.join(", ")})<span className="text-muted-foreground"> {i.name ?? ""}</span>
                    {i.where && <span className="text-muted-foreground"> where {i.where}</span>}
                  </span>
                </li>
              );
            })}
            {c?.indexes.removed.map((i, n) => (
              <li key={`removed${n}`} className="flex min-w-0 gap-1.5 opacity-70">
                <span className="w-3 shrink-0 text-destructive">−</span>
                <span className="min-w-0 truncate line-through">
                  ({i.columns.join(", ")}) {i.name ?? ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(t.fks.length > 0 || incoming.length > 0) && (
        <div className="grid gap-3 @xl:grid-cols-2">
          <div>
            <Label>References</Label>
            <ul className="space-y-0.5 font-mono">
              {t.fks.length === 0 && <li className="font-sans text-muted-foreground">—</li>}
              {t.fks.map((f, n) => (
                <li key={n} className="flex min-w-0 flex-wrap gap-x-1.5">
                  <span>({f.columns.join(", ")})</span>
                  <span className="text-muted-foreground">→</span>
                  <button type="button" onClick={() => onFocusTable(f.refTable)} className={cn("hover:underline", f.inferred && "decoration-dashed")}>
                    {refLabel(f.refTable)}
                  </button>
                  {f.onDelete && <span className="text-muted-foreground">on delete {f.onDelete.toLowerCase()}</span>}
                  {f.inferred && <span className="font-sans text-muted-foreground" title="Only an ORM relation declares it">inferred</span>}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <Label>Referenced by</Label>
            <ul className="space-y-0.5 font-mono">
              {incoming.length === 0 && <li className="font-sans text-muted-foreground">—</li>}
              {incoming.map(({ from, fk }, n) => (
                <li key={n} className="flex min-w-0 gap-x-1.5">
                  <button type="button" onClick={() => onFocusTable(from.id)} className="hover:underline">
                    {tableLabel(from)}
                  </button>
                  <span className="text-muted-foreground">({fk.columns.join(", ")})</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {t.history.length > 0 && (
        <div>
          <Label>
            Migrations <span className="font-mono">{t.history.length}</span>
          </Label>
          <ol className="space-y-0.5 border-l border-border pl-2.5">
            {!allHistory && t.history.length > history.length && (
              <li>
                <button type="button" onClick={() => setAllHistory(true)} className="text-muted-foreground hover:text-foreground hover:underline">
                  {t.history.length - history.length} earlier
                </button>
              </li>
            )}
            {history.map((h, n) => {
              const isNew = prMigrations.has(h.migration);
              return (
                <li key={`${h.migration}:${n}`} className="flex min-w-0 items-baseline gap-2">
                  <button type="button" onClick={() => onOpenFile(h.file, h.line)} className={cn("max-w-[45%] shrink-0 truncate font-mono hover:underline", isNew ? "text-warning" : "text-muted-foreground")} title={`${h.file}:${h.line}${isNew ? " — added by this change" : ""}`}>
                    {h.name}
                  </button>
                  <span className="min-w-0 truncate font-mono" title={h.summary}>
                    {h.summary}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {(t.models.length > 0 || (t.endpoints?.length ?? 0) > 0) && (
        <div className="grid gap-3 @xl:grid-cols-2">
          {t.models.length > 0 && (
            <div>
              <Label>Models</Label>
              <ul className="space-y-0.5">
                {t.models.map((m) => (
                  <li key={`${m.file}#${m.name}`} className="flex min-w-0 gap-1.5">
                    <span className="w-14 shrink-0 text-muted-foreground">{m.tool}</span>
                    <button type="button" onClick={() => onOpenFile(m.file, m.line)} className="min-w-0 truncate font-mono hover:underline" title={`${m.file}:${m.line}`}>
                      {m.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(t.endpoints?.length ?? 0) > 0 && (
            <div>
              <Label>Read / written by</Label>
              <ul className="space-y-0.5">
                {t.endpoints!.slice(0, 12).map((e) => {
                  const sqlOnly = e.via.length === 1 && e.via[0] === "sql";
                  return (
                    <li key={e.endpoint} className="flex min-w-0 items-baseline gap-1.5">
                      <button type="button" onClick={() => onOpenEndpoint?.(e.endpoint)} className="min-w-0 truncate font-mono hover:underline">
                        {e.label}
                      </button>
                      {e.access && <span className="text-muted-foreground">{e.access}</span>}
                      {sqlOnly && (
                        <span className="text-muted-foreground" title="Found only in SQL text — can be wrong (a name in a comment or an unrelated string)">
                          SQL text
                        </span>
                      )}
                    </li>
                  );
                })}
                {t.endpoints!.length > 12 && <li className="text-muted-foreground">+{t.endpoints!.length - 12} more</li>}
              </ul>
            </div>
          )}
        </div>
      )}

      {t.drift.length > 0 && (
        <div>
          <Label>Drift between models and migrations</Label>
          <ul className="space-y-0.5">
            {t.drift.map((d, n) => (
              <li key={n} className="flex min-w-0 items-baseline gap-1.5">
                <span className="min-w-0">{d.text}</span>
                {d.file && (
                  <button type="button" onClick={() => onOpenFile(d.file!, d.line)} className="shrink-0 font-mono text-muted-foreground hover:text-foreground hover:underline">
                    {d.file.split("/").pop()}
                    {d.line ? `:${d.line}` : ""}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
