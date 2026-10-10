"use client";

// "API" in the Graph tab's left summary (DESIGN.md §6.11): what the
// selected diff does to the API — "+2 −1 ~3", breaking
// ones first — from the base/head comparison. Each line opens the API view
// at that endpoint. Shown, never counted as findings — and only when the
// diff changed the API (like the Infra section, §6.12).

import { useState } from "react";
import { cn } from "cn";
import { ChangeCounts, MethodBadge } from "./ApiView";
import { CHANGE_STYLES } from "./api-view-model";
import type { ApiChange } from "./api-types";

const SHOWN = 6;

export function ApiChangesSection({ change, onOpen }: { change: ApiChange | undefined; onOpen: (endpointId: string) => void }) {
  const [all, setAll] = useState(false);
  // Only API changes; results stored before code changes were split off can still say "reached".
  const changes = (change?.changes ?? []).filter((c) => c.status in CHANGE_STYLES);
  if (!change || changes.length === 0) return null;
  const shown = all ? changes : changes.slice(0, SHOWN);
  return (
    <section className="mt-3 border-t border-border pt-2.5 text-[11px]">
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase">API</p>
        <ChangeCounts change={change} />
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {shown.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onOpen(c.id)}
              className="group flex w-full min-w-0 items-baseline gap-1.5 py-0.5 text-left"
              title={`${CHANGE_STYLES[c.status].title}${c.breaking ? " — can break existing clients" : ""}`}
            >
              <span className={cn("w-12 shrink-0 font-mono text-[10px]", CHANGE_STYLES[c.status].className)}>
                {CHANGE_STYLES[c.status].word}
                {c.breaking && <span className="text-destructive">!</span>}
              </span>
              <MethodBadge method={c.endpoint.method} className="w-12 text-[9px]" />
              <span className={cn("min-w-0 truncate font-mono group-hover:underline", c.status === "removed" && "line-through")}>{c.endpoint.path}</span>
            </button>
          </li>
        ))}
      </ul>
      {changes.length > SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {all ? "show fewer" : `${changes.length - SHOWN} more`}
        </button>
      )}
    </section>
  );
}
