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
// So the dock sits in the main column, directly below the canvas, at full
// width. It leads with the exceptions: the headline is "N need a look", the
// list is every finding still below `ok`, worst first, one row each —
// and the OK and resolved findings fold behind a single line, because a
// review of 25 OKs should read as one fact, not 25 cards. Confidence is
// only shown when it is low. The cost counter lives in a tooltip.
//
// A finding's colour is its *assessment* (is the change sound on its own
// terms); how it relates to the PR's description and what kind of change it
// is sit beside it as a neutral tag ("Drive-by fix"). Two more passes have
// their own place: the PR-level "does it deliver what it describes" verdict
// is one line under the headline, and usages the change left behind (the
// impact check) are their own section, since they point at files the diff
// never touched.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Cable,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  ClipboardCopy,
  Ellipsis,
  ExternalLink,
  History,
  Info,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { FileDiffModal } from "./FileDiffModal";
import { JobLogHover } from "./JobLogHover";
import {
  ASSESSMENT_VISUALS,
  compareAssessment,
  computeVerdict,
  effectiveAssessment,
  formatConfidence,
  findingTag,
  formatLocation,
  isImpactFinding,
  isImpactNote,
  isIntentFinding,
  isResolvable,
  reviewMarkdown,
  SCOPE_DESCRIPTIONS,
  worstAssessment,
} from "./review-visuals";
import { Spark } from "./Spark";
import {
  REVIEW_EFFORT_OPTIONS,
  reviewTargetLabel,
  reviewTargetQuery,
  type FindingDTO,
  type Assessment,
  type ReviewEffort,
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
  /** Re-run only what failed (model call errors), keeping the other findings. */
  onRetryFailed: () => void;
  /** Mirrors the canvas selection, so the matching group is highlighted. */
  selectedComponentId?: string | null;
  /** Clicking a finding selects its component in the graph — same mechanism as tapping the node. */
  onSelectComponent: (componentId: string | null) => void;
  /** Resolve (or reopen) a below-match finding. */
  onSetResolved: (findingId: string, resolved: boolean) => void;
  /** Effort level for the next run (automatic or re-run). Changing it does not start a run by itself. */
  effort: ReviewEffort;
  onEffortChange: (effort: ReviewEffort) => void;
}

const shortSha = (sha: string) => sha.slice(0, 7);

/** Findings below this confidence say so; above it the number is noise. */
const LOW_CONFIDENCE = 0.8;

