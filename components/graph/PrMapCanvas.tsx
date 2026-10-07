"use client";

// The Graph tab's PR view (DESIGN.md §6.4): the PR map drawn as small area
// cards with labelled edges, laid out left-to-right by ELK and rendered with
// React Flow through the shared `CardFlow` canvas (also used by the app map).
//
// Why not Cytoscape (which drew the removed Repo view): cards are HTML
// (badges, bars, wrapped names), and Cytoscape draws to a <canvas>. The map is small (a handful of
// cards), so React Flow's DOM nodes cost nothing.
//
// A card is an *area* of the change. Clicking one selects it: the other
// cards step back, its edges light up, the review dock below filters to its
// findings and files, and the right column explains it (`PrAreaPanel`).
// Clicking it again, or the background, goes back to the whole PR. The
// numbers on the cards come from `buildPrAreas`, the same object the dock
// and the inspector read, so the three never disagree.

import { useCallback, useMemo, useState } from "react";
import { Eye, EyeOff, LoaderCircle, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { CardFlow, type CardFlowLink } from "./CardFlow";
import { PR_CARD_WIDTH, PrMapCard } from "./PrMapNode";
import { Spark } from "./Spark";
import { ASSESSMENT_VISUALS } from "./review-visuals";
import { areaLifecycle, type AreaLifecycle, type PrAreas } from "./pr-areas";
import type { PrMapResponseDTO } from "./pr-map-types";
import { VIEW_CANVAS, VIEW_TOOLBAR } from "./view-chrome";

export interface PrMapCanvasProps {
  map: PrMapResponseDTO | null;
  loading: boolean;
  error: string | null;
  areas: PrAreas;
  /** The selected area (card id), or `null` for the whole PR. */
  selectedCardId: string | null;
  onSelectCard: (cardId: string | null) => void;
  /** A component selected elsewhere in the Graph tab — the cards holding it light up while no area is picked. */
  selectedComponentId?: string | null;
  /** A review of this target is queued or running — its PR map pass will rename the cards. */
  reviewPending?: boolean;
  /** Drawn first in the toolbar — GraphView's view switch. */
  leading?: React.ReactNode;
  className?: string;
}

export function PrMapCanvas({
  map,
  loading,
  error,
  areas,
  selectedCardId,
  onSelectCard,
  selectedComponentId,
  reviewPending,
  leading,
  className,
}: PrMapCanvasProps) {
  const [showContext, setShowContext] = useState(true);

  const cards = useMemo(
    () => (map ? map.nodes.filter((n) => showContext || n.role !== "context" || n.id === selectedCardId) : []),
    [map, showContext, selectedCardId]
  );
  const cardIds = useMemo(() => new Set(cards.map((c) => c.id)), [cards]);
  const links = useMemo(
    () => (map ? map.edges.filter((e) => cardIds.has(e.source) && cardIds.has(e.target)) : []),
    [map, cardIds]
  );
  const contextCount = map?.nodes.filter((n) => n.role === "context").length ?? 0;
  /** Which of the new / deleted looks appear on this map — the legend only explains those. */
  const lifecycles = useMemo(() => {
    const seen = new Set<AreaLifecycle>();
    for (const node of map?.nodes ?? []) {
      const lifecycle = areaLifecycle(node);
      if (lifecycle) seen.add(lifecycle);
    }
    return seen;
  }, [map]);

  const highlighted = useMemo(() => {
    if (selectedCardId) return new Set([selectedCardId]);
    if (!selectedComponentId) return new Set<string>();
    return new Set(cards.filter((c) => c.componentIds.includes(selectedComponentId)).map((c) => c.id));
  }, [selectedCardId, selectedComponentId, cards]);

  const renderCard = useCallback(
    (id: string) => {
      const card = cards.find((c) => c.id === id);
      if (!card) return null;
      return (
        <PrMapCard
          node={card}
          area={areas.areas.get(card.id)}
          selected={highlighted.has(card.id)}
          dimmed={Boolean(selectedCardId) && card.id !== selectedCardId}
        />
      );
    },
    [cards, areas, highlighted, selectedCardId]
  );

  // Only what changes a card's size or the edge set re-runs the layout: the
  // name, whether it has a role tag, and the edges. (The badge floats over
  // the corner, so findings arriving never move a card.)
  const layoutKey = useMemo(
    () =>
      JSON.stringify([
        cards.map((c) => [c.id, c.name, c.role]),
        links.map((e) => [e.source, e.target]),
      ]),
    [cards, links]
  );
  const cardIdList = useMemo(() => cards.map((c) => c.id), [cards]);
  const flowLinks = useMemo<CardFlowLink[]>(() => {
    const roleOf = new Map(cards.map((c) => [c.id, c.role]));
    return links.map((link) => ({
      ...link,
      dashed: roleOf.get(link.source) === "context" || roleOf.get(link.target) === "context",
    }));
  }, [links, cards]);

  // File and line totals live in the diff summary (left column) — the
  // toolbar only says how the map is grouped and what the colours mean.
  const groups = map?.nodes.filter((n) => n.role !== "context").length ?? 0;

  return (
    <div className={className}>
      <div className={VIEW_TOOLBAR}>
        {leading}
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {map && (
            <span className="font-mono text-[11px]">
              {groups} area{groups === 1 ? "" : "s"} · {map.edges.length} link{map.edges.length === 1 ? "" : "s"}
            </span>
          )}
          {map && <SourceNote map={map} reviewPending={reviewPending} />}
          {loading && <LoaderCircle className="size-3.5 animate-spin" aria-label="Loading" />}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {contextCount > 0 && (
            <button
              type="button"
              onClick={() => setShowContext((v) => !v)}
              aria-pressed={showContext}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                showContext
                  ? "border-foreground/25 bg-secondary text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
              title="Untouched modules the changed code imports or is imported by"
            >
              {showContext ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
              Neighbours ({contextCount})
            </button>
          )}
        </div>
      </div>

      <CardFlow
        className={VIEW_CANVAS}
        cardIds={cardIdList}
        cardWidth={PR_CARD_WIDTH}
        renderCard={renderCard}
        links={flowLinks}
        highlighted={highlighted}
        layoutKey={layoutKey}
        onCardClick={(id) => onSelectCard(id === selectedCardId ? null : id)}
        onPaneClick={() => onSelectCard(null)}
      >
        {/* Floats over the canvas so the toolbar above stays one row. */}
        {map && map.nodes.length > 0 && <Legend lifecycles={lifecycles} />}
        {!map && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            {error ? (
              <p className="flex max-w-md items-start gap-2 px-6 text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                {error}
              </p>
            ) : (
              <>
                <LoaderCircle className="size-5 animate-spin" aria-hidden />
                Building the PR map…
              </>
            )}
          </div>
        )}
        {map && map.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            This diff changes no files.
          </div>
        )}
        {selectedCardId && (
          <button
            type="button"
            onClick={() => onSelectCard(null)}
            className="absolute bottom-3 left-3 z-10 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          >
            Show the whole PR
          </button>
        )}
      </CardFlow>
    </div>
  );
}

