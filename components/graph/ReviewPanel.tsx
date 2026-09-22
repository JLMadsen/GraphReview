"use client";

// The AI review dock — advisory annotations only; it never blocks a review
// and never auto-posts to GitHub.
//
// ---------------------------------------------------------------------------
// Why this is a full-width dock under the canvas, not a sidebar card
// ---------------------------------------------------------------------------
// Everything else in the Graph tab's sidebar is a *control* (pick a diff) or
// a *list of names* (a component's files) — both survive 320px (`lg:w-80`).
// A finding does not: it is a component name, a verdict badge, a plain-
// English summary sentence, a `path/to/file.ts:120-148` location and a
// collapsible rationale paragraph. Stacked into a 320px column those wrap to
// five or six lines each, and a 20-component review becomes a single
// scrolling ribbon that can only be read one finding at a time — exactly the
// "use the whole page width, this is an analysis tool" complaint that made
// the Graph tab opt out of the repo shell's `max-w-6xl` cap in the first
// place (see app/repo/[repoId]/layout.tsx).
//
// So the dock sits in the main column, directly below the canvas, where it
// gets ~1600px on a wide screen and lays findings out in two or three
// columns. Nothing is behind an extra click: the progress bar, the cost
// counter, the filter chips and the findings themselves are all on the page
// as soon as a PR/ref target is selected. The graph keeps its full height,
// and three other cues point at the dock from above it — the coloured
// markers on the nodes, the finding counts in the canvas legend, and the
// selected component's findings in the sidebar panel.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Bot,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  ExternalLink,
  FileDiff,
  History,
  Info,
  LoaderCircle,
  RefreshCw,
  Settings2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { FileDiffModal } from "./FileDiffModal";
import { JobLogHover } from "./JobLogHover";
import {
  INTENT_ORDER,
  INTENT_VISUALS,
  compareIntent,
  countByIntent,
  formatConfidence,
  formatLocation,
  worstIntent,
} from "./review-visuals";
import {
  reviewTargetLabel,
  reviewTargetQuery,
  type FindingDTO,
  type IntentMatch,
  type ReviewFreshnessDTO,
  type ReviewProgressDTO,
  type ReviewStateDTO,
  type ReviewTargetDTO,
} from "./types";

const NUMBER = new Intl.NumberFormat("en-US");

export interface ReviewPanelProps {
  repoId: string;
  /** The PR / ref pair under review. The panel renders nothing without one. */
  target: ReviewTargetDTO | null;
  status: "idle" | "loading" | "ready" | "error";
  state: ReviewStateDTO;
  progress?: ReviewProgressDTO;
  findings: FindingDTO[];
  /** Whether the reviewed branch/PR has moved since the review ran (advisory; absent for legacy reviews). */
  freshness?: ReviewFreshnessDTO;
  aiConfigured: boolean;
  notice: string | null;
  noticeCode: string | null;
  rerunning: boolean;
  canRerun: boolean;
  onRerun: () => void;
  /** Mirrors the canvas selection, so the matching group is highlighted. */
  selectedComponentId?: string | null;
  /** Clicking a finding selects its component in the graph — same mechanism as tapping the node. */
  onSelectComponent: (componentId: string | null) => void;
}

const shortSha = (sha: string) => sha.slice(0, 7);

/** A short sha as a monospace chip; the full sha is on hover. */
function Sha({ sha }: { sha: string }) {
  return (
    <code
      className="rounded bg-secondary px-1 py-px font-mono text-[11px] text-foreground"
      title={sha}
    >
      {shortSha(sha)}
    </code>
  );
}

