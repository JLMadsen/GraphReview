"use client";

// The PR prerequisite checklist (DESIGN.md §6.6), in the diff summary in the
// left column, under the review's verdict: a small "Checks" heading with the
// result beside it — "3 of 6 fail", "all 6 pass" — in the result's colour,
// and every item under it, always open. (The verdict above is the headline;
// the two are separate results and each says its own.) Failing items are
// only marks; nothing is blocked. The gear opens the per-repo editor in place.
// When the PR states acceptance criteria, one expandable item lists them,
// each with its verdict and evidence (DESIGN.md §6.27).

import { useState } from "react";
import {
  Check,
  ChevronRight,
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
import type { AcceptanceCriterionRowDTO, ChecklistItemResultDTO, ChecklistStatusDTO } from "./checklist-types";
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

const CRITERION_VISUALS: Record<AcceptanceCriterionRowDTO["verdict"], { status: ChecklistStatusDTO; label: string }> = {
  pass: { status: "pass", label: "Met" },
  fail: { status: "fail", label: "Not met" },
  unknown: { status: "unknown", label: "Can't tell" },
  pending: { status: "pending", label: "Not judged yet" },
};

export interface ChecklistPanelProps {
  repoId: string;
  checklist: UseChecklistResult;
  /** Opens a changed file's diff, scrolled to `lines` ("12" or "12-18"). */
  onOpenFile?: (path: string, lines?: string) => void;
}

export function ChecklistPanel({ repoId, checklist, onOpenFile }: ChecklistPanelProps) {
  const [editing, setEditing] = useState(false);
  const { data, loading, error, runningAi, waitsForReview } = checklist;
  const items = data?.items ?? [];
  const counted = items.filter((i) => i.status !== "not_applicable");
  const passed = counted.filter((i) => i.status === "pass").length;
  const failed = counted.filter((i) => i.status === "fail").length;
  const aiWaiting = items.filter((i) => i.kind === "ai" && i.status === "pending").length;
  const pending = counted.filter((i) => i.status === "pending").length;
  // Checks that can't apply here (CI, description, linked issue on a plain
  // commit range) are left out of the list; a hover on the count names them.
  const skipped = items.filter((i) => i.status === "not_applicable");
  const skippedNote = skipped.length > 0 ? `
Not shown — they don't apply here: ${skipped.map((i) => i.label).join(", ")}` : "";

  return (
    <section className="text-[11px]">
      <div className="flex items-center gap-1">
        <p className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden whitespace-nowrap">
          <span className="font-semibold tracking-wide text-muted-foreground uppercase">Checks</span>
          {data ? (
            failed > 0 ? (
              <span className="truncate font-mono text-destructive" title={`${failed} of ${counted.length} checks fail${skippedNote}`}>
                {failed}/{counted.length} ✕
              </span>
            ) : pending > 0 ? (
              <span className="truncate font-mono text-warning" title={`${passed} of ${counted.length} checks pass${skippedNote}`}>
                {passed}/{counted.length} ✓
              </span>
            ) : counted.length > 0 ? (
              <span className="truncate font-mono text-success" title={`All ${counted.length} checks pass${skippedNote}`}>
                ✓ {counted.length}
              </span>
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
            {counted.map((item) => {
              if (item.kind === "acceptance-criteria") {
                return <AcceptanceCriteriaItem key={item.itemId} item={item} onOpenFile={onOpenFile} />;
              }
              const visual = STATUS_VISUALS[item.status];
              const Icon = item.kind === "ai" && item.status === "pending" && runningAi ? LoaderCircle : visual.icon;
              return (
                // Titles say what each check is; the result's detail ("1758 lines changed") is on hover —
                // except a failing AI check, whose rationale is the finding itself and shows under it.
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
                    {item.kind === "ai" && item.status === "fail" && item.detail && (
                      <p className="mt-0.5 text-muted-foreground">{item.detail}</p>
                    )}
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

/** "Acceptance criteria 3/5", expandable to one row per criterion (DESIGN.md §6.27). */
function AcceptanceCriteriaItem({
  item,
  onOpenFile,
}: {
  item: ChecklistItemResultDTO;
  onOpenFile?: (path: string, lines?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const visual = STATUS_VISUALS[item.status];
  const Icon = visual.icon;
  const rows = item.criteria ?? [];
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full gap-1.5 text-left"
        title={`${visual.label}: ${item.detail}`}
      >
        <Icon className={cn("mt-px size-3 shrink-0", visual.className)} aria-label={visual.label} />
        <span className="min-w-0 flex-1 text-xs">
          {item.label}
          <Spark className="ml-1" title="Judged by the model during the AI review" />
        </span>
        <ChevronRight className={cn("mt-px size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
      </button>
      {open && (
        <ul className="mt-1 ml-[18px] space-y-1.5 border-l border-border pl-2">
          {rows.map((row, index) => {
            const rowVisual = CRITERION_VISUALS[row.verdict];
            const RowIcon = STATUS_VISUALS[rowVisual.status].icon;
            return (
              <li key={index} className="flex gap-1.5">
                <RowIcon className={cn("mt-px size-3 shrink-0", STATUS_VISUALS[rowVisual.status].className)} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-xs whitespace-pre-line">{row.text}</p>
                  <p className="mt-0.5 text-muted-foreground">
                    <span className={cn("font-medium", STATUS_VISUALS[rowVisual.status].className)}>{rowVisual.label}</span>
                    {" · "}
                    {row.source === "description" ? "from the description" : `from issue ${row.source}`}
                    {row.ticked && " (ticked there)"}
                  </p>
                  {row.reason && <p className="mt-0.5 text-muted-foreground">{row.reason}</p>}
                  {row.evidence.length > 0 && (
                    <p className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 font-mono">
                      {row.evidence.map((e) => {
                        const label = `${e.path.split("/").pop()}${e.lines ? `:${e.lines}` : ""}`;
                        return onOpenFile ? (
                          <button
                            key={`${e.path}:${e.lines ?? ""}`}
                            type="button"
                            onClick={() => onOpenFile(e.path, e.lines)}
                            className="underline-offset-2 hover:underline"
                            title={`Open the diff of ${e.path}${e.lines ? ` at line ${e.lines}` : ""}`}
                          >
                            {label}
                          </button>
                        ) : (
                          <span key={`${e.path}:${e.lines ?? ""}`} title={e.path}>
                            {label}
                          </span>
                        );
                      })}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
