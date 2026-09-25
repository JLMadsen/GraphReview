"use client";

// The Graph tab's PR view (DESIGN.md §6.4): the PR map drawn as cards with
// labelled edges, laid out left-to-right by ELK and rendered with React Flow.
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getViewportForBounds,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Eye, EyeOff, LoaderCircle, Sparkles, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { PR_CARD_WIDTH, PrMapCard, type PrCardMarker, type PrMapCardProps } from "./PrMapNode";
import { effectiveIntent, worstIntent } from "./review-visuals";
import type { PrMapNodeDTO, PrMapResponseDTO } from "./pr-map-types";
import type { FindingDTO, IntentMatch } from "./types";

// Concrete colours rather than CSS variables: React Flow writes the arrow
// marker colour into SVG attributes, where `var(...)` doesn't resolve. Both
// read on the light and the dark canvas.
const EDGE_COLOR = "#8a93a6";
const EDGE_ACTIVE_COLOR = "#6d72f0";
/** Above this many edges, labels only show on the selected card's edges — otherwise "imports ×3" everywhere buries the cards. */
const ALWAYS_LABEL_EDGES = 12;
const MIN_ZOOM = 0.2;

type ElkApi = { layout: (graph: unknown) => Promise<{ children?: Array<{ id: string; x?: number; y?: number }> }> };
let elkPromise: Promise<ElkApi> | null = null;
/** elkjs is ~1.5 MB — loaded on first layout, not with the Graph tab. */
function getElk(): Promise<ElkApi> {
  elkPromise ??= import("elkjs/lib/elk.bundled.js").then((mod) => {
    const ELK = (mod.default ?? mod) as unknown as new () => ElkApi;
    return new ELK();
  });
  return elkPromise;
}

const ELK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "120",
  "elk.spacing.nodeNode": "36",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.separateConnectedComponents": "true",
  "elk.spacing.componentComponent": "56",
  "elk.aspectRatio": "1.8",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
};

type CardData = { card: PrMapCardProps };

function PrCardNode({ data }: NodeProps<Node<CardData>>) {
  const hidden = { opacity: 0, pointerEvents: "none" as const, border: 0, width: 1, height: 1 };
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={hidden} />
      <PrMapCard {...data.card} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={hidden} />
    </>
  );
}

const NODE_TYPES = { prCard: PrCardNode };

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

export function PrMapCanvas(props: PrMapCanvasProps) {
  return (
    <ReactFlowProvider>
      <PrMapFlow {...props} />
    </ReactFlowProvider>
  );
}