/** What the cards' badges and glows mean: the badge colours, plus the new / deleted looks this map has. */
function Legend({ lifecycles }: { lifecycles: ReadonlySet<AreaLifecycle> }) {
  const items = [
    { label: "defect", style: { background: ASSESSMENT_VISUALS.defect.color } },
    { label: "concern", style: { background: ASSESSMENT_VISUALS.concern.color } },
  ];
  const glows: Array<{ key: AreaLifecycle; label: string; className: string }> = [
    { key: "new", label: "all new", className: "border-success/60 shadow-[0_0_6px_0_color-mix(in_oklab,var(--success)_60%,transparent)]" },
    { key: "deleted", label: "all deleted", className: "border-destructive/60 shadow-[0_0_6px_0_color-mix(in_oklab,var(--destructive)_60%,transparent)]" },
  ];
  return (
    <span
      className="pointer-events-none absolute top-2 right-3 z-10 flex items-center gap-3 rounded-md bg-background/70 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur-sm"
      aria-hidden
    >
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={item.style} />
          {item.label}
        </span>
      ))}
      {glows
        .filter((g) => lifecycles.has(g.key))
        .map((g) => (
          <span key={g.key} className="flex items-center gap-1.5">
            <span className={cn("h-2 w-3 rounded-[2px] border bg-card", g.className)} />
            {g.label}
          </span>
        ))}
    </span>
  );
}

function SourceNote({ map, reviewPending }: { map: PrMapResponseDTO; reviewPending?: boolean }) {
  if (map.source === "ai") {
    return (
      <span
        className="flex items-center gap-1 text-[11px]"
        title={map.model ? `Grouped and named by ${map.model}` : "Grouped and named by the review"}
      >
        <Spark /> grouped by review
      </span>
    );
  }
  if (reviewPending) {
    return <span className="text-[11px]">Grouped by module — names arrive when the review finishes</span>;
  }
  if (map.aiOutdated) {
    return (
      <span className="text-[11px] text-warning">
        Files changed since the review grouped them — re-run the review to refresh it
      </span>
    );
  }
  return <span className="text-[11px]">Grouped by module</span>;
}
