"use client";

// One finding in the review dock's list.

import { useState } from "react";
import {
  Boxes,
  Check,
  ChevronRight,
  FileDiff,
  MessageSquare,
  RotateCcw,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import {
  ASSESSMENT_VISUALS,
  formatConfidence,
  findingTag,
  formatLocation,
  isImpactFinding,
  isResolvable,
  SCOPE_DESCRIPTIONS,
} from "../review-visuals";
import {
  type FindingDTO,
} from "../types";
import { type RowKeyboardProps, STATIC_CATEGORY_LABEL, useRowKeyboard, FINDING_GRID, tint, SeverityBadge, Chip, LOW_CONFIDENCE, Replies } from "./parts";

/**
 * One finding as a row: the labelled severity badge (colour is never the
 * only channel), the summary — which expands the model's reasoning — with its
 * facts as chips under it (component, kind, low confidence, fixing), the
 * file:line, and real Diff / Resolve buttons — and Ask, which puts the finding
 * in the chat's input. Open defects carry a faint tint.
 */
export function FindingRow({
  finding,
  onSelectComponent,
  onViewDiff,
  onSetResolved,
  onRetry,
  onAskChat,
  ...keyboard
}: RowKeyboardProps & {
  finding: FindingDTO;
  onSelectComponent: (componentId: string | null) => void;
  onViewDiff: (finding: FindingDTO) => void;
  onSetResolved: (findingId: string, resolved: boolean) => void;
  /** Present when failed calls can be retried right now. */
  onRetry?: () => void;
  /** Puts the finding in the chat's input, to ask about it. */
  onAskChat?: (finding: FindingDTO) => void;
}) {
  const [open, setOpen] = useState(false);
  const location = formatLocation(finding);
  const resolved = Boolean(finding.resolvedAt);
  const fixing = !resolved && Boolean(finding.responses?.some((reply) => reply.kind === "fixing"));
  const settled = resolved || finding.assessment === "ok";
  const impact = isImpactFinding(finding);
  const tag = impact
    ? null
    : STATIC_CATEGORY_LABEL[finding.category]
      ? STATIC_CATEGORY_LABEL[finding.category]
      : finding.category === "chat"
        ? "From chat"
        : findingTag(finding);
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
        {onAskChat && !finding.callFailed && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onAskChat(finding)}
            title="Ask the chat about this finding — whether it holds, what it means, how to fix it"
            aria-label="Ask the chat about this finding"
          >
            <MessageSquare aria-hidden />
          </Button>
        )}
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
