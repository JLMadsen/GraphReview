"use client";

// "Env" in the Graph tab's left summary (DESIGN.md §6.15 §5): what the
// selected diff does to the env vars — "+1 −0 ~2", findings first — from
// the base/head comparison. Shown only when the diff changed env vars; each
// line opens the Env view at that name.

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { EnvChangeCounts } from "./EnvView";
import { envChanged } from "./env-view-model";
import { ASSESSMENT_VISUALS } from "./review-visuals";
import type { EnvChange } from "./env-types";

const SHOWN = 6;

const WORDS = { new: ["new", "text-success"], gone: ["gone", "text-destructive"], changed: ["changed", "text-warning"] } as const;

export function EnvChangesSection({ change, onOpen }: { change: EnvChange | undefined; onOpen: (name: string) => void }) {
  const [all, setAll] = useState(false);
  if (!envChanged(change)) return null;
  const assessment = new Map(change.findings.map((f) => [f.key, f.assessment]));
  const shown = all ? change.changes : change.changes.slice(0, SHOWN);
  return (
    <section className="mt-3 border-t border-border pt-2.5 text-[11px]">
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase">Env</p>
        <EnvChangeCounts change={change} />
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {shown.map((c) => {
          const worst = c.findings?.some((k) => assessment.get(k) === "defect") ? "defect" : c.findings?.length ? "concern" : undefined;
          const [word, tone] = WORDS[c.status];
          return (
            <li key={c.name}>
              <button type="button" onClick={() => onOpen(c.name)} className="group flex w-full min-w-0 items-baseline gap-1.5 py-0.5 text-left" title={`${c.status}${worst ? ` — with a ${worst}` : ""}`}>
                <span className={cn("w-12 shrink-0 font-mono text-[10px]", tone)}>{word}</span>
                <span className={cn("min-w-0 truncate font-mono group-hover:underline", c.status === "gone" && "line-through")}>{c.name}</span>
                {worst && <TriangleAlert className="size-3 shrink-0 translate-y-0.5" style={{ color: ASSESSMENT_VISUALS[worst].text }} aria-label={worst} />}
              </button>
            </li>
          );
        })}
      </ul>
      {change.changes.length > SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {all ? "show fewer" : `${change.changes.length - SHOWN} more`}
        </button>
      )}
    </section>
  );
}
