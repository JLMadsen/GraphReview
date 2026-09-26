"use client";

// The card canvas shared by the PR map (DESIGN.md §6.4) and the app map
// (§6.5): HTML cards joined by labelled edges, laid out by ELK and rendered
// with React Flow.
//
// Why not the Cytoscape canvas: a card holds clickable chips, which is HTML,
// and Cytoscape draws to a <canvas>. Maps are small enough (tens of cards,
// low hundreds at most) that React Flow's DOM nodes cost nothing.
//
// Layout is two-pass. Card heights depend on their content, so every card is
// first rendered offscreen at the fixed card width and measured, then ELK
// places the measured boxes, then React Flow draws them there. Cards are not
// draggable: the layout is the point, and a dragged card would be thrown
// away by the next refresh anyway. The caller passes `layoutKey` — anything
// that changes a card's size or the edge set — and only a new key re-runs
// the layout (and refits the viewport), so selection never moves anything.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

// Concrete colours rather than CSS variables: React Flow writes the arrow
// marker colour into SVG attributes, where `var(...)` doesn't resolve. Both
// read on the light and the dark canvas.
const EDGE_COLOR = "#8a93a6";
const EDGE_ACTIVE_COLOR = "#6d72f0";
const MIN_ZOOM = 0.1;

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

export const DEFAULT_ELK_OPTIONS: Record<string, string> = {
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

export interface CardFlowLink {
  source: string;
  target: string;
  label: string;
  weight: number;
  /** Drawn dashed — e.g. an edge to a faded context card. */
  dashed?: boolean;
}

export function linkId(link: { source: string; target: string }): string {
  return `${link.source}->${link.target}`;
}

type CardData = { content: ReactNode };

function CardNode({ data }: NodeProps<Node<CardData>>) {
  const hidden = { opacity: 0, pointerEvents: "none" as const, border: 0, width: 1, height: 1 };
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={hidden} />
      {data.content}
      <Handle type="source" position={Position.Right} isConnectable={false} style={hidden} />
    </>
  );
}

const NODE_TYPES = { card: CardNode };

export interface CardFlowProps {
  cardIds: string[];
  cardWidth: number;
  renderCard: (id: string) => ReactNode;
  links: CardFlowLink[];
  /** Cards drawn as selected; their edges light up and the rest dim. */
  highlighted: Set<string>;
  /** An edge drawn as selected (`linkId`). */
  selectedLink?: string | null;
  /** Anything that changes a card's size or the edge set. */
  layoutKey: string;
  onCardClick: (id: string) => void;
  onPaneClick: () => void;
  onLinkClick?: (link: CardFlowLink) => void;
  /** Above this many edges, labels only show on highlighted edges. */
  alwaysLabelEdges?: number;
  elkOptions?: Record<string, string>;
  /** Classes for the canvas pane (size, rounding, ring). */
  className?: string;
  /** Overlays drawn over the canvas (empty/loading states). */
  children?: ReactNode;
}

export function CardFlow(props: CardFlowProps) {
  return (
    <ReactFlowProvider>
      <CardFlowInner {...props} />
    </ReactFlowProvider>
  );
}

