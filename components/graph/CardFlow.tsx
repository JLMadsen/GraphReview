"use client";

// The card canvas shared by the PR map (DESIGN.md §6.4) and the app map
// (§6.5): HTML cards joined by labelled edges, laid out by ELK and rendered
// with React Flow.
//
// Why not Cytoscape (which drew the removed Repo view): a card holds
// clickable chips, which is HTML, and Cytoscape draws to a <canvas>. Maps are small enough (tens of cards,
// low hundreds at most) that React Flow's DOM nodes cost nothing.
//
// Layout is two-pass. Card heights depend on their content, so every card is
// first rendered offscreen at the fixed card width and measured, then ELK
// places the measured boxes — and routes the edges between them, orthogonally,
// each in its own lane and attached at its own point along the card's side —
// then React Flow draws the cards there and the edges along ELK's routes
// (`RoutedEdge`). Left to React Flow, every edge would be a bezier from the
// single midpoint of each card's side, and a busy map turns into a knot. Cards are not
// draggable: the layout is the point, and a dragged card would be thrown
// away by the next refresh anyway. The caller passes `layoutKey` — anything
// that changes a card's size or the edge set — and only a new key re-runs
// the layout (and refits the viewport), so selection never moves anything.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  getViewportForBounds,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "cn";

/** Below this zoom a card's small text is unreadable, so cards switch to their far-zoom look. */
const FAR_ZOOM = 0.72;
/**
 * The largest `--label-scale` ever applied. Cards are also measured at this
 * scale in their far-zoom look, and the layout reserves the taller of the two
 * heights — so a zoomed-out card can wrap its name onto several lines and
 * still never outgrow its box.
 */
const MAX_LABEL_SCALE = 2.1;

/**
 * Publishes the zoom to the canvas element for the cards' far-zoom CSS
 * (`.cardflow[data-far] .amc-*` in app/globals.css): `data-far` when zoomed
 * out past `FAR_ZOOM`, and `--label-scale` — how much to enlarge a label so
 * it lands at about its normal on-screen size (capped, so long names still
 * fit a card).
 */
function ZoomPublisher({ target }: { target: React.RefObject<HTMLDivElement | null> }) {
  const zoom = useStore((state) => state.transform[2]);
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const far = zoom < FAR_ZOOM;
    el.toggleAttribute("data-far", far);
    el.style.setProperty("--label-scale", String(Math.min(MAX_LABEL_SCALE, 0.9 / zoom)));
  }, [zoom, target]);
  return null;
}

// Concrete colours rather than CSS variables: React Flow writes the arrow
// marker colour into SVG attributes, where `var(...)` doesn't resolve. Both
// read on the light and the dark canvas.
const EDGE_COLOR = "#5d6474";
const EDGE_ACTIVE_COLOR = "#6d72f0";
const MIN_ZOOM = 0.1;

type Point = { x: number; y: number };
type ElkSection = { startPoint: Point; endPoint: Point; bendPoints?: Point[] };
type ElkApi = {
  layout: (graph: unknown) => Promise<{
    children?: Array<{ id: string; x?: number; y?: number }>;
    edges?: Array<{ id: string; sections?: ElkSection[] }>;
  }>;
};
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
  // Edges are routed by ELK too (see RoutedEdge): right angles, one lane per
  // edge between layers, kept clear of the cards.
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.edgeEdge": "12",
  "elk.spacing.edgeNode": "24",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.layered.unnecessaryBendpoints": "false",
};

export interface CardFlowLink {
  /** Unique id when several links join the same two cards (function calls); defaults to `source->target`. */
  id?: string;
  source: string;
  target: string;
  label: string;
  weight: number;
  /** Drawn dashed — e.g. an edge to a faded context card. */
  dashed?: boolean;
  /**
   * Port keys (`data-port` of a row inside the card): the edge leaves the
   * source row's right side and enters the target row's left side, instead
   * of the cards' sides. Needs `ports` on the canvas.
   */
  sourcePort?: string;
  targetPort?: string;
  /** `new` (added by the change), `removed` (gone at the head, drawn ghosted), `broken` (a caller left behind). */
  tone?: "new" | "removed" | "broken";
}