/** A short sha as mono text; the full sha is on hover. */
function Sha({ sha }: { sha: string }) {
  return (
    <code className="font-mono text-[11px] text-foreground" title={sha}>
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

/** How each kind of agent reply reads above its text. */
const RESPONSE_LABELS: Record<NonNullable<FindingDTO["responses"]>[number]["kind"], string> = {
  answered: "answered",
  fixing: "agreed, fixing",
  comment: "commented",
};

/**
 * One finding as a row: verdict glyph (colour + shape + a label on hover —
 * colour is never the only channel), the summary, then component · file:line
 * · Diff · Why on one quiet line. `<details>` gives the collapsible rationale
 * for free — no state, keyboard-operable, and it prints open.
 */
function FindingRow({
  finding,
  selected,
  onSelectComponent,
  onViewDiff,
  onSetResolved,
  onRetry,
}: {
  finding: FindingDTO;
  selected: boolean;
  onSelectComponent: (componentId: string | null) => void;
  onViewDiff: (finding: FindingDTO) => void;
  onSetResolved: (findingId: string, resolved: boolean) => void;
  /** Present when failed calls can be retried right now. */
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const location = formatLocation(finding);
  const resolved = Boolean(finding.resolvedAt);
  const fixing = !resolved && Boolean(finding.responses?.some((reply) => reply.kind === "fixing"));
  const visual = ASSESSMENT_VISUALS[finding.assessment];
  const Icon = visual.icon;
  const impact = isImpactFinding(finding);
  const tag = impact ? null : findingTag(finding);
  return (
    <li className={cn("group/row flex gap-2.5 py-2", selected && "-mx-2 bg-brand-muted px-2")}>
      <span
        className={cn("mt-0.5 shrink-0", resolved && "opacity-45")}
        style={{ color: visual.text }}
        title={`${visual.label} — ${visual.description}`}
      >
        <Icon className="size-3.5" aria-label={visual.label} />
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={finding.rationale ? open : undefined}
          disabled={!finding.rationale}
          className={cn(
            "block w-full text-left text-[13px] leading-snug disabled:cursor-default",
            finding.rationale && "cursor-pointer hover:text-foreground",
            resolved && "text-muted-foreground line-through decoration-muted-foreground/40"
          )}
          title={finding.rationale ? (open ? "Hide the reasoning" : "Show the reasoning") : undefined}
        >
          {finding.summary}
          {finding.rationale && (
            <ChevronRight
              className={cn(
                "ml-1 inline size-3 align-[-1px] text-muted-foreground opacity-0 transition group-hover/row:opacity-100",
                open && "rotate-90 opacity-100"
              )}
              aria-hidden
            />
          )}
        </button>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {tag && (
            <span
              className="rounded-sm border border-border px-1 py-px text-[10px] leading-none"
              title={finding.scope ? SCOPE_DESCRIPTIONS[finding.scope] : undefined}
            >
              {tag}
            </span>
          )}
          {finding.componentId && finding.componentName && (
            <button
              type="button"
              onClick={() => onSelectComponent(selected ? null : finding.componentId)}
              className="max-w-48 truncate underline-offset-2 hover:text-foreground hover:underline"
              title={selected ? "Clear the selection" : `Select ${finding.componentName} on the map`}
            >
              {finding.componentName}
            </button>
          )}
          {location && (
            <span className="min-w-0 truncate font-mono" title={location}>
              {location}
            </span>
          )}
          {finding.filePath && (
            <button
              type="button"
              onClick={() => onViewDiff(finding)}
              className="underline-offset-2 hover:text-foreground hover:underline"
              title={impact ? `Open ${finding.filePath} at the reviewed commit (the diff did not touch it)` : `View the diff for ${finding.filePath}`}
            >
              {impact ? "open" : "diff"}
            </button>
          )}
          {!resolved && finding.confidence < LOW_CONFIDENCE && (
            <span className="font-mono text-warning" title="Model-reported confidence">
              {formatConfidence(finding.confidence)} sure
            </span>
          )}
          {resolved && <span className="text-success">resolved</span>}
          {fixing && (
            <span className="text-brand" title="An agent agreed with this finding and is fixing it">
              fixing
            </span>
          )}
        </div>
        {open && finding.rationale && (
          <p className="mt-1.5 border-l border-border pl-2.5 text-xs leading-relaxed whitespace-pre-line text-muted-foreground">
            {finding.rationale}
          </p>
        )}
        {finding.responses && (
          <ul className="mt-1.5 space-y-1 border-l border-brand/40 pl-2.5">
            {finding.responses.map((reply) => (
              <li key={reply.id} className="text-xs leading-relaxed">
                <span className="text-[11px] text-muted-foreground" title={new Date(reply.createdAt).toLocaleString()}>
                  {reply.author} · {RESPONSE_LABELS[reply.kind]} · {timeAgo(reply.createdAt)}
                </span>
                <p className="whitespace-pre-line">{reply.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      {finding.callFailed ? (
        onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="h-fit shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="Run the failed parts of this review again — every other finding is kept"
          >
            <span className="flex items-center gap-1">
              <RotateCcw className="size-3" aria-hidden /> Retry
            </span>
          </button>
        )
      ) : isResolvable(finding) && (
        <button
          type="button"
          onClick={() => onSetResolved(finding.id, !resolved)}
          className="h-fit shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          title={resolved ? "Reopen this finding" : "Mark this finding resolved — it then counts as OK in the overall verdict"}
        >
          {resolved ? (
            <span className="flex items-center gap-1">
              <RotateCcw className="size-3" aria-hidden /> Reopen
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <Check className="size-3" aria-hidden /> Resolve
            </span>
          )}
        </button>
      )}
    </li>
  );
}

/** What the verdict tooltip says wherever the verdict is shown. */
const ADVISORY = "Judged by the model on each change's own merits — it can be wrong. Nothing here blocks the PR or is posted anywhere.";

/**
 * The review's verdict in one line — "2 need a look", "All 28 OK",
 * "Reviewing 3/7" — in the worst verdict's colour. It heads the review under
 * the map (`heading`); as a button it jumps to the findings.
 */
export function ReviewHeadline({
  status,
  state,
  progress,
  findings,
  aiConfigured,
  as = "button",
}: Pick<ReviewPanelProps, "status" | "state" | "progress" | "findings" | "aiConfigured"> & {
  as?: "button" | "heading";
}) {
  const running = state === "queued" || state === "running";
  const open = findings.filter((f) => effectiveAssessment(f) !== "ok");
  const judged = findings.filter((f) => !isImpactNote(f)).length;
  const worst = open.reduce<Assessment | null>((w, f) => (w ? worstAssessment(w, f.assessment) : f.assessment), null);
  const jump = () => document.getElementById("review")?.scrollIntoView({ behavior: "smooth", block: "start" });

  let body: React.ReactNode;
  if (status === "ready" && !aiConfigured) {
    body = <span className="text-muted-foreground">Review is off</span>;
  } else if (running && findings.length === 0) {
    body = (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        Reviewing{progress?.total ? ` ${progress.completed}/${progress.total}` : "…"}
      </span>
    );
  } else if (worst) {
    const visual = ASSESSMENT_VISUALS[worst];
    const Icon = visual.icon;
    body = (
      <span className="flex items-center gap-1.5" style={{ color: visual.text }}>
        <Icon className="size-4" aria-hidden />
        {open.length} need{open.length === 1 ? "s" : ""} a look
      </span>
    );
  } else if (findings.length > 0) {
    const Icon = ASSESSMENT_VISUALS.ok.icon;
    body = (
      <span className="flex items-center gap-1.5" style={{ color: ASSESSMENT_VISUALS.ok.text }}>
        <Icon className="size-4" aria-hidden />
        {judged === 1 ? "OK" : `All ${judged} OK`}
      </span>
    );
  } else if (status === "loading") {
    body = <span className="text-muted-foreground">Checking…</span>;
  } else {
    body = <span className="text-muted-foreground">Not reviewed yet</span>;
  }

  if (as === "heading") {
    return (
      <h2 className="flex items-center gap-1.5 text-[15px] leading-tight font-medium" title={ADVISORY}>
        {body}
        {findings.length > 0 && running && (
          <LoaderCircle className="size-3 animate-spin text-muted-foreground" aria-label="Still reviewing" />
        )}
        <Spark title={ADVISORY} />
      </h2>
    );
  }

  return (
    <button
      type="button"
      onClick={jump}
      className="flex w-full items-center gap-2 text-left text-[15px] leading-tight font-medium"
      title={`${ADVISORY} Click to see the findings.`}
    >
      {body}
      {findings.length > 0 && running && (
        <LoaderCircle className="size-3 animate-spin text-muted-foreground" aria-label="Still reviewing" />
      )}
      <Spark className="ml-auto" title={ADVISORY} />
    </button>
  );
}

/** Secondary review actions: effort for the next run, and copying the review. */
function ReviewMenu({
  effort,
  onEffortChange,
  aiConfigured,
  canCopy,
  copied,
  onCopy,
}: {
  effort: ReviewEffort;
  onEffortChange: (effort: ReviewEffort) => void;
  aiConfigured: boolean;
  canCopy: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!aiConfigured && !canCopy) return null;
  return (
    <div ref={ref} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="More review actions"
        title="More"
      >
        <Ellipsis aria-hidden />
      </Button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-56 rounded-md border border-border bg-popover p-1 text-xs shadow-lg">
          {aiConfigured && (
            <label className="flex items-center justify-between gap-2 rounded-sm px-2 py-1.5">
              <span className="text-muted-foreground">Effort next run</span>
              <select
                value={effort}
                onChange={(event) => onEffortChange(event.target.value as ReviewEffort)}
                className="rounded-sm border border-border bg-transparent px-1 py-0.5 text-[11px] outline-none focus-visible:border-brand"
                title={`${REVIEW_EFFORT_OPTIONS.find((o) => o.value === effort)?.description ?? ""} Larger diffs are split into several calls rather than cut off.`}
              >
                {REVIEW_EFFORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} title={option.description}>
                    {option.label} · {option.budget}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canCopy && (
            <button
              type="button"
              onClick={() => {
                onCopy();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-secondary"
              title="The overall verdict and every open/resolved finding"
            >
              {copied ? <Check className="size-3.5" aria-hidden /> : <ClipboardCopy className="size-3.5" aria-hidden />}
              {copied ? "Copied" : "Copy as Markdown"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function sortFindings(list: FindingDTO[]): FindingDTO[] {
  return [...list].sort(
    (a, b) =>
      compareAssessment(effectiveAssessment(a), effectiveAssessment(b)) ||
      compareAssessment(a.assessment, b.assessment) ||
      b.confidence - a.confidence ||
      (a.componentName || "").localeCompare(b.componentName || "")
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
  onRetryFailed,
  selectedComponentId,
  onSelectComponent,
  onSetResolved,
  effort,
  onEffortChange,
}: ReviewPanelProps) {
  /** The finding whose file diff is open in `FileDiffModal`, or `null` when it's closed. */
  const [diffFinding, setDiffFinding] = useState<FindingDTO | null>(null);

  // A new target is a different review.
  const targetKey = target ? reviewTargetLabel(target) : null;
  useEffect(() => {
    setDiffFinding(null);
  }, [targetKey]);

  // Exceptions first: anything still below `ok` needs a look; OK and
  // resolved findings are "settled" and fold behind one line. The PR-level
  // intent verdict and the impact check each get their own place.
  const { intentFinding, open, impactOpen, notes, settled, driveBys } = useMemo(() => {
    const open: FindingDTO[] = [];
    const impactOpen: FindingDTO[] = [];
    const notes: FindingDTO[] = [];
    const settled: FindingDTO[] = [];
    let intentFinding: FindingDTO | undefined;
    let driveBys = 0;
    for (const f of findings) {
      if (isIntentFinding(f)) intentFinding = f;
      else if (isImpactNote(f)) notes.push(f);
      else if (effectiveAssessment(f) === "ok") {
        settled.push(f);
        if (f.scope === "unmentioned") driveBys++;
      } else (isImpactFinding(f) ? impactOpen : open).push(f);
    }
    return {
      intentFinding,
      open: sortFindings(open),
      impactOpen: sortFindings(impactOpen),
      notes,
      settled: sortFindings(settled),
      driveBys,
    };
  }, [findings]);
  const components = useMemo(
    () => new Set(findings.filter((f) => f.category === "change").map((f) => f.componentId)).size,
    [findings]
  );

  const verdict = useMemo(() => computeVerdict(findings), [findings]);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    []
  );

  if (!target) return null;

  const handleCopyMarkdown = async () => {
    if (!verdict) return;
    const text = reviewMarkdown(reviewTargetLabel(target), verdict, findings, freshness?.reviewedHeadSha);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (plain http on a non-localhost host):
      // fall back to a hidden textarea and the legacy copy command.
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  const running = state === "queued" || state === "running";
  /** Placeholders for model calls that never completed — what "Retry failed" re-runs. */
  const failedCount = findings.filter((finding) => finding.callFailed).length;
  const retryFromRow = aiConfigured && canRerun ? onRetryFailed : undefined;
  const total = progress?.total ?? 0;
  const done = (progress?.completed ?? 0) + (progress?.failed ?? 0);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

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

  return (
    <>
      {/* Fills the space GraphView gives it under the map: the header stays
          put and the findings scroll inside. */}
      <section id="review" className="flex min-h-0 flex-1 flex-col border-t border-border pt-3" aria-label="Review">
        {/* ---- Header: the headline, then quiet controls ------------------ */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <ReviewHeadline
            as="heading"
            status={status}
            state={state}
            progress={progress}
            findings={findings}
            aiConfigured={aiConfigured}
          />
          {findings.length > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground" title={costTitle}>
              {findings.length} finding{findings.length === 1 ? "" : "s"} · {components} component{components === 1 ? "" : "s"}
            </span>
          )}
          {status === "loading" && (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" aria-hidden />
              Checking…
            </span>
          )}
          {running && (
            <JobLogHover logsUrl={logsUrl} label="Review job log">
              <span className="flex cursor-default items-center gap-1.5 text-[11px] font-medium">
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
          {showFreshness && freshness && !freshness.stale && !freshness.checkError && (
            <span className="text-[11px] text-muted-foreground">
              at <Sha sha={freshness.reviewedHeadSha} />
              {timeAgo(freshness.reviewedAt) ? ` · ${timeAgo(freshness.reviewedAt)}` : ""}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            {aiConfigured && failedCount > 0 && !running && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={onRetryFailed}
                disabled={!canRerun}
                className="text-destructive hover:text-destructive"
                title="Run only the parts whose model call failed again (the provider was busy or erroring) — every other finding is kept"
              >
                <RotateCcw aria-hidden />
                Retry {failedCount} failed
              </Button>
            )}
            {aiConfigured && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={onRerun}
                disabled={!canRerun}
                title={
                  !canRerun
                    ? "A review of this target is already in flight."
                    : state === "none"
                      ? "Run the review at the selected effort."
                      : "Run the review again at the selected effort — existing findings are overwritten."
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
              onCopy={() => void handleCopyMarkdown()}
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
                <CircleDashed className="mt-px size-3 shrink-0 animate-spin" aria-hidden />
                <span className="truncate" title={progress.running.join(", ")}>
                  {progress.running.join(", ")}
                </span>
              </p>
            )}
          </div>
        )}

        {/* ---- Stale review (advisory — the user decides) ----------------- */}
        {showFreshness && freshness?.stale && (
          <p role="status" className="mt-2 flex items-start gap-1.5 text-[11px] text-warning">
            <History className="mt-px size-3 shrink-0" aria-hidden />
            <span>
              {isPullRequest ? "The PR" : "The branch"} has new commits since this review (<Sha sha={freshness.reviewedHeadSha} />
              {" → "}
              <Sha sha={freshness.currentHeadSha} />
              {timeAgo(freshness.reviewedAt) ? `, reviewed ${timeAgo(freshness.reviewedAt)}` : ""}) — the findings may be
              out of date.
            </span>
          </p>
        )}
        {showFreshness && freshness?.checkError && (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground" title={freshness.checkError}>
            <CircleHelp className="mt-px size-3 shrink-0" aria-hidden />
            <span>
              Reviewed at <Sha sha={freshness.reviewedHeadSha} /> — couldn&apos;t check whether that is still current.
            </span>
          </p>
        )}

        {/* ---- AI off / inline problems ----------------------------------- */}
        {notConfigured && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Info className="size-3 shrink-0" aria-hidden />
            Review is off — set up an OpenAI-compatible model provider to have each change explained and checked.
            <Link href="/settings" className="inline-flex items-center gap-0.5 text-foreground underline-offset-2 hover:underline">
              Settings <ExternalLink className="size-2.5 opacity-60" aria-hidden />
            </Link>
          </p>
        )}
        {notice && (
          <p className={cn("mt-2 flex items-start gap-1.5 text-[11px]", isQueueProblem ? "text-warning" : "text-destructive")}>
            <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
            <span className="min-w-0">{notice}</span>
          </p>
        )}

        {/* ---- Findings: what needs a look, then the settled ones --------- */}
        {findings.length > 0 ? (
          <div className="mt-1.5 min-h-0 flex-1 overflow-y-auto pr-1">
            {intentFinding && (
              <div className="mb-1 border-b border-border/70">
                <p className="pt-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  Delivers what it describes?
                </p>
                <ul>
                  <FindingRow
                    finding={intentFinding}
                    selected={false}
                    onSelectComponent={onSelectComponent}
                    onViewDiff={setDiffFinding}
                    onSetResolved={onSetResolved}
                    onRetry={retryFromRow}
                  />
                </ul>
              </div>
            )}
            {open.length > 0 && (
              <ul className="divide-y divide-border/70">
                {open.map((finding) => (
                  <FindingRow
                    key={finding.id}
                    finding={finding}
                    selected={finding.componentId === selectedComponentId}
                    onSelectComponent={onSelectComponent}
                    onViewDiff={setDiffFinding}
                    onSetResolved={onSetResolved}
                    onRetry={retryFromRow}
                  />
                ))}
              </ul>
            )}
            {(impactOpen.length > 0 || notes.length > 0) && (
              <div className={cn(open.length > 0 && "border-t border-border/70", "pt-2")}>
                <p
                  className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
                  title="Usages of a changed signature, type or constant that the change did not update. They are usually in files the diff never touched."
                >
                  <Cable className="size-3" aria-hidden />
                  Impact · {impactOpen.length} caller{impactOpen.length === 1 ? "" : "s"} not updated
                </p>
                {impactOpen.length > 0 && (
                  <ul className="divide-y divide-border/70">
                    {impactOpen.map((finding) => (
                      <FindingRow
                        key={finding.id}
                        finding={finding}
                        selected={Boolean(finding.componentId) && finding.componentId === selectedComponentId}
                        onSelectComponent={onSelectComponent}
                        onViewDiff={setDiffFinding}
                        onSetResolved={onSetResolved}
                        onRetry={retryFromRow}
                      />
                    ))}
                  </ul>
                )}
                {notes.map((note) => (
                  <p key={note.id} className="flex items-start gap-1.5 py-1.5 text-[11px] text-muted-foreground" title={note.rationale}>
                    <Info className="mt-px size-3 shrink-0" aria-hidden />
                    <span>{note.summary}</span>
                  </p>
                ))}
              </div>
            )}
            {settled.length > 0 && (
              <>
                {(open.length > 0 || impactOpen.length > 0 || notes.length > 0 || intentFinding) && (
                  <p className="flex items-center gap-1.5 border-t border-border/70 pt-3 pb-1 text-[11px] text-muted-foreground">
                    <CircleCheck className="size-3 text-success" aria-hidden />
                    {settled.length} OK or resolved
                    {driveBys > 0 && (
                      <span title="Correct changes the description does not mention. Informational only.">
                        · {driveBys} unmentioned
                      </span>
                    )}
                  </p>
                )}
                <ul className="divide-y divide-border/70">
                  {settled.map((finding) => (
                    <FindingRow
                      key={finding.id}
                      finding={finding}
                      selected={finding.componentId === selectedComponentId}
                      onSelectComponent={onSelectComponent}
                      onViewDiff={setDiffFinding}
                      onSetResolved={onSetResolved}
                      onRetry={retryFromRow}
                    />
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : (
          status === "ready" &&
          !notConfigured && (
            <p className="mt-2 text-xs text-muted-foreground">
              {running
                ? "Waiting for the first component to come back…"
                : state === "failed"
                  ? "The review job failed before it produced any findings."
                  : state === "none" && !rerunning
                    ? "Not reviewed yet. Reviews start on their own only for open pull requests and branch comparisons — press Review to run one."
                    : "No findings for this diff yet."}
            </p>
          )
        )}

      </section>
      <FileDiffModal repoId={repoId} target={target} finding={diffFinding} onClose={() => setDiffFinding(null)} />
    </>
  );
}