/** "3 h ago"-style relative time, coarse on purpose; empty when the timestamp is missing/invalid. */
function timeAgo(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Verdict badge: colour + glyph + word, so it survives both a dark surface and no colour perception at all. */
function IntentBadge({
  intent,
  compact,
}: {
  intent: IntentMatch;
  compact?: boolean;
}) {
  const visual = INTENT_VISUALS[intent];
  const Icon = visual.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border font-medium",
        compact ? "px-1.5 py-px text-[10px]" : "px-2 py-0.5 text-[11px]"
      )}
      style={{
        color: visual.text,
        borderColor: `${visual.color}59`,
        backgroundColor: `${visual.color}1f`,
      }}
      title={visual.description}
    >
      <Icon className={compact ? "size-2.5" : "size-3"} aria-hidden />
      {visual.label}
    </span>
  );
}

/** One finding. `<details>` gives the collapsible rationale for free — no state, keyboard-operable, and it prints open. */
function FindingCard({
  finding,
  onViewDiff,
}: {
  finding: FindingDTO;
  onViewDiff: (finding: FindingDTO) => void;
}) {
  const location = formatLocation(finding);
  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <IntentBadge intent={finding.intentMatch} />
        <span
          className="font-mono text-[10px] text-muted-foreground"
          title="Model-reported confidence"
        >
          {formatConfidence(finding.confidence)} confident
        </span>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-foreground/90">
        {finding.summary}
      </p>
      {location && (
        <div className="mt-1 flex items-center gap-1.5">
          <p
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
            title={location}
          >
            {location}
          </p>
          {finding.filePath && (
            <button
              type="button"
              onClick={() => onViewDiff(finding)}
              className="flex shrink-0 items-center gap-1 rounded text-[11px] text-muted-foreground transition-colors hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              title={`View the diff for ${finding.filePath}`}
            >
              <FileDiff className="size-3" aria-hidden />
              Diff
            </button>
          )}
        </div>
      )}
      {finding.rationale && (
        <details className="group mt-1.5">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-3 transition-transform group-open:rotate-90"
              aria-hidden
            />
            Why
          </summary>
          <p className="mt-1.5 border-l-2 border-border pl-2.5 text-[11px] leading-relaxed whitespace-pre-line text-muted-foreground">
            {finding.rationale}
          </p>
        </details>
      )}
    </li>
  );
}