export function linkId(link: { id?: string; source: string; target: string }): string {
  return link.id ?? `${link.source}->${link.target}`;
}

/** Edge colours per tone — concrete values, see EDGE_COLOR. */
const TONE_COLORS: Record<NonNullable<CardFlowLink["tone"]>, string> = {
  new: "#d8703a",
  removed: "#8a909c",
  broken: "#e5484d",
};

const portId = (card: string, port: string, side: "in" | "out") => `${card}::${port}::${side}`;

type CardData = { content: ReactNode; height: number };

/**
 * A card stretched to the height the layout reserved for it. ELK routed the
 * edges to points along that box's sides, but the card's own height changes
 * with zoom (the far-zoom look is taller or shorter than the close-up one) —
 * drawn at its natural height, edges would end in empty space below a card or
 * run into it.
 */
function CardNode({ data }: NodeProps<Node<CardData>>) {
  const hidden = { opacity: 0, pointerEvents: "none" as const, border: 0, width: 1, height: 1 };
  return (
    <div className="flex flex-col *:flex-1" style={{ height: data.height }}>
      <Handle type="target" position={Position.Left} isConnectable={false} style={hidden} />
      {data.content}
      <Handle type="source" position={Position.Right} isConnectable={false} style={hidden} />
    </div>
  );
}

const NODE_TYPES = { card: CardNode };

/** An orthogonal polyline with its corners rounded (radius shrinks on short legs). */
function roundedPath(points: Point[], radius = 10): string {
  if (points.length < 2) return "";
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const d2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 0.5) {
      d += ` L ${cur.x},${cur.y}`;
      continue;
    }
    const before = { x: cur.x - ((cur.x - prev.x) / d1) * r, y: cur.y - ((cur.y - prev.y) / d1) * r };
    const after = { x: cur.x + ((next.x - cur.x) / d2) * r, y: cur.y + ((next.y - cur.y) / d2) * r };
    d += ` L ${before.x},${before.y} Q ${cur.x},${cur.y} ${after.x},${after.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x},${last.y}`;
}

/** Where a route's label goes: the middle of its longest leg. */
function labelPoint(points: Point[]): Point {
  let best = { x: points[0].x, y: points[0].y };
  let length = -1;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > length) {
      length = l;
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return best;
}

type RoutedEdgeData = { points?: Point[] };

/**
 * Draws an edge along the route ELK computed for it. An edge ELK didn't lay
 * out (a weak connection added when its card is selected) falls back to a
 * smooth-step path between the card sides — the same right-angled language.
 */
function RoutedEdge(props: EdgeProps<Edge<RoutedEdgeData>>) {
  const { data, markerEnd, style, label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius, interactionWidth } = props;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (data?.points && data.points.length >= 2) {
    path = roundedPath(data.points);
    ({ x: labelX, y: labelY } = labelPoint(data.points));
  } else {
    [path, labelX, labelY] = getSmoothStepPath({
      sourceX: props.sourceX,
      sourceY: props.sourceY,
      sourcePosition: props.sourcePosition,
      targetX: props.targetX,
      targetY: props.targetY,
      targetPosition: props.targetPosition,
      borderRadius: 10,
    });
  }
  return (
    <BaseEdge
      path={path}
      markerEnd={markerEnd}
      style={style}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={labelStyle}
      labelShowBg
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
      interactionWidth={interactionWidth}
    />
  );
}

const EDGE_TYPES = { routed: RoutedEdge };

