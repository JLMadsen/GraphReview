"use client";

// The Graph tab toolbar's "Labels" control.
//
// This is the entry point for the AI pass that completes the three-tier
// hierarchy: it groups the module-tier components into domain boxes and
// writes a one-sentence description for each module. The domain
// tier's absence should be communicated in the UI, not silently
// mislabeled — so when a repo has no domains the button says exactly what
// pressing it will do, and when no AI provider is configured it says that
// instead of offering an action that cannot work.
//
// Everything here is presentational. The state, the POST and the polling
// live in `useLabels`; the collapse/expand of the compound boxes belongs to
// the Cytoscape instance and is passed down from `GraphCanvas`.

import {
  Ban,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleX,
  LoaderCircle,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { cn } from "cn";
import { JobLogHover } from "./JobLogHover";
import {
  formatAgo,
  formatLabelCost,
  labelPhaseLabel,
  type UseLabelsResult,
} from "./label-types";

export interface LabelsControlProps {
  labels: UseLabelsResult;
  /** Whether the canvas currently has any compound (domain) boxes to collapse. */
  hasDomains: boolean;
  /** `true` when every group is currently collapsed. */
  collapsed: boolean;
  onToggleCollapse: () => void;
  className?: string;
}

export function LabelsControl({
  labels,
  hasDomains,
  collapsed,
  onToggleCollapse,
  className,
}: LabelsControlProps) {
  const { aiConfigured, hasLabels, running, progress, status, logsUrl } = labels;

  // First GET still in flight: render a same-sized placeholder so the
  // toolbar doesn't jump when the answer lands.
  if (status === "loading") {
    return (
      <div
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground",
          className
        )}
      >
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        Labels…
      </div>
    );
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {aiConfigured ? (
        <button
          type="button"
          onClick={() => labels.generate({ force: false })}
          disabled={!labels.canGenerate}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
            "border-border bg-card text-foreground hover:bg-secondary",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
          title={
            hasLabels
              ? "Run the AI labeling pass again — replaces the domain groups and fills in any module that still has no description"
              : "Group the modules into domains and describe each one, using the configured AI provider"
          }
        >
          {running ? (
            <LoaderCircle className="size-3.5 animate-spin text-brand" aria-hidden />
          ) : (
            <Sparkles className="size-3.5 text-brand" aria-hidden />
          )}
          {running
            ? "Labeling…"
            : hasLabels
              ? "Re-generate labels"
              : "Generate labels"}
        </button>
      ) : (
        // Say why the domain tier is missing rather than pretending a
        // button would work. Never POSTs.
        <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground">
          <Sparkles className="size-3.5 opacity-60" aria-hidden />
          AI not configured —{" "}
          <a
            href="/settings"
            className="font-medium text-brand underline-offset-2 hover:underline"
          >
            Settings
          </a>
        </span>
      )}

      {/* Live progress + running cost counter. Hoverable: the job's
          own log lines (worker/index.ts) are one fetch away, for "what is it
          actually doing right now" beyond the done/total counter. */}
      {running && (
        <JobLogHover logsUrl={logsUrl} label="Labeling job log">
          <span className="flex cursor-default items-center gap-1.5 text-[11px] text-muted-foreground">
            {labels.cancelling ? (
              <span className="text-warning">Cancelling…</span>
            ) : progress ? (
              <>
                <span>{labelPhaseLabel(progress.phase)}</span>
                {progress.phase !== "saving" && (
                  <span className="font-mono text-foreground">
                    {progress.done}/{progress.total}
                  </span>
                )}
                <span className="opacity-40">·</span>
                <span className="font-mono">{formatLabelCost(progress)}</span>
              </>
            ) : (
              <span>Queued…</span>
            )}
          </span>
        </JobLogHover>
      )}

      {/* Stop a run. Hidden once it is saving — that phase is short and must
          finish, or the old domains would be gone with the new ones half
          written. */}
      {running && labels.canCancel && (
        <button
          type="button"
          onClick={labels.cancel}
          className="flex items-center gap-1 rounded-full border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
          title="Stop this labeling run. Nothing it produced is saved; the tokens already spent are not refunded."
        >
          <CircleX className="size-3" aria-hidden />
          Cancel
        </button>
      )}

      {/* How the last run ended, when that isn't obvious from what exists. */}
      {!running && labels.state === "cancelled" && (
        <span
          className="flex items-center gap-1 text-[11px] text-muted-foreground"
          title="The last labeling run was cancelled before it saved anything"
        >
          <Ban className="size-3" aria-hidden />
          Last run cancelled
          {formatAgo(labels.finishedAt) && ` ${formatAgo(labels.finishedAt)}`}
        </span>
      )}

      {/* What exists today, once a run has produced something. */}
      {!running && hasLabels && (
        <span
          className="text-[11px] text-muted-foreground"
          title="Domain groups and described modules currently stored for this repo"
        >
          <span className="font-mono text-foreground">{labels.domains}</span> domain
          {labels.domains === 1 ? "" : "s"}
          <span className="mx-1 opacity-40">·</span>
          <span className="font-mono text-foreground">
            {labels.describedModules}
          </span>
          /{labels.modules} described
          {labels.state === "completed" && formatAgo(labels.finishedAt) && (
            <>
              <span className="mx-1 opacity-40">·</span>
              labeled {formatAgo(labels.finishedAt)}
            </>
          )}
        </span>
      )}

      {hasDomains && (
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
          title={
            collapsed
              ? "Expand every domain group back into its modules"
              : "Collapse every domain group into a single node"
          }
          aria-pressed={collapsed}
        >
          {collapsed ? (
            <ChevronsUpDown className="size-3.5 opacity-70" aria-hidden />
          ) : (
            <ChevronsDownUp className="size-3.5 opacity-70" aria-hidden />
          )}
          {collapsed ? "Expand groups" : "Collapse groups"}
        </button>
      )}

      {labels.notice && (
        <span
          className="flex max-w-72 items-center gap-1.5 text-[11px] text-warning"
          title={labels.notice}
        >
          <TriangleAlert className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{labels.notice}</span>
        </span>
      )}
    </div>
  );
}
