"use client";

// One card of the PR map: a name, a one-line description, and a chip per
// changed file with its status and +/- counts. Rendered twice per layout —
// once offscreen by `PrMapCanvas` to measure its height for ELK, and once as
// the React Flow node — so it takes plain props and knows nothing about
// React Flow itself (the handles are added by the node wrapper).

import { ChevronDown, ChevronUp, Network } from "lucide-react";
import { cn } from "cn";
import { INTENT_VISUALS } from "./review-visuals";
import type { PrMapFileDTO, PrMapNodeDTO, PrMapRole } from "./pr-map-types";
import type { FileDiffStatus, IntentMatch } from "./types";

/** Fixed card width — ELK only has to discover heights. */
export const PR_CARD_WIDTH = 280;
/** Files shown before the "+N more" toggle. */
export const PR_CARD_FILE_LIMIT = 6;

const ROLE_TAGS: Partial<Record<PrMapRole, string>> = {
  test: "Tests",
  dependency: "Dependency",
  config: "Config",
  docs: "Docs",
  context: "Unchanged",
};

const STATUS_BADGES: Record<FileDiffStatus, { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "text-success", label: "Added" },
  removed: { letter: "D", className: "text-destructive", label: "Deleted" },
  modified: { letter: "M", className: "text-warning", label: "Modified" },
  renamed: { letter: "R", className: "text-info", label: "Renamed" },
  copied: { letter: "C", className: "text-info", label: "Copied" },
  changed: { letter: "M", className: "text-warning", label: "Changed" },
  unchanged: { letter: "·", className: "text-muted-foreground", label: "Unchanged" },
};

/** Basenames, widened to `dir/base` only where two files in the card share a basename. */
function chipLabels(files: PrMapFileDTO[]): Map<string, string> {
  const counts = new Map<string, number>();
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  for (const file of files) counts.set(base(file.path), (counts.get(base(file.path)) ?? 0) + 1);
  return new Map(
    files.map((file) => {
      const name = base(file.path);
      if ((counts.get(name) ?? 0) < 2) return [file.path, name];
      const parts = file.path.split("/");
      return [file.path, parts.length > 1 ? parts.slice(-2).join("/") : name];
    })
  );
}

export interface PrCardMarker {
  worst: IntentMatch;
  count: number;
}

export interface PrMapCardProps {
  node: PrMapNodeDTO;
  selected?: boolean;
  expanded?: boolean;
  marker?: PrCardMarker;
  /** Worst verdict per file path, for the chip dots. */
  fileMarkers?: Map<string, IntentMatch>;
  onOpenFile?: (path: string) => void;
  onToggleExpand?: () => void;
  onShowInRepo?: () => void;
}

export function PrMapCard({
  node,
  selected,
  expanded,
  marker,
  fileMarkers,
  onOpenFile,
  onToggleExpand,
  onShowInRepo,
}: PrMapCardProps) {
  const context = node.role === "context";
  const labels = chipLabels(node.files);
  const hidden = node.files.length - PR_CARD_FILE_LIMIT;
  const files = expanded || hidden <= 0 ? node.files : node.files.slice(0, PR_CARD_FILE_LIMIT);
  const tag = ROLE_TAGS[node.role];
  const visual = marker ? INTENT_VISUALS[marker.worst] : null;
  const MarkerIcon = visual?.icon;

  return (
    <div
      style={{ width: PR_CARD_WIDTH }}
      className={cn(
        "rounded-xl px-3 pt-2.5 pb-3 text-left transition-shadow",
        context
          ? "border border-dashed border-border bg-card/40 opacity-70"
          : "bg-card shadow-sm ring-1 ring-border",
        selected && "ring-2 ring-brand opacity-100"
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {tag && (
            <p className="mb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {tag}
            </p>
          )}
          <p className="text-[13px] leading-snug font-semibold tracking-tight">{node.name}</p>
        </div>
        {visual && MarkerIcon && (
          <span
            className="mt-0.5 flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1"
            style={{ color: visual.text, boxShadow: `inset 0 0 0 1px ${visual.color}66` }}
            title={`${visual.label} — ${marker!.count} finding${marker!.count === 1 ? "" : "s"}`}
          >
            <MarkerIcon className="size-3" />
            {marker!.count}
          </span>
        )}
        {onShowInRepo && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onShowInRepo();
            }}
            className="nodrag -mr-1 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="Show in repo graph"
            aria-label={`Show ${node.name} in the repo graph`}
          >
            <Network className="size-3.5" />
          </button>
        )}
      </div>

      {node.description && (
        <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-muted-foreground">
          {node.description}
        </p>
      )}

      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((file) => {
            const badge = STATUS_BADGES[file.status] ?? STATUS_BADGES.changed;
            const intent = fileMarkers?.get(file.path);
            const content = (
              <>
                {intent && (
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: INTENT_VISUALS[intent].color }}
                    title={`Worst finding: ${INTENT_VISUALS[intent].label}`}
                  />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                  {labels.get(file.path)}
                </span>
                {(file.additions > 0 || file.deletions > 0) && (
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    <span className="text-success">+{file.additions}</span>{" "}
                    <span className="text-destructive">−{file.deletions}</span>
                  </span>
                )}
                <span
                  className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", badge.className)}
                  title={badge.label}
                >
                  {badge.letter}
                </span>
              </>
            );
            return (
              <li key={file.path}>
                {onOpenFile ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenFile(file.path);
                    }}
                    className="nodrag flex w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-left ring-1 ring-border/60 transition-colors hover:bg-secondary hover:ring-border"
                    title={`${file.path} — view diff`}
                  >
                    {content}
                  </button>
                ) : (
                  <div
                    className="flex w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 ring-1 ring-border/60"
                    title={file.path}
                  >
                    {content}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hidden > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand?.();
          }}
          className="nodrag mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3" /> Show fewer
            </>
          ) : (
            <>
              <ChevronDown className="size-3" /> {hidden} more file{hidden === 1 ? "" : "s"}
            </>
          )}
        </button>
      )}
    </div>
  );
}
