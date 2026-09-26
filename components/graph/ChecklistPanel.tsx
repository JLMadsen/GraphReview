"use client";

// The PR prerequisite checklist card (DESIGN.md §6.6), in the column under
// the graph next to the AI review. One row per enabled item with its
// status; failing items are only badges — nothing is blocked. The gear
// opens the per-repo editor in place.

import { useState } from "react";
import {
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleX,
  ExternalLink,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  Settings2,
  Sparkles,
} from "lucide-react";
import { cn } from "cn";
import { ChecklistEditor } from "./ChecklistEditor";
import type { ChecklistStatusDTO } from "./checklist-types";
import type { UseChecklistResult } from "./useChecklist";

const STATUS_VISUALS: Record<ChecklistStatusDTO, { icon: typeof CircleCheck; className: string; label: string }> = {
  pass: { icon: CircleCheck, className: "text-success", label: "Passes" },
  fail: { icon: CircleX, className: "text-destructive", label: "Fails" },
  pending: { icon: CircleDashed, className: "text-warning", label: "Pending" },
  unknown: { icon: CircleHelp, className: "text-muted-foreground", label: "Can't tell" },
  not_applicable: { icon: CircleMinus, className: "text-muted-foreground/60", label: "Doesn't apply" },
};

export interface ChecklistPanelProps {
  repoId: string;
  checklist: UseChecklistResult;
}

export function ChecklistPanel({ repoId, checklist }: ChecklistPanelProps) {
  const [editing, setEditing] = useState(false);
  const { data, loading, error, runningAi } = checklist;
  const items = data?.items ?? [];
  const counted = items.filter((i) => i.status !== "not_applicable");
  const passed = counted.filter((i) => i.status === "pass").length;
  const failed = counted.filter((i) => i.status === "fail").length;
  const hasAi = items.some((i) => i.kind === "ai");

  return (
    <section className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <ListChecks className="size-4 shrink-0 text-brand" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tracking-tight">Checklist</p>
          <p className="text-[11px] text-muted-foreground">
            {data ? (
              <>
                <span className="font-mono text-foreground">{passed}</span>/{counted.length} pass
                {failed > 0 && (
                  <>
                    {" · "}
                    <span className="font-mono text-destructive">{failed}</span> failing
                  </>
                )}
              </>
            ) : loading ? (
              "Checking…"
            ) : (
              "—"
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={checklist.refresh}
          disabled={loading}
          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
          title="Check again (re-reads CI and the PR)"
          aria-label="Check again"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          aria-pressed={editing}
          className={cn(
            "rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground",
            editing && "bg-secondary text-foreground"
          )}
          title="Choose the checks for this repo"
          aria-label="Edit checklist"
        >
          <Settings2 className="size-3.5" />
        </button>
      </header>

      {error && <p className="border-b border-border bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{error}</p>}

      {editing ? (
        <div className="px-3 py-3">
          <ChecklistEditor repoId={repoId} onChanged={checklist.refresh} />
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {items.map((item) => {
              const visual = STATUS_VISUALS[item.status];
              const Icon = item.kind === "ai" && item.status === "pending" && runningAi ? LoaderCircle : visual.icon;
              return (
                <li key={item.itemId} className="flex gap-2 px-3 py-2">
                  <Icon
                    className={cn("mt-px size-4 shrink-0", visual.className, Icon === LoaderCircle && "animate-spin")}
                    aria-label={visual.label}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-xs font-medium">
                      {item.label}
                      {item.kind === "ai" && <Sparkles className="size-3 text-brand" aria-label="AI-judged" />}
                    </p>
                    {item.detail && (
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{item.detail}</p>
                    )}
                    {item.links && item.links.length > 0 && (
                      <p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                        {item.links.map((link) => (
                          <a
                            key={link.url}
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-0.5 text-[11px] text-brand hover:underline"
                          >
                            {link.label}
                            <ExternalLink className="size-2.5" />
                          </a>
                        ))}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
            {data && items.length === 0 && (
              <li className="px-3 py-3 text-[11px] text-muted-foreground">
                No checks are switched on for this repo — use the gear to add some.
              </li>
            )}
            {!data && loading && (
              <li className="flex items-center gap-1.5 px-3 py-3 text-[11px] text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" /> Reading the PR and its CI…
              </li>
            )}
          </ul>

          {hasAi && data?.aiConfigured && (
            <footer className="flex items-center gap-2 border-t border-border px-3 py-2">
              <button
                type="button"
                onClick={() => void checklist.runAi()}
                disabled={runningAi}
                className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
                title="Ask the AI provider every AI question again (one model call)"
              >
                {runningAi ? <LoaderCircle className="size-3 animate-spin" /> : <Sparkles className="size-3 text-brand" />}
                {runningAi ? "Asking…" : data.aiPending > 0 ? "Run AI checks" : "Re-run AI checks"}
              </button>
              {data.aiPending > 0 && !runningAi && (
                <span className="text-[10px] text-muted-foreground">Runs by itself once the AI review finishes.</span>
              )}
            </footer>
          )}
        </>
      )}
    </section>
  );
}
