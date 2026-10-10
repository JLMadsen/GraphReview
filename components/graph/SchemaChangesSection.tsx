"use client";

// "Schema" in the Graph tab's left summary (DESIGN.md §6.13 §7): what the
// selected diff does to the database — `+1 table ~2 · 3 migrations · ! 1
// destructive`, findings first — from the base/head comparison. Shown only
// when the diff changed the schema; each line opens the Data view at that
// table.

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { ASSESSMENT_VISUALS } from "./review-visuals";
import { STATUS_STYLES, schemaChanged, tableLabel } from "./db-view-model";
import type { DbChange } from "./db-types";

const SHOWN = 6;

export function SchemaChangeCounts({ change, className }: { change: DbChange; className?: string }) {
  const c = change.counts;
  const parts: Array<[string, string, string]> = [];
  if (c.added) parts.push([`+${c.added} table${c.added === 1 ? "" : "s"}`, "text-success", `${c.added} table(s) added`]);
  if (c.removed) parts.push([`−${c.removed}`, "text-destructive", `${c.removed} table(s) removed`]);
  if (c.changed + c.renamed) parts.push([`~${c.changed + c.renamed}`, "text-warning", `${c.changed} changed, ${c.renamed} renamed`]);
  return (
    <span className={cn("flex flex-wrap items-center gap-x-1.5 font-mono text-[11px] font-normal", className)}>
      {parts.map(([text, tone, title]) => (
        <span key={title} className={tone} title={title}>
          {text}
        </span>
      ))}
      {c.migrations > 0 && (
        <span className="text-muted-foreground" title="Migrations this diff adds">
          {parts.length ? "· " : ""}
          {c.migrations} migration{c.migrations === 1 ? "" : "s"}
        </span>
      )}
      {c.destructive > 0 && (
        <span className="text-destructive" title="Drops a table or column — data loss">
          · ! {c.destructive} destructive
        </span>
      )}
    </span>
  );
}

export function SchemaChangesSection({ change, onOpen }: { change: DbChange | undefined; onOpen: (tableId: string) => void }) {
  const [all, setAll] = useState(false);
  if (!schemaChanged(change)) return null;
  const shown = all ? change.tables : change.tables.slice(0, SHOWN);
  const concern = ASSESSMENT_VISUALS.concern;
  return (
    <section className="mt-3 border-t border-border pt-2.5 text-[11px]">
      <div className="flex items-baseline gap-2">
        <p className="shrink-0 font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase">Schema</p>
        <SchemaChangeCounts change={change} className="ml-auto justify-end" />
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {shown.map((c) => {
          const style = STATUS_STYLES[c.status];
          return (
            <li key={`${c.status}:${c.id}`}>
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                className="group flex w-full min-w-0 items-baseline gap-1.5 py-0.5 text-left"
                title={`${style.title}${c.findings?.length ? ` — ${c.findings.length} finding(s)` : ""}\n${c.table.definedAt.file}`}
              >
                <span className={cn("w-12 shrink-0 font-mono text-[10px]", style.className)}>{style.word}</span>
                <span className={cn("min-w-0 truncate font-mono group-hover:underline", c.status === "removed" && "line-through")}>{tableLabel(c.table)}</span>
                {c.status !== "added" && c.status !== "removed" && c.columns.length > 0 && <span className="shrink-0 font-mono text-muted-foreground">{c.columns.length} col</span>}
                {c.findings?.length ? <TriangleAlert className="size-3 shrink-0 translate-y-0.5" style={{ color: concern.text }} aria-label="finding" /> : null}
              </button>
            </li>
          );
        })}
        {change.tables.length === 0 && change.migrations.length > 0 && (
          <li className="text-muted-foreground">{change.migrations.length} new migration(s), no table change read from them</li>
        )}
      </ul>
      {change.tables.length > SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {all ? "show fewer" : `${change.tables.length - shown.length} more`}
        </button>
      )}
    </section>
  );
}
