"use client";

// One card of the app map (DESIGN.md §6.5), styled like a PR map card: a
// layer-coloured stripe, the name, a one-line description, a bar showing
// which layers the card's files sit in, and chips — modules on an
// architecture card, files (key files first) on a feature or module card.
// Rendered twice per layout (offscreen to measure, then as the node), so it
// takes plain props and knows nothing about React Flow.

import { ChevronDown, ChevronUp, FileCode2, Sparkles, Star } from "lucide-react";
import { cn } from "cn";
import { APP_LAYERS, type AppMapLevel, type AppMapNodeDTO } from "./app-map-types";

export const APP_CARD_WIDTH = 300;
const CHIP_LIMIT = 5;

export interface AppMapCardProps {
  node: AppMapNodeDTO;
  level: AppMapLevel;
  selected?: boolean;
  /** Something else is selected/searched and this card isn't part of it. */
  dimmed?: boolean;
  expanded?: boolean;
  /** Files of the current diff — cards and chips holding them are marked. */
  changedFiles?: ReadonlySet<string>;
  onToggleExpand?: () => void;
  onSelectModule?: (moduleId: string) => void;
  onSelectFile?: (path: string) => void;
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export function LayerBar({ layers, className }: { layers: AppMapNodeDTO["layers"]; className?: string }) {
  const total = layers.reduce((n, l) => n + l.files, 0) || 1;
  return (
    <div
      className={cn("flex h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      title={layers.map((l) => `${APP_LAYERS[l.layer].name}: ${l.files}`).join(" · ")}
    >
      {layers.map((l) => (
        <span
          key={l.layer}
          style={{ width: `${(l.files / total) * 100}%`, backgroundColor: APP_LAYERS[l.layer].color }}
        />
      ))}
    </div>
  );
}

export function AppMapCard({
  node,
  level,
  selected,
  dimmed,
  expanded,
  changedFiles,
  onToggleExpand,
  onSelectModule,
  onSelectFile,
}: AppMapCardProps) {
  const layer = APP_LAYERS[node.layer];
  const changed = changedFiles && changedFiles.size > 0 ? node.files.filter((f) => changedFiles.has(f)).length : 0;
  const tag =
    level === "architecture"
      ? "Layer"
      : level === "features"
        ? `Feature · ${node.layers.slice(0, 2).map((l) => APP_LAYERS[l.layer].name).join(" + ")}`
        : `Module · ${layer.name}`;

  // Chips: modules on a layer card, files (key files first) otherwise.
  const keyPaths = new Set(node.keyFiles.map((k) => k.path));
  const chipFiles = [...node.keyFiles.map((k) => k.path), ...node.files.filter((f) => !keyPaths.has(f))];
  const moduleChips = level === "architecture";
  const total = moduleChips ? node.modules.length : chipFiles.length;
  const hidden = total - CHIP_LIMIT;
  const shown = expanded || hidden <= 0 ? total : CHIP_LIMIT;

  return (
    <div
      style={{ width: APP_CARD_WIDTH }}
      className={cn(
        "relative overflow-hidden rounded-xl bg-card pt-2.5 pr-3 pb-3 pl-4 text-left shadow-sm ring-1 ring-border transition-[opacity,box-shadow]",
        selected && "ring-2 ring-brand",
        dimmed && "opacity-40"
      )}
    >
      <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: layer.color }} aria-hidden />
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="mb-0.5 truncate text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{tag}</p>
          <p className="text-[13px] leading-snug font-semibold tracking-tight">{node.name}</p>
        </div>
        {changed > 0 && (
          <span
            className="mt-0.5 shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning"
            title={`${changed} file${changed === 1 ? "" : "s"} changed in the selected diff`}
          >
            {changed} changed
          </span>
        )}
        {node.explanation && (
          <Sparkles className="mt-1 size-3.5 shrink-0 text-brand" aria-label="Has an AI explanation — select the card to read it" />
        )}
      </div>

      {node.description && (
        <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-muted-foreground">{node.description}</p>
      )}

      <div className="mt-2 flex items-center gap-2">
        {level !== "architecture" && <LayerBar layers={node.layers} className="flex-1" />}
        <span className={cn("shrink-0 text-[10px] text-muted-foreground", level === "architecture" && "ml-auto")}>
          {node.files.length} file{node.files.length === 1 ? "" : "s"}
          {level !== "modules" && ` · ${node.modules.length} module${node.modules.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <ul className="mt-2 space-y-1">
        {moduleChips
          ? node.modules.slice(0, shown).map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectModule?.(m.id);
                  }}
                  className="nodrag flex w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-left ring-1 ring-border/60 transition-colors hover:bg-secondary hover:ring-border"
                  title={`${m.name} — open module`}
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{m.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{m.files}</span>
                </button>
              </li>
            ))
          : chipFiles.slice(0, shown).map((f) => (
              <li key={f}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectFile?.(f);
                  }}
                  className="nodrag flex w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-left ring-1 ring-border/60 transition-colors hover:bg-secondary hover:ring-border"
                  title={`${f} — open its module`}
                >
                  {keyPaths.has(f) ? (
                    <Star className="size-3 shrink-0 fill-current text-warning" aria-label="Key file" />
                  ) : (
                    <FileCode2 className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{basename(f)}</span>
                  {changedFiles?.has(f) && (
                    <span className="size-1.5 shrink-0 rounded-full bg-warning" title="Changed in the selected diff" />
                  )}
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: APP_LAYERS[layerOfFile(node, f)].color }}
                    aria-hidden
                  />
                </button>
              </li>
            ))}
      </ul>

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
              <ChevronDown className="size-3" /> {hidden} more {moduleChips ? "module" : "file"}
              {hidden === 1 ? "" : "s"}
            </>
          )}
        </button>
      )}
    </div>
  );
}

/** A file's layer: per-file when the card spans several, the card's own otherwise. */
function layerOfFile(node: AppMapNodeDTO, path: string): AppMapNodeDTO["layer"] {
  return node.fileLayers?.[path] ?? node.layer;
}
