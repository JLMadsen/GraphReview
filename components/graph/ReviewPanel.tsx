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
//     expands its reasoning, call sites and agent replies.
//   - **Files**, every changed file sorted by how much it changed, with the
//     area it belongs to and how many open findings point at it.
//
// Both tabs follow the scope picked elsewhere: an area on the PR map (and,
// from the area inspector, one of its components). The verdict itself — "17
// need a look" and the PR-level "delivers what it describes?" — heads the
// left column (`ReviewSummary`); the dock is the list.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Boxes,
  Check,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleHelp,
  ClipboardCopy,
  Ellipsis,
  ExternalLink,
  FileDiff,
  History,
  Info,
  LoaderCircle,
  MessageSquare,
  Minus,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { FileDiffModal } from "./FileDiffModal";
import { JobLogHover } from "./JobLogHover";
import { STATUS_BADGES } from "./PrMapNode";
import {
  ASSESSMENT_VISUALS,
  compareAssessment,
  computeVerdict,
  formatConfidence,
  findingTag,
  formatLocation,
  impactChange,
  impactReasons,
  impactSymbol,
  isImpactFinding,
  isImpactNote,
  isResolvable,
  reviewMarkdown,
  SCOPE_DESCRIPTIONS,
} from "./review-visuals";
import { FINDING_BUCKETS, emptyCounts, findingBucket, isAreaFinding, type FindingBucket, type PrAreas } from "./pr-areas";
import type { PrMapFileDTO, PrMapResponseDTO } from "./pr-map-types";
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
  /** The PR map — the Files tab lists its files. */
  map: PrMapResponseDTO | null;
  /** The map's cards as areas — which area a finding belongs to. */
  areas: PrAreas;
  /** The area (card id) the dock is scoped to, if any. */
  scopeAreaId: string | null;
  /** The component (within that area) the dock is scoped to, if any. */
  scopeComponentId: string | null;
  onClearScope: () => void;
  componentName: (id: string) => string | undefined;
  /** Opens a changed file's diff (the Files tab). Absent when there is no diff to show. */
  onOpenFile?: (path: string) => void;
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
function SeverityBadge({
  assessment,
  resolved,
  failed,
}: {
  assessment: Assessment;
  resolved?: boolean;
  failed?: boolean;
}) {
  if (resolved) {
    return (
      <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-[2px] border border-success/30 bg-success/10 px-1.5 text-[10px] font-semibold tracking-wide text-success uppercase">
        <Check className="size-3" aria-hidden />
        Resolved
      </span>
    );
  }
  const visual = ASSESSMENT_VISUALS[assessment];
  const Icon = failed ? Minus : visual.icon;
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-[2px] border px-1.5 text-[10px] font-semibold tracking-wide whitespace-nowrap uppercase"
      style={{ color: visual.text, borderColor: tint(visual.color, 0.35), background: tint(visual.color, 0.12) }}
      title={failed ? "The model call behind this never completed — nothing was judged." : visual.description}
    >
      <Icon className="size-3" aria-hidden />
      {failed ? "Not run" : visual.label}
    </span>
  );
}

/** A quiet bordered chip for the facts under a finding's title. */
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

/** The grid every findings row (and the header above them) lays out on: badge · what · where · actions. */
const FINDING_GRID =
  "grid grid-cols-[76px_minmax(0,1fr)_auto] gap-x-3 @3xl:grid-cols-[76px_minmax(0,1fr)_minmax(0,200px)_auto]";

/** What the dock's keys do to a row: Enter, R and D. */
interface RowActions {
  toggle: () => void;
  resolve: () => void;
  open: () => void;
}

/** A row's part in keyboard navigation: whether it is the current one, and how it reports its actions. */
interface RowKeyboardProps {
  active?: boolean;
  onActivate?: () => void;
  register?: (actions: RowActions | null) => void;
}