export function ReviewPanel({
  repoId,
  target,
  status,
  state,
  progress,
  findings,
  freshness,
  aiConfigured,
  notice,
  noticeCode,
  rerunning,
  canRerun,
  onRerun,
  selectedComponentId,
  onSelectComponent,
}: ReviewPanelProps) {
  // Chip filters. Held here rather than lifted: they only ever narrow this
  // list — the graph markers deliberately keep showing everything, so the
  // canvas never disagrees with itself about which nodes were reviewed.
  const [hidden, setHidden] = useState<Set<IntentMatch>>(new Set());
  /** The finding whose file diff is open in `FileDiffModal`, or `null` when it's closed. */
  const [diffFinding, setDiffFinding] = useState<FindingDTO | null>(null);

  // A new target is a different review; carrying a "mismatch only" filter
  // across to it would silently hide the new findings.
  const targetKey = target ? reviewTargetLabel(target) : null;
  useEffect(() => {
    setHidden(new Set());
    setDiffFinding(null);
  }, [targetKey]);

  const counts = useMemo(() => countByIntent(findings), [findings]);

  const visibleFindings = useMemo(
    () => findings.filter((f) => !hidden.has(f.intentMatch)),
    [findings, hidden]
  );

  /** Grouped by component, worst group first, and worst finding first inside each group. */
  const groups = useMemo(() => {
    const byComponent = new Map<
      string,
      { id: string; name: string; worst: IntentMatch; findings: FindingDTO[] }
    >();
    for (const finding of visibleFindings) {
      const existing = byComponent.get(finding.componentId);
      if (existing) {
        existing.findings.push(finding);
        existing.worst = worstIntent(existing.worst, finding.intentMatch);
      } else {
        byComponent.set(finding.componentId, {
          id: finding.componentId,
          name: finding.componentName,
          worst: finding.intentMatch,
          findings: [finding],
        });
      }
    }
    const list = [...byComponent.values()];
    for (const group of list) {
      group.findings.sort(
        (a, b) =>
          compareIntent(a.intentMatch, b.intentMatch) ||
          b.confidence - a.confidence
      );
    }
    list.sort(
      (a, b) => compareIntent(a.worst, b.worst) || a.name.localeCompare(b.name)
    );
    return list;
  }, [visibleFindings]);

  if (!target) return null;

  const running = state === "queued" || state === "running";
  const total = progress?.total ?? 0;
  const done = (progress?.completed ?? 0) + (progress?.failed ?? 0);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const notConfigured = status === "ready" && !aiConfigured;
  // Freshness only means something for a settled review on screen: while a
  // re-run is in flight the answer is about to change, so say nothing.
  const showFreshness =
    Boolean(freshness) && status === "ready" && state === "completed" && !running && !rerunning;
  const isPullRequest = "prNumber" in target;
  const isQueueProblem = noticeCode === "queue_unavailable";
  const logsUrl = `/api/repos/${encodeURIComponent(repoId)}/review?${reviewTargetQuery(target)}&logs=1`;

  return (
    <>
    <section
      className="overflow-hidden rounded-xl bg-card ring-1 ring-border"
      aria-label="AI review"
    >
      {/* ---- Header: identity, cost counter, re-run --------------------- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3.5 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Bot className="size-4 text-brand" aria-hidden />
          AI review
        </h2>
        <span
          className="max-w-64 truncate rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          title={reviewTargetLabel(target)}
        >
          {reviewTargetLabel(target)}
        </span>

        {status === "loading" && (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" aria-hidden />
            Checking…
          </span>
        )}
        {running && (
          <JobLogHover logsUrl={logsUrl} label="Review job log">
            <span className="flex cursor-default items-center gap-1.5 text-[11px] font-medium text-brand">
              <LoaderCircle className="size-3 animate-spin" aria-hidden />
              {state === "queued" ? "Queued" : "Reviewing"}
            </span>
          </JobLogHover>
        )}
        {state === "failed" && (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-destructive">
            <TriangleAlert className="size-3" aria-hidden />
            Failed
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Running cost counter — visible in the moment, gating nothing. */}
          {progress && (
            <span
              className="hidden items-center gap-1.5 rounded-lg bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground sm:flex"
              title="Model calls and token usage for this review run — visibility only, nothing is capped."
            >
              <span className="text-foreground">
                {NUMBER.format(progress.calls)}
              </span>
              call{progress.calls === 1 ? "" : "s"}
              <span className="opacity-40">·</span>
              <span className="text-foreground">
                {NUMBER.format(progress.promptTokens)}
              </span>
              prompt
              <span className="opacity-40">+</span>
              <span className="text-foreground">
                {NUMBER.format(progress.completionTokens)}
              </span>
              completion tokens
            </span>
          )}
          {aiConfigured && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onRerun}
              disabled={!canRerun}
              title={
                canRerun
                  ? "Run the intent check again — existing findings are overwritten."
                  : "A review of this target is already in flight."
              }
            >
              {rerunning ? (
                <LoaderCircle className="animate-spin" aria-hidden />
              ) : (
                <RefreshCw aria-hidden />
              )}
              Re-run review
            </Button>
          )}
        </div>
      </div>

      {/* ---- Live progress --------------------------------------------- */}
      {progress && (running || rerunning) && (
        <div className="border-b border-border px-3.5 py-2.5">
          <div className="flex items-center gap-3">
            <div
              className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total || 1}
              aria-valuenow={done}
              aria-label="Components reviewed"
            >
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              <span className="text-foreground">{progress.completed}</span>
              {" / "}
              {total || "?"}
            </span>
            {progress.failed > 0 && (
              <span
                className="shrink-0 font-mono text-[11px] text-destructive"
                title="Components whose model call failed — each still gets one 'unknown' finding explaining the error."
              >
                {progress.failed} failed
              </span>
            )}
          </div>
          {progress.running.length > 0 && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <CircleDashed
                className="mt-px size-3 shrink-0 animate-spin text-brand"
                aria-hidden
              />
              <span className="truncate" title={progress.running.join(", ")}>
                {progress.running.join(", ")}
              </span>
            </p>
          )}
          {progress.unmatchedFiles > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground/80">
              {progress.unmatchedFiles} changed file
              {progress.unmatchedFiles === 1 ? "" : "s"} matched no analyzed
              component.
            </p>
          )}
        </div>
      )}

      {/* ---- Stale-review banner (advisory — the user decides) ---------- */}
      {showFreshness && freshness?.stale && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-warning/8 px-3.5 py-2.5 text-xs text-foreground/85"
        >
          <span className="flex min-w-0 items-start gap-2">
            <History className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            <span className="min-w-0">
              <span className="font-medium">
                {isPullRequest ? "The PR" : "The branch"} has new commits since
                this review
              </span>{" "}
              <span className="whitespace-nowrap">
                (<Sha sha={freshness.reviewedHeadSha} />
                <span aria-label="to"> → </span>
                <Sha sha={freshness.currentHeadSha} />)
              </span>
              {timeAgo(freshness.reviewedAt) && (
                <span className="text-muted-foreground">
                  {" "}
                  · reviewed {timeAgo(freshness.reviewedAt)}
                </span>
              )}
              <span className="text-muted-foreground">
                {" "}
                · the findings below may be out of date.
              </span>
            </span>
          </span>
          {aiConfigured && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="ml-auto"
              onClick={onRerun}
              disabled={!canRerun}
              title="Run the intent check again on the latest commits — existing findings are overwritten."
            >
              <RefreshCw aria-hidden />
              Re-run review
            </Button>
          )}
        </div>
      )}
      {showFreshness && freshness && !freshness.stale && !freshness.checkError && (
        <p className="flex items-center gap-1.5 border-b border-border px-3.5 py-1.5 text-[11px] text-muted-foreground">
          <CircleCheck className="size-3 shrink-0 text-success" aria-hidden />
          <span>
            Reviewed at <Sha sha={freshness.reviewedHeadSha} /> · up to date
            {timeAgo(freshness.reviewedAt)
              ? ` · reviewed ${timeAgo(freshness.reviewedAt)}`
              : ""}
          </span>
        </p>
      )}
      {showFreshness && freshness?.checkError && (
        <p
          className="flex items-start gap-1.5 border-b border-border px-3.5 py-1.5 text-[11px] text-muted-foreground"
          title={freshness.checkError}
        >
          <CircleHelp className="mt-px size-3 shrink-0" aria-hidden />
          <span className="min-w-0">
            Reviewed at <Sha sha={freshness.reviewedHeadSha} /> — couldn&apos;t
            check whether that is still current. {freshness.checkError}
          </span>
        </p>
      )}

      {/* ---- AI off / inline problems ----------------------------------- */}
      {notConfigured && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-info/8 px-3.5 py-2.5 text-xs text-foreground/80">
          <span className="flex items-center gap-2">
            <Info className="size-3.5 shrink-0 text-info" aria-hidden />
            <span>
              <span className="font-medium">AI review is off.</span> Configure
              an OpenAI-compatible provider to get intent checks on this diff.
            </span>
          </span>
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 text-[11px] font-medium transition-colors hover:bg-secondary"
          >
            <Settings2 className="size-3" aria-hidden />
            Open Settings
            <ExternalLink className="size-2.5 opacity-60" aria-hidden />
          </Link>
        </div>
      )}

      {notice && (
        <p
          className={cn(
            "flex items-start gap-2 border-b border-border px-3.5 py-2.5 text-xs",
            isQueueProblem
              ? "bg-warning/8 text-warning"
              : "bg-destructive/8 text-destructive"
          )}
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{notice}</span>
        </p>
      )}

      {/* ---- Filter chips ----------------------------------------------- */}
      {findings.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3.5 py-2.5">
          {INTENT_ORDER.map((intent) => {
            const visual = INTENT_VISUALS[intent];
            const Icon = visual.icon;
            const count = counts[intent];
            const on = !hidden.has(intent);
            return (
              <button
                key={intent}
                type="button"
                disabled={count === 0}
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev);
                    if (next.has(intent)) next.delete(intent);
                    else next.add(intent);
                    return next;
                  })
                }
                aria-pressed={on}
                title={`${visual.description} Click to ${on ? "hide" : "show"}.`}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35",
                  on
                    ? "hover:brightness-110"
                    : "border-transparent bg-muted text-muted-foreground line-through decoration-muted-foreground/50"
                )}
                style={
                  on
                    ? {
                        color: visual.text,
                        borderColor: `${visual.color}59`,
                        backgroundColor: `${visual.color}14`,
                      }
                    : undefined
                }
              >
                <Icon className="size-3" aria-hidden />
                {visual.label}
                <span className="font-mono">{count}</span>
              </button>
            );
          })}
          <span className="ml-auto text-[11px] text-muted-foreground">
            {groups.length} component{groups.length === 1 ? "" : "s"} ·{" "}
            {visibleFindings.length} finding
            {visibleFindings.length === 1 ? "" : "s"}
          </span>
        </div>
      )}

      {/* ---- Findings ---------------------------------------------------- */}
      {groups.length > 0 ? (
        // Capped and scrollable so the dock never pushes the page into an
        // endless scroll on a 20-component review, but tall enough that
        // several components are readable without scrolling at all.
        <div className="max-h-[52vh] overflow-y-auto p-3">
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {groups.map((group) => {
              const selected = group.id === selectedComponentId;
              const visual = INTENT_VISUALS[group.worst];
              return (
                <li
                  key={group.id}
                  className={cn(
                    "overflow-hidden rounded-lg border bg-background/40 transition-colors",
                    selected
                      ? "border-brand/60 ring-1 ring-brand/30"
                      : "border-border"
                  )}
                >
                  <button
                    type="button"
                    onClick={() =>
                      onSelectComponent(selected ? null : group.id)
                    }
                    className="flex w-full items-center gap-2 border-b border-border/70 px-3 py-2 text-left transition-colors hover:bg-secondary/60"
                    title={
                      selected
                        ? "Clear this component's selection in the graph"
                        : "Select this component in the graph"
                    }
                    aria-pressed={selected}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: visual.color,
                        boxShadow: `0 0 0 3px ${visual.color}26`,
                      }}
                      aria-hidden
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight"
                      title={group.name}
                    >
                      {group.name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {group.findings.length}
                    </span>
                  </button>
                  <ul className="divide-y divide-border/60">
                    {group.findings.map((finding) => (
                      <FindingCard
                        key={finding.id}
                        finding={finding}
                        onViewDiff={setDiffFinding}
                      />
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        status === "ready" &&
        !notConfigured && (
          <p className="px-3.5 py-4 text-xs text-muted-foreground">
            {findings.length > 0
              ? "Every finding is hidden by the filters above."
              : running
                ? "Waiting for the first component to come back…"
                : state === "failed"
                  ? "The review job failed before it produced any findings."
                  : "No findings for this diff yet."}
          </p>
        )
      )}

      {/* ---- Advisory footer ----------------------------- */}
      <p className="flex items-center gap-1.5 border-t border-border bg-muted/40 px-3.5 py-2 text-[11px] text-muted-foreground">
        <Info className="size-3 shrink-0" aria-hidden />
        Advisory only — AI can be wrong. Nothing here blocks a review or is
        posted to GitHub.
      </p>
    </section>
    <FileDiffModal
      repoId={repoId}
      target={target}
      finding={diffFinding}
      onClose={() => setDiffFinding(null)}
    />
    </>
  );
}
