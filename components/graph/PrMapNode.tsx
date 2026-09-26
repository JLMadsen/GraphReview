"use client";

// One card of the PR map: a name, a one-line description, and a chip per
// changed file with its status and +/- counts. Rendered twice per layout —
// once offscreen by `PrMapCanvas` to measure its height for ELK, and once as
// the React Flow node — so it takes plain props and knows nothing about
// React Flow itself (the handles are added by the node wrapper).

import { ChevronDown, ChevronUp, LayoutGrid } from "lucide-react";
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

/** A card's worst review verdict and finding count — shared by the PR map and the app map. Glyph + count, no pill: status is loud colour on a quiet card. */
export function CardMarkerBadge({ marker, className }: { marker: PrCardMarker; className?: string }) {
  const visual = INTENT_VISUALS[marker.worst];
  const Icon = visual.icon;
  return (
    <span
      className={cn("flex shrink-0 items-center gap-0.5 font-mono text-[11px] font-medium", className)}
      style={{ color: visual.text }}
      title={`${visual.label} — ${marker.count} finding${marker.count === 1 ? "" : "s"}`}
    >
      <Icon className="size-[1.1em]" />
      {marker.count}
    </span>
  );
}

/** A file's worst verdict as its glyph in the verdict colour — the file-row counterpart of `CardMarkerBadge`. */
export function IntentGlyph({ intent }: { intent: IntentMatch }) {
  const visual = INTENT_VISUALS[intent];
  const Icon = visual.icon;
  return (
    <span className="shrink-0" style={{ color: visual.text }} title={`Worst finding: ${visual.label}`}>
      <Icon className="size-3" />
    </span>
  );
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
  return (
    <div
      style={{ width: PR_CARD_WIDTH }}
      className={cn(
        "rounded-lg border px-3 pt-2.5 pb-2.5 text-left transition-colors",
        context ? "border-dashed border-border bg-card/40 opacity-70" : "border-foreground/14 bg-card",
        selected && "border-brand opacity-100 ring-1 ring-brand"
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {tag && (
            <p className="mb-0.5 font-mono text-[11px] text-muted-foreground lowercase">{tag}</p>
          )}
          <p className="amc-name text-[13px] leading-snug font-medium">{node.name}</p>
        </div>
        {marker && <CardMarkerBadge marker={marker} className="mt-0.5" />}
        {onShowInRepo && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onShowInRepo();
            }}
            className="nodrag -mr-1 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="Show on the app map"
            aria-label={`Show ${node.name} on the app map`}
          >
            <LayoutGrid className="size-3.5" />
          </button>
        )}
      </div>

      {node.description && (
        <p className="amc-desc mt-1 text-[11px] leading-snug text-muted-foreground">
          {node.description}
        </p>
      )}

      {files.length > 0 && (
        <ul className="mt-2 border-t border-border/70 pt-1">
          {files.map((file) => {
            const badge = STATUS_BADGES[file.status] ?? STATUS_BADGES.changed;
            const intent = fileMarkers?.get(file.path);
            const content = (
              <>
                {intent && (
                  <IntentGlyph intent={intent} />
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
                    className="nodrag -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-secondary"
                    title={`${file.path} — view diff`}
                  >
                    {content}
                  </button>
                ) : (
                  <div
                    className="flex w-full items-center gap-1.5 py-0.5"
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
