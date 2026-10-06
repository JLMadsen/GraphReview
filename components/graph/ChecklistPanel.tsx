"use client";

// The PR prerequisite checklist (DESIGN.md §6.6), in the diff summary in the
// left column, under the review's verdict: a small "Checks" heading with the
// result beside it — "3 of 6 fail", "all 6 pass" — in the result's colour,
// and every item under it, always open. (The verdict above is the headline;
// the two are separate results and each says its own.) Failing items are
// only marks; nothing is blocked. The gear opens the per-repo editor in place.

import { useState } from "react";
import {
  Check,
  Clock,
  Ellipsis,
  ExternalLink,
  LoaderCircle,
  Minus,
  RefreshCw,
  Settings2,
  X,
} from "lucide-react";
import { cn } from "cn";
import { ChecklistEditor } from "./ChecklistEditor";
import { Spark } from "./Spark";
import type { ChecklistStatusDTO } from "./checklist-types";
import type { UseChecklistResult } from "./useChecklist";

const STATUS_VISUALS: Record<ChecklistStatusDTO, { icon: typeof Check; className: string; label: string }> = {
  pass: { icon: Check, className: "text-success", label: "Passes" },
  fail: { icon: X, className: "text-destructive", label: "Fails" },
  pending: { icon: Clock, className: "text-warning", label: "Pending" },
  unknown: {
    icon: Ellipsis,
    className: "text-muted-foreground",
    label: "Can't tell",
  },
  not_applicable: {
    icon: Minus,
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
  const { data, loading, error, runningAi, waitsForReview } = checklist;
  const items = data?.items ?? [];
  const counted = items.filter((i) => i.status !== "not_applicable");
  const passed = counted.filter((i) => i.status === "pass").length;
  const failed = counted.filter((i) => i.status === "fail").length;
  const aiWaiting = items.filter((i) => i.kind === "ai" && i.status === "pending").length;
  const pending = counted.filter((i) => i.status === "pending").length;

  return (
    <section className="text-[11px]">
      <div className="flex items-center gap-1">
        <p className="flex min-w-0 flex-1 items-baseline gap-2 whitespace-nowrap">
          <span className="font-semibold tracking-wide text-muted-foreground uppercase">Checks</span>
          {data ? (
            failed > 0 ? (
              <span className="font-mono text-destructive">
                {failed} of {counted.length} fail
              </span>
            ) : pending > 0 ? (
              <span className="font-mono text-warning">
                {passed} of {counted.length} pass
              </span>
            ) : counted.length > 0 ? (
              <span className="font-mono text-success">all {counted.length} pass</span>
            ) : (
              <span className="text-muted-foreground">none apply</span>
            )
          ) : loading ? (
            <LoaderCircle className="size-3 self-center animate-spin text-muted-foreground" aria-label="Checking" />
          ) : null}
        </p>
        {items.some((i) => i.kind === "ai") && data?.aiConfigured && (
          <button
            type="button"
            onClick={() => void checklist.runAi()}
            disabled={runningAi}
            className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
            title={
              runningAi
                ? "Judging…"
                : `${data.aiPending > 0 ? "Judge now" : "Judge again"} — ask the AI provider every AI question (one model call)`
            }
            aria-label={data.aiPending > 0 ? "Judge now" : "Judge again"}
          >
            {runningAi ? <LoaderCircle className="size-3 animate-spin" aria-hidden /> : <Spark />}
          </button>
        )}
        <button
          type="button"
          onClick={checklist.refresh}
          disabled={loading}
          className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
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
            "flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground",
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
          {aiWaiting} <Spark /> {runningAi ? "being judged…" : waitsForReview ? "judged once the review finishes" : "not judged yet"}
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
                // Titles say what each check is; the result's detail ("1758 lines changed") is on hover.
                <li key={item.itemId} className="flex gap-1.5" title={item.detail ? `${visual.label}: ${item.detail}` : visual.label}>
                  <Icon
                    className={cn("mt-px size-3 shrink-0", visual.className, Icon === LoaderCircle && "animate-spin")}
                    aria-label={visual.label}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs">
                      {item.label}
                      {item.kind === "ai" && <Spark className="ml-1" title="Judged by the model" />}
                    </p>
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

        </>
      )}
    </section>
  );
}
