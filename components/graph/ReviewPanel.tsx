"use client";

// The review dock — advisory annotations only; it never blocks a review and
// never auto-posts to GitHub.
//
// It sits under the PR map at full width (a finding is a verdict, a sentence,
// a file:line and a paragraph of reasoning — it doesn't survive a 320px
// sidebar), and it has two tabs:
//
//   - **Findings**, exceptions first. Four chips filter by severity — defect,
//     concern, unknown, OK/resolved — and OK starts hidden, behind a "Show N
//     OK" line, because a review of 50 OKs should read as one fact. Usages
//     the change left behind (the impact check) are grouped by the
//     declaration they use — "isPendingJobState was removed — 11 lines in 7
//     files" is one row, not eleven — and resolve together. A row's title
//     expands its reasoning, call sites and agent replies. A Structure
//     chip narrows the list to what static analysis found in the change's
//     shape — import cycles it creates (lib/jobs/target-graph.ts), no model.
//   - **Changed files**, every changed file sorted by how much it changed, with the
//     area it belongs to and how many open findings point at it.
//
// Both tabs follow the scope picked elsewhere: an area on the PR map (and,
// from the area inspector, one of its components). The verdict itself — "17
// need a look" and the PR-level "delivers what it describes?" — heads the
// left column (`ReviewSummary`); the dock is the list.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Ban,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleHelp,
  ExternalLink,
  History,
  Info,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { FileDiffModal } from "./FileDiffModal";
import { JobLogHover } from "./JobLogHover";
import {
  computeVerdict,
  isImpactNote,
  reviewMarkdown,
} from "./review-visuals";
import { FINDING_BUCKETS, emptyCounts, findingBucket, isAreaFinding, type FindingBucket, type PrAreas } from "./pr-areas";
import type { PrMapResponseDTO } from "./pr-map-types";
import {
  REVIEW_EFFORT_OPTIONS,
  formatAgo,
  reviewTargetLabel,
  reviewTargetQuery,
  type FindingDTO,
  type ReviewEffort,
  type ReviewFreshnessDTO,
  type ReviewProgressDTO,
  type ReviewStateDTO,
  type ReviewTargetDTO,
  type FindingCategory,
} from "./types";
import { FindingRow } from "./review/FindingRow";
import { ImpactGroupRow } from "./review/ImpactGroupRow";
import { STATIC_CATEGORIES, shortSha, BucketChips, Callout, Sha, FINDING_GRID, ImpactNote } from "./review/parts";
import { ReviewMenu } from "./review/ReviewMenu";
import { buildRows } from "./review/rows";
import { ReviewFilesTab, useChangedFiles } from "./review/ReviewFilesTab";
import { useCopyText } from "./review/useCopyText";
import { useTriageKeys } from "./review/useTriageKeys";

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
  /** Re-run only what failed (model call errors), keeping the other findings. */
  onRetryFailed: () => void;
  /** The last run was cancelled (see `useReview`). */
  cancelled: boolean;
  /** A cancel was sent and the run hasn't stopped yet. */
  cancelling: boolean;
  canCancel: boolean;
  /** Stops the queued or running review; findings that already came back are kept. */
  onCancel: () => void;
  /** A finding's component chip — opens that module (GraphView sends it to the app map). */
  onSelectComponent: (componentId: string | null) => void;
  /** Resolve (or reopen) a below-match finding. */
  onSetResolved: (findingId: string, resolved: boolean) => void;
  /** Effort level for the next run (automatic or re-run). Changing it does not start a run by itself. */
  effort: ReviewEffort;
  onEffortChange: (effort: ReviewEffort) => void;
  /** The dock has the whole column, the map folded away above it. */
  expanded?: boolean;
  /** Folds the map away (Expand) or brings it back (Show map). Absent: no button. */
  onToggleExpanded?: () => void;
  /** The PR map — the Changed files tab lists its files. */
  map: PrMapResponseDTO | null;
  /** The map's cards as areas — which area a finding belongs to. */
  areas: PrAreas;
  /** The area (card id) the dock is scoped to, if any. */
  scopeAreaId: string | null;
  /** The component (within that area) the dock is scoped to, if any. */
  scopeComponentId: string | null;
  onClearScope: () => void;
  componentName: (id: string) => string | undefined;
  /** Opens a changed file's diff (the Changed files tab). Absent when there is no diff to show. */
  onOpenFile?: (path: string) => void;
  /** A filter the chat asked for (filter_findings); a new object (nonce) applies it again. */
  filterRequest?: { nonce: number; buckets?: FindingBucket[]; category?: FindingCategory } | null;
  /** A finding the chat showed (show kind finding): listed, made the active row and scrolled to. A new object each time. */
  focusRequest?: { nonce: number; findingId: string } | null;
  /** A finding's Ask: puts it in the chat's input, to ask about. */
  onAskChat?: (finding: FindingDTO) => void;
}

