"use client";

// One card of the app map (DESIGN.md §6.5), deliberately compact: a muted
// layer stripe, the name, the full description, a file count and at most two
// status words — how many of its files the selected diff changes, and the
// worst review verdict over its findings. Files, key files, modules and the
// AI explanation live in the explainer (`AppMapPanel`) that opens when the
// card is selected.
//
// With a diff selected the map is about the diff: cards it touches get an
// amber edge and tint, the rest fade back. Zoomed far out (`CardFlow` sets
// `data-far` and `--label-scale` on the canvas), the description is hidden
// and the name and status are drawn larger, so a fitted map of 15 cards still
// reads — see `.amc-*` in app/globals.css.
// Rendered twice per layout (offscreen to measure, then as the node), so it
// takes plain props and knows nothing about React Flow.

import { cn } from "cn";
import { layerTint, type AppMapLevel, type AppMapNodeDTO } from "./app-map-types";
import { CardMarkerBadge, type PrCardMarker } from "./PrMapNode";
import { Spark } from "./Spark";

export const APP_CARD_WIDTH = 248;

export interface AppMapCardProps {
  node: AppMapNodeDTO;
  level: AppMapLevel;
  selected?: boolean;
  /** Holds the component selected elsewhere (a chat chip, the review dock, the PR map). */
  focused?: boolean;
  /** Something else is selected/searched and this card isn't part of it. */
  dimmed?: boolean;
  /** Files of the current diff — cards holding them say how many and stand out. */
  changedFiles?: ReadonlySet<string>;
  /** Worst review verdict over the card's findings. */
  marker?: PrCardMarker;
  /** Make the diff stand out: changed cards amber, the rest faded. Off shows every card normally (the "N changed" words stay). */
  highlightChanges?: boolean;
}

export function AppMapCard({
  node,
  level,
  selected,
  focused,
  dimmed,
  changedFiles,
  marker,
  highlightChanges = true,
}: AppMapCardProps) {
  const hasDiff = Boolean(changedFiles && changedFiles.size > 0);
  const changed = hasDiff ? node.files.filter((f) => changedFiles!.has(f)).length : 0;
  const diffMode = hasDiff && highlightChanges;
  const count =
    level === "architecture"
      ? `${node.modules.length} mod · ${node.files.length}`
      : String(node.files.length);
  const faded = dimmed || (diffMode && changed === 0 && !marker && !selected && !focused);

  return (
    <div
      style={{ width: APP_CARD_WIDTH }}
      className={cn(
        "relative rounded-lg border py-2 pr-2.5 pl-3.5 text-left transition-[opacity,border-color]",
        diffMode && changed > 0 ? "border-warning/60 bg-[color-mix(in_oklab,var(--warning)_7%,var(--card))]" : "bg-card",
        selected
          ? "border-brand ring-1 ring-brand"
          : focused
            ? "border-brand/60"
            : !(diffMode && changed > 0) && "border-foreground/14",
        faded && "opacity-35"
      )}
    >
      <span
        className="absolute inset-y-0 left-0 w-[3px] rounded-l-lg"
        style={{ backgroundColor: layerTint(node.layer) }}
        aria-hidden
      />
      <div className="flex items-baseline gap-2">
        <p className="amc-name min-w-0 flex-1 text-[13px] leading-snug font-medium">
          {node.name}
          {node.explanation && <Spark className="ml-1 align-[1px]" title="Described by the model — select to read it" />}
        </p>
        <span
          className="amc-count shrink-0 font-mono text-[11px] text-muted-foreground"
          title={`${node.files.length} file${node.files.length === 1 ? "" : "s"} · ${node.modules.length} module${node.modules.length === 1 ? "" : "s"}`}
        >
          {count}
        </span>
      </div>

      {node.description && (
        <p className="amc-desc mt-0.5 text-[11px] leading-snug text-muted-foreground">{node.description}</p>
      )}

      {(changed > 0 || marker) && (
        <div className="amc-status mt-1.5 flex items-center gap-2.5 text-[11px]">
          {changed > 0 && (
            <span
              className="font-mono text-warning"
              title={`${changed} file${changed === 1 ? "" : "s"} changed in the selected diff`}
            >
              {changed} changed
            </span>
          )}
          {marker && <CardMarkerBadge marker={marker} />}
        </div>
      )}
    </div>
  );
}

/** The share of a card's files per layer, as one thin bar — used by the explainer. */
export function LayerBar({ layers, className }: { layers: AppMapNodeDTO["layers"]; className?: string }) {
  const total = layers.reduce((n, l) => n + l.files, 0) || 1;
  return (
    <div className={cn("flex h-1 w-full overflow-hidden rounded-sm bg-muted", className)}>
      {layers.map((l) => (
        <span key={l.layer} style={{ width: `${(l.files / total) * 100}%`, backgroundColor: layerTint(l.layer) }} />
      ))}
    </div>
  );
}
