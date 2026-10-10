"use client";

// "Infra" in the Graph tab's left summary (DESIGN.md §6.12): what the
// selected diff does to the infrastructure — "+1 −0 ~2", findings first —
// from the base/head comparison. Shown only when the diff changed infra;
// each line opens the Infra view at that resource.

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { InfraChangeCounts, ToolIcon } from "./InfraView";
import { ACTION_STYLES } from "./infra-view-model";
import { ASSESSMENT_VISUALS } from "./review-visuals";
import type { InfraChange } from "./infra-types";

const SHOWN = 6;

/** Whether the diff changed infra — the section (and its kin) show only then. */
export const infraChanged = (change: InfraChange | undefined): change is InfraChange => Boolean(change && (change.changes.length > 0 || change.findings.length > 0));

export function InfraChangesSection({ change, onOpen }: { change: InfraChange | undefined; onOpen: (resourceId: string) => void }) {
  const [all, setAll] = useState(false);
  if (!infraChanged(change)) return null;
  // Findings about resources the diff didn't change (code now reads an env var its workload doesn't set) get a line too.
  const changed = new Set(change.changes.map((c) => c.id));
  const loose = change.findings.filter((f) => !changed.has(f.resource));
  const total = change.changes.length + loose.length;
  const shown = all ? change.changes : change.changes.slice(0, Math.max(0, SHOWN - loose.length));
  return (
    <section className="mt-3 border-t border-border pt-2.5 text-[11px]">
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase">Infra</p>
        <InfraChangeCounts change={change} />
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {loose.map((f) => (
          <li key={f.key}>
            <button type="button" onClick={() => onOpen(f.resource)} className="group flex w-full min-w-0 items-baseline gap-1.5 py-0.5 text-left" title={f.rationale}>
              <span className="w-12 shrink-0 font-mono text-[10px]" style={{ color: ASSESSMENT_VISUALS.concern.text }}>
                finding
              </span>
              <span className="min-w-0 truncate group-hover:underline">{f.summary}</span>
            </button>
          </li>
        ))}
        {shown.map((c) => {
          const style = ACTION_STYLES[c.action];
          return (
            <li key={`${c.action}:${c.id}`}>
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                className="group flex w-full min-w-0 items-baseline gap-1.5 py-0.5 text-left"
                title={`${style.title}${c.findings?.length ? " — with a finding" : ""}\n${c.resource.file}:${c.resource.line}`}
              >
                <span className={cn("w-12 shrink-0 font-mono text-[10px]", style.className)}>{style.word}</span>
                <ToolIcon tool={c.resource.tool} className="size-3 translate-y-0.5" />
                <span className={cn("min-w-0 truncate font-mono group-hover:underline", c.action === "destroy" && "line-through")}>{c.resource.address}</span>
                {c.findings?.length ? <TriangleAlert className="size-3 shrink-0 translate-y-0.5" style={{ color: ASSESSMENT_VISUALS.concern.text }} aria-label="finding" /> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {total > SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {all ? "show fewer" : `${total - loose.length - shown.length} more`}
        </button>
      )}
    </section>
  );
}
