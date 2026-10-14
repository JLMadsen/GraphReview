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
import { createPortal } from "react-dom";
import { Eye, EyeOff, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { CardFlow, type CardFlowLink } from "./CardFlow";
import { activeLinksFor, type FunctionView } from "./call-graph-view";
import { FUNCTION_CARD_WIDTH, FUNCTION_STATUS, FunctionCard } from "./FunctionCard";
import { PR_CARD_WIDTH, PrMapCard } from "./PrMapNode";
import { Segmented } from "./Segmented";
import { ASSESSMENT_VISUALS } from "./review-visuals";
import { areaLifecycle, type AreaLifecycle, type PrAreas } from "./pr-areas";
import type { PrMapNodeDTO, PrMapResponseDTO } from "./pr-map-types";
import type { TargetGraphData } from "./target-graph-types";
import type { UseTargetGraphResult } from "./useTargetGraph";
import { VIEW_CANVAS } from "./view-chrome";

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
  /** Components a chat answer highlighted — the cards holding any of them light up while no area is picked. */
  highlightComponentIds?: readonly string[] | null;
  /** A review of this target is queued or running — its PR map pass will rename the cards. */
  reviewPending?: boolean;
  className?: string;
  /** Files (areas) or Functions (the call graph). */
  mode?: PrMapMode;
  onModeChange?: (mode: PrMapMode) => void;
  /** The base/head comparison: structure links in Files mode, everything in Functions mode. */
  targetGraph?: UseTargetGraphResult;
  functionView?: FunctionView | null;
  selectedFunctionId?: string | null;
  onSelectFunction?: (id: string | null) => void;
  /** The eyes on the function cards. */
  onHideFunction?: (id: string) => void;
  onHideCard?: (cardId: string) => void;
  /** Puts everything hidden back on the map. */
  onShowHidden?: () => void;
  /** Table names per file (DESIGN.md §6.13 §7): each area card gets a ⛁N badge for the tables its files touch. */
  tablesByFile?: ReadonlyMap<string, readonly string[]>;
  /** Where the map's controls go — the right end of GraphView's view tabs, while this view is the active one. `null`: not drawn. */
  toolbarSlot?: HTMLElement | null;
}

