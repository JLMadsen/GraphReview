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
  Boxes,
  Cable,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  ClipboardCopy,
  Ellipsis,
  ExternalLink,
  FileDiff,
  History,
  Info,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  Wrench,
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
  IMPACTED_COLOR,
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

/** `#rrggbb` → `rgba(…, alpha)`, for tints of the assessment colours. */
function tint(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The verdict as a small coloured label — shape, colour and word, so it reads without colour too. */
function SeverityBadge({ assessment, resolved }: { assessment: Assessment; resolved?: boolean }) {
  if (resolved) {
    return (
      <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-[2px] border border-success/30 bg-success/10 px-1.5 text-[10px] font-semibold tracking-wide text-success uppercase">
        <Check className="size-3" aria-hidden />
        Resolved
      </span>
    );
  }
  const visual = ASSESSMENT_VISUALS[assessment];
  const Icon = visual.icon;
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-[2px] border px-1.5 text-[10px] font-semibold tracking-wide uppercase"
      style={{ color: visual.text, borderColor: tint(visual.color, 0.35), background: tint(visual.color, 0.12) }}
      title={visual.description}
    >
      <Icon className="size-3" aria-hidden />
      {visual.label}
    </span>
  );
}

/** A quiet bordered chip for the facts under a finding's summary. */
function Chip({
  children,
  onClick,
  title,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
  className?: string;
}) {
  const classes = cn(
    "inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-[2px] border border-border bg-background/60 px-1.5 text-[11px] text-muted-foreground",
    onClick && "transition-colors hover:border-foreground/30 hover:text-foreground",
    className
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={classes} title={title}>
      {children}
    </button>
  ) : (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}

/**
 * One finding as a card: a coloured left edge and a labelled severity badge
 * (colour is never the only channel), the summary, then its facts as chips —
 * component (selects it on the map), file:line (opens the diff), kind, low
 * confidence — and its state (resolved, fixing). Defects carry a faint tint
 * so they stand out in a long list. Clicking the summary expands the
 * model's reasoning; agent replies (MCP) always show, as a thread.
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
  const [allReplies, setAllReplies] = useState(false);
  const location = formatLocation(finding);
  const resolved = Boolean(finding.resolvedAt);
  // The latest reply is what says where things stand; older ones fold away.
  const replies = finding.responses ?? [];
  const shownReplies = allReplies ? replies : replies.slice(-1);
  const fixing = !resolved && Boolean(finding.responses?.some((reply) => reply.kind === "fixing"));
  const settled = resolved || finding.assessment === "ok";
  const visual = ASSESSMENT_VISUALS[finding.assessment];
  const impact = isImpactFinding(finding);
  const tag = impact ? null : findingTag(finding);
  const edge = settled ? tint(resolved ? ASSESSMENT_VISUALS.ok.color : visual.color, 0.5) : visual.color;
  return (
    <li
      className={cn(
        "group/row rounded-[2px] border border-border/70 py-1.5 pr-1.5 pl-2.5 transition-colors",
        selected && "ring-1 ring-brand",
        settled && "opacity-70 hover:opacity-100"
      )}
      style={{
        borderLeft: `3px solid ${edge}`,
        background: !settled && finding.assessment === "defect" ? tint(visual.color, 0.06) : undefined,
      }}
    >
      <div className="flex items-start gap-2.5">
        <SeverityBadge assessment={finding.assessment} resolved={resolved} />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={finding.rationale ? open : undefined}
          disabled={!finding.rationale}
          className={cn(
            "min-w-0 flex-1 text-left text-[13px] leading-snug font-medium disabled:cursor-default",
            finding.rationale && "cursor-pointer hover:text-foreground",
            resolved && "font-normal text-muted-foreground line-through decoration-muted-foreground/40"
          )}
          title={finding.rationale ? (open ? "Hide the reasoning" : "Show the reasoning") : undefined}
        >
          {finding.summary}
          {finding.rationale && (
            <ChevronRight
              className={cn("ml-1 inline size-3 align-[-1px] text-muted-foreground transition", open && "rotate-90")}
              aria-hidden
            />
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {finding.filePath && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onViewDiff(finding)}
              title={
                impact
                  ? `Open ${finding.filePath} at the reviewed commit (the diff did not touch it)`
                  : `View the diff for ${finding.filePath}`
              }
            >
              <FileDiff aria-hidden />
              {impact ? "Open" : "Diff"}
            </Button>
          )}
          {finding.callFailed
            ? onRetry && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={onRetry}
                  className="text-destructive hover:text-destructive"
                  title="Run the failed parts of this review again — every other finding is kept"
                >
                  <RotateCcw aria-hidden /> Retry
                </Button>
              )
            : isResolvable(finding) && (
                <Button
                  type="button"
                  variant={resolved ? "ghost" : "outline"}
                  size="xs"
                  onClick={() => onSetResolved(finding.id, !resolved)}
                  title={
                    resolved
                      ? "Reopen this finding"
                      : "Mark this finding resolved — it then counts as OK in the overall verdict"
                  }
                >
                  {resolved ? <RotateCcw aria-hidden /> : <Check aria-hidden />}
                  {resolved ? "Reopen" : "Resolve"}
                </Button>
              )}
        </div>
      </div>

      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
        {finding.componentId && finding.componentName && (
          <Chip
            onClick={() => onSelectComponent(selected ? null : finding.componentId)}
            title={selected ? "Clear the selection" : `Select ${finding.componentName} on the map`}
            className={cn(selected && "border-brand text-foreground")}
          >
            <Boxes className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{finding.componentName}</span>
          </Chip>
        )}
        {location && (
          <Chip onClick={() => onViewDiff(finding)} title={location} className="font-mono">
            <span className="truncate">{location}</span>
          </Chip>
        )}
        {tag && <Chip title={finding.scope ? SCOPE_DESCRIPTIONS[finding.scope] : undefined}>{tag}</Chip>}
        {!settled && !finding.callFailed && finding.confidence < LOW_CONFIDENCE && (
          <Chip className="border-warning/40 font-mono text-warning" title="Model-reported confidence">
            {formatConfidence(finding.confidence)} sure
          </Chip>
        )}
        {finding.callFailed && (
          <Chip className="border-destructive/40 text-destructive" title="The model call behind this finding never completed">
            <TriangleAlert className="size-3" aria-hidden /> Call failed
          </Chip>
        )}
        {fixing && (
          <Chip className="border-brand/50 text-brand" title="An agent agreed with this finding and is fixing it">
            <Wrench className="size-3" aria-hidden /> Fixing
          </Chip>
        )}
      </div>

      {open && finding.rationale && (
        <p className="mt-2 rounded-[2px] border-l-2 border-border bg-secondary/40 px-2.5 py-1.5 text-xs leading-relaxed whitespace-pre-line text-muted-foreground">
          {finding.rationale}
        </p>
      )}
      {replies.length > 1 && (
        <button
          type="button"
          onClick={() => setAllReplies((v) => !v)}
          className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 transition", allReplies && "rotate-90")} aria-hidden />
          {allReplies ? "Show only the latest reply" : `${replies.length - 1} earlier repl${replies.length === 2 ? "y" : "ies"}`}
        </button>
      )}
      {shownReplies.length > 0 && (
        <ul className="mt-1.5 space-y-1.5">
          {shownReplies.map((reply) => (
            <li key={reply.id} className="rounded-[2px] border border-brand/25 bg-brand/5 px-2.5 py-1.5 text-xs leading-relaxed">
              <span
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                title={new Date(reply.createdAt).toLocaleString()}
              >
                <MessageSquare className="size-3 text-brand" aria-hidden />
                <span className="font-medium text-foreground">{reply.author}</span>
                {RESPONSE_LABELS[reply.kind]} · {timeAgo(reply.createdAt)}
              </span>
              <p className="mt-0.5 whitespace-pre-line">{reply.body}</p>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Which slice of the findings the list shows — set from the severity strip. */
type FindingFilter = "all" | "defect" | "concern" | "unknown" | "impact" | "settled";
type FindingBucket = Exclude<FindingFilter, "all">;

const BUCKETS: Array<{
  key: FindingBucket;
  label: string;
  color: string;
  text: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
}> = [
  ...(["defect", "concern", "unknown"] as const).map((key) => ({
    key,
    label: ASSESSMENT_VISUALS[key].label,
    color: ASSESSMENT_VISUALS[key].color,
    text: ASSESSMENT_VISUALS[key].text,
    icon: ASSESSMENT_VISUALS[key].icon,
    title: ASSESSMENT_VISUALS[key].description,
  })),
  {
    key: "impact",
    label: "Impact",
    color: IMPACTED_COLOR,
    text: ASSESSMENT_VISUALS.defect.text,
    icon: Cable,
    title: "Usages of a changed signature, type or constant that the change did not update. Usually in files the diff never touched.",
  },
  {
    key: "settled",
    label: "OK / resolved",
    color: ASSESSMENT_VISUALS.ok.color,
    text: ASSESSMENT_VISUALS.ok.text,
    icon: CircleCheck,
    title: "Changes that look right, and findings someone resolved.",
  },
];

/**
 * The review at a glance: a proportional bar of every finding by bucket,
 * and one chip per bucket that filters the list to it (click again to show
 * everything). Empty buckets are left out.
 */
function SeverityStrip({
  counts,
  filter,
  onFilter,
}: {
  counts: Record<FindingBucket, number>;
  filter: FindingFilter;
  onFilter: (filter: FindingFilter) => void;
}) {
  const shown = BUCKETS.filter((b) => counts[b.key] > 0);
  const total = shown.reduce((sum, b) => sum + counts[b.key], 0);
  if (total === 0) return null;
  return (
    <div className="mt-2.5 space-y-2">
      <div className="flex h-1.5 gap-px overflow-hidden rounded-[2px] bg-muted" aria-hidden>
        {shown.map((b) => (
          <div
            key={b.key}
            className="h-full transition-[width] duration-300"
            style={{
              width: `${(counts[b.key] / total) * 100}%`,
              background: b.key === "settled" ? tint(b.color, 0.45) : b.color,
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Filter findings">
        {shown.map((b) => {
          const active = filter === b.key;
          const Icon = b.icon;
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => onFilter(active ? "all" : b.key)}
              aria-pressed={active}
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-[2px] border px-2 text-[11px] transition-colors",
                active ? "text-foreground" : "border-border text-muted-foreground hover:text-foreground"
              )}
              style={active ? { borderColor: b.color, background: tint(b.color, 0.12) } : undefined}
              title={`${b.title} ${active ? "Click to show every finding." : "Click to show only these."}`}
            >
              <span style={{ color: b.text }}>
                <Icon className="size-3.5" aria-hidden />
              </span>
              <span className="font-mono font-semibold text-foreground">{counts[b.key]}</span>
              {b.label}
            </button>
          );
        })}
        {filter !== "all" && (
          <button
            type="button"
            onClick={() => onFilter("all")}
            className="px-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Show all
          </button>
        )}
      </div>
    </div>
  );
}

/** A heading over one bucket of the list, in the bucket's colour. */
function SectionHeading({ bucket, count }: { bucket: FindingBucket; count: number }) {
  const b = BUCKETS.find((x) => x.key === bucket)!;
  const Icon = b.icon;
  return (
    <h3
      className="flex items-center gap-1.5 pt-3 pb-1.5 text-[11px] font-semibold tracking-wide uppercase first:pt-1"
      style={{ color: b.text }}
      title={b.title}
    >
      <Icon className="size-3.5" aria-hidden />
      {bucket === "impact" ? "Impact · callers not updated" : b.label}
      <span className="font-mono text-muted-foreground">{count}</span>
      <span className="ml-1 h-px flex-1 bg-border" aria-hidden />
    </h3>
  );
}

/** A coloured banner for what needs attention before the findings: failures, a stale review, the PR-level verdict. */
function Callout({
  tone,
  icon: Icon,
  children,
  action,
  title,
}: {
  tone: "danger" | "warning" | "info";
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  action?: React.ReactNode;
  title?: string;
}) {
  return (
    <div
      role={tone === "info" ? undefined : "status"}
      title={title}
      className={cn(
        "mt-2 flex items-start gap-2 rounded-[2px] border border-l-[3px] px-2.5 py-1.5 text-xs leading-relaxed",
        tone === "danger" && "border-destructive/30 border-l-destructive bg-destructive/10 text-destructive",
        tone === "warning" && "border-warning/30 border-l-warning bg-warning/10 text-warning",
        tone === "info" && "border-border border-l-muted-foreground/50 bg-secondary/40 text-muted-foreground"
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** "Impact check incomplete: N usages were not checked" — a note, not a finding. */
function ImpactNote({ note }: { note: FindingDTO }) {
  return (
    <p className="flex items-start gap-1.5 pt-2 text-[11px] text-muted-foreground" title={note.rationale}>
      <Info className="mt-px size-3 shrink-0" aria-hidden />
      <span>{note.summary}</span>
    </p>
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

  // Exceptions first: open findings are bucketed by severity (impact —
  // callers the change left behind — is its own bucket), and OK and
  // resolved findings are "settled" and come last. The PR-level intent
  // verdict and impact notes each get their own place.
  const { intentFinding, buckets, notes, driveBys } = useMemo(() => {
    const buckets: Record<FindingBucket, FindingDTO[]> = { defect: [], concern: [], unknown: [], impact: [], settled: [] };
    const notes: FindingDTO[] = [];
    let intentFinding: FindingDTO | undefined;
    let driveBys = 0;
    for (const f of findings) {
      if (isIntentFinding(f)) intentFinding = f;
      else if (isImpactNote(f)) notes.push(f);
      else if (effectiveAssessment(f) === "ok") {
        buckets.settled.push(f);
        if (f.scope === "unmentioned") driveBys++;
      } else if (isImpactFinding(f)) buckets.impact.push(f);
      else buckets[f.assessment as "defect" | "concern" | "unknown"].push(f);
    }
    for (const key of Object.keys(buckets) as FindingBucket[]) buckets[key] = sortFindings(buckets[key]);
    return { intentFinding, buckets, notes, driveBys };
  }, [findings]);
  const counts = useMemo(
    () =>
      Object.fromEntries(Object.entries(buckets).map(([key, list]) => [key, list.length])) as Record<FindingBucket, number>,
    [buckets]
  );
  const [filter, setFilter] = useState<FindingFilter>("all");
  useEffect(() => {
    setFilter("all");
  }, [targetKey]);
  // A filter whose bucket emptied (everything resolved, a re-run) shows everything again.
  const activeFilter: FindingFilter = filter !== "all" && counts[filter] === 0 ? "all" : filter;
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

        <SeverityStrip counts={counts} filter={activeFilter} onFilter={setFilter} />

        {/* ---- Scrolls under the pinned header: problems first, as banners,
             then the PR-level verdict and one section per bucket ---------- */}
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto pr-1 pb-2">
          {notice && (
            <Callout tone={isQueueProblem ? "warning" : "danger"} icon={TriangleAlert}>
              {notice}
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
              {timeAgo(freshness.reviewedAt) ? `, reviewed ${timeAgo(freshness.reviewedAt)}` : ""}) — the findings may be out of
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
          {findings.length > 0 ? (
            <div>
              {intentFinding && activeFilter === "all" && (
                <div className="pt-1">
                  <h3 className="pb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    Delivers what it describes?
                  </h3>
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
              {BUCKETS.filter((b) => counts[b.key] > 0 && (activeFilter === "all" || activeFilter === b.key)).map((b) => (
                <section key={b.key} aria-label={b.label}>
                  <SectionHeading bucket={b.key} count={counts[b.key]} />
                  {b.key === "settled" && driveBys > 0 && (
                    <p
                      className="-mt-1 pb-1.5 text-[11px] text-muted-foreground"
                      title="Correct changes the description does not mention. Informational only."
                    >
                      {driveBys} of them not mentioned in the description
                    </p>
                  )}
                  <ul className="space-y-1.5">
                    {buckets[b.key].map((finding) => (
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
                  {b.key === "impact" && notes.map((note) => <ImpactNote key={note.id} note={note} />)}
                </section>
              ))}
              {counts.impact === 0 && activeFilter === "all" && notes.map((note) => <ImpactNote key={note.id} note={note} />)}
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
        </div>
      </section>
      <FileDiffModal repoId={repoId} target={target} finding={diffFinding} onClose={() => setDiffFinding(null)} />
    </>
  );
}
