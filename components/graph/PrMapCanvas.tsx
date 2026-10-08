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
//
// Two modes (DESIGN.md §6.10): **Files** — the areas, with the links the
// change adds between them drawn in its colour and the ones it removes
// ghosted (from the base/head comparison, `useTargetGraph`) — and
// **Functions** — every area opened into the functions the change touches,
// with their untouched callers and callees on neighbour cards and the calls
// drawn row to row (`FunctionCard`, `buildFunctionView`).

import { useCallback, useMemo, useState } from "react";
import { Eye, EyeOff, LoaderCircle, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { CardFlow, type CardFlowLink } from "./CardFlow";
import { activeLinksFor, type FunctionView } from "./call-graph-view";
import { FUNCTION_CARD_WIDTH, FUNCTION_STATUS, FunctionCard } from "./FunctionCard";
import { PR_CARD_WIDTH, PrMapCard } from "./PrMapNode";
import { Segmented } from "./Segmented";
import { Spark } from "./Spark";
import { ASSESSMENT_VISUALS } from "./review-visuals";
import { areaLifecycle, type AreaLifecycle, type PrAreas } from "./pr-areas";
import type { PrMapNodeDTO, PrMapResponseDTO } from "./pr-map-types";
import type { TargetGraphData } from "./target-graph-types";
import type { UseTargetGraphResult } from "./useTargetGraph";
import { VIEW_CANVAS, VIEW_TOOLBAR } from "./view-chrome";

export type PrMapMode = "files" | "functions";

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
  /** Files (areas) or Functions (the call graph). */
  mode?: PrMapMode;
  onModeChange?: (mode: PrMapMode) => void;
  /** The base/head comparison: structure links in Files mode, everything in Functions mode. */
  targetGraph?: UseTargetGraphResult;
  functionView?: FunctionView | null;
  selectedFunctionId?: string | null;
  onSelectFunction?: (id: string | null) => void;
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
  mode = "files",
  onModeChange,
  targetGraph,
  functionView,
  selectedFunctionId = null,
  onSelectFunction,
}: PrMapCanvasProps) {
  const [showContext, setShowContext] = useState(true);
  const structure = targetGraph?.graph?.data;

  const cards = useMemo(
    () => (map ? map.nodes.filter((n) => showContext || n.role !== "context" || n.id === selectedCardId) : []),
    [map, showContext, selectedCardId]
  );
  const cardIds = useMemo(() => new Set(cards.map((c) => c.id)), [cards]);
  const links = useMemo<CardFlowLink[]>(() => {
    const own = map ? map.edges.filter((e) => cardIds.has(e.source) && cardIds.has(e.target)) : [];
    return structure ? withStructureLinks(own, cards, structure) : own;
  }, [map, cardIds, cards, structure]);
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
  const linkTones = useMemo(() => new Set(links.map((l) => l.tone).filter(Boolean)), [links]);

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
        links.map((e) => [e.source, e.target, e.tone ?? ""]),
      ]),
    [cards, links]
  );
  const cardIdList = useMemo(() => cards.map((c) => c.id), [cards]);
  const flowLinks = useMemo<CardFlowLink[]>(() => {
    const roleOf = new Map(cards.map((c) => [c.id, c.role]));
    return links.map((link) => ({
      ...link,
      dashed: !link.tone && (roleOf.get(link.source) === "context" || roleOf.get(link.target) === "context"),
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
          {map && mode === "files" && (
            <span className="font-mono text-[11px]">
              {groups} area{groups === 1 ? "" : "s"} · {map.edges.length} link{map.edges.length === 1 ? "" : "s"}
            </span>
          )}
          {map && mode === "functions" && functionView && (
            <span className="font-mono text-[11px]">
              {functionView.functionById.size} function{functionView.functionById.size === 1 ? "" : "s"} · {functionView.edges.length} call
              {functionView.edges.length === 1 ? "" : "s"}
            </span>
          )}
          {map && mode === "files" && <SourceNote map={map} reviewPending={reviewPending} />}
          {loading && <LoaderCircle className="size-3.5 animate-spin" aria-label="Loading" />}
          {targetGraph && <StructureNote targetGraph={targetGraph} />}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {mode === "files" && contextCount > 0 && (
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
          {onModeChange && (
            <Segmented
              label="Show"
              size="xs"
              value={mode}
              onChange={onModeChange}
              options={[
                { value: "files" as const, label: "Files", title: "The areas of the change and how they connect" },
                {
                  value: "functions" as const,
                  label: "Functions",
                  title: "The functions the change touches, their callers and callees, and the calls between them",
                },
              ]}
            />
          )}
        </div>
      </div>

      {mode === "functions" ? (
        <FunctionCanvas
          view={functionView ?? null}
          targetGraph={targetGraph}
          selectedFunctionId={selectedFunctionId}
          onSelectFunction={onSelectFunction ?? (() => undefined)}
        />
      ) : (
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
          {map && map.nodes.length > 0 && <Legend lifecycles={lifecycles} tones={linkTones} />}
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
      )}
    </div>
  );
}

/**
 * The PR map's links plus what the change does to them: a link the change
 * adds (a component dependency the base didn't have) is drawn in the "new"
 * colour — added to the map if it wasn't there — and one it removes is drawn
 * ghosted between the cards, when both are on the map.
 */
function withStructureLinks(links: CardFlowLink[], cards: PrMapNodeDTO[], data: TargetGraphData): CardFlowLink[] {
  const cardOfFile = (file: string): string | undefined => {
    const changed = cards.find((c) => c.files.some((f) => f.path === file));
    if (changed) return changed.id;
    const component = data.fileComponents[file]?.id;
    return component ? cards.find((c) => c.componentIds.includes(component))?.id : undefined;
  };
  const out = links.map((l) => ({ ...l }));
  const index = new Map(out.map((l) => [`${l.source}->${l.target}`, l]));
  const mark = (change: { files: Array<{ from: string; to: string }> }, tone: "new" | "removed") => {
    const pairs = new Map<string, { source: string; target: string; count: number }>();
    for (const edge of change.files) {
      const source = cardOfFile(edge.from);
      const target = cardOfFile(edge.to);
      if (!source || !target || source === target) continue;
      const key = `${source}->${target}`;
      const pair = pairs.get(key) ?? { source, target, count: 0 };
      pair.count += 1;
      pairs.set(key, pair);
    }
    for (const [key, { source, target, count }] of pairs) {
      const existing = index.get(key);
      if (existing) {
        if (tone === "new" && existing.tone !== "new") {
          existing.tone = "new";
          existing.label = `${existing.label} (new)`;
        }
        continue;
      }
      const link: CardFlowLink = { source, target, label: tone === "new" ? "imports (new)" : "no longer imports", weight: count, tone };
      out.push(link);
      index.set(key, link);
    }
  };
  for (const change of data.structure.components.added) mark(change, "new");
  for (const change of data.structure.components.removed) mark(change, "removed");
  return out;
}

/** "1 new import cycle · +3 dependencies · 74 files depend on it" — the structure change in one line. */
function StructureNote({ targetGraph }: { targetGraph: UseTargetGraphResult }) {
  const data = targetGraph.graph?.data;
  if (!data) {
    if (targetGraph.error) {
      return (
        <span className="text-[11px] text-warning" title={targetGraph.error}>
          Couldn&apos;t compare base and head
        </span>
      );
    }
    return targetGraph.pending ? (
      <span className="flex items-center gap-1 text-[11px]">
        <LoaderCircle className="size-3 animate-spin" aria-hidden /> Comparing base and head…
      </span>
    ) : null;
  }
  const s = data.structure;
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const parts: Array<{ key: string; text: string; title: string; style?: React.CSSProperties; className?: string }> = [];
  if (s.newCycles.length > 0) {
    parts.push({
      key: "cycles",
      text: `${s.newCycles.length} new import ${plural(s.newCycles.length, "cycle", "cycles")}`,
      title: s.newCycles.map((c) => c.files.join(" → ")).join("\n"),
      style: { color: ASSESSMENT_VISUALS.concern.text },
    });
  }
  if (s.components.added.length > 0) {
    parts.push({
      key: "added",
      text: `+${s.components.added.length} ${plural(s.components.added.length, "dependency", "dependencies")}`,
      title: `Module dependencies this change adds:\n${s.components.added.map((c) => `${c.fromName} → ${c.toName}`).join("\n")}`,
      className: "text-[#d8703a]",
    });
  }
  if (s.components.removed.length > 0) {
    parts.push({
      key: "removed",
      text: `−${s.components.removed.length} ${plural(s.components.removed.length, "dependency", "dependencies")}`,
      title: `Module dependencies this change removes:\n${s.components.removed.map((c) => `${c.fromName} → ${c.toName}`).join("\n")}`,
    });
  }
  if (s.orphaned.length > 0) {
    parts.push({
      key: "orphaned",
      text: `${s.orphaned.length} ${plural(s.orphaned.length, "file", "files")} no longer imported`,
      title: `Imported by something at the base, by nothing now:\n${s.orphaned.join("\n")}`,
    });
  }
  if (s.dependents.count > 0) {
    parts.push({
      key: "dependents",
      text: `${s.dependents.count} ${plural(s.dependents.count, "file depends", "files depend")} on it`,
      title: `Files that import the changed files, directly or through others, in ${s.dependentComponents} ${plural(s.dependentComponents, "module", "modules")}`,
    });
  }
  if (parts.length === 0) return <span className="text-[11px]">No structural change</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-2 font-mono text-[11px]">
      {parts.map((part, i) => (
        <span key={part.key} className="flex items-center gap-2">
          {i > 0 && <span className="text-muted-foreground/50">·</span>}
          <span className={part.className} style={part.style} title={part.title}>
            {part.text}
          </span>
        </span>
      ))}
      {targetGraph.pending && <LoaderCircle className="size-3 animate-spin" aria-label="Updating" />}
    </span>
  );
}

/** The Functions mode canvas: function cards, calls drawn row to row. */
function FunctionCanvas({
  view,
  targetGraph,
  selectedFunctionId,
  onSelectFunction,
}: {
  view: FunctionView | null;
  targetGraph?: UseTargetGraphResult;
  selectedFunctionId: string | null;
  onSelectFunction: (id: string | null) => void;
}) {
  const cardIds = useMemo(() => view?.cards.map((c) => c.id) ?? [], [view]);
  const activeLinks = useMemo(() => (view ? activeLinksFor(view, selectedFunctionId) : undefined), [view, selectedFunctionId]);
  const related = useMemo(() => {
    const out = new Set<string>();
    if (!view || !selectedFunctionId) return out;
    for (const e of view.edges) {
      if (e.from === selectedFunctionId) out.add(e.to);
      if (e.to === selectedFunctionId) out.add(e.from);
    }
    return out;
  }, [view, selectedFunctionId]);
  const highlighted = useMemo(() => {
    if (!view || !selectedFunctionId) return new Set<string>();
    const out = new Set<string>();
    for (const id of [selectedFunctionId, ...related]) {
      const card = view.cardOf.get(id);
      if (card) out.add(card);
    }
    return out;
  }, [view, selectedFunctionId, related]);
  const renderCard = useCallback(
    (id: string) => {
      const card = view?.cards.find((c) => c.id === id);
      if (!card) return null;
      return (
        <FunctionCard
          card={card}
          selectedFunctionId={selectedFunctionId}
          relatedIds={related}
          onSelectFunction={(fn) => onSelectFunction(fn === selectedFunctionId ? null : fn)}
          dimmed={highlighted.size > 0 && !highlighted.has(card.id)}
        />
      );
    },
    [view, selectedFunctionId, related, highlighted, onSelectFunction]
  );
  const layoutKey = useMemo(
    () =>
      JSON.stringify([
        view?.cards.map((c) => [c.id, c.functions.map((f) => f.id), c.hidden, c.unresolved > 0]),
        view?.links.map((l) => l.id),
      ]),
    [view]
  );
  const statuses = useMemo(() => new Set(view?.cards.flatMap((c) => c.functions.map((f) => f.status)) ?? []), [view]);
  const tones = useMemo(() => new Set(view?.links.map((l) => l.tone ?? "existing") ?? []), [view]);

  return (
    <CardFlow
      className={VIEW_CANVAS}
      cardIds={cardIds}
      cardWidth={FUNCTION_CARD_WIDTH}
      renderCard={renderCard}
      links={view?.links ?? []}
      highlighted={highlighted}
      activeLinks={activeLinks}
      ports
      layoutKey={layoutKey}
      alwaysLabelEdges={0}
      onCardClick={() => undefined}
      onPaneClick={() => onSelectFunction(null)}
    >
      {view && view.cards.length > 0 && <FunctionLegend statuses={statuses} tones={tones} />}
      {!view && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          {targetGraph?.error ? (
            <p className="flex max-w-md items-start gap-2 px-6 text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {targetGraph.error}
            </p>
          ) : (
            <>
              <LoaderCircle className="size-5 animate-spin" aria-hidden />
              Comparing the base and the head…
            </>
          )}
        </div>
      )}
      {view && view.cards.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
          No functions to show — the change touches no functions in TypeScript, JavaScript, Python, Java or Kotlin.
        </div>
      )}
    </CardFlow>
  );
}

const TONE_LEGEND: Array<{ key: string; label: string; style: React.CSSProperties }> = [
  { key: "new", label: "new call", style: { borderTop: "2px solid #d8703a" } },
  { key: "removed", label: "removed call", style: { borderTop: "2px dotted #8a909c" } },
  { key: "broken", label: "caller not updated", style: { borderTop: "2px dashed #e5484d" } },
];

function FunctionLegend({ statuses, tones }: { statuses: ReadonlySet<string>; tones: ReadonlySet<string> }) {
  const order = ["signature", "body", "added", "removed", "unchanged"] as const;
  return (
    <span
      className="pointer-events-none absolute top-2 right-3 z-10 flex max-w-[70%] flex-wrap items-center justify-end gap-x-3 gap-y-1 rounded-md bg-background/70 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur-sm"
      aria-hidden
    >
      {order
        .filter((s) => statuses.has(s))
        .map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={cn("h-2.5 w-3.5 rounded-[2px] border", FUNCTION_STATUS[s].row)} />
            {FUNCTION_STATUS[s].label}
          </span>
        ))}
      {TONE_LEGEND.filter((t) => tones.has(t.key)).map((t) => (
        <span key={t.key} className="flex items-center gap-1.5">
          <span className="w-4" style={t.style} />
          {t.label}
        </span>
      ))}
    </span>
  );
}