export function PrMapCanvas({
  map,
  loading,
  error,
  areas,
  selectedCardId,
  onSelectCard,
  selectedComponentId,
  highlightComponentIds,
  tablesByFile,
  reviewPending,
  className,
  mode = "files",
  onModeChange,
  targetGraph,
  functionView,
  selectedFunctionId = null,
  onSelectFunction,
  onHideFunction,
  onHideCard,
  onShowHidden,
  toolbarSlot = null,
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
    const ids = new Set([...(selectedComponentId ? [selectedComponentId] : []), ...(highlightComponentIds ?? [])]);
    if (ids.size === 0) return new Set<string>();
    return new Set(cards.filter((c) => c.componentIds.some((id) => ids.has(id))).map((c) => c.id));
  }, [selectedCardId, selectedComponentId, highlightComponentIds, cards]);

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
          tables={tablesByFile ? [...new Set(card.files.flatMap((f) => tablesByFile.get(f.path) ?? []))].sort() : undefined}
        />
      );
    },
    [cards, areas, highlighted, selectedCardId, tablesByFile]
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
  // notes only say how the map is grouped and what the comparison found.
  const groups = map?.nodes.filter((n) => n.role !== "context").length ?? 0;

  return (
    <div className={className}>
      {/* No toolbar row of its own: the controls sit at the right end of the
          view tabs, and what the row used to say (counts, how the cards were
          grouped, what the comparison found) is the info icon's hover. */}
      {toolbarSlot &&
        createPortal(
        <div className="flex items-center gap-2">
          {(loading || targetGraph?.pending) && (
            <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />
          )}
          {map && (
            <MapNotes
              lines={[
                mode === "functions" && functionView
                  ? { text: `${functionView.shownCount} function${functionView.shownCount === 1 ? "" : "s"} · ${functionView.edges.length} call${functionView.edges.length === 1 ? "" : "s"}` }
                  : { text: `${groups} area${groups === 1 ? "" : "s"} · ${map.edges.length} link${map.edges.length === 1 ? "" : "s"}` },
                ...(mode === "files" ? [sourceNote(map, reviewPending)] : []),
                ...(targetGraph ? structureNotes(targetGraph) : []),
              ]}
            />
          )}
          {mode === "functions" && functionView && functionView.hiddenItems.length > 0 && onShowHidden && (
            <button
              type="button"
              onClick={onShowHidden}
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground"
              title={
                `Hidden: ${functionView.hiddenItems.map((item) => (item.kind === "card" ? `${item.label} (card)` : item.label)).join(", ")}` +
                (functionView.prunedCount > 0
                  ? `\nAlso off the map: ${functionView.prunedCount} untouched function${functionView.prunedCount === 1 ? "" : "s"} that only called or were called by them.`
                  : "") +
                "\nClick to show everything again."
              }
            >
              <EyeOff className="size-3.5" aria-hidden />
              {functionView.hiddenItems.length} hidden
              {functionView.prunedCount > 0 && <span className="font-normal">(+{functionView.prunedCount})</span>}
              <span className="text-foreground">· Show all</span>
            </button>
          )}
          {mode === "files" && contextCount > 0 && (
            <button
              type="button"
              onClick={() => setShowContext((v) => !v)}
              aria-pressed={showContext}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors",
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
        </div>,
        toolbarSlot
      )}

      {mode === "functions" ? (
        <FunctionCanvas
          view={functionView ?? null}
          targetGraph={targetGraph}
          selectedFunctionId={selectedFunctionId}
          onSelectFunction={onSelectFunction ?? (() => undefined)}
          onHideFunction={onHideFunction}
          onHideCard={onHideCard}
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
interface MapNote {
  text: string;
  /** Worth the reviewer's attention — turns the info icon amber. */
  warn?: boolean;
}

/** The map's notes behind one icon: its size, how its cards were grouped and what the base/head comparison found. */
function MapNotes({ lines }: { lines: MapNote[] }) {
  const warn = lines.some((l) => l.warn);
  const Icon = warn ? TriangleAlert : Info;
  return (
    <span
      tabIndex={0}
      className={cn("flex cursor-help items-center rounded p-0.5 outline-none focus-visible:ring-1 focus-visible:ring-ring", warn ? "text-warning" : "text-muted-foreground hover:text-foreground")}
      title={lines.map((l) => l.text).join("\n")}
      aria-label={lines.map((l) => l.text).join(". ")}
    >
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}

function structureNotes(targetGraph: UseTargetGraphResult): MapNote[] {
  const data = targetGraph.graph?.data;
  if (!data) {
    if (targetGraph.error) return [{ text: `Couldn't compare base and head: ${targetGraph.error}`, warn: true }];
    return targetGraph.pending ? [{ text: "Comparing base and head…" }] : [];
  }
  const s = data.structure;
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const notes: MapNote[] = [];
  if (s.newCycles.length > 0) {
    notes.push({
      text: `${s.newCycles.length} new import ${plural(s.newCycles.length, "cycle", "cycles")}: ${s.newCycles.map((c) => c.files.join(" → ")).join("; ")}`,
      warn: true,
    });
  }
  if (s.components.added.length > 0) {
    notes.push({
      text: `+${s.components.added.length} ${plural(s.components.added.length, "dependency", "dependencies")}: ${s.components.added.map((c) => `${c.fromName} → ${c.toName}`).join(", ")}`,
    });
  }
  if (s.components.removed.length > 0) {
    notes.push({
      text: `−${s.components.removed.length} ${plural(s.components.removed.length, "dependency", "dependencies")}: ${s.components.removed.map((c) => `${c.fromName} → ${c.toName}`).join(", ")}`,
    });
  }
  if (s.orphaned.length > 0) {
    notes.push({ text: `${s.orphaned.length} ${plural(s.orphaned.length, "file", "files")} no longer imported: ${s.orphaned.join(", ")}` });
  }
  if (s.dependents.count > 0) {
    notes.push({
      text: `${s.dependents.count} ${plural(s.dependents.count, "file depends", "files depend")} on it, in ${s.dependentComponents} ${plural(s.dependentComponents, "module", "modules")}`,
    });
  }
  return notes.length > 0 ? notes : [{ text: "No structural change" }];
}

/** The Functions mode canvas: function cards, calls drawn row to row. */
function FunctionCanvas({
  view,
  targetGraph,
  selectedFunctionId,
  onSelectFunction,
  onHideFunction,
  onHideCard,
}: {
  view: FunctionView | null;
  targetGraph?: UseTargetGraphResult;
  selectedFunctionId: string | null;
  onSelectFunction: (id: string | null) => void;
  onHideFunction?: (id: string) => void;
  onHideCard?: (cardId: string) => void;
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
          onHideFunction={onHideFunction}
          onHideCard={onHideCard}
          dimmed={highlighted.size > 0 && !highlighted.has(card.id)}
        />
      );
    },
    [view, selectedFunctionId, related, highlighted, onSelectFunction, onHideFunction, onHideCard]
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
          {view.hiddenItems.length > 0
            ? "Everything is hidden — use Show all in the toolbar to bring it back."
            : "No functions to show — the change touches no functions in TypeScript, JavaScript, Python, Java or Kotlin."}
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
  const order = ["signature", "body", "added", "moved", "removed", "unchanged"] as const;
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

function sourceNote(map: PrMapResponseDTO, reviewPending?: boolean): MapNote {
  if (map.source === "ai") return { text: map.model ? `Grouped and named by ${map.model}` : "Grouped and named by the review" };
  if (reviewPending) return { text: "Grouped by module — names arrive when the review finishes" };
  if (map.aiOutdated) return { text: "Files changed since the review grouped them — re-run the review to refresh it", warn: true };
  return { text: "Grouped by module" };
}