function PrMapFlow({
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
  const { setViewport } = useReactFlow();
  const paneRef = useRef<HTMLDivElement | null>(null);
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
    const fileMarkers = new Map<string, IntentMatch>();
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
      const intent = effectiveIntent(finding);
      if (finding.filePath) {
        const prev = fileMarkers.get(finding.filePath);
        fileMarkers.set(finding.filePath, prev ? worstIntent(prev, intent) : intent);
      }
      const cardId =
        (finding.filePath && cardOfFile.get(finding.filePath)) || cardOfComponent(finding.componentId);
      if (!cardId) continue;
      const prev = cardMarkers.get(cardId);
      cardMarkers.set(cardId, {
        worst: prev ? worstIntent(prev.worst, intent) : intent,
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

  // --- Layout: measure offscreen, then ELK -------------------------------
  const measureRefs = useRef(new Map<string, HTMLDivElement>());
  /** Top-left corner and measured size of every card, from the last layout. */
  const [positions, setPositions] = useState<Map<string, { x: number; y: number; width: number; height: number }> | null>(null);
  const layoutKey = useMemo(
    () =>
      JSON.stringify([
        cards.map((c) => [c.id, c.name, c.description, c.files.length, expanded.has(c.id), cardMarkers.has(c.id)]),
        links.map((e) => [e.source, e.target]),
      ]),
    [cards, links, expanded, cardMarkers]
  );
  const layoutRun = useRef(0);

  useLayoutEffect(() => {
    const run = ++layoutRun.current;
    if (cards.length === 0) {
      setPositions(null);
      return;
    }
    const children = cards.map((card) => ({
      id: card.id,
      width: PR_CARD_WIDTH,
      height: Math.ceil(measureRefs.current.get(card.id)?.offsetHeight ?? 120),
    }));
    const graph = {
      id: "root",
      layoutOptions: ELK_OPTIONS,
      children,
      edges: links.map((e, i) => ({ id: `e${i}`, sources: [e.source], targets: [e.target] })),
    };
    getElk()
      .then((elk) => elk.layout(graph))
      .then((result) => {
        if (run !== layoutRun.current) return;
        const size = new Map(children.map((c) => [c.id, c]));
        setPositions(
          new Map(
            (result.children ?? []).map((c) => [
              c.id,
              { x: c.x ?? 0, y: c.y ?? 0, width: PR_CARD_WIDTH, height: size.get(c.id)?.height ?? 120 },
            ])
          )
        );
      })
      .catch((err: unknown) => {
        console.error("PR map layout failed:", err);
        if (run !== layoutRun.current) return;
        // A plain column is still readable.
        let y = 0;
        setPositions(
          new Map(
            children.map((c) => {
              const pos = { x: 0, y, width: c.width, height: c.height };
              y += c.height + 32;
              return [c.id, pos];
            })
          )
        );
      });
    // `layoutKey` captures everything that changes a card's size or the edge set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // Refit only when the layout itself changes — never on selection, so a
  // click doesn't yank the viewport out from under the pointer. Computed from
  // the layout rather than with `fitView()`: in React Flow 12 that only
  // *queues* a fit, flushed through `onNodesChange`, which a canvas with
  // fixed, non-draggable nodes never fires.
  useEffect(() => {
    const pane = paneRef.current;
    if (!positions || positions.size === 0 || !pane) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of positions.values()) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.width);
      maxY = Math.max(maxY, p.y + p.height);
    }
    const viewport = getViewportForBounds(
      { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      pane.clientWidth,
      pane.clientHeight,
      MIN_ZOOM,
      1,
      0.08
    );
    void setViewport(viewport, { duration: 200 });
  }, [positions, setViewport]);

  const nodes = useMemo<Node<CardData>[]>(
    () =>
      positions
        ? cards
            .filter((card) => positions.has(card.id))
            .map((card) => ({
              id: card.id,
              type: "prCard",
              position: { x: positions.get(card.id)!.x, y: positions.get(card.id)!.y },
              data: { card: cardProps(card) },
              draggable: false,
              selectable: false,
              connectable: false,
            }))
        : [],
    [positions, cards, cardProps]
  );

  const edges = useMemo<Edge[]>(() => {
    const roleOf = new Map(cards.map((c) => [c.id, c.role]));
    return links.map((link) => {
      const active = highlighted.has(link.source) || highlighted.has(link.target);
      const dimmed = highlighted.size > 0 && !active;
      const context = roleOf.get(link.source) === "context" || roleOf.get(link.target) === "context";
      const color = active ? EDGE_ACTIVE_COLOR : EDGE_COLOR;
      const labelled = active || links.length <= ALWAYS_LABEL_EDGES;
      return {
        id: `${link.source}->${link.target}`,
        source: link.source,
        target: link.target,
        label: labelled ? (link.weight > 1 ? `${link.label} ×${link.weight}` : link.label) : undefined,
        selectable: false,
        focusable: false,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
        style: {
          stroke: color,
          // Heavier for edges that stand for many imports.
          strokeWidth: (active ? 0.6 : 0) + 1.2 + Math.min(1.6, Math.log2(link.weight) * 0.5),
          strokeDasharray: context ? "5 4" : undefined,
          opacity: dimmed ? 0.3 : 1,
        },
        labelStyle: { fill: "var(--muted-foreground)", fontSize: 11, opacity: dimmed ? 0.4 : 1 },
        labelBgStyle: { fill: "var(--canvas)" },
        labelBgPadding: [5, 2] as [number, number],
        labelBgBorderRadius: 4,
      };
    });
  }, [links, cards, highlighted]);

  // --- Summary -----------------------------------------------------------
  const changedFiles = map?.nodes.reduce((n, node) => n + node.files.length, 0) ?? 0;
  const groups = map?.nodes.filter((n) => n.role !== "context").length ?? 0;
  const additions = map?.nodes.reduce((n, node) => n + node.files.reduce((m, f) => m + f.additions, 0), 0) ?? 0;
  const deletions = map?.nodes.reduce((n, node) => n + node.files.reduce((m, f) => m + f.deletions, 0), 0) ?? 0;

  return (
    <div className={className}>
      <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {map && (
            <span>
              <span className="font-medium text-foreground">{changedFiles}</span> changed file
              {changedFiles === 1 ? "" : "s"} in{" "}
              <span className="font-medium text-foreground">{groups}</span> group{groups === 1 ? "" : "s"}
              {(additions > 0 || deletions > 0) && (
                <span className="ml-2 font-mono">
                  <span className="text-success">+{additions}</span>{" "}
                  <span className="text-destructive">−{deletions}</span>
                </span>
              )}
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
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              showContext
                ? "border-border bg-card text-foreground hover:bg-secondary"
                : "border-transparent bg-muted text-muted-foreground"
            )}
            title="Untouched modules the changed code imports or is imported by"
          >
            {showContext ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            Unchanged neighbours ({contextCount})
          </button>
        )}
      </div>

      <div
        ref={paneRef}
        className="relative h-[min(68vh,680px)] min-h-[440px] overflow-hidden rounded-xl bg-canvas ring-1 ring-border"
        style={
          {
            // The un-suffixed names: React Flow re-declares the `-default`
            // ones on its own root, which would shadow anything set here.
            "--xy-background-color": "transparent",
            "--xy-controls-button-background-color": "var(--card)",
            "--xy-controls-button-background-color-hover": "var(--secondary)",
            "--xy-controls-button-color": "var(--foreground)",
            "--xy-controls-button-color-hover": "var(--foreground)",
            "--xy-controls-button-border-color": "var(--border)",
            "--xy-controls-box-shadow": "0 0 0 1px var(--border)",
          } as React.CSSProperties
        }
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          minZoom={MIN_ZOOM}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => {
            const card = map?.nodes.find((n) => n.id === node.id);
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
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>

        {/* Offscreen measuring pass — same card, same width, never seen. */}
        <div aria-hidden inert className="pointer-events-none invisible absolute top-0 left-[-10000px]">
          {cards.map((card) => (
            <div
              key={card.id}
              ref={(el) => {
                if (el) measureRefs.current.set(card.id, el);
                else measureRefs.current.delete(card.id);
              }}
            >
              <PrMapCard {...cardProps(card)} />
            </div>
          ))}
        </div>

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
      </div>
    </div>
  );
}

function SourceNote({ map, reviewPending }: { map: PrMapResponseDTO; reviewPending?: boolean }) {
  if (map.source === "ai") {
    return (
      <span
        className="flex items-center gap-1 rounded-full bg-brand-muted px-2 py-0.5 text-[11px] font-medium text-brand"
        title={map.model ? `Grouped and named by ${map.model}` : "Grouped and named by the AI review"}
      >
        <Sparkles className="size-3" aria-hidden /> AI grouping
      </span>
    );
  }
  if (reviewPending) {
    return <span className="text-[11px]">Grouped by module — AI names arrive when the review finishes</span>;
  }
  if (map.aiOutdated) {
    return (
      <span className="text-[11px] text-warning">
        Files changed since the AI grouping — re-run the review to refresh it
      </span>
    );
  }
  return <span className="text-[11px]">Grouped by module</span>;
}