/** What the cards' badges and glows mean: the badge colours, the new / deleted looks, and the change's link colours this map has. */
function Legend({ lifecycles, tones }: { lifecycles: ReadonlySet<AreaLifecycle>; tones: ReadonlySet<string | undefined> }) {
  const items = [
    { label: "defect", style: { background: ASSESSMENT_VISUALS.defect.color } },
    { label: "concern", style: { background: ASSESSMENT_VISUALS.concern.color } },
  ];
  const glows: Array<{ key: AreaLifecycle; label: string; className: string }> = [
    { key: "new", label: "all new", className: "border-success/60 shadow-[0_0_6px_0_color-mix(in_oklab,var(--success)_60%,transparent)]" },
    { key: "deleted", label: "all deleted", className: "border-destructive/60 shadow-[0_0_6px_0_color-mix(in_oklab,var(--destructive)_60%,transparent)]" },
  ];
  const linkItems = [
    { key: "new", label: "new dependency", style: { borderTop: "2px solid #d8703a" } },
    { key: "removed", label: "removed dependency", style: { borderTop: "2px dotted #8a909c" } },
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
      {linkItems
        .filter((l) => tones.has(l.key))
        .map((l) => (
          <span key={l.key} className="flex items-center gap-1.5">
            <span className="w-4" style={l.style} />
            {l.label}
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