function CardFlowInner({
  cardIds,
  cardWidth,
  renderCard,
  links,
  highlighted,
  selectedLink,
  layoutKey,
  onCardClick,
  onPaneClick,
  onLinkClick,
  alwaysLabelEdges = 12,
  elkOptions = DEFAULT_ELK_OPTIONS,
  className,
  children,
}: CardFlowProps) {
  const { setViewport } = useReactFlow();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const measureRefs = useRef(new Map<string, HTMLDivElement>());
  const [positions, setPositions] = useState<Map<string, { x: number; y: number; width: number; height: number }> | null>(null);
  const layoutRun = useRef(0);

  useLayoutEffect(() => {
    const run = ++layoutRun.current;
    if (cardIds.length === 0) {
      setPositions(null);
      return;
    }
    const children = cardIds.map((id) => ({
      id,
      width: cardWidth,
      height: Math.ceil(measureRefs.current.get(id)?.offsetHeight ?? 120),
    }));
    const graph = {
      id: "root",
      layoutOptions: elkOptions,
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
              { x: c.x ?? 0, y: c.y ?? 0, width: cardWidth, height: size.get(c.id)?.height ?? 120 },
            ])
          )
        );
      })
      .catch((err: unknown) => {
        console.error("Card map layout failed:", err);
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

  // Refit when the layout itself changes, and when the pane is resized (the
  // window, a side panel, or the view becoming visible) — never on selection,
  // so a click doesn't yank the viewport out from under the pointer. Computed
  // from the layout rather than with `fitView()`: in React Flow 12 that only
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
    const fit = (duration: number) => {
      if (pane.clientWidth === 0 || pane.clientHeight === 0) return;
      const viewport = getViewportForBounds(
        { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        pane.clientWidth,
        pane.clientHeight,
        MIN_ZOOM,
        1,
        0.08
      );
      void setViewport(viewport, { duration });
    };
    fit(200);
    let last = `${pane.clientWidth}x${pane.clientHeight}`;
    const observer = new ResizeObserver(() => {
      const size = `${pane.clientWidth}x${pane.clientHeight}`;
      if (size === last) return;
      last = size;
      fit(0);
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [positions, setViewport]);

  const nodes = useMemo<Node<CardData>[]>(
    () =>
      positions
        ? cardIds
            .filter((id) => positions.has(id))
            .map((id) => ({
              id,
              type: "card",
              position: { x: positions.get(id)!.x, y: positions.get(id)!.y },
              data: { content: renderCard(id) },
              draggable: false,
              selectable: false,
              connectable: false,
            }))
        : [],
    [positions, cardIds, renderCard]
  );

  const edges = useMemo<Edge[]>(
    () =>
      links.map((link) => {
        const id = linkId(link);
        const active = id === selectedLink || highlighted.has(link.source) || highlighted.has(link.target);
        const dimmed = (highlighted.size > 0 || Boolean(selectedLink)) && !active;
        const color = active ? EDGE_ACTIVE_COLOR : EDGE_COLOR;
        const labelled = active || links.length <= alwaysLabelEdges;
        return {
          id,
          source: link.source,
          target: link.target,
          label: labelled ? (link.weight > 1 ? `${link.label} ×${link.weight}` : link.label) : undefined,
          selectable: false,
          focusable: false,
          interactionWidth: onLinkClick ? 14 : 0,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
          style: {
            stroke: color,
            cursor: onLinkClick ? "pointer" : undefined,
            // Heavier for edges that stand for many imports.
            strokeWidth: (active ? 0.6 : 0) + (id === selectedLink ? 0.8 : 0) + 1.2 + Math.min(1.6, Math.log2(link.weight) * 0.5),
            strokeDasharray: link.dashed ? "5 4" : undefined,
            opacity: dimmed ? 0.25 : 1,
          },
          labelStyle: { fill: "var(--muted-foreground)", fontSize: 11, opacity: dimmed ? 0.4 : 1 },
          labelBgStyle: { fill: "var(--canvas)" },
          labelBgPadding: [5, 2] as [number, number],
          labelBgBorderRadius: 4,
        };
      }),
    [links, highlighted, selectedLink, alwaysLabelEdges, onLinkClick]
  );

  const linkById = useMemo(() => new Map(links.map((l) => [linkId(l), l])), [links]);

  return (
    <div
      ref={paneRef}
      className={className ?? "relative h-[min(68vh,680px)] min-h-[440px] overflow-hidden rounded-xl bg-canvas ring-1 ring-border"}
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
        onNodeClick={(_, node) => onCardClick(node.id)}
        onEdgeClick={
          onLinkClick
            ? (_, edge) => {
                const link = linkById.get(edge.id);
                if (link) onLinkClick(link);
              }
            : undefined
        }
        onPaneClick={onPaneClick}
      >
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>

      {/* Offscreen measuring pass — same card, same width, never seen. */}
      <div aria-hidden inert className="pointer-events-none invisible absolute top-0 left-[-10000px]">
        {cardIds.map((id) => (
          <div
            key={id}
            ref={(el) => {
              if (el) measureRefs.current.set(id, el);
              else measureRefs.current.delete(id);
            }}
          >
            {renderCard(id)}
          </div>
        ))}
      </div>

      {children}
    </div>
  );
}