const DEFAULT_SHOWN: Record<FindingBucket, boolean> = { defect: true, concern: true, unknown: true, fine: false };

type DockTab = "findings" | "files";

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
  onRetryFailed,
  cancelled,
  cancelling,
  canCancel,
  onCancel,
  onSelectComponent,
  onSetResolved,
  effort,
  onEffortChange,
  expanded = false,
  onToggleExpanded,
  map,
  areas,
  scopeAreaId,
  scopeComponentId,
  onClearScope,
  componentName,
  onOpenFile,
  filterRequest,
  focusRequest,
  onAskChat,
}: ReviewPanelProps) {
  /** The finding whose file diff is open in `FileDiffModal`, or `null` when it's closed. */
  const [diffFinding, setDiffFinding] = useState<FindingDTO | null>(null);
  const [tab, setTab] = useState<DockTab>("findings");
  const [shown, setShown] = useState<Record<FindingBucket, boolean>>(DEFAULT_SHOWN);
  /** Only one category of static-analysis findings (import cycles, infra), or every finding. */
  const [onlyCategory, setOnlyCategory] = useState<FindingCategory | null>(null);

  // A new target is a different review.
  const targetKey = target ? reviewTargetLabel(target) : null;
  useEffect(() => {
    setDiffFinding(null);
    setShown(DEFAULT_SHOWN);
    setOnlyCategory(null);
  }, [targetKey]);

  // A filter the chat set (filter_findings): verdicts and/or one category, on the findings tab.
  useEffect(() => {
    if (!filterRequest) return;
    if (filterRequest.buckets?.length) setShown(Object.fromEntries(FINDING_BUCKETS.map((b) => [b, filterRequest.buckets!.includes(b)])) as Record<FindingBucket, boolean>);
    setOnlyCategory(filterRequest.category ?? null);
    setTab("findings");
  }, [filterRequest]);

  const inScope = useMemo(() => {
    if (!scopeAreaId && !scopeComponentId) return () => true;
    return (finding: FindingDTO) =>
      (!scopeAreaId || areas.areaOf(finding) === scopeAreaId) &&
      (!scopeComponentId || finding.componentId === scopeComponentId);
  }, [areas, scopeAreaId, scopeComponentId]);

  const notes = useMemo(() => findings.filter(isImpactNote), [findings]);
  const inArea = useMemo(() => findings.filter((f) => isAreaFinding(f) && inScope(f)), [findings, inScope]);
  const staticCounts = useMemo(
    () => STATIC_CATEGORIES.map((c) => ({ ...c, count: inArea.filter((f) => f.category === c.category).length })).filter((c) => c.count > 0),
    [inArea]
  );
  const activeOnly = onlyCategory && staticCounts.some((c) => c.category === onlyCategory) ? onlyCategory : null;
  const scoped = useMemo(() => (activeOnly ? inArea.filter((f) => f.category === activeOnly) : inArea), [inArea, activeOnly]);
  const counts = useMemo(() => {
    const c = emptyCounts();
    for (const f of scoped) c[findingBucket(f)] += 1;
    return c;
  }, [scoped]);
  const rows = useMemo(() => buildRows(scoped), [scoped]);
  const visibleRows = useMemo(() => rows.filter((row) => shown[row.bucket]), [rows, shown]);

  const { activeKey, setActiveKey, registerRow } = useTriageKeys(tab === "findings", visibleRows);

  // A finding the chat showed: make sure its verdict and category are listed, then make its row the active one.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const finding = findings.find((f) => f.id === focusRequest.findingId);
    if (!finding) return;
    setTab("findings");
    setShown((s) => ({ ...s, [findingBucket(finding)]: true }));
    setOnlyCategory((c) => (c && c !== finding.category ? null : c));
    if (!inScope(finding)) onClearScope();
    setPendingFocus(finding.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);
  useEffect(() => {
    if (!pendingFocus) return;
    const row = visibleRows.find((r) => (r.kind === "one" ? r.finding.id === pendingFocus : r.findings.some((f) => f.id === pendingFocus)));
    if (!row) return;
    setActiveKey(row.key);
    setPendingFocus(null);
  }, [pendingFocus, visibleRows, setActiveKey]);
  const hiddenFine = shown.fine ? 0 : counts.fine;

  const files = useChangedFiles(map, scopeAreaId, scopeComponentId);

  const verdict = useMemo(() => computeVerdict(findings), [findings]);
  const [copied, copyText] = useCopyText();

  if (!target) return null;

  const handleCopyMarkdown = () => {
    if (!verdict) return;
    void copyText(reviewMarkdown(reviewTargetLabel(target), verdict, findings, freshness?.reviewedHeadSha));
  };

  const running = state === "queued" || state === "running";
  /** Placeholders for model calls that never completed — what "Retry failed" re-runs. */
  const failedCount = findings.filter((finding) => finding.callFailed).length;
  const retryFromRow = aiConfigured && canRerun ? onRetryFailed : undefined;
  const total = progress?.total ?? 0;
  const done = (progress?.completed ?? 0) + (progress?.failed ?? 0);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  // A re-run in flight is about to replace the cancelled one; say nothing.
  const showCancelled = cancelled && !running && !rerunning;
  const cancelledNote =
    total === 0 || !progress
      ? "Review cancelled before it started."
      : done === 0
        ? "Review cancelled before any component was reviewed."
        : done >= total
          ? "Review cancelled after every component was reviewed — the impact, intent and PR map checks didn't finish."
          : `Review cancelled after ${done} of ${total} components. Their findings are kept; the rest weren't reviewed this time.`;

  const notConfigured = status === "ready" && !aiConfigured;
  // Freshness only means something for a settled review on screen: while a
  // re-run is in flight the answer is about to change, so say nothing.
  const showFreshness = Boolean(freshness) && status === "ready" && state === "completed" && !running && !rerunning;
  const isPullRequest = "prNumber" in target;
  const isQueueProblem = noticeCode === "queue_unavailable";
  const logsUrl = `/api/repos/${encodeURIComponent(repoId)}/review?${reviewTargetQuery(target)}&logs=1`;
  const costTitle = progress
    ? `${NUMBER.format(progress.calls)} model call${progress.calls === 1 ? "" : "s"} · ` +
      `${NUMBER.format(progress.promptTokens)} prompt + ${NUMBER.format(progress.completionTokens)} completion tokens` +
      (progress.effort ? ` · ${REVIEW_EFFORT_OPTIONS.find((o) => o.value === progress.effort)?.label} effort` : "")
    : undefined;

  // When the review ran (and what it cost) lives on the Re-run button's
  // tooltip, so the dock's header fits on one row.
  const reviewedNote =
    showFreshness && freshness && !freshness.stale && !freshness.checkError
      ? `Reviewed at ${shortSha(freshness.reviewedHeadSha)}${formatAgo(freshness.reviewedAt) ? `, ${formatAgo(freshness.reviewedAt)}` : ""}${costTitle ? ` · ${costTitle}` : ""}`
      : costTitle;

  // Nothing reviewed yet: the empty dock becomes one big start button
  // (and the header's small one steps aside).
  const showStart =
    status === "ready" && aiConfigured && state === "none" && !running && !rerunning && !cancelled && findings.length === 0;

  const scopeArea = scopeAreaId ? areas.areas.get(scopeAreaId) : undefined;
  const scopeParts = [
    ...(scopeArea ? [scopeArea.node.name] : []),
    ...(scopeComponentId ? [componentName(scopeComponentId) ?? scopeComponentId] : []),
  ];
  const findingsCount = inArea.length;

  const tabButton = (value: DockTab, label: string, count: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === value}
      onClick={() => setTab(value)}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-1 pt-1 pb-2 text-[13px] transition-colors",
        tab === value
          ? "border-foreground font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
      <span className="font-mono text-[11px] text-muted-foreground">{count}</span>
    </button>
  );

  return (
    <>
      {/* Fills the space GraphView gives it under the map: the header stays
          put and the list scrolls inside. */}
      <section id="review" className="@container flex min-h-0 flex-1 flex-col border-t border-border bg-card px-4 pt-1" aria-label="Review">
        {/* ---- Header: tabs, filters, scope, then quiet controls ----------- */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border">
          <div role="tablist" aria-label="Review" className="flex items-center gap-3">
            {tabButton("findings", "Findings", findingsCount)}
            {tabButton("files", "Changed files", files.length)}
          </div>
          {tab === "findings" && findingsCount > 0 && (
            <div className="pb-1.5">
              <BucketChips counts={counts} shown={shown} onToggle={(b) => setShown((s) => ({ ...s, [b]: !s[b] }))} />
            </div>
          )}
          {tab === "findings" &&
            staticCounts.map((c) => (
              <button
                key={c.category}
                type="button"
                onClick={() => setOnlyCategory((v) => (v === c.category ? null : c.category))}
                aria-pressed={activeOnly === c.category}
                className={cn(
                  "mb-1.5 inline-flex h-6 items-center gap-1.5 rounded-[2px] border px-1.5 text-[11px] transition-colors",
                  activeOnly === c.category ? "border-foreground/40 bg-secondary text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                )}
                title={activeOnly === c.category ? `Showing only ${c.what}. Click to show every finding.` : `Show only ${c.what}.`}
              >
                {c.label}
                <span className="font-mono font-semibold">{c.count}</span>
              </button>
            ))}
          {scopeParts.length > 0 && (
            <span className="mb-1.5 inline-flex h-6 items-center gap-1 rounded-[2px] bg-brand/12 pr-0.5 pl-2 text-[11px] text-foreground">
              In {scopeParts.join(" › ")}
              <button
                type="button"
                onClick={onClearScope}
                className="rounded-[2px] p-1 text-muted-foreground hover:text-foreground"
                aria-label="Show the whole PR"
                title="Show the whole PR"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          )}

          <div className="mb-1.5 ml-auto flex items-center gap-1">
            {status === "loading" && (
              <span className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" aria-hidden />
                Checking…
              </span>
            )}
            {running && (
              <JobLogHover logsUrl={logsUrl} label="Review job log">
                <span className="flex cursor-default items-center gap-1.5 px-1 text-[11px] font-medium">
                  <LoaderCircle className="size-3 animate-spin" aria-hidden />
                  {state === "queued" ? "Queued" : "Reviewing"}
                </span>
              </JobLogHover>
            )}
            {running && (
              <button
                type="button"
                onClick={onCancel}
                disabled={!canCancel}
                className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] hover:bg-secondary disabled:opacity-60 disabled:hover:bg-transparent"
                title="Stop the review — findings that already came back are kept"
              >
                {cancelling ? "Cancelling…" : "Cancel"}
              </button>
            )}
            {showCancelled && (
              <span className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-muted-foreground">
                <Ban className="size-3" aria-hidden />
                Cancelled
              </span>
            )}
            {state === "failed" && !cancelled && (
              <span className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-destructive">
                <TriangleAlert className="size-3" aria-hidden />
                Failed
              </span>
            )}
            {onToggleExpanded && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={onToggleExpanded}
                aria-expanded={expanded}
                aria-label={expanded ? "Show map" : "Expand"}
                title={expanded ? "Show map — bring the map back above the review" : "Expand — fold the map away and give the review the whole column"}
              >
                {expanded ? <ChevronsDown aria-hidden /> : <ChevronsUp aria-hidden />}
              </Button>
            )}
            {aiConfigured && !showStart && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={onRerun}
                disabled={!canRerun}
                title={
                  (!canRerun
                    ? "A review of this target is already in flight."
                    : state === "none"
                      ? "Run the review at the selected effort."
                      : "Run the review again at the selected effort — existing findings are overwritten.") +
                  (reviewedNote ? `\n${reviewedNote}` : "")
                }
              >
                {rerunning ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
                {state === "none" && !rerunning ? "Review" : "Re-run"}
              </Button>
            )}
            <ReviewMenu
              effort={effort}
              onEffortChange={onEffortChange}
              aiConfigured={aiConfigured}
              canCopy={Boolean(verdict)}
              copied={copied}
              onCopy={handleCopyMarkdown}
            />
          </div>
        </div>

        {/* ---- Live progress ---------------------------------------------- */}
        {progress && (running || rerunning) && (
          <div className="mt-2">
            <div className="flex items-center gap-3">
              <div
                className="h-1 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={total || 1}
                aria-valuenow={done}
                aria-label="Components reviewed"
              >
                <div className="h-full bg-foreground/70 transition-[width] duration-300" style={{ width: `${pct}%` }} />
              </div>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground" title={costTitle}>
                <span className="text-foreground">{progress.completed}</span>/{total || "?"}
                {progress.failed > 0 && <span className="text-destructive"> · {progress.failed} failed</span>}
              </span>
            </div>
            {progress.running.length > 0 && (
              <p className="mt-1 flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <LoaderCircle className="mt-px size-3 shrink-0 animate-spin" aria-hidden />
                <span className="truncate" title={progress.running.join(", ")}>
                  {progress.running.join(", ")}
                </span>
              </p>
            )}
          </div>
        )}

        {/* ---- Scrolls under the pinned header: problems first, as banners,
             then the list ----------------------------------------------- */}
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {notice && (
            <Callout tone={isQueueProblem ? "warning" : "danger"} icon={TriangleAlert}>
              {notice}
            </Callout>
          )}
          {showCancelled && (
            <Callout tone="info" icon={Ban}>
              {cancelledNote}
            </Callout>
          )}
          {aiConfigured && failedCount > 0 && !running && (
            <Callout
              tone="danger"
              icon={TriangleAlert}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={onRetryFailed}
                  disabled={!canRerun}
                  title="Run only the parts whose model call failed again — every other finding is kept"
                >
                  <RotateCcw aria-hidden />
                  Retry {failedCount} failed
                </Button>
              }
            >
              {failedCount} part{failedCount === 1 ? "" : "s"} of the review could not be checked — the AI provider was busy or
              erroring. Their findings are placeholders, not a judgement of the code.
            </Callout>
          )}
          {showFreshness && freshness?.stale && (
            <Callout tone="warning" icon={History}>
              {isPullRequest ? "The PR" : "The branch"} has new commits since this review (<Sha sha={freshness.reviewedHeadSha} />
              {" → "}
              <Sha sha={freshness.currentHeadSha} />
              {formatAgo(freshness.reviewedAt) ? `, reviewed ${formatAgo(freshness.reviewedAt)}` : ""}) — the findings may be out of
              date.
            </Callout>
          )}
          {showFreshness && freshness?.checkError && (
            <Callout tone="info" icon={CircleHelp} title={freshness.checkError}>
              Reviewed at <Sha sha={freshness.reviewedHeadSha} /> — couldn&apos;t check whether that is still current.
            </Callout>
          )}
          {notConfigured && (
            <Callout tone="info" icon={Info}>
              Review is off — set up an OpenAI-compatible model provider to have each change explained and checked.{" "}
              <Link href="/settings" className="inline-flex items-center gap-0.5 text-foreground underline-offset-2 hover:underline">
                Settings <ExternalLink className="size-2.5 opacity-60" aria-hidden />
              </Link>
            </Callout>
          )}

          {tab === "findings" &&
            (findings.length > 0 ? (
              <>
                {visibleRows.length > 0 && (
                  <div
                    className={cn(
                      FINDING_GRID,
                      "sticky top-0 z-10 border-b border-border bg-card px-2 py-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
                    )}
                  >
                    <span>Severity</span>
                    <span>What</span>
                    <span className="hidden @3xl:block">Where</span>
                    <span
                      className="text-right font-mono font-normal tracking-normal normal-case"
                      title="Keyboard: J / K move, Enter expands, R resolves, D opens the file"
                    >
                      j k ↵ r d
                    </span>
                  </div>
                )}
                <ul>
                  {visibleRows.map((row) =>
                    row.kind === "group" ? (
                      <ImpactGroupRow
                        key={row.key}
                        active={activeKey === row.key}
                        onActivate={() => setActiveKey(row.key)}
                        register={(actions) => registerRow(row.key, actions)}
                        symbol={row.symbol}
                        change={row.change}
                        findings={row.findings}
                        onSelectComponent={onSelectComponent}
                        onViewDiff={setDiffFinding}
                        onSetResolved={onSetResolved}
                      />
                    ) : (
                      <FindingRow
                        key={row.key}
                        active={activeKey === row.key}
                        onActivate={() => setActiveKey(row.key)}
                        register={(actions) => registerRow(row.key, actions)}
                        finding={row.finding}
                        onSelectComponent={onSelectComponent}
                        onViewDiff={setDiffFinding}
                        onSetResolved={onSetResolved}
                        onRetry={retryFromRow}
                        onAskChat={onAskChat}
                      />
                    )
                  )}
                </ul>
                {visibleRows.length === 0 && (
                  <p className="px-2 py-4 text-xs text-muted-foreground">
                    {findingsCount === 0
                      ? scopeParts.length > 0
                        ? `No findings in ${scopeParts.join(" › ")}.`
                        : "No findings for this diff yet."
                      : "Nothing to show with these filters."}
                  </p>
                )}
                {hiddenFine > 0 && (
                  <button
                    type="button"
                    onClick={() => setShown((s) => ({ ...s, fine: true }))}
                    className="flex w-full items-center gap-1.5 px-2 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronRight className="size-3" aria-hidden />
                    Show {hiddenFine} OK
                  </button>
                )}
                {(!scopeAreaId || counts.defect > 0) && notes.map((note) => <ImpactNote key={note.id} note={note} />)}
              </>
            ) : showStart ? (
              <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 py-6 text-center">
                <button
                  type="button"
                  onClick={onRerun}
                  disabled={!canRerun}
                  title={reviewedNote ?? "Run the review at the selected effort."}
                  className="group flex size-16 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-primary transition-colors hover:bg-primary/20 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
                >
                  <Play className="ml-1 size-7 fill-current" aria-hidden />
                  <span className="sr-only">Review this diff</span>
                </button>
                <div className="space-y-1">
                  <p className="text-sm font-medium">Review this diff</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    Reviews start on their own only for open pull requests and branch comparisons.
                  </p>
                </div>
              </div>
            ) : (
              status === "ready" &&
              !notConfigured && (
                <p className="mt-2 px-2 text-xs text-muted-foreground">
                  {running
                    ? "Waiting for the first component to come back…"
                    : cancelled
                      ? `No findings. Press ${state === "none" ? "Review" : "Re-run"} to review this diff.`
                      : state === "failed"
                        ? "The review job failed before it produced any findings."
                        : state === "none" && !rerunning
                          ? "Not reviewed yet. Reviews start on their own only for open pull requests and branch comparisons — press Review to run one."
                          : "No findings for this diff yet."}
                </p>
              )
            ))}

          {tab === "files" && (
            <ReviewFilesTab
              files={files}
              findings={findings}
              mapLoaded={map !== null}
              scopeAreaId={scopeAreaId}
              scopeParts={scopeParts}
              componentName={componentName}
              onOpenFile={onOpenFile}
            />
          )}
        </div>
      </section>
      <FileDiffModal repoId={repoId} target={target} finding={diffFinding} onClose={() => setDiffFinding(null)} />
    </>
  );
}