/** The current row's ring, and keeping it in view as J/K move it. */
function useRowKeyboard(
  { active, register }: RowKeyboardProps,
  actions: RowActions
): React.RefObject<HTMLLIElement | null> {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  // Re-registered every render so the actions always see the current finding.
  useEffect(() => {
    register?.(actions);
    return () => register?.(null);
  });
  return ref;
}

/** Agent replies under a finding (MCP), latest first-class, older ones folded. */
function Replies({ finding }: { finding: FindingDTO }) {
  const [all, setAll] = useState(false);
  const replies = finding.responses ?? [];
  const shown = all ? replies : replies.slice(-1);
  if (replies.length === 0) return null;
  return (
    <>
      {replies.length > 1 && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 transition", all && "rotate-90")} aria-hidden />
          {all ? "Show only the latest reply" : `${replies.length - 1} earlier repl${replies.length === 2 ? "y" : "ies"}`}
        </button>
      )}
      <ul className="mt-1.5 space-y-1.5">
        {shown.map((reply) => (
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
    </>
  );
}

/**
 * One finding as a row: the labelled severity badge (colour is never the
 * only channel), the summary — which expands the model's reasoning — with its
 * facts as chips under it (component, kind, low confidence, fixing), the
 * file:line, and real Diff / Resolve buttons. Open defects carry a faint tint.
 */
function FindingRow({
  finding,
  onSelectComponent,
  onViewDiff,
  onSetResolved,
  onRetry,
  ...keyboard
}: RowKeyboardProps & {
  finding: FindingDTO;
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
  const settled = resolved || finding.assessment === "ok";
  const impact = isImpactFinding(finding);
  const tag = impact ? null : findingTag(finding);
  const visual = ASSESSMENT_VISUALS[finding.assessment];
  const rowRef = useRowKeyboard(keyboard, {
    toggle: () => setOpen((v) => !v),
    resolve: () => {
      if (!finding.callFailed && isResolvable(finding)) onSetResolved(finding.id, !resolved);
    },
    open: () => {
      if (finding.filePath) onViewDiff(finding);
    },
  });
  return (
    <li
      ref={rowRef}
      onMouseDown={keyboard.onActivate}
      className={cn(
        FINDING_GRID,
        "items-start border-b border-border/70 px-2 py-2",
        settled && "opacity-75 hover:opacity-100",
        keyboard.active && "opacity-100 ring-1 ring-brand/60 ring-inset"
      )}
      style={{ background: !settled && finding.assessment === "defect" ? tint(visual.color, 0.05) : undefined }}
    >
      <div className="pt-px">
        <SeverityBadge assessment={finding.assessment} resolved={resolved} failed={finding.callFailed} />
      </div>
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={finding.rationale ? open : undefined}
          disabled={!finding.rationale}
          className={cn(
            "text-left text-[13px] leading-snug font-medium disabled:cursor-default",
            finding.rationale && "cursor-pointer hover:underline hover:decoration-muted-foreground/50 hover:underline-offset-2",
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
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
          {finding.componentId && finding.componentName && (
            <Chip onClick={() => onSelectComponent(finding.componentId)} title={`Open ${finding.componentName} on the app map`}>
              <Boxes className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{finding.componentName}</span>
            </Chip>
          )}
          {location && (
            <Chip onClick={() => onViewDiff(finding)} title={location} className="font-mono @3xl:hidden">
              <span className="truncate">{location}</span>
            </Chip>
          )}
          {tag && <Chip title={finding.scope ? SCOPE_DESCRIPTIONS[finding.scope] : undefined}>{tag}</Chip>}
          {!settled && !finding.callFailed && finding.confidence < LOW_CONFIDENCE && (
            <Chip className="border-warning/40 font-mono text-warning" title="Model-reported confidence">
              {formatConfidence(finding.confidence)} sure
            </Chip>
          )}
          {fixing && (
            <Chip className="border-brand/50 text-brand" title="An agent agreed with this finding and is fixing it">
              <Wrench className="size-3" aria-hidden /> Fixing
            </Chip>
          )}
        </div>
        {open && finding.rationale && (
          <p className="mt-2 rounded-[2px] bg-secondary/50 px-2.5 py-1.5 text-xs leading-relaxed whitespace-pre-line text-muted-foreground">
            {finding.rationale}
          </p>
        )}
        <Replies finding={finding} />
      </div>
      <div className="hidden min-w-0 pt-0.5 @3xl:block">
        {location && (
          <button
            type="button"
            onClick={() => onViewDiff(finding)}
            className="block max-w-full truncate text-left font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline hover:underline-offset-2"
            title={`${location} — view diff`}
          >
            {location}
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1">
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
                  resolved ? "Reopen this finding" : "Mark this finding resolved — it then counts as OK in the overall verdict"
                }
              >
                {resolved ? <RotateCcw aria-hidden /> : <Check aria-hidden />}
                {resolved ? "Reopen" : "Resolve"}
              </Button>
            )}
      </div>
    </li>
  );
}

/** "`before` to `after`" from an impact rationale, as two labelled code lines. */
function SignatureChange({ text }: { text: string }) {
  const match = /^`([\s\S]*)` to `([\s\S]*)`$/.exec(text.trim());
  const rows = match ? [["Before", match[1]], ["After", match[2]]] : [["Change", text.replace(/`/g, "")]];
  return (
    <dl className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-[2px] border border-border bg-background/60 px-2 py-1.5">
      {rows.map(([label, code]) => (
        <div key={label} className="grid grid-cols-[48px_minmax(0,1fr)] gap-2">
          <dt className="text-[11px]">{label}</dt>
          <dd className="font-mono text-[11px] break-words whitespace-pre-wrap text-foreground">{code}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Basename + line of a finding, for call-site chips. */
function siteLabel(finding: FindingDTO): string {
  const base = finding.filePath ? finding.filePath.slice(finding.filePath.lastIndexOf("/") + 1) : "?";
  return finding.lineRange ? `${base}:${finding.lineRange}` : base;
}

/**
 * Every usage of one changed declaration that the change left behind, as a
 * single row: the declaration, what happened to it, how many lines in how
 * many files still use it. Expanding lists the call sites (each opens its
 * file) and the model's reason; Resolve resolves the whole group.
 */
function ImpactGroupRow({
  symbol,
  change,
  findings,
  onSelectComponent,
  onViewDiff,
  onSetResolved,
  ...keyboard
}: RowKeyboardProps & {
  symbol: string;
  change: string | null;
  findings: FindingDTO[];
  onSelectComponent: (componentId: string | null) => void;
  onViewDiff: (finding: FindingDTO) => void;
  onSetResolved: (findingId: string, resolved: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const openOnes = findings.filter((f) => !f.resolvedAt);
  const resolved = openOnes.length === 0;
  const files = new Set(findings.map((f) => f.filePath));
  const components = [...new Map(findings.filter((f) => f.componentId).map((f) => [f.componentId, f.componentName])).entries()];
  const reasons = [...new Set(findings.flatMap(impactReasons))];
  const lines = `${files.size} file${files.size === 1 ? "" : "s"}`;
  const single = findings.length === 1 ? findings[0] : null;
  const where = single ? formatLocation(single) : `${files.size} file${files.size === 1 ? "" : "s"}`;
  const visual = ASSESSMENT_VISUALS.defect;
  const anyFixing = openOnes.some((f) => f.responses?.some((r) => r.kind === "fixing"));
  // "in lib/x.ts changed from `<whole old signature>` to `<whole new one>`"
  // is a paragraph; the title says what changed and the expansion shows how.
  const signature = change ? /^(?:in (\S+)|moved from \S+ to (\S+) and) changed from ([\s\S]+)$/.exec(change) : null;
  const shortChange = signature
    ? signature[1]
      ? `changed in ${signature[1]}`
      : `moved to ${signature[2]} and changed`
    : (change ?? "changed");
  const rowRef = useRowKeyboard(keyboard, {
    toggle: () => setOpen((v) => !v),
    resolve: () => {
      if (resolved) findings.forEach((f) => onSetResolved(f.id, false));
      else openOnes.forEach((f) => onSetResolved(f.id, true));
    },
    open: () => onViewDiff(single ?? findings[0]),
  });
  return (
    <li
      ref={rowRef}
      onMouseDown={keyboard.onActivate}
      className={cn(
        FINDING_GRID,
        "items-start border-b border-border/70 px-2 py-2",
        resolved && "opacity-75 hover:opacity-100",
        keyboard.active && "opacity-100 ring-1 ring-brand/60 ring-inset"
      )}
      style={{ background: resolved ? undefined : tint(visual.color, 0.05) }}
    >
      <div className="pt-px">
        <SeverityBadge assessment="defect" resolved={resolved} />
      </div>
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            "cursor-pointer text-left text-[13px] leading-snug hover:underline hover:decoration-muted-foreground/50 hover:underline-offset-2",
            resolved && "text-muted-foreground line-through decoration-muted-foreground/40"
          )}
          title={open ? "Hide the call sites" : "Show the call sites and why"}
        >
          <code className="font-mono font-medium">{symbol}</code>{" "}
          <span className="text-muted-foreground">{shortChange}</span>
          <ChevronRight
            className={cn("ml-1 inline size-3 align-[-1px] text-muted-foreground transition", open && "rotate-90")}
            aria-hidden
          />
        </button>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
          <Chip
            className="border-transparent bg-transparent px-0"
            title="Usages the change did not update — usually in files the diff never touched"
          >
            {resolved ? `${lines} — resolved` : `${lines} still use${files.size === 1 ? "s" : ""} it`}
          </Chip>
          {components.map(([id, name]) => (
            <Chip key={id} onClick={() => onSelectComponent(id)} title={`Open ${name} on the app map`}>
              <Boxes className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{name}</span>
            </Chip>
          ))}
          {anyFixing && (
            <Chip className="border-brand/50 text-brand" title="An agent agreed and is fixing some of these">
              <Wrench className="size-3" aria-hidden /> Fixing
            </Chip>
          )}
        </div>
        {open && (
          <div className="mt-2 rounded-[2px] bg-secondary/50 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
            <div className="flex flex-wrap gap-1.5">
              {findings.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => onViewDiff(f)}
                  className={cn(
                    "inline-flex h-5 items-center rounded-[2px] border border-border bg-background/60 px-1.5 font-mono text-[11px] transition-colors hover:border-foreground/30 hover:text-foreground",
                    f.resolvedAt && "line-through opacity-60"
                  )}
                  title={`${f.filePath}:${f.lineRange ?? ""} — open the file at the reviewed commit`}
                >
                  {siteLabel(f)}
                </button>
              ))}
            </div>
            {signature && <SignatureChange text={signature[3]} />}
            {reasons.map((reason) => (
              <p key={reason} className="mt-1.5">
                {reason}
              </p>
            ))}
            <p className="mt-1.5 text-[11px]">
              These lines weren&apos;t edited by the change. If the declaration moved or is still exported elsewhere, resolve
              them.
            </p>
            {findings.map((f) => (
              <Replies key={f.id} finding={f} />
            ))}
          </div>
        )}
      </div>
      <div className="hidden min-w-0 pt-0.5 @3xl:block">
        {single ? (
          <button
            type="button"
            onClick={() => onViewDiff(single)}
            className="block max-w-full truncate text-left font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline hover:underline-offset-2"
            title={`${where} — open the file`}
          >
            {where}
          </button>
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground">{where}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1">
        {single && (
          <Button type="button" variant="outline" size="xs" onClick={() => onViewDiff(single)} title={`Open ${single.filePath}`}>
            <FileDiff aria-hidden /> Open
          </Button>
        )}
        <Button
          type="button"
          variant={resolved ? "ghost" : "outline"}
          size="xs"
          onClick={() => {
            if (resolved) findings.forEach((f) => onSetResolved(f.id, false));
            else openOnes.forEach((f) => onSetResolved(f.id, true));
          }}
          title={resolved ? "Reopen all of these" : `Mark all ${openOnes.length} resolved`}
        >
          {resolved ? <RotateCcw aria-hidden /> : <Check aria-hidden />}
          {resolved ? "Reopen" : openOnes.length > 1 ? `Resolve ${openOnes.length}` : "Resolve"}
        </Button>
      </div>
    </li>
  );
}

const BUCKET_CHIPS: Record<FindingBucket, { label: string; color: string; text: string; title: string }> = {
  defect: {
    label: ASSESSMENT_VISUALS.defect.label,
    color: ASSESSMENT_VISUALS.defect.color,
    text: ASSESSMENT_VISUALS.defect.text,
    title: `${ASSESSMENT_VISUALS.defect.description} Includes callers the change left behind.`,
  },
  concern: {
    label: ASSESSMENT_VISUALS.concern.label,
    color: ASSESSMENT_VISUALS.concern.color,
    text: ASSESSMENT_VISUALS.concern.text,
    title: ASSESSMENT_VISUALS.concern.description,
  },
  unknown: {
    label: ASSESSMENT_VISUALS.unknown.label,
    color: ASSESSMENT_VISUALS.unknown.color,
    text: ASSESSMENT_VISUALS.unknown.text,
    title: ASSESSMENT_VISUALS.unknown.description,
  },
  fine: {
    label: "OK",
    color: ASSESSMENT_VISUALS.ok.color,
    text: ASSESSMENT_VISUALS.ok.text,
    title: "Changes that look right, and findings someone resolved.",
  },
};

/** One toggle per severity — several can be on at once. Empty buckets are left out, so the header fits on one row. */
function BucketChips({
  counts,
  shown,
  onToggle,
}: {
  counts: Record<FindingBucket, number>;
  shown: Record<FindingBucket, boolean>;
  onToggle: (bucket: FindingBucket) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show findings by severity">
      {FINDING_BUCKETS.map((bucket) => {
        const chip = BUCKET_CHIPS[bucket];
        const on = shown[bucket];
        const empty = counts[bucket] === 0;
        if (empty) return null;
        return (
          <button
            key={bucket}
            type="button"
            onClick={() => onToggle(bucket)}
            aria-pressed={on}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-[2px] border px-1.5 text-[11px] transition-colors",
              on ? "text-foreground" : "border-border text-muted-foreground hover:text-foreground"
            )}
            style={on ? { borderColor: tint(chip.color, 0.6), background: tint(chip.color, 0.12) } : undefined}
            title={`${chip.title} ${on ? "Click to hide them." : "Click to show them."}`}
          >
            <span className="size-2 rounded-full" style={{ background: chip.color, opacity: on ? 1 : 0.5 }} aria-hidden />
            {chip.label}
            <span className="font-mono font-semibold">{counts[bucket]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A coloured banner for what needs attention before the findings: failures, a stale review. */
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
        "mt-2 flex items-start gap-2 rounded-[2px] border px-2.5 py-1.5 text-xs leading-relaxed",
        tone === "danger" && "border-destructive/30 bg-destructive/10 text-destructive",
        tone === "warning" && "border-warning/30 bg-warning/10 text-warning",
        tone === "info" && "border-border bg-secondary/40 text-muted-foreground"
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
    <p className="flex items-start gap-1.5 px-2 pt-2 text-[11px] text-muted-foreground" title={note.rationale}>
      <Info className="mt-px size-3 shrink-0" aria-hidden />
      <span>{note.summary}</span>
    </p>
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

function compareFindings(a: FindingDTO, b: FindingDTO): number {
  return (
    compareAssessment(a.assessment, b.assessment) ||
    Number(Boolean(a.callFailed)) - Number(Boolean(b.callFailed)) ||
    b.confidence - a.confidence ||
    (a.componentName || "").localeCompare(b.componentName || "") ||
    (a.filePath || "").localeCompare(b.filePath || "")
  );
}

/** One line of the findings list: a finding, or every usage of one changed declaration. */
type ListRow =
  | { kind: "one"; key: string; bucket: FindingBucket; finding: FindingDTO }
  | { kind: "group"; key: string; bucket: FindingBucket; symbol: string; change: string | null; findings: FindingDTO[] };

const BUCKET_RANK: Record<FindingBucket, number> = { defect: 0, concern: 1, unknown: 2, fine: 3 };

function buildRows(findings: FindingDTO[]): ListRow[] {
  const rows: ListRow[] = [];
  const groups = new Map<string, Extract<ListRow, { kind: "group" }>>();
  for (const finding of findings) {
    const symbol = impactSymbol(finding);
    if (!symbol) {
      rows.push({ kind: "one", key: finding.id, bucket: findingBucket(finding), finding });
      continue;
    }
    const change = impactChange(finding);
    const key = `impact:${symbol}\u0000${change ?? ""}`;
    const group = groups.get(key);
    if (group) group.findings.push(finding);
    else {
      const row = { kind: "group" as const, key, bucket: "fine" as FindingBucket, symbol, change, findings: [finding] };
      groups.set(key, row);
      rows.push(row);
    }
  }
  for (const group of groups.values()) {
    group.findings.sort((a, b) => (a.filePath || "").localeCompare(b.filePath || "") || Number(a.lineRange) - Number(b.lineRange));
    const open = group.findings.find((f) => !f.resolvedAt);
    group.bucket = open ? findingBucket(open) : "fine";
  }
  const size = (row: ListRow) => (row.kind === "group" ? row.findings.length : 1);
  return rows.sort(
    (a, b) =>
      BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] ||
      size(b) - size(a) ||
      (a.kind === "one" && b.kind === "one" ? compareFindings(a.finding, b.finding) : 0)
  );
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
}: ReviewPanelProps) {
  /** The finding whose file diff is open in `FileDiffModal`, or `null` when it's closed. */
  const [diffFinding, setDiffFinding] = useState<FindingDTO | null>(null);
  const [tab, setTab] = useState<DockTab>("findings");
  const [shown, setShown] = useState<Record<FindingBucket, boolean>>(DEFAULT_SHOWN);

  // A new target is a different review.
  const targetKey = target ? reviewTargetLabel(target) : null;
  useEffect(() => {
    setDiffFinding(null);
    setShown(DEFAULT_SHOWN);
  }, [targetKey]);

  const inScope = useMemo(() => {
    if (!scopeAreaId && !scopeComponentId) return () => true;
    return (finding: FindingDTO) =>
      (!scopeAreaId || areas.areaOf(finding) === scopeAreaId) &&
      (!scopeComponentId || finding.componentId === scopeComponentId);
  }, [areas, scopeAreaId, scopeComponentId]);

  const notes = useMemo(() => findings.filter(isImpactNote), [findings]);
  const scoped = useMemo(() => findings.filter((f) => isAreaFinding(f) && inScope(f)), [findings, inScope]);
  const counts = useMemo(() => {
    const c = emptyCounts();
    for (const f of scoped) c[findingBucket(f)] += 1;
    return c;
  }, [scoped]);
  const rows = useMemo(() => buildRows(scoped), [scoped]);
  const visibleRows = useMemo(() => rows.filter((row) => shown[row.bucket]), [rows, shown]);

  // Keyboard triage: J/K move through the visible rows, Enter expands, R
  // resolves (or reopens), D opens the file. Off while typing, while a dialog
  // is open, and on the Files tab.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const rowActions = useRef(new Map<string, RowActions>());
  const registerRow = useCallback((key: string, actions: RowActions | null) => {
    if (actions) rowActions.current.set(key, actions);
    else rowActions.current.delete(key);
  }, []);
  useEffect(() => {
    if (tab !== "findings") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      // The target is the document itself when nothing has focus.
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("[role=dialog]")) return;
      const keys = visibleRows.map((row) => row.key);
      if (keys.length === 0) return;
      const index = activeKey ? keys.indexOf(activeKey) : -1;
      const key = e.key.toLowerCase();
      if (key === "j" || key === "k") {
        e.preventDefault();
        const next = key === "j" ? Math.min(keys.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1);
        setActiveKey(keys[next]);
        return;
      }
      const actions = index >= 0 ? rowActions.current.get(keys[index]) : undefined;
      if (!actions) return;
      if (e.key === "Enter" && !el?.closest("button, a")) {
        e.preventDefault();
        actions.toggle();
      } else if (key === "r") {
        e.preventDefault();
        actions.resolve();
      } else if (key === "d") {
        e.preventDefault();
        actions.open();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tab, visibleRows, activeKey]);
  const hiddenFine = shown.fine ? 0 : counts.fine;

  // --- Files tab ------------------------------------------------------------
  const files = useMemo(() => {
    if (!map) return [];
    const list: Array<PrMapFileDTO & { areaId: string; areaName: string }> = [];
    for (const node of map.nodes) {
      if (node.role === "context" || (scopeAreaId && node.id !== scopeAreaId)) continue;
      for (const file of node.files) {
        if (scopeComponentId && file.componentId !== scopeComponentId) continue;
        list.push({ ...file, areaId: node.id, areaName: node.name });
      }
    }
    return list.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path));
  }, [map, scopeAreaId, scopeComponentId]);
  const flagsByFile = useMemo(() => {
    const flags = new Map<string, { open: number; defect: boolean }>();
    for (const f of findings) {
      if (!f.filePath || f.resolvedAt || (f.assessment !== "defect" && f.assessment !== "concern")) continue;
      const prev = flags.get(f.filePath) ?? { open: 0, defect: false };
      flags.set(f.filePath, { open: prev.open + 1, defect: prev.defect || f.assessment === "defect" });
    }
    return flags;
  }, [findings]);
  const maxChurn = Math.max(1, ...files.map((f) => f.additions + f.deletions));

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

  // When the review ran (and what it cost) lives on the Re-run button's
  // tooltip, so the dock's header fits on one row.
  const reviewedNote =
    showFreshness && freshness && !freshness.stale && !freshness.checkError
      ? `Reviewed at ${shortSha(freshness.reviewedHeadSha)}${timeAgo(freshness.reviewedAt) ? `, ${timeAgo(freshness.reviewedAt)}` : ""}${costTitle ? ` · ${costTitle}` : ""}`
      : costTitle;

  const scopeArea = scopeAreaId ? areas.areas.get(scopeAreaId) : undefined;
  const scopeParts = [
    ...(scopeArea ? [scopeArea.node.name] : []),
    ...(scopeComponentId ? [componentName(scopeComponentId) ?? scopeComponentId] : []),
  ];
  const findingsCount = scoped.length;

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
            {tabButton("files", "Files", files.length)}
          </div>
          {tab === "findings" && findingsCount > 0 && (
            <div className="pb-1.5">
              <BucketChips counts={counts} shown={shown} onToggle={(b) => setShown((s) => ({ ...s, [b]: !s[b] }))} />
            </div>
          )}
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
            {state === "failed" && (
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
            {aiConfigured && (
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
            ) : (
              status === "ready" &&
              !notConfigured && (
                <p className="mt-2 px-2 text-xs text-muted-foreground">
                  {running
                    ? "Waiting for the first component to come back…"
                    : state === "failed"
                      ? "The review job failed before it produced any findings."
                      : state === "none" && !rerunning
                        ? "Not reviewed yet. Reviews start on their own only for open pull requests and branch comparisons — press Review to run one."
                        : "No findings for this diff yet."}
                </p>
              )
            ))}

          {tab === "files" &&
            (files.length > 0 ? (
              <>
                <div className="sticky top-0 z-10 grid grid-cols-[16px_minmax(0,1fr)_auto] gap-x-3 border-b border-border bg-card px-2 py-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase @2xl:grid-cols-[16px_minmax(0,1fr)_140px_56px_56px_96px_32px]">
                  <span />
                  <span>Path</span>
                  <span className="hidden @2xl:block">{scopeAreaId ? "Component" : "Area"}</span>
                  <span className="hidden text-right @2xl:block">Added</span>
                  <span className="hidden text-right @2xl:block">Removed</span>
                  <span className="hidden @2xl:block" />
                  <span className="text-right">Open</span>
                </div>
                <ul>
                  {files.map((file) => {
                    const badge = STATUS_BADGES[file.status] ?? STATUS_BADGES.changed;
                    const slash = file.path.lastIndexOf("/");
                    const flag = flagsByFile.get(file.path);
                    const owner = file.componentId ? (componentName(file.componentId) ?? "") : "";
                    const row = (
                      <>
                        <span className={cn("font-mono text-[11px] font-semibold", badge.className)} title={badge.label}>
                          {badge.letter}
                        </span>
                        <span className="min-w-0 truncate font-mono text-[12px]" title={file.path}>
                          <span className="text-muted-foreground">{slash >= 0 ? file.path.slice(0, slash + 1) : ""}</span>
                          {slash >= 0 ? file.path.slice(slash + 1) : file.path}
                        </span>
                        <span className="hidden truncate text-[11px] text-muted-foreground @2xl:block">
                          {scopeAreaId ? owner : file.areaName}
                        </span>
                        <span className="hidden text-right font-mono text-[11px] text-success @2xl:block">
                          {file.additions > 0 ? `+${NUMBER.format(file.additions)}` : ""}
                        </span>
                        <span className="hidden text-right font-mono text-[11px] text-destructive @2xl:block">
                          {file.deletions > 0 ? `−${NUMBER.format(file.deletions)}` : ""}
                        </span>
                        <span className="hidden h-1.5 items-center gap-px @2xl:flex" aria-hidden>
                          <span className="h-full rounded-[1px] bg-success" style={{ width: `${(file.additions / maxChurn) * 100}%` }} />
                          <span className="h-full rounded-[1px] bg-destructive" style={{ width: `${(file.deletions / maxChurn) * 100}%` }} />
                        </span>
                        <span className="text-right">
                          {flag && (
                            <span
                              className="inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold text-background"
                              style={{ background: ASSESSMENT_VISUALS[flag.defect ? "defect" : "concern"].color }}
                              title={`${flag.open} open finding${flag.open === 1 ? "" : "s"} in this file`}
                            >
                              {flag.open}
                            </span>
                          )}
                        </span>
                      </>
                    );
                    const grid =
                      "grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border/70 px-2 py-1.5 text-left @2xl:grid-cols-[16px_minmax(0,1fr)_140px_56px_56px_96px_32px]";
                    return (
                      <li key={file.path}>
                        {onOpenFile ? (
                          <button
                            type="button"
                            onClick={() => onOpenFile(file.path)}
                            className={cn(grid, "transition-colors hover:bg-secondary/60")}
                            title={`${file.path} — view diff`}
                          >
                            {row}
                          </button>
                        ) : (
                          <div className={grid}>{row}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                {map ? (scopeParts.length > 0 ? `No changed files in ${scopeParts.join(" › ")}.` : "No changed files.") : "Loading the files…"}
              </p>
            ))}
        </div>
      </section>
      <FileDiffModal repoId={repoId} target={target} finding={diffFinding} onClose={() => setDiffFinding(null)} />
    </>
  );
}
