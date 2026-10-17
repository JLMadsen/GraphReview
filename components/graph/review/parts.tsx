"use client";

// Small pieces shared by the review dock's rows (DESIGN.md §6.8): badges, chips,
// the short-sha label, replies, callouts and the row keyboard handling.

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Info,
  MessageSquare,
  Minus,
} from "lucide-react";
import { cn } from "cn";
import {
  ASSESSMENT_VISUALS,
} from "../review-visuals";
import { FINDING_BUCKETS, type FindingBucket } from "../pr-areas";
import {
  formatAgo,
  type FindingDTO,
  type Assessment,
  type FindingCategory,
} from "../types";

/**
 * Finding categories static analysis produces, without a model: each gets a
 * tag on its rows and a chip in the dock's header that shows only it. A new
 * static check (the DB schema's, DESIGN.md §6.13) is one more entry.
 */
export const STATIC_CATEGORIES: ReadonlyArray<{ category: FindingCategory; label: string; what: string }> = [
  { category: "structure", label: "Structure", what: "what static analysis found in the change's structure — import cycles it creates" },
  { category: "infra", label: "Infra", what: "what static analysis found in the change's infrastructure — renames without a moved block, destroyed stateful resources, env vars no longer set" },
  { category: "schema", label: "Schema", what: "what static analysis found in the migrations this change adds — dropped tables or columns, NOT NULL without a default, narrowed types, renames, Postgres index locks" },
  { category: "env", label: "Env", what: "what static analysis found in the change's env vars — new reads nothing declares, secrets exposed to the browser or committed, declarations removed while still read" },
  { category: "security", label: "Security", what: "what static analysis found that touches security — credentials on lines the change adds (the value is never shown), endpoints whose auth was removed or can no longer be seen, new endpoints with no visible auth" },
  { category: "tests", label: "Tests", what: "what static analysis found in the change's tests — focused or skipped tests it adds, test files deleted while their code stays, changed code no test reaches or the coverage report misses" },
];

export const STATIC_CATEGORY_LABEL: Partial<Record<FindingCategory, string>> = Object.fromEntries(STATIC_CATEGORIES.map((c) => [c.category, c.label]));

export const shortSha = (sha: string) => sha.slice(0, 7);

/** Findings below this confidence say so; above it the number is noise. */
export const LOW_CONFIDENCE = 0.8;

/** A short sha as mono text; the full sha is on hover. */
export function Sha({ sha }: { sha: string }) {
  return (
    <code className="font-mono text-[11px] text-foreground" title={sha}>
      {shortSha(sha)}
    </code>
  );
}

/** How each kind of agent reply reads above its text. */
export const RESPONSE_LABELS: Record<NonNullable<FindingDTO["responses"]>[number]["kind"], string> = {
  answered: "answered",
  fixing: "agreed, fixing",
  comment: "commented",
};

/** `#rrggbb` → `rgba(…, alpha)`, for tints of the assessment colours. */
export function tint(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The verdict as a small coloured label — shape, colour and word, so it reads without colour too. */
export function SeverityBadge({
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
export function Chip({
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
export const FINDING_GRID =
  "grid grid-cols-[76px_minmax(0,1fr)_auto] gap-x-3 @3xl:grid-cols-[76px_minmax(0,1fr)_minmax(0,200px)_auto]";

/** What the dock's keys do to a row: Enter, R and D. */
export interface RowActions {
  toggle: () => void;
  resolve: () => void;
  open: () => void;
}

/** A row's part in keyboard navigation: whether it is the current one, and how it reports its actions. */
export interface RowKeyboardProps {
  active?: boolean;
  onActivate?: () => void;
  register?: (actions: RowActions | null) => void;
}

/** The current row's ring, and keeping it in view as J/K move it. */
export function useRowKeyboard(
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
export function Replies({ finding }: { finding: FindingDTO }) {
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
              {RESPONSE_LABELS[reply.kind]} · {formatAgo(reply.createdAt)}
            </span>
            <p className="mt-0.5 whitespace-pre-line">{reply.body}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

export const BUCKET_CHIPS: Record<FindingBucket, { label: string; color: string; text: string; title: string }> = {
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
export function BucketChips({
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
export function Callout({
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
export function ImpactNote({ note }: { note: FindingDTO }) {
  return (
    <p className="flex items-start gap-1.5 px-2 pt-2 text-[11px] text-muted-foreground" title={note.rationale}>
      <Info className="mt-px size-3 shrink-0" aria-hidden />
      <span>{note.summary}</span>
    </p>
  );
}
