"use client";

// The Graph tab's PR view (DESIGN.md §6.4): the PR map drawn as cards with
// labelled edges, laid out left-to-right by ELK and rendered with React Flow
// through the shared `CardFlow` canvas (also used by the app map).
//
// Why not the Cytoscape canvas: a card here holds a list of clickable file
// chips, which is HTML, and Cytoscape draws to a <canvas>. The map is small
// (a handful of cards), so React Flow's DOM nodes cost nothing and every
// card is an ordinary React component.
//
// Layout is two-pass. Card heights depend on their content (description
// length, number of files, whether "+N more" is expanded), so every card is
// first rendered offscreen at the fixed card width and measured, then ELK
// places the measured boxes, then React Flow draws them at those positions.
// Nodes are not draggable: the layout is the point, and a dragged card would
// be thrown away by the next refresh anyway.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, LoaderCircle, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { CardFlow, type CardFlowLink } from "./CardFlow";
import { PR_CARD_WIDTH, PrMapCard, type PrCardMarker, type PrMapCardProps } from "./PrMapNode";
import { Spark } from "./Spark";
import { effectiveAssessment, worstAssessment } from "./review-visuals";
import type { PrMapNodeDTO, PrMapResponseDTO } from "./pr-map-types";
import type { FindingDTO, Assessment } from "./types";

export interface PrMapCanvasProps {
  map: PrMapResponseDTO | null;
  loading: boolean;
  error: string | null;
  findings: FindingDTO[];
  /** The component selected anywhere in the Graph tab — cards holding it light up. */
  selectedComponentId: string | null;
  /** A card was clicked (its component ids), or the background (`[]`). */
  onSelectComponents: (componentIds: string[]) => void;
  /** Opens a file's diff. Absent when there is no diff to show (pasted paths). */
  onOpenFile?: (path: string) => void;
  onShowInRepo: (componentIds: string[]) => void;
  /** A review of this target is queued or running — its PR map pass will rename the cards. */
  reviewPending?: boolean;
  className?: string;
}

