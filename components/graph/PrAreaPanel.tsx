"use client";

// The right column's inspector on the PR view (DESIGN.md §6.4): with an area
// (a PR map card) selected, what it is — its description and how it connects
// to the other areas — then its size, the components it spans (a chip
// filters the review dock to that component) and its most-changed files.
// With nothing selected it is not shown and the chat has the column (the
// cards already name every area). Everything comes from `buildPrAreas`, the
// object the canvas and the dock read too.

import { useMemo } from "react";
import { LayoutGrid, X } from "lucide-react";
import { cn } from "cn";
import { FindingCounts, LIFECYCLE_STYLES, OpenBadge, STATUS_BADGES } from "./PrMapNode";
import { areaLifecycle, type PrArea } from "./pr-areas";

const NUMBER = new Intl.NumberFormat("en-US");

/** Files listed under "Most changed". */
const TOP_FILES = 6;

export interface PrAreaPanelProps {
  area: PrArea;
  componentName: (id: string) => string | undefined;
  /** The component the dock is filtered to, if any. */
  selectedComponentId: string | null;
  onSelectComponent: (componentId: string | null) => void;
  /** Opens a file's diff. Absent when there is no diff to show (pasted paths). */
  onOpenFile?: (path: string) => void;
  onShowInAppMap?: (componentId: string) => void;
  onClose: () => void;
}

export function PrAreaPanel({
  area,
  componentName,
  selectedComponentId,
  onSelectComponent,
  onOpenFile,
  onShowInAppMap,
  onClose,
}: PrAreaPanelProps) {
  const { node } = area;
  const components = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of node.files) {
      if (file.componentId) counts.set(file.componentId, (counts.get(file.componentId) ?? 0) + 1);
    }
    // An unchanged neighbour has no files; its component is the card itself.
    if (counts.size === 0) for (const id of node.componentIds) counts.set(id, 0);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [node]);
  const top = useMemo(
    () =>
      [...node.files]
        .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path))
        .slice(0, TOP_FILES),
    [node.files]
  );
  const maxChurn = Math.max(1, ...top.map((f) => f.additions + f.deletions));
  const mainComponent = node.componentIds[0];
  const lifecycle = areaLifecycle(node);

  return (
    <section className="px-4 py-3 text-xs" aria-label={`Area: ${node.name}`}>
      <div className="flex items-center gap-1">
        <p className="flex-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {node.role === "context" ? "Unchanged neighbour" : "Area"}
          {lifecycle && (
            <span className={cn("ml-1.5", LIFECYCLE_STYLES[lifecycle].text)} title={LIFECYCLE_STYLES[lifecycle].title}>
              · all {LIFECYCLE_STYLES[lifecycle].word}
            </span>
          )}
        </p>
        {onShowInAppMap && mainComponent && (
          <button
            type="button"
            onClick={() => onShowInAppMap(mainComponent)}
            className="flex items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="Show this area's main module on the app map"
          >
            <LayoutGrid className="size-3.5" aria-hidden /> App map
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Back to the whole PR"
          title="Back to the whole PR"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <h2 className="mt-1 text-[17px] leading-snug font-semibold">{node.name}</h2>
      {node.description && <p className="mt-1.5 leading-relaxed text-muted-foreground">{node.description}</p>}
      {area.links.length > 0 && (
        <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-muted-foreground">
          {area.links.map((link) => (
            <li key={link}>{link}</li>
          ))}
        </ul>
      )}

      {node.role !== "context" && (
        <dl className="mt-3 grid grid-cols-3 border-y border-border">
          <div className="py-2">
            <dd className="font-mono text-[15px]">{node.files.length}</dd>
            <dt className="text-[11px] text-muted-foreground">file{node.files.length === 1 ? "" : "s"}</dt>
          </div>
          <div className="py-2">
            <dd className="font-mono text-[15px] text-success">+{NUMBER.format(area.additions)}</dd>
            <dt className="font-mono text-[11px] text-destructive">−{NUMBER.format(area.deletions)}</dt>
          </div>
          <div className="py-2">
            <dd className="flex h-[22px] items-center font-mono text-[15px]">
              {area.open > 0 ? <OpenBadge area={area} /> : <span className="text-muted-foreground">0</span>}
            </dd>
            <dt className="text-[11px] text-muted-foreground">need a look</dt>
          </div>
        </dl>
      )}
      <FindingCounts counts={area.counts} className="mt-2" />

      {components.length > 0 && (
        <>
          <p className="mt-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Components</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Filter the review by component">
            {components.map(([id, count]) => {
              const active = selectedComponentId === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSelectComponent(active ? null : id)}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex h-6 items-center gap-1.5 rounded-[3px] border px-2 font-mono text-[11px] transition-colors",
                    active
                      ? "border-brand bg-brand/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                  )}
                  title={active ? "Show the whole area in the review" : "Show only this component's findings and files in the review"}
                >
                  {componentName(id) ?? id}
                  {count > 0 && <span className="text-muted-foreground">{count}</span>}
                </button>
              );
            })}
          </div>
        </>
      )}

      {top.length > 0 && (
        <>
          <p className="mt-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Most changed</p>
          <ul className="mt-1">
            {top.map((file) => {
              const badge = STATUS_BADGES[file.status] ?? STATUS_BADGES.changed;
              const label = file.path.split("/").slice(-2).join("/");
              const content = (
                <>
                  <span className={cn("w-3 shrink-0 font-mono text-[11px] font-semibold", badge.className)} title={badge.label}>
                    {badge.letter}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{label}</span>
                  <span className="flex h-1 w-20 shrink-0 justify-end gap-px" aria-hidden>
                    <span className="h-full rounded-[1px] bg-success" style={{ width: `${(file.additions / maxChurn) * 100}%` }} />
                    <span className="h-full rounded-[1px] bg-destructive" style={{ width: `${(file.deletions / maxChurn) * 100}%` }} />
                  </span>
                </>
              );
              return (
                <li key={file.path}>
                  {onOpenFile ? (
                    <button
                      type="button"
                      onClick={() => onOpenFile(file.path)}
                      className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-sm px-1 py-1 text-left transition-colors hover:bg-secondary"
                      title={`${file.path} · +${file.additions} −${file.deletions} — view diff`}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 py-1" title={file.path}>
                      {content}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {node.files.length > TOP_FILES && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              All {node.files.length} are in the review&apos;s Files tab.
            </p>
          )}
        </>
      )}
    </section>
  );
}
