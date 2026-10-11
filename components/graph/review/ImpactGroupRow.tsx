"use client";

// One impact group in the review dock's list: the callers a changed name left behind.

import { useState } from "react";
import {
  Boxes,
  Check,
  ChevronRight,
  FileDiff,
  RotateCcw,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import {
  ASSESSMENT_VISUALS,
  formatLocation,
  impactReasons,
} from "../review-visuals";
import {
  type FindingDTO,
} from "../types";
import { type RowKeyboardProps, useRowKeyboard, FINDING_GRID, tint, SeverityBadge, Chip, Replies } from "./parts";

/** "`before` to `after`" from an impact rationale, as two labelled code lines. */
export function SignatureChange({ text }: { text: string }) {
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
export function siteLabel(finding: FindingDTO): string {
  const base = finding.filePath ? finding.filePath.slice(finding.filePath.lastIndexOf("/") + 1) : "?";
  return finding.lineRange ? `${base}:${finding.lineRange}` : base;
}

/**
 * Every usage of one changed declaration that the change left behind, as a
 * single row: the declaration, what happened to it, how many lines in how
 * many files still use it. Expanding lists the call sites (each opens its
 * file) and the model's reason; Resolve resolves the whole group.
 */
export function ImpactGroupRow({
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