export interface CardFlowProps {
  cardIds: string[];
  cardWidth: number;
  renderCard: (id: string) => ReactNode;
  links: CardFlowLink[];
  /** Cards drawn as selected; their edges light up and the rest dim. */
  highlighted: Set<string>;
  /** An edge drawn as selected (`linkId`). */
  selectedLink?: string | null;
  /** An edge drawn lit and labelled while something outside the canvas points at it (`linkId`). */
  hoveredLink?: string | null;
  /** A lit edge's label; defaults to `label ×weight`. */
  formatLabel?: (link: CardFlowLink) => string;
  /** Anything that changes a card's size or the edge set. */
  layoutKey: string;
  onCardClick: (id: string) => void;
  onPaneClick: () => void;
  onLinkClick?: (link: CardFlowLink) => void;
  /** Above this many edges, labels only show on highlighted edges. */
  alwaysLabelEdges?: number;
  /**
   * Rows inside the cards carry `data-port="<key>"`: links with
   * `sourcePort`/`targetPort` are routed between those rows. Measured with
   * the cards, so a port is where its row is.
   */
  ports?: boolean;
  /** Links drawn lit, overriding the highlighted-card rule (`linkId`s). */
  activeLinks?: Set<string>;
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
  hoveredLink,
  formatLabel,
  layoutKey,
  onCardClick,
  onPaneClick,
  onLinkClick,
  alwaysLabelEdges = 12,
  ports = false,
  activeLinks,
  elkOptions = DEFAULT_ELK_OPTIONS,
  className,
  children,
}: CardFlowProps) {
  const { setViewport } = useReactFlow();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const measureRefs = useRef(new Map<string, HTMLDivElement>());
  const measureFarRefs = useRef(new Map<string, HTMLDivElement>());
  const [positions, setPositions] = useState<Map<string, { x: number; y: number; width: number; height: number }> | null>(null);
  /** ELK's route per link (`linkId`) for the links that were part of the last layout. */
  const [routes, setRoutes] = useState<Map<string, Point[]>>(new Map());
  const layoutRun = useRef(0);

  useLayoutEffect(() => {
    const run = ++layoutRun.current;
    if (cardIds.length === 0) {
      setPositions(null);
      return;
    }
    /** Each card's rows that carry a port, and where their middle is. */
    const portRows = new Map<string, Map<string, number>>();
    if (ports) {
      for (const id of cardIds) {
        const el = measureRefs.current.get(id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        const rows = new Map<string, number>();
        for (const row of el.querySelectorAll<HTMLElement>("[data-port]")) {
          const rect = row.getBoundingClientRect();
          rows.set(row.dataset.port!, Math.round(rect.top - top + rect.height / 2));
        }
        portRows.set(id, rows);
      }
    }
    const children = cardIds.map((id) => {
      const height = Math.ceil(
        Math.max(measureRefs.current.get(id)?.offsetHeight ?? 120, measureFarRefs.current.get(id)?.offsetHeight ?? 0)
      );
      const rows = portRows.get(id);
      if (!rows || rows.size === 0) return { id, width: cardWidth, height };
      return {
        id,
        width: cardWidth,
        height,
        layoutOptions: { "elk.portConstraints": "FIXED_POS" },
        ports: [...rows].flatMap(([key, y]) => [
          { id: portId(id, key, "in"), x: 0, y, width: 0, height: 0, layoutOptions: { "elk.port.side": "WEST" } },
          { id: portId(id, key, "out"), x: cardWidth, y, width: 0, height: 0, layoutOptions: { "elk.port.side": "EAST" } },
        ]),
      };
    });
    const hasPort = (card: string, key: string | undefined) => Boolean(key && portRows.get(card)?.has(key));
    const laidOut = links.map(linkId);
    const graph = {
      id: "root",
      layoutOptions: elkOptions,
      children,
      edges: links.map((e, i) => ({
        id: `e${i}`,
        sources: [hasPort(e.source, e.sourcePort) ? portId(e.source, e.sourcePort!, "out") : e.source],
        targets: [hasPort(e.target, e.targetPort) ? portId(e.target, e.targetPort!, "in") : e.target],
      })),
    };
    getElk()
      .then((elk) => elk.layout(graph))
      .then((result) => {
        if (run !== layoutRun.current) return;
        const size = new Map(children.map((c) => [c.id, c]));
        const nextRoutes = new Map<string, Point[]>();
        for (const edge of result.edges ?? []) {
          const section = edge.sections?.[0];
          const index = Number(edge.id.slice(1));
          if (!section || !Number.isInteger(index) || !laidOut[index]) continue;
          nextRoutes.set(laidOut[index], [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]);
        }
        setRoutes(nextRoutes);
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
        setRoutes(new Map());
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
              data: { content: renderCard(id), height: positions.get(id)!.height },
              draggable: false,
              selectable: false,
              connectable: false,
            }))
        : [],
    [positions, cardIds, renderCard]
  );

  const edges = useMemo<Edge<RoutedEdgeData>[]>(
    () =>
      links.map((link) => {
        const id = linkId(link);
        const hovered = id === hoveredLink;
        const active = activeLinks
          ? activeLinks.has(id) || hovered
          : hoveredLink
            ? hovered
            : id === selectedLink || highlighted.has(link.source) || highlighted.has(link.target);
        const dimmed =
          (activeLinks ? activeLinks.size > 0 || Boolean(hoveredLink) : highlighted.size > 0 || Boolean(selectedLink) || Boolean(hoveredLink)) &&
          !active;
        const color = link.tone ? TONE_COLORS[link.tone] : active ? EDGE_ACTIVE_COLOR : EDGE_COLOR;
        const labelled = active || links.length <= alwaysLabelEdges;
        const labelText = formatLabel ? formatLabel(link) : link.weight > 1 ? `${link.label} ×${link.weight}` : link.label;
        return {
          id,
          type: "routed",
          data: { points: routes.get(id) },
          // Lit edges draw over the rest where lanes cross.
          zIndex: hovered ? 2 : active ? 1 : 0,
          source: link.source,
          target: link.target,
          label: labelled ? labelText : undefined,
          selectable: false,
          focusable: false,
          interactionWidth: onLinkClick ? 14 : 0,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
          style: {
            stroke: color,
            cursor: onLinkClick ? "pointer" : undefined,
            // Heavier for edges that stand for many imports.
            strokeWidth: (active ? 0.6 : 0) + (id === selectedLink || hovered ? 0.8 : 0) + 1.2 + Math.min(1.6, Math.log2(link.weight) * 0.5),
            strokeDasharray: link.tone === "removed" ? "3 4" : link.tone === "broken" ? "6 3" : link.dashed ? "5 4" : undefined,
            opacity: dimmed ? 0.2 : link.tone === "removed" ? 0.7 : 1,
          },
          labelStyle: { fill: "var(--muted-foreground)", fontSize: 11, opacity: dimmed ? 0.4 : 1 },
          labelBgStyle: { fill: "var(--canvas)" },
          labelBgPadding: [5, 2] as [number, number],
          labelBgBorderRadius: 2,
        };
      }),
    [links, routes, highlighted, selectedLink, hoveredLink, formatLabel, alwaysLabelEdges, onLinkClick, activeLinks]
  );

  const linkById = useMemo(() => new Map(links.map((l) => [linkId(l), l])), [links]);

  return (
    <div
      ref={paneRef}
      className={cn("cardflow", className ?? "bp-grid relative min-h-[220px] flex-1 overflow-hidden rounded-lg border border-border")}
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
        edgeTypes={EDGE_TYPES}
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
        <ZoomPublisher target={paneRef} />
      </ReactFlow>

      {/* Offscreen measuring pass — same card, same width, never seen: once
          as drawn close up, once in the far-zoom look at its largest scale. */}
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
      <div
        aria-hidden
        inert
        className="amc-measure-far pointer-events-none invisible absolute top-0 left-[-20000px]"
        style={{ "--label-scale": MAX_LABEL_SCALE } as React.CSSProperties}
      >
        {cardIds.map((id) => (
          <div
            key={id}
            ref={(el) => {
              if (el) measureFarRefs.current.set(id, el);
              else measureFarRefs.current.delete(id);
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
