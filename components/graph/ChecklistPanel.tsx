"use client";

// The PR prerequisite checklist (DESIGN.md §6.6), in the diff summary in the
// left column: its result as the section's headline — "3 of 6 checks fail",
// "All 6 checks pass" — in the result's colour, and every item under it,
// always open. (The review's own verdict heads the review under the map; the
// two are separate results and each says its own.) Failing items are only marks; nothing
// is blocked. The gear opens the per-repo editor in place.

import { useState } from "react";
import {
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleX,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { cn } from "cn";
import { ChecklistEditor } from "./ChecklistEditor";
import { Spark } from "./Spark";
import type { ChecklistStatusDTO } from "./checklist-types";
import type { UseChecklistResult } from "./useChecklist";

const STATUS_VISUALS: Record<ChecklistStatusDTO, { icon: typeof CircleCheck; className: string; label: string }> = {
  pass: { icon: CircleCheck, className: "text-success", label: "Passes" },
  fail: { icon: CircleX, className: "text-destructive", label: "Fails" },
  pending: { icon: CircleDashed, className: "text-warning", label: "Pending" },
  unknown: {
    icon: CircleHelp,
    className: "text-muted-foreground",
    label: "Can't tell",
  },
  not_applicable: {
    icon: CircleMinus,
    className: "text-muted-foreground/60",
    label: "Doesn't apply",
  },
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
  const aiWaiting = items.filter((i) => i.kind === "ai" && i.status === "pending").length;
  const pending = counted.filter((i) => i.status === "pending").length;

  return (
    <section className="mt-2 text-[11px]">
      <div className="flex items-center gap-1">
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-[15px] leading-tight font-medium">
          {data ? (
            failed > 0 ? (
              <span className="flex items-center gap-1.5 text-destructive">
                <CircleX className="size-4" aria-hidden />
                {failed} of {counted.length} checks fail
              </span>
            ) : pending > 0 ? (
              <span className="flex items-center gap-1.5 text-warning">
                <CircleDashed className="size-4" aria-hidden />
                {passed} of {counted.length} checks pass
              </span>
            ) : counted.length > 0 ? (
              <span className="flex items-center gap-1.5 text-success">
                <CircleCheck className="size-4" aria-hidden />
                All {counted.length} checks pass
              </span>
            ) : (
              <span className="text-muted-foreground">No checks apply</span>
            )
          ) : loading ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              Checking…
            </span>
          ) : (
            <span className="text-muted-foreground">Checks</span>
          )}
        </p>
        <button
          type="button"
          onClick={checklist.refresh}
          disabled={loading}
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
          title="Check again (re-reads CI and the PR)"
          aria-label="Check again"
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
        </button>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          aria-pressed={editing}
          className={cn(
            "rounded-sm p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground",
            editing && "bg-secondary text-foreground",
          )}
          title="Choose the checks for this repo"
          aria-label="Edit checklist"
        >
          <Settings2 className="size-3" />
        </button>
      </div>

      {aiWaiting > 0 && (
        <p className="mt-1 text-muted-foreground" title="Model-judged checks not answered yet">
          {aiWaiting} <Spark /> {runningAi ? "being judged…" : "waiting for the review to finish"}
        </p>
      )}
      {error && <p className="mt-1.5 text-destructive">{error}</p>}

      {editing ? (
        <div className="mt-2">
          <ChecklistEditor repoId={repoId} onChanged={checklist.refresh} />
        </div>
      ) : (
        <>
          <ul className="mt-1.5 space-y-1.5">
            {items.map((item) => {
              const visual = STATUS_VISUALS[item.status];
              const Icon = item.kind === "ai" && item.status === "pending" && runningAi ? LoaderCircle : visual.icon;
              return (
                <li key={item.itemId} className="flex gap-1.5">
                  <Icon
                    className={cn("mt-px size-3 shrink-0", visual.className, Icon === LoaderCircle && "animate-spin")}
                    aria-label={visual.label}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs">
                      {item.label}
                      {item.kind === "ai" && <Spark className="ml-1" title="Judged by the model" />}
                    </p>
                    {item.detail && <p className="leading-snug text-muted-foreground">{item.detail}</p>}
                    {item.links && item.links.length > 0 && (
                      <p className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                        {item.links.map((link) => (
                          <a
                            key={link.url}
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
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
              <li className="text-muted-foreground">
                No checks are switched on for this repo — use the gear to add some.
              </li>
            )}
            {!data && loading && (
              <li className="flex items-center gap-1.5 text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" /> Reading the PR and its CI…
              </li>
            )}
          </ul>

          {items.some((i) => i.kind === "ai") && data?.aiConfigured && (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void checklist.runAi()}
                disabled={runningAi}
                className="rounded-sm border border-border px-2 py-0.5 font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
                title="Ask the AI provider every AI question again (one model call)"
              >
                {runningAi ? "Judging…" : data.aiPending > 0 ? "✦ Judge now" : "✦ Judge again"}
              </button>
              {data.aiPending > 0 && !runningAi && (
                <span className="text-muted-foreground">Or wait — they run once the review finishes.</span>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