export function PrMapCanvas({
  map,
  loading,
  error,
  findings,
  selectedComponentId,
  onSelectComponents,
  onOpenFile,
  onShowInRepo,
  reviewPending,
  className,
}: PrMapCanvasProps) {
  const [showContext, setShowContext] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** The card clicked last — kept locally because a card with no component (e.g. dependencies) can't be expressed as a component selection. */
  const [activeCardId, setActiveCardId] = useState<string | null>(null);

  // A new map is a new set of cards: expansion and the local selection don't carry over.
  useEffect(() => {
    setExpanded(new Set());
    setActiveCardId(null);
  }, [map]);

  const cards = useMemo(
    () => (map ? map.nodes.filter((n) => showContext || n.role !== "context") : []),
    [map, showContext]
  );
  const cardIds = useMemo(() => new Set(cards.map((c) => c.id)), [cards]);
  const links = useMemo(
    () => (map ? map.edges.filter((e) => cardIds.has(e.source) && cardIds.has(e.target)) : []),
    [map, cardIds]
  );
  const contextCount = map?.nodes.filter((n) => n.role === "context").length ?? 0;

  // --- Findings: one marker per card, one dot per file -------------------
  const { cardMarkers, fileMarkers } = useMemo(() => {
    const fileMarkers = new Map<string, Assessment>();
    const cardMarkers = new Map<string, PrCardMarker>();
    if (!map) return { cardMarkers, fileMarkers };
    const cardOfFile = new Map<string, string>();
    for (const node of map.nodes) for (const file of node.files) cardOfFile.set(file.path, node.id);
    const cardOfComponent = (componentId: string): string | undefined =>
      (
        map.nodes.find((n) => n.role === "code" && n.componentIds.includes(componentId)) ??
        map.nodes.find((n) => n.role !== "context" && n.componentIds.includes(componentId))
      )?.id;
    for (const finding of findings) {
      const intent = effectiveAssessment(finding);
      if (finding.filePath) {
        const prev = fileMarkers.get(finding.filePath);
        fileMarkers.set(finding.filePath, prev ? worstAssessment(prev, intent) : intent);
      }
      const cardId =
        (finding.filePath && cardOfFile.get(finding.filePath)) || cardOfComponent(finding.componentId);
      if (!cardId) continue;
      const prev = cardMarkers.get(cardId);
      cardMarkers.set(cardId, {
        worst: prev ? worstAssessment(prev.worst, intent) : intent,
        count: (prev?.count ?? 0) + 1,
      });
    }
    return { cardMarkers, fileMarkers };
  }, [map, findings]);

  // --- Selection ---------------------------------------------------------
  useEffect(() => {
    if (!activeCardId) return;
    const card = map?.nodes.find((n) => n.id === activeCardId);
    if (!card) return setActiveCardId(null);
    // Something else changed the selection (the review dock, the Repo view):
    // drop the local pick unless it still holds the selected component.
    if (selectedComponentId ? !card.componentIds.includes(selectedComponentId) : card.componentIds.length > 0) {
      setActiveCardId(null);
    }
  }, [selectedComponentId, activeCardId, map]);

  const highlighted = useMemo(() => {
    if (activeCardId) return new Set([activeCardId]);
    if (!selectedComponentId) return new Set<string>();
    return new Set(cards.filter((c) => c.componentIds.includes(selectedComponentId)).map((c) => c.id));
  }, [activeCardId, selectedComponentId, cards]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const cardProps = useCallback(
    (node: PrMapNodeDTO): PrMapCardProps => ({
      node,
      expanded: expanded.has(node.id),
      selected: highlighted.has(node.id),
      marker: cardMarkers.get(node.id),
      fileMarkers,
      onOpenFile,
      onToggleExpand: () => toggleExpand(node.id),
      onShowInRepo: node.componentIds.length > 0 ? () => onShowInRepo(node.componentIds) : undefined,
    }),
    [expanded, highlighted, cardMarkers, fileMarkers, onOpenFile, toggleExpand, onShowInRepo]
  );

  // --- Canvas ------------------------------------------------------------
  const layoutKey = useMemo(
    () =>
      JSON.stringify([
        cards.map((c) => [c.id, c.name, c.description, c.files.length, expanded.has(c.id), cardMarkers.has(c.id)]),
        links.map((e) => [e.source, e.target]),
      ]),
    [cards, links, expanded, cardMarkers]
  );
  const cardIdList = useMemo(() => cards.map((c) => c.id), [cards]);
  const renderCard = useCallback(
    (id: string) => {
      const card = cards.find((c) => c.id === id);
      return card ? <PrMapCard {...cardProps(card)} /> : null;
    },
    [cards, cardProps]
  );
  const flowLinks = useMemo<CardFlowLink[]>(() => {
    const roleOf = new Map(cards.map((c) => [c.id, c.role]));
    return links.map((link) => ({
      ...link,
      dashed: roleOf.get(link.source) === "context" || roleOf.get(link.target) === "context",
    }));
  }, [links, cards]);

  // --- Summary -----------------------------------------------------------
  // File and line totals live in the diff summary (left column) — saying
  // them again here is how the page ended up with four disagreeing counts.
  const groups = map?.nodes.filter((n) => n.role !== "context").length ?? 0;

  return (
    <div className={className}>
      <div className="mb-3 flex min-h-[26px] flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {map && (
            <span className="font-mono text-[11px]">
              {groups} group{groups === 1 ? "" : "s"}
            </span>
          )}
          {map && <SourceNote map={map} reviewPending={reviewPending} />}
          {loading && <LoaderCircle className="size-3.5 animate-spin" aria-label="Loading" />}
        </div>
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
            Unchanged neighbours ({contextCount})
          </button>
        )}
      </div>

      <CardFlow
        cardIds={cardIdList}
        cardWidth={PR_CARD_WIDTH}
        renderCard={renderCard}
        links={flowLinks}
        highlighted={highlighted}
        layoutKey={layoutKey}
        onCardClick={(id) => {
          const card = map?.nodes.find((n) => n.id === id);
          if (!card) return;
          if (highlighted.has(card.id) && activeCardId === card.id) {
            setActiveCardId(null);
            onSelectComponents([]);
            return;
          }
          setActiveCardId(card.id);
          onSelectComponents(card.componentIds);
        }}
        onPaneClick={() => {
          setActiveCardId(null);
          onSelectComponents([]);
        }}
      >
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
      </CardFlow>
    </div>
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
