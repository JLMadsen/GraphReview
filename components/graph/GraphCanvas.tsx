"use client";

// Cytoscape wrapper — DESIGN.md §3, §4, §6.1.
//
// - Layout switcher: Force (`fcose`) / Circle / Grid / Hierarchical
//   (`cytoscape-elk`, top-to-bottom layered), re-run on switch.
// - Compound nodes: a node with a `parentId` that resolves to another node
//   in the same payload is nested via Cytoscape's native `parent` field;
//   `cytoscape-expand-collapse` adds the collapse/expand cue on top of that,
//   and the toolbar's Labels control drives its collapse-all/expand-all.
//   The domain tier that produces those parents is written on demand by the
//   AI labeling job (DESIGN.md §6.1, lib/jobs/label.ts) — until someone runs
//   it, no node carries a `parentId`, no node is a parent, and this renders
//   as a flat graph exactly as before.
// - Node selection: tapping a node reports it up (`onSelectNode`) so the
//   sidebar can show that component's files, and lights up the node, its
//   direct DEPENDS_ON neighbours (both directions) and the connecting
//   edges while fading everything else. This is a second, independent
//   highlight layer from the diff-impact one below: it only touches
//   borders/opacity/z-index, never `background-color`, so a selected
//   node keeps its touched/neighbor impact colour instead of fighting it.
// - Tooltips are a small custom floating panel positioned from
//   `node.renderedPosition()` rather than `cytoscape-popper` — popper needs
//   a positioning engine (Popper/`@floating-ui`) passed in as a factory,
//   and neither is a declared dependency of this project; a custom overlay
//   avoids adding one just for a hover label. See this directory's report
//   for the full rationale.
// - Touched/neighbor/not-affected highlighting, mirroring the prototype's
//   filter toggles.
// - AI review markers: a THIRD independent highlight layer (DESIGN.md §9,
//   §10), drawn with Cytoscape's `underlay-*` properties. Underlays are a
//   halo painted *behind* the node, so unlike the two layers above they
//   touch neither `background-color` (layer 1, impact) nor `border-*`/
//   `opacity`/`z-index` (layer 2, selection). All three compose: a touched
//   component that is also selected and also has a mismatch finding renders
//   as an amber node with a bright white border sitting in a rose halo.
//   Colours and glyphs live in review-visuals.ts, shared with ReviewPanel.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";
import expandCollapse from "cytoscape-expand-collapse";
import {
  CircleDot,
  Grid3x3,
  Network,
  Spline,
  Workflow,
  X,
} from "lucide-react";
import { cn } from "cn";
import {
  INTENT_CLASS_NAMES,
  INTENT_ORDER,
  INTENT_VISUALS,
  countComponentsByIntent,
  intentClassName,
  type ReviewMarkerMap,
} from "./review-visuals";
import { LabelsControl } from "./LabelsControl";
import type { UseLabelsResult } from "./label-types";
import type { GraphEdgeDTO, GraphNodeDTO, IntentMatch } from "./types";

let extensionsRegistered = false;
function registerExtensionsOnce() {
  if (extensionsRegistered) return;
  // fcose/expandCollapse are typed `any` via the bodiless ambient shims in
  // cytoscape-shims.d.ts (see that file for why) — cast to `cytoscape.Ext`
  // here at the one call site each is used. `cytoscape-elk`
  // is deliberately NOT here — it wraps elkjs, whose GWT-compiled bundle is
  // large (~400KB+), so it's dynamically imported by `ensureElkRegistered`
  // only the first time someone actually selects the Hierarchical layout,
  // rather than bloating every Graph tab's initial load for a layout most
  // views of the graph won't use.
  cytoscape.use(fcose as cytoscape.Ext);
  cytoscape.use(expandCollapse as cytoscape.Ext);
  extensionsRegistered = true;
}

let elkRegistered = false;
let elkRegistering: Promise<void> | null = null;
/** Lazily loads and registers `cytoscape-elk` — see `registerExtensionsOnce`'s comment for why. Safe to call repeatedly/concurrently. */
function ensureElkRegistered(): Promise<void> {
  if (elkRegistered) return Promise.resolve();
  if (!elkRegistering) {
    elkRegistering = import("cytoscape-elk").then((mod) => {
      cytoscape.use((mod.default ?? mod) as cytoscape.Ext);
      elkRegistered = true;
    });
  }
  return elkRegistering;
}

export type LayoutMode = "fcose" | "circle" | "grid" | "elk";

export const LAYOUT_OPTIONS: Array<{
  value: LayoutMode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: "fcose", label: "Force", icon: Spline },
  { value: "circle", label: "Circle", icon: CircleDot },
  { value: "grid", label: "Grid", icon: Grid3x3 },
  { value: "elk", label: "Hierarchical", icon: Workflow },
];

// `cytoscape-elk` (github.com/cytoscape/cytoscape.js-elk) wraps `elkjs`,
// which itself wraps the Eclipse Layout Kernel's `layered` algorithm — a
// structured, direction-aware layout well suited to showing dependency
// direction clearly, unlike Force/Circle/Grid. `elk.direction: "DOWN"`
// (top-to-bottom) reads naturally for `Component-[:DEPENDS_ON]->Component`
// edges: a dependency sits visually below/downstream of what depends on it,
// the same top-to-bottom reading order as e.g. a `git log --graph` or an
// npm dependency tree. Compound (tier) nodes are supported natively by ELK's
// hierarchical layout, so the same `parent` nesting used for Force keeps
// working here with no extra handling.
//
// The spacing values are set wide enough that the node *labels* (which sit
// below each node and are what made the dense real-world graph unreadable)
// have somewhere to go.
//
// `elk.hierarchyHandling: "INCLUDE_CHILDREN"` is what makes compound nodes
// actually work here. ELK's default (`SEPARATE_CHILDREN`) lays each compound
// node out as its own isolated drawing, so a `DEPENDS_ON` edge that crosses
// a domain boundary — which is most of them — is routed between two layouts
// that never saw each other, and the result is a column of boxes with edges
// looping around them. `INCLUDE_CHILDREN` lays the whole hierarchy out in
// one pass, honouring cross-boundary edges, which is the only reading of the
// graph that makes the domain tier useful.
const ELK_LAYOUT_OPTIONS = {
  algorithm: "layered",
  "elk.direction": "DOWN",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": 90,
  "elk.spacing.nodeNode": 55,
  // Compound boxes need room for their own uppercase label, which sits above
  // the box (see the `:parent` style below).
  "elk.padding": "[top=42,left=24,bottom=24,right=24]",
};

/**
 * Force-layout tuning. The stock fcose defaults pack a 100+ node component
 * graph tightly enough that every label overlaps its neighbours; pushing
 * repulsion and ideal edge length up trades a little compactness for labels
 * that can actually be read. Applied on first render *and* on re-selection
 * so the two paths produce the same picture.
 */
const FCOSE_LAYOUT_OPTIONS = {
  nodeSeparation: 140,
  idealEdgeLength: 120,
  nodeRepulsion: 9000,
  gravity: 0.15,
  numIter: 2500,
};

/**
 * Sibling-first ordering for the two discrete layouts.
 *
 * Circle and Grid have no concept of compound nodes — they place every node
 * independently and leave the parent boxes to be drawn around whatever ended
 * up inside them, so with an interleaved order every domain box overlaps
 * every other one and the grouping disappears. Keeping siblings adjacent is
 * the first half of the fix (and the whole of it for a flat graph);
 * `runTiledByDomain` below is the second half, since contiguity alone still
 * leaves a domain's bounding box spanning whole rows (Grid) or a wide arc
 * (Circle).
 * Cytoscape passes the comparator every node it is laying out.
 */
function siblingSort(a: cytoscape.NodeSingular, b: cytoscape.NodeSingular): number {
  const parentA = (a.data("parent") as string | undefined) ?? "";
  const parentB = (b.data("parent") as string | undefined) ?? "";
  if (parentA !== parentB) return parentA < parentB ? -1 : 1;
  const nameA = (a.data("name") as string | undefined) ?? "";
  const nameB = (b.data("name") as string | undefined) ?? "";
  return nameA.localeCompare(nameB);
}

/** Space between two domains' tiles, comfortably more than twice the `:parent` padding so their boxes can't touch. */
const DOMAIN_TILE_GAP = 140;

/**
 * Circle and Grid, run once per domain and packed into tiles.
 *
 * Neither layout understands compound nodes. Run over the whole graph they
 * place every node independently and leave the parent boxes to be drawn
 * around whatever ended up inside them: with 4 domains over 109 modules a
 * domain's members occupy a wide arc (Circle) or a band of full-width rows
 * (Grid), and the resulting boxes all overlap each other, so the grouping
 * the labeling pass just created is invisible. `sort` only guarantees the
 * members are contiguous, which isn't enough, and Grid's `position`
 * callback can't fix it either — the parent nodes take part in the same
 * cell grid and displace their own children.
 *
 * So each domain gets its own layout run, and the results are packed
 * row-major into disjoint tiles. Modules with no domain (new since the last
 * labeling run) share one final tile. Circle still draws rings and Grid
 * still draws a matrix — one per box instead of one for the graph.
 */
function runTiledByDomain(cy: cytoscape.Core, name: "circle" | "grid"): void {
  const parents = cy.nodes(":parent").sort((a, b) => a.id().localeCompare(b.id()));
  // `.map`'s callback is typed as a bare element (it could be an edge for a
  // mixed collection), so the node-only API needs the cast.
  const groups = parents.map((parent) => (parent as cytoscape.NodeSingular).children());
  const loose = cy.nodes().not(":parent").not(":child");
  if (loose.nonempty()) groups.push(loose);

  const cols = Math.max(1, Math.ceil(Math.sqrt(groups.length)));
  let x = 0;
  let y = 0;
  let rowHeight = 0;

  groups.forEach((group, index) => {
    // Each group is laid out wherever it happens to be, then *translated*
    // into its tile. Passing the tile as the layout's `boundingBox` instead
    // looks tidier but doesn't hold: `avoidOverlap` grows a ring's radius
    // until every member fits on the circumference — about 1.4x past any
    // diameter estimated from node count — and it then spills out of the
    // tile it was supposed to stay inside. Measuring the real bounding box
    // afterwards and shifting is exact, whatever the layout decided.
    group
      .layout({
        name,
        fit: false,
        animate: false,
        avoidOverlap: true,
        padding: 0,
        sort: siblingSort,
        ...(name === "grid"
          ? { cols: Math.max(1, Math.ceil(Math.sqrt(group.length))) }
          : {}),
      } as unknown as cytoscape.LayoutOptions)
      .run();

    // `boundingBox()` includes labels, which sit below each node — counting
    // them is what stops one domain's labels landing on the next one's tile.
    const bounds = group.boundingBox();
    const dx = x - bounds.x1;
    const dy = y - bounds.y1;
    group.positions((node) => ({
      x: node.position().x + dx,
      y: node.position().y + dy,
    }));

    rowHeight = Math.max(rowHeight, bounds.h);
    if ((index + 1) % cols === 0) {
      x = 0;
      y += rowHeight + DOMAIN_TILE_GAP;
      rowHeight = 0;
    } else {
      x += bounds.w + DOMAIN_TILE_GAP;
    }
  });

  cy.fit(undefined, 32);
}

/** One place that knows each layout's options, so the first render and a later switch can never drift apart. */
function buildLayoutOptions(
  layout: LayoutMode,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    name: layout,
    fit: true,
    padding: 32,
    avoidOverlap: true,
    ...extra,
  };
  if (layout === "fcose") Object.assign(options, FCOSE_LAYOUT_OPTIONS);
  if (layout === "elk") options.elk = ELK_LAYOUT_OPTIONS;
  // Only reached for a flat graph — `applyLayout` diverts Circle/Grid to
  // `runTiledByDomain` as soon as there is a domain box to respect.
  if (layout === "circle" || layout === "grid") options.sort = siblingSort;
  return options;
}

/**
 * The layout currently running per Cytoscape instance, so a switch can stop
 * it before starting another. A `WeakMap` rather than a ref because
 * `applyLayout` is module scope (shared by three call sites) and a destroyed
 * instance must not keep its layout alive.
 */
const runningLayouts = new WeakMap<cytoscape.Core, cytoscape.Layouts>();

/**
 * Runs `layout` on `cy`, hiding the three things every call site would
 * otherwise have to repeat: stopping the previous layout, ELK's lazy
 * registration (async, hence the returned cancel function) and Circle's
 * per-domain special case.
 */
function applyLayout(
  cy: cytoscape.Core,
  layout: LayoutMode,
  extra: Record<string, unknown> = {}
): () => void {
  let cancelled = false;
  const run = (): void => {
    if (cancelled) return;
    // Stop whatever was still running first. A layout keeps writing
    // positions over several frames, so switching before the previous one
    // settles used to let the *old* layout overwrite the new one's result —
    // clicking Circle right after the graph loaded gave a force-directed
    // blob inside correctly-placed boxes.
    runningLayouts.get(cy)?.stop();
    runningLayouts.delete(cy);

    if ((layout === "circle" || layout === "grid") && cy.nodes(":parent").nonempty()) {
      runTiledByDomain(cy, layout);
      return;
    }
    const instance = cy.layout(
      buildLayoutOptions(layout, extra) as unknown as cytoscape.LayoutOptions
    );
    // `cytoscape-elk` computes asynchronously and its own `fit` lands before
    // the final positions do, so a tall hierarchy (which is what the domain
    // tier produces) opens scrolled into the middle of itself. Re-fitting
    // once the layout signals it has stopped is the reliable moment.
    if (layout === "elk") instance.one("layoutstop", () => cy.fit(undefined, 32));
    runningLayouts.set(cy, instance);
    instance.run();
  };

  if (layout === "elk") void ensureElkRegistered().then(run);
  else run();

  return () => {
    cancelled = true;
  };
}

type AffectedCategory = "touched" | "neighbor" | "notAffected";

const CATEGORY_LABELS: Record<AffectedCategory, string> = {
  touched: "Touched",
  neighbor: "Neighbor",
  notAffected: "Not affected",
};

/**
 * Single source of truth for the impact palette: the Cytoscape stylesheet
 * below and the legend chips in the toolbar read the same values, so a dot
 * in the legend is exactly the colour of the node it stands for.
 *
 * Amber for touched (the thing to look at), the app's own indigo for its
 * one-hop neighbourhood, and a desaturated slate for everything else so the
 * unaffected bulk of the graph recedes instead of competing.
 */
const IMPACT_COLORS: Record<
  AffectedCategory,
  { fill: string; border: string; label: string }
> = {
  touched: { fill: "#f0a92b", border: "#fcd34d", label: "#1a1205" },
  neighbor: { fill: "#6366f1", border: "#a5b4fc", label: "#eef2ff" },
  notAffected: { fill: "#242a36", border: "#3a4252", label: "#c8cfdd" },
};

/**
 * Selection palette — the second highlight layer (see the module comment).
 * Deliberately *not* drawn from `IMPACT_COLORS`: selection has to stay
 * readable on top of a touched (amber) or diff-neighbour (indigo) node, so
 * it uses near-white for the selected node itself and a light sky tone for
 * its dependency neighbourhood — both sit inside the app's blue-tinted dark
 * palette without colliding with amber or indigo.
 */
const SELECTION_COLORS = {
  focus: "#f8fafc",
  neighbor: "#7dd3fc",
};

/** Matches `--canvas` in globals.css — used as the label halo colour. */
const CANVAS_COLOR = "#0e1014";

const MIN_NODE_SIZE = 30;
const MAX_NODE_SIZE = 88;
/**
 * Node diameter at which the label gains its second line (the file count).
 * Below it only the component name is drawn: at 100+ nodes the "— N files"
 * suffix on every label was most of the overlap, and the count is on the
 * hover tooltip regardless.
 */
const DETAIL_LABEL_MIN_SIZE = 52;

function nodeSize(fileCount: number, maxFileCount: number): number {
  if (maxFileCount <= 0) return MIN_NODE_SIZE;
  const t = Math.sqrt(Math.min(fileCount, maxFileCount) / maxFileCount);
  return Math.round(MIN_NODE_SIZE + t * (MAX_NODE_SIZE - MIN_NODE_SIZE));
}

/**
 * One `intent-*` rule's style block — the AI-review marker layer.
 *
 * `underlay-*` is not in `@types/cytoscape` (the package's `Css.Node`
 * interface predates it; the properties themselves have shipped in
 * Cytoscape since 3.19 and this project is on 3.34), so the object is cast
 * at this single choke point rather than sprinkling casts through the
 * stylesheet. Nothing else here needs a cast, and if the typings ever catch
 * up, deleting the cast is a one-line change.
 */
function intentUnderlayStyle(
  intent: IntentMatch
): cytoscape.StylesheetStyle["style"] {
  const visual = INTENT_VISUALS[intent];
  return {
    "underlay-color": visual.color,
    "underlay-opacity": visual.markerOpacity,
    "underlay-padding": visual.markerPadding,
    "underlay-shape": "ellipse",
  } as unknown as cytoscape.StylesheetStyle["style"];
}

// `cytoscape.StylesheetStyle` (the `{selector, style}` shape used below),
// not the `Stylesheet` union alias — that alias isn't reachable through
// this package's `export = / export as namespace` default-import pattern
// the way its member interfaces (`Core`, `EventObject`, ...) are; only the
// interfaces merge onto the default-imported binding, not this alias.
function buildStylesheet(): cytoscape.StylesheetStyle[] {
  return [
    {
      selector: "node",
      style: {
        "background-color": IMPACT_COLORS.notAffected.fill,
        "border-width": 1,
        "border-color": IMPACT_COLORS.notAffected.border,
        "border-opacity": 0.9,
        label: "data(label)",
        color: IMPACT_COLORS.notAffected.label,
        "font-size": 11,
        "font-weight": 500,
        "text-valign": "bottom",
        "text-margin-y": 7,
        "text-wrap": "wrap",
        "text-max-width": "104px",
        // The halo. Labels sit below the nodes, directly on top of the edge
        // mesh; without an outline in the canvas colour they dissolve into
        // it the moment the graph gets dense, which is exactly what the
        // pre-polish screenshots showed. 3px of canvas-coloured outline
        // punches each glyph out of whatever is behind it.
        "text-outline-width": 3,
        "text-outline-color": CANVAS_COLOR,
        "text-outline-opacity": 0.92,
        // Progressive disclosure, part 1. `min-zoomed-font-size` is a
        // *rendered* size threshold: below it Cytoscape drops the label
        // entirely. A high value here means the long tail of small
        // components stays unlabelled until you actually zoom into them,
        // which is what keeps a 100+ node graph from being the grey haze of
        // overlapping text it was before.
        "min-zoomed-font-size": 9,
        "text-events": "no",
        width: "data(size)",
        height: "data(size)",
        "transition-property":
          "background-color, border-color, border-width, opacity",
        "transition-duration": 150,
      },
    },
    {
      // Progressive disclosure, part 2. Bigger components can afford the
      // extra line, they're the ones worth naming precisely, and their much
      // lower `min-zoomed-font-size` keeps them labelled at the zoom level
      // a whole-graph "fit" lands on — so the default view reads as a
      // labelled map of the major components rather than either an
      // unlabelled field of circles or a wall of text.
      selector: `node[size >= ${DETAIL_LABEL_MIN_SIZE}]`,
      style: {
        label: "data(labelDetail)",
        "font-size": 12,
        "font-weight": 600,
        "min-zoomed-font-size": 4,
      },
    },
    {
      // Grouping outline. Cytoscape's compound-node support is already wired
      // up in the element builder below (a node whose `parentId` resolves
      // gets a `parent`), but a parent node with no style of its own is
      // drawn exactly like a leaf — an ellipse the size of its children's
      // bounding box, indistinguishable from an ordinary component. This
      // rule is what makes a grouping read as a *box around* its children:
      // a barely-there fill, a dashed border, generous padding so children
      // don't touch the edge, and the group's name sitting above it.
      //
      // Nothing changes in v1, where no node carries a `parentId` (the
      // domain tier isn't populated — DESIGN.md §6.1/§16) so no node is a
      // parent and this selector matches nothing. It is in place for when
      // the domain tier lands.
      //
      // `width`/`height` are deliberately not reset from the `node` rule
      // above: Cytoscape ignores both on a compound parent and sizes it
      // from its children's bounding box plus `padding`.
      selector: ":parent",
      style: {
        shape: "round-rectangle",
        "background-color": "#8ea3c4",
        "background-opacity": 0.055,
        "border-width": 1.5,
        "border-style": "dashed",
        "border-color": "#4a5568",
        "border-opacity": 0.85,
        label: "data(name)",
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": -8,
        color: "#94a3b8",
        "font-size": 11,
        "font-weight": 700,
        "text-transform": "uppercase",
        "text-outline-width": 3,
        "text-outline-color": CANVAS_COLOR,
        // The group label is structural, so unlike a leaf's it stays legible
        // at whole-graph zoom instead of being dropped.
        "min-zoomed-font-size": 0,
        padding: "30px",
        "z-index": 1,
      },
    },
    {
      selector: "edge",
      style: {
        width: "data(edgeWidth)",
        "line-color": "#394152",
        "target-arrow-color": "#3a4252",
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.65,
        "curve-style": "bezier",
        opacity: 0.5,
        "transition-property": "opacity, line-color",
        "transition-duration": 150,
      },
    },
    {
      selector: "node.touched",
      style: {
        "background-color": IMPACT_COLORS.touched.fill,
        "border-color": IMPACT_COLORS.touched.border,
        "border-width": 2.5,
        color: "#fde3af",
        "font-weight": 700,
        "z-index": 20,
      },
    },
    {
      selector: "node.neighbor",
      style: {
        "background-color": IMPACT_COLORS.neighbor.fill,
        "border-color": IMPACT_COLORS.neighbor.border,
        "border-width": 2,
        color: "#c7d2fe",
        "z-index": 10,
      },
    },
    {
      // An edge with a touched endpoint is the actual path the change can
      // propagate along — it gets the touched hue and lifts above the mesh.
      selector: "edge.impacted",
      style: {
        "line-color": IMPACT_COLORS.touched.fill,
        "target-arrow-color": IMPACT_COLORS.touched.fill,
        opacity: 0.55,
        "z-index": 5,
      },
    },
    {
      selector: "node.dimmed",
      style: { opacity: 0.12 },
    },
    {
      selector: "edge.dimmed",
      style: { opacity: 0.04 },
    },
    // ---- Selection highlight layer (independent of the impact layer) ----
    // These come last so their borders/opacity win over the impact rules
    // above at equal specificity, while leaving `background-color` alone —
    // that's what lets a selected touched node stay amber *and* read as
    // selected at the same time.
    {
      // Everything that isn't the selected node or one of its direct
      // DEPENDS_ON neighbours. Slightly stronger than `.dimmed` so the
      // neighbourhood stands out even mid-diff-check, when much of the
      // graph is already dimmed.
      selector: "node.selection-faded",
      style: { opacity: 0.08 },
    },
    {
      selector: "edge.selection-faded",
      style: { opacity: 0.03 },
    },
    {
      selector: "edge.selection-edge",
      style: {
        "line-color": SELECTION_COLORS.neighbor,
        "target-arrow-color": SELECTION_COLORS.neighbor,
        opacity: 0.85,
        "z-index": 25,
      },
    },
    {
      selector: "node.selection-neighbor",
      style: {
        "border-color": SELECTION_COLORS.neighbor,
        "border-width": 3,
        "border-opacity": 1,
        color: "#e0f2fe",
        opacity: 1,
        // The neighbourhood is the thing being read, so its labels are
        // exempt from the zoom-based label culling the rest of the graph
        // gets (see `min-zoomed-font-size` on the base `node` rule).
        "min-zoomed-font-size": 0,
        "z-index": 35,
      },
    },
    {
      selector: "node.selection-focus",
      style: {
        "border-color": SELECTION_COLORS.focus,
        "border-width": 5,
        "border-opacity": 1,
        color: "#f8fafc",
        "font-weight": 700,
        opacity: 1,
        "min-zoomed-font-size": 0,
        "z-index": 45,
      },
    },
    {
      selector: "node.hovered",
      style: {
        "border-width": 3,
        "border-color": "#f8fafc",
        "z-index": 50,
      },
    },
    // ---- AI review marker layer (third, independent of the two above) ----
    // Only `underlay-*` is set, so these rules cannot overwrite an impact
    // fill or a selection border no matter where they sit in the sheet — the
    // three layers are orthogonal by construction, not by ordering luck.
    ...INTENT_ORDER.map((intent) => ({
      selector: `node.${intentClassName(intent)}`,
      style: intentUnderlayStyle(intent),
    })),
    // ...and the one place the three layers *do* have to know about each
    // other. `opacity` on a node covers its body and label but NOT its
    // underlay, so a node faded by the selection layer (or hidden by an
    // impact filter) kept a full-strength marker halo — on a real review
    // the dimmed-out background of the graph stayed lit with bright red
    // and green rings that competed with the node actually in focus.
    // Re-stating `underlay-opacity` *after* the `intent-*` rules above is
    // what lets the fade win, since Cytoscape resolves equal-specificity
    // conflicts in sheet order.
    {
      selector: "node.selection-faded",
      style: { "underlay-opacity": 0.05 } as unknown as cytoscape.StylesheetStyle["style"],
    },
    {
      selector: "node.dimmed",
      style: { "underlay-opacity": 0.06 } as unknown as cytoscape.StylesheetStyle["style"],
    },
  ];
}

export interface GraphCanvasHandle {
  fit(): void;
}

export interface GraphCanvasProps {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  /** From the diff-impact endpoint. `undefined` = no diff selected yet, so touched/neighbor highlighting is inactive. */
  touchedComponentIds?: string[];
  /** Controlled selection: the component whose node is lit up (with its DEPENDS_ON neighbourhood). `null`/`undefined` = nothing selected. */
  selectedNodeId?: string | null;
  /** Fired on tapping a node (its id) or the background / the same node again (`null`). */
  onSelectNode?: (nodeId: string | null) => void;
  /**
   * AI review findings collapsed to one marker per component (DESIGN.md §9)
   * — the third highlight layer. Keyed by component id, which is the same
   * value as a graph node id. Memoize it in the parent: it is an effect
   * dependency here, so a fresh object on every render would re-apply the
   * classes on every render.
   */
  reviewMarkers?: ReviewMarkerMap;
  /**
   * AI labeling state (DESIGN.md §6.1) for the toolbar's Labels control.
   * Omitted (e.g. on sample data) means no control is rendered at all.
   */
  labels?: UseLabelsResult;
  className?: string;
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(
  function GraphCanvas(
    {
      nodes,
      edges,
      touchedComponentIds,
      selectedNodeId,
      onSelectNode,
      reviewMarkers,
      labels,
      className,
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const cyRef = useRef<cytoscape.Core | null>(null);
    const tooltipRef = useRef<HTMLDivElement | null>(null);
    /** The node the cursor is currently over, so an open tooltip can be redrawn when its data changes. */
    const hoveredNodeRef = useRef<cytoscape.NodeSingular | null>(null);
    /** Assigned on mount; redraws the open tooltip from outside the mount effect's closure. */
    const refreshTooltipRef = useRef<(() => void) | null>(null);
    // The tap handler is registered once, on mount, but has to call
    // whatever the *current* `onSelectNode`/`selectedNodeId` are — a ref
    // keeps the listener stable (no re-binding on every render) without
    // closing over stale values.
    const selectionRef = useRef<{
      selectedNodeId: string | null;
      onSelectNode?: (nodeId: string | null) => void;
    }>({ selectedNodeId: selectedNodeId ?? null, onSelectNode });
    selectionRef.current = {
      selectedNodeId: selectedNodeId ?? null,
      onSelectNode,
    };
    // Same trick for the review markers: the hover-tooltip handler is bound
    // once on mount but has to read whatever findings have streamed in since.
    // Crucially this is *not* node `data` — putting it there would mean
    // rebuilding every element (and therefore re-running the layout, so the
    // whole graph jumps) each time a component's findings land mid-review.
    const markersRef = useRef<ReviewMarkerMap>({});
    markersRef.current = reviewMarkers ?? {};

    /** `cytoscape-expand-collapse`'s API handle, captured at init so the toolbar can drive it (typed in cytoscape-augment.d.ts). */
    const expandCollapseRef = useRef<ReturnType<
      cytoscape.Core["expandCollapse"]
    > | null>(null);

    const [layout, setLayout] = useState<LayoutMode>("fcose");
    const [collapsed, setCollapsed] = useState(false);
    const [ready, setReady] = useState(false);
    const [visibleCategories, setVisibleCategories] = useState<
      Record<AffectedCategory, boolean>
    >({ touched: true, neighbor: true, notAffected: true });

    const hasDiff = Boolean(touchedComponentIds && touchedComponentIds.length > 0);

    // Neighbor set: components one DEPENDS_ON hop away from a touched
    // component, in either direction (§4's "Neighbor" filter).
    const neighborIds = useMemo(() => {
      if (!touchedComponentIds || touchedComponentIds.length === 0) {
        return new Set<string>();
      }
      const touched = new Set(touchedComponentIds);
      const neighbors = new Set<string>();
      for (const e of edges) {
        if (touched.has(e.source) && !touched.has(e.target)) {
          neighbors.add(e.target);
        }
        if (touched.has(e.target) && !touched.has(e.source)) {
          neighbors.add(e.source);
        }
      }
      return neighbors;
    }, [edges, touchedComponentIds]);

    const categoryOf = (id: string): AffectedCategory => {
      if (touchedComponentIds?.includes(id)) return "touched";
      if (neighborIds.has(id)) return "neighbor";
      return "notAffected";
    };

    // Counts for the legend chips — the same categorisation the canvas
    // uses, so "Touched 7" always agrees with what's lit up.
    /**
     * The nodes that are actually drawn as a compound box — i.e. every node
     * some *other* node in this payload names as its parent.
     *
     * Derived from the payload's own `parentId` links rather than from
     * `tier === "domain"`, for the same reason the element builder below
     * only nests under a parent that exists: a domain node whose children
     * didn't make it into this payload isn't a box on screen, and the
     * toolbar must not offer to collapse a group nobody can see.
     */
    const domainIds = useMemo(() => {
      const ids = new Set(nodes.map((n) => n.id));
      const parents = new Set<string>();
      for (const node of nodes) {
        if (node.parentId && ids.has(node.parentId)) parents.add(node.parentId);
      }
      return parents;
    }, [nodes]);

    // Impact counts cover *module* nodes only. A domain box owns no files of
    // its own, so it can never be touched by a diff — counting it as "Not
    // affected" would inflate that chip by one per group and make the three
    // numbers stop adding up to the component count in the scale readout.
    const categoryCounts = useMemo(() => {
      const counts: Record<AffectedCategory, number> = {
        touched: 0,
        neighbor: 0,
        notAffected: 0,
      };
      if (!hasDiff) return counts;
      const touched = new Set(touchedComponentIds);
      for (const node of nodes) {
        if (domainIds.has(node.id)) continue;
        if (touched.has(node.id)) counts.touched += 1;
        else if (neighborIds.has(node.id)) counts.neighbor += 1;
        else counts.notAffected += 1;
      }
      return counts;
    }, [hasDiff, nodes, domainIds, neighborIds, touchedComponentIds]);

    useImperativeHandle(ref, () => ({
      fit() {
        cyRef.current?.fit(undefined, 40);
      },
    }));

    // Mount: create the cy instance once.
    useEffect(() => {
      if (!containerRef.current) return;
      registerExtensionsOnce();

      const cy = cytoscape({
        container: containerRef.current,
        style: buildStylesheet(),
        // No `wheelSensitivity`. It was set to 0.2 here, which is what made
        // scroll-to-zoom feel like wading through treacle on a real
        // 100+ node graph *and* what triggered Cytoscape's own console
        // warning that a custom sensitivity makes zooming behave
        // unnaturally. Cytoscape's default is already normalised per input
        // device (it divides by a different factor for a trackpad's many
        // small deltas than for a mouse wheel's few large ones), so any
        // constant multiplier on top of it breaks that normalisation for
        // one device or the other. Nothing in the history justified the
        // 0.2 — the default is the right answer here.
        //
        // Zoom bounds are unchanged and still hold up: `minZoom` is low
        // enough that `fit: true` can always frame the whole graph (at 0.1
        // a 100+ node Circle layout — whose radius grows linearly with node
        // count — needed ~0.07 to fit, so the fit was clamped and the view
        // opened *inside* the ring, showing an almost empty canvas), and
        // with the default wheel sensitivity the whole 0.03 → 3 range is
        // now a couple of flicks of the wheel rather than a long grind.
        minZoom: 0.03,
        maxZoom: 3,
      });
      cyRef.current = cy;

      // Hover tooltip (see module comment for why this isn't cytoscape-popper).
      //
      // Split out from the `mouseover` handler so it can be re-run for the
      // node still under the cursor when the review data changes underneath
      // it (see `refreshTooltipRef` below) — the tooltip is built once as
      // detached DOM, so without that it would keep asserting a finding for
      // a review that has since been replaced or cleared.
      const renderTooltip = (node: cytoscape.NodeSingular) => {
        const tooltip = tooltipRef.current;
        const container = containerRef.current;
        if (!tooltip || !container) return;

        const pos = node.renderedPosition();
        const fileCount = node.data("fileCount") as number;
        const tier = node.data("tier") as string;
        const description = node.data("description") as string | undefined;

        tooltip.innerHTML = "";

        const title = document.createElement("div");
        title.className = "text-[13px] font-semibold tracking-tight text-foreground";
        title.textContent = node.data("name") as string;
        tooltip.appendChild(title);

        const meta = document.createElement("div");
        meta.className = "mt-1.5 flex items-center gap-1.5";

        const tierChip = document.createElement("span");
        tierChip.className =
          "rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wide";
        tierChip.textContent = tier;
        meta.appendChild(tierChip);

        const count = document.createElement("span");
        count.className = "text-[11px] text-muted-foreground";
        count.textContent = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
        meta.appendChild(count);

        tooltip.appendChild(meta);

        if (description) {
          const desc = document.createElement("div");
          desc.className =
            "mt-2 max-w-56 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground";
          desc.textContent = description;
          tooltip.appendChild(desc);
        }

        // Worst finding, in the tooltip's existing idiom: a bordered block
        // under the description, one label line plus one summary line. The
        // label carries the verdict in words (the marker halo is colour
        // only), and the summary is clamped to two lines so a long sentence
        // can't turn the tooltip into a wall of text.
        const marker = markersRef.current[node.id()];
        if (marker) {
          const visual = INTENT_VISUALS[marker.worst];
          const findingBox = document.createElement("div");
          findingBox.className =
            "mt-2 max-w-56 border-t border-border pt-2 text-[11px] leading-relaxed";

          const verdict = document.createElement("div");
          verdict.className = "flex items-center gap-1.5 font-medium";
          verdict.style.color = visual.text;
          const dot = document.createElement("span");
          dot.className = "inline-block size-1.5 shrink-0 rounded-full";
          dot.style.backgroundColor = visual.color;
          verdict.appendChild(dot);
          verdict.appendChild(
            document.createTextNode(
              marker.count > 1
                ? `${visual.label} · ${marker.count} findings`
                : visual.label
            )
          );
          findingBox.appendChild(verdict);

          const summary = document.createElement("div");
          summary.className = "mt-1 line-clamp-2 text-muted-foreground";
          summary.textContent = marker.summary;
          findingBox.appendChild(summary);

          tooltip.appendChild(findingBox);
        }

        tooltip.style.left = `${pos.x}px`;
        tooltip.style.top = `${pos.y}px`;
        tooltip.style.display = "block";
      };

      const handleMouseOver = (evt: cytoscape.EventObject) => {
        const node = evt.target as cytoscape.NodeSingular;
        node.addClass("hovered");
        hoveredNodeRef.current = node;
        renderTooltip(node);
      };
      const handleMouseOut = (evt: cytoscape.EventObject) => {
        (evt.target as cytoscape.NodeSingular).removeClass("hovered");
        hoveredNodeRef.current = null;
        if (tooltipRef.current) tooltipRef.current.style.display = "none";
      };

      // Lets the review-marker effect below redraw an open tooltip without
      // reaching into this closure. Returns quietly when nothing is hovered.
      refreshTooltipRef.current = () => {
        const node = hoveredNodeRef.current;
        const tooltip = tooltipRef.current;
        if (!tooltip) return;
        if (!node || node.removed() || tooltip.style.display !== "block") {
          tooltip.style.display = "none";
          hoveredNodeRef.current = null;
          return;
        }
        renderTooltip(node);
      };
      const handlePosition = (evt: cytoscape.EventObject) => {
        const node = evt.target as cytoscape.NodeSingular;
        const tooltip = tooltipRef.current;
        if (!tooltip || tooltip.style.display !== "block") return;
        const pos = node.renderedPosition();
        tooltip.style.left = `${pos.x}px`;
        tooltip.style.top = `${pos.y}px`;
      };

      // Node selection. `tap` is Cytoscape's click equivalent (it fires on
      // a press-release that wasn't a drag, so panning the canvas doesn't
      // accidentally select). Tapping the already-selected node clears the
      // selection, as does tapping the background — the second handler is
      // registered without a selector and checks `evt.target === cy`, which
      // is how Cytoscape distinguishes a background tap from an element one.
      const handleNodeTap = (evt: cytoscape.EventObject) => {
        const node = evt.target as cytoscape.NodeSingular;
        const { selectedNodeId: current, onSelectNode: notify } =
          selectionRef.current;
        const id = node.id();
        notify?.(current === id ? null : id);
      };
      const handleBackgroundTap = (evt: cytoscape.EventObject) => {
        if (evt.target !== cy) return;
        selectionRef.current.onSelectNode?.(null);
      };

      cy.on("mouseover", "node", handleMouseOver);
      cy.on("mouseout", "node", handleMouseOut);
      cy.on("position", "node", handlePosition);
      cy.on("pan zoom", handlePosition as unknown as cytoscape.EventHandler);
      cy.on("tap", "node", handleNodeTap);
      cy.on("tap", handleBackgroundTap);

      // Adds the +/- expand/collapse cue to any compound (parent) node, and
      // gives us the handle the toolbar's Collapse/Expand-all button drives.
      // A no-op visually when no node has a `parent` set (an unlabeled repo).
      //
      // `layoutBy: null` on purpose: the extension would otherwise re-run a
      // layout of its own choosing on every collapse, fighting the layout
      // switcher above. The toggle below re-runs the *current* layout itself.
      expandCollapseRef.current = cy.expandCollapse({
        layoutBy: null,
        fisheye: false,
        animate: true,
        undoable: false,
        cueEnabled: true,
      });

      setReady(true);

      // Cytoscape sizes its canvas from the container's dimensions once at
      // creation and doesn't watch for later resizes on its own (e.g. a
      // sidebar collapsing, or the window resizing) — without this, the
      // canvas keeps stale pixel dimensions and the graph can overflow or
      // letterbox inside its now-differently-sized container.
      const resizeObserver = new ResizeObserver(() => {
        cy.resize();
      });
      resizeObserver.observe(containerRef.current);

      return () => {
        resizeObserver.disconnect();
        cy.removeListener("mouseover", "node", handleMouseOver);
        cy.removeListener("mouseout", "node", handleMouseOut);
        cy.removeListener("position", "node", handlePosition);
        cy.removeListener("tap", "node", handleNodeTap);
        cy.removeListener("tap", handleBackgroundTap);
        cy.destroy();
        cyRef.current = null;
        hoveredNodeRef.current = null;
        refreshTooltipRef.current = null;
      };
    }, []);

    // Rebuild elements whenever the graph data changes.
    useEffect(() => {
      const cy = cyRef.current;
      if (!cy || !ready) return;

      const nodeIds = new Set(nodes.map((n) => n.id));
      const maxFileCount = nodes.reduce((m, n) => Math.max(m, n.fileCount), 0);
      const maxWeight = edges.reduce((m, e) => Math.max(m, e.weight), 0);

      const nodeElements: cytoscape.ElementDefinition[] = nodes.map((n) => ({
        group: "nodes",
        data: {
          id: n.id,
          name: n.name,
          // Two label variants; the stylesheet picks between them by node
          // size so only the big components pay for the extra line.
          label: n.name,
          labelDetail: `${n.name}\n${n.fileCount} file${
            n.fileCount === 1 ? "" : "s"
          }`,
          tier: n.tier,
          fileCount: n.fileCount,
          description: n.description,
          size: nodeSize(n.fileCount, maxFileCount),
          // Only nest under a parent that actually exists in this payload —
          // tolerates a dangling/absent domain tier gracefully (§6.1/§16).
          ...(n.parentId && nodeIds.has(n.parentId)
            ? { parent: n.parentId }
            : {}),
        },
      }));

      const edgeElements: cytoscape.ElementDefinition[] = edges
        .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
        .map((e) => ({
          group: "edges",
          data: {
            id: `${e.source}->${e.target}`,
            source: e.source,
            target: e.target,
            weight: e.weight,
            edgeWidth: maxWeight > 0 ? 0.8 + (e.weight / maxWeight) * 3 : 1.2,
          },
        }));

      cy.elements().remove();
      cy.add([...nodeElements, ...edgeElements]);
      // Rebuilding the elements drops any collapsed state with them, so the
      // toolbar's toggle has to start from "expanded" again.
      setCollapsed(false);
      return applyLayout(cy, layout, { animate: false });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes, edges, ready]);

    // Re-run layout on switch.
    useEffect(() => {
      const cy = cyRef.current;
      if (!cy || !ready || cy.elements().length === 0) return;
      return applyLayout(cy, layout, {
        animate: true,
        ...(layout === "fcose" ? { randomize: false } : {}),
      });
    }, [layout, ready]);

    // Touched/neighbor/not-affected classes + filter-driven dimming.
    useEffect(() => {
      const cy = cyRef.current;
      if (!cy || !ready) return;

      cy.batch(() => {
        cy.nodes().forEach((node) => {
          node.removeClass("touched neighbor dimmed");
          // Domain boxes are structural, not impacted: they own no files, so
          // they can never be touched, and dimming a box while its children
          // stay lit (or vice versa) just makes the grouping flicker.
          if (!hasDiff || node.isParent()) return;
          const category = categoryOf(node.id());
          node.addClass(category === "notAffected" ? "" : category);
          if (!visibleCategories[category]) node.addClass("dimmed");
        });
        cy.edges().forEach((edge) => {
          edge.removeClass("dimmed impacted");
          if (!hasDiff) return;
          const sourceCat = categoryOf(edge.data("source"));
          const targetCat = categoryOf(edge.data("target"));
          // Purely visual: an edge with a touched endpoint is drawn in the
          // touched hue. Dimming below is unchanged.
          if (sourceCat === "touched" || targetCat === "touched") {
            edge.addClass("impacted");
          }
          const eitherHidden =
            !visibleCategories[sourceCat] || !visibleCategories[targetCat];
          if (eitherHidden) edge.addClass("dimmed");
        });
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [touchedComponentIds, neighborIds, visibleCategories, ready, hasDiff]);

    // Selection highlight: the selected node, its direct DEPENDS_ON
    // neighbours in *both* directions, and the edges between them; every
    // other element fades back. Kept in its own effect with its own class
    // names so it composes with — rather than overwrites — the diff-impact
    // effect above; both run on every relevant change and neither clears
    // the other's classes.
    useEffect(() => {
      const cy = cyRef.current;
      if (!cy || !ready) return;

      cy.batch(() => {
        cy.elements().removeClass(
          "selection-focus selection-neighbor selection-edge selection-faded"
        );
        if (!selectedNodeId) return;

        const focus = cy.getElementById(selectedNodeId);
        if (focus.empty()) return;

        // A domain box has no DEPENDS_ON edges of its own (§7 aggregates
        // them at the module tier), so the module rule below would light up
        // the box and fade literally everything else — including its own
        // children. Its "neighbourhood" is instead what it contains, which
        // is also the thing its file panel is about to list.
        const isGroup = focus.isParent();
        const neighborhood = isGroup
          ? focus.descendants()
          : focus.connectedEdges().connectedNodes().difference(focus);
        // For a group: only the edges *inside* it, so the highlight stays
        // bounded rather than reaching out into the faded graph.
        // For a module: `connectedEdges` is direction-agnostic, covering both
        // "what this depends on" and "what depends on it" in one go.
        const connected = isGroup
          ? neighborhood.edgesWith(neighborhood)
          : focus.connectedEdges();

        focus.addClass("selection-focus");
        neighborhood.addClass("selection-neighbor");
        connected.addClass("selection-edge");

        cy.nodes()
          .difference(focus.union(neighborhood))
          // Never fade a compound box: its dashed outline is the map legend
          // for where the lit-up nodes sit, and fading it to 8% while its
          // children are at full strength reads as a rendering glitch.
          .not(":parent")
          .addClass("selection-faded");
        cy.edges().difference(connected).addClass("selection-faded");
      });
      // `nodes`/`edges` are listed so the classes are re-applied after the
      // element-rebuild effect above replaces the elements they were on.
    }, [selectedNodeId, nodes, edges, ready]);

    // AI review markers — the third layer. Its own effect with its own class
    // namespace (`intent-*`), for the same reason selection has one: it must
    // compose with the other two rather than clobber them, and it changes on
    // a completely different cadence (every ~1.2s poll while a review
    // streams in, versus once per diff check / click).
    useEffect(() => {
      const cy = cyRef.current;
      if (!cy || !ready) return;

      cy.batch(() => {
        cy.nodes().removeClass(INTENT_CLASS_NAMES);
        if (!reviewMarkers) return;
        for (const [componentId, marker] of Object.entries(reviewMarkers)) {
          // A finding can outlive the graph it was made against (findings
          // persist, components are re-derived on re-analysis), so a marker
          // for a component that is no longer a node is simply skipped.
          const node = cy.getElementById(componentId);
          if (!node.empty()) node.addClass(intentClassName(marker.worst));
        }
      });

      // If a tooltip is open on a node whose findings just changed — or
      // just went away, e.g. switching the diff panel to "paste paths",
      // which has no review — redraw it rather than leaving a verdict on
      // screen that no longer holds.
      refreshTooltipRef.current?.();
      // `nodes` for the same reason as the selection effect above: the
      // element rebuild drops every class with the elements it replaces.
    }, [reviewMarkers, nodes, ready]);

    // Legend counts for the review layer: how many *components* carry each
    // verdict as their worst finding — i.e. exactly what is drawn on the
    // canvas, so a "Mismatch 3" chip always means three haloed nodes. (The
    // dock below counts findings, which is a different and larger number;
    // each chip says which it is in its tooltip.)
    const intentCounts = useMemo(
      () => countComponentsByIntent(reviewMarkers ?? {}),
      [reviewMarkers]
    );
    const hasReview = useMemo(
      () => INTENT_ORDER.some((intent) => intentCounts[intent] > 0),
      [intentCounts]
    );

    const visibleEdgeCount = useMemo(() => {
      const nodeIds = new Set(nodes.map((n) => n.id));
      return edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
        .length;
    }, [nodes, edges]);

    // Mirrors what the canvas lights up, for the on-canvas selection chip —
    // same both-directions neighbourhood as the effect above.
    const selectionSummary = useMemo(() => {
      if (!selectedNodeId) return null;
      const node = nodes.find((n) => n.id === selectedNodeId);
      if (!node) return null;
      const neighbors = new Set<string>();
      for (const e of edges) {
        if (e.source === selectedNodeId) neighbors.add(e.target);
        if (e.target === selectedNodeId) neighbors.add(e.source);
      }
      neighbors.delete(selectedNodeId);
      return { name: node.name, neighborCount: neighbors.size };
    }, [selectedNodeId, nodes, edges]);

    /** Re-runs whatever layout is selected — used after a collapse/expand, which changes how many nodes there are to place. */
    const runCurrentLayout = (): void => {
      const cy = cyRef.current;
      if (!cy || cy.elements().length === 0) return;
      applyLayout(cy, layout, {
        animate: true,
        ...(layout === "fcose" ? { randomize: false } : {}),
      });
    };

    const handleToggleCollapse = (): void => {
      const api = expandCollapseRef.current;
      if (!api) return;
      const next = !collapsed;
      if (next) api.collapseAll();
      else api.expandAll();
      setCollapsed(next);
      // Collapsing swaps N module nodes for one box (and expanding does the
      // reverse), so the surviving positions are wrong either way until the
      // layout runs again.
      runCurrentLayout();
    };

    return (
      <div className={className}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="flex items-center gap-0.5 rounded-lg bg-muted p-[3px] ring-1 ring-border/60"
              role="group"
              aria-label="Graph layout"
            >
              {LAYOUT_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const active = layout === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setLayout(opt.value)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                      active
                        ? "bg-elevated text-foreground shadow-sm ring-1 ring-border/60"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                    aria-pressed={active}
                  >
                    <Icon
                      className={cn("size-3.5", active ? "text-brand" : "opacity-70")}
                    />
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {/* AI labeling (§6.1) — the on-demand action that creates the
                domain tier, plus the collapse/expand toggle for the boxes it
                produces. Sits next to the layout switcher because both are
                about how the graph is *arranged*, not about the diff. */}
            {labels && (
              <LabelsControl
                labels={labels}
                hasDomains={domainIds.size > 0}
                collapsed={collapsed}
                onToggleCollapse={handleToggleCollapse}
              />
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {(Object.keys(CATEGORY_LABELS) as AffectedCategory[]).map((cat) => {
              const on = visibleCategories[cat];
              return (
                <button
                  key={cat}
                  type="button"
                  disabled={!hasDiff}
                  onClick={() =>
                    setVisibleCategories((prev) => ({ ...prev, [cat]: !prev[cat] }))
                  }
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                    on
                      ? "border-border bg-card text-foreground hover:bg-secondary"
                      : "border-transparent bg-muted text-muted-foreground line-through decoration-muted-foreground/50"
                  )}
                  aria-pressed={on}
                  title={
                    hasDiff
                      ? `Toggle ${CATEGORY_LABELS[cat].toLowerCase()} components`
                      : "Run an impact check to enable impact filters"
                  }
                >
                  <span
                    className="inline-block size-2 rounded-full ring-1 ring-inset ring-black/20"
                    style={{
                      backgroundColor: on
                        ? IMPACT_COLORS[cat].fill
                        : "transparent",
                      boxShadow: on
                        ? `0 0 0 1px ${IMPACT_COLORS[cat].border}66`
                        : `inset 0 0 0 1px ${IMPACT_COLORS[cat].border}`,
                    }}
                  />
                  {CATEGORY_LABELS[cat]}
                  {hasDiff ? (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {categoryCounts[cat]}
                    </span>
                  ) : null}
                </button>
              );
            })}

            {/*
              Review legend. Appears only once a review has produced findings,
              so the toolbar is unchanged for every pre-AI flow, and it reads
              as a second, quieter group rather than three more filter
              buttons: a hairline divider, no borders, no toggle affordance
              (the actual filters live in the dock below the canvas, which is
              also where the findings are — duplicating them here would give
              two controls for one list). Verdicts with no components are
              omitted entirely, so the common "all match" review adds one
              small chip instead of four.
            */}
            {hasReview && (
              <>
                <span
                  className="mx-0.5 h-4 w-px bg-border"
                  aria-hidden
                />
                <div
                  className="flex items-center gap-1.5"
                  aria-label="AI review findings"
                >
                  {INTENT_ORDER.filter((intent) => intentCounts[intent] > 0).map(
                    (intent) => {
                      const visual = INTENT_VISUALS[intent];
                      const Icon = visual.icon;
                      return (
                        <span
                          key={intent}
                          className="flex items-center gap-1 rounded-full px-1.5 py-1 text-xs font-medium"
                          style={{
                            color: visual.text,
                            backgroundColor: `${visual.color}14`,
                          }}
                          title={`${intentCounts[intent]} component${
                            intentCounts[intent] === 1 ? "" : "s"
                          } marked ${visual.label.toLowerCase()} — ${
                            visual.description
                          }`}
                        >
                          <Icon className="size-3" aria-hidden />
                          {visual.label}
                          <span className="font-mono text-[10px] opacity-80">
                            {intentCounts[intent]}
                          </span>
                        </span>
                      );
                    }
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="relative overflow-hidden rounded-xl bg-canvas ring-1 ring-border">
          <div
            ref={containerRef}
            className="h-[min(68vh,680px)] min-h-[440px] w-full"
          />

          {/*
            Scale readout. Costs nothing (both numbers are already props) and
            gives the canvas the data-density of the reference prototype
            instead of an unlabelled field of circles.
          */}
          {nodes.length > 0 && (
            <div className="pointer-events-none absolute top-3 left-3 z-20 flex items-center gap-2 rounded-lg border border-border/70 bg-background/70 px-2.5 py-1.5 text-[11px] text-muted-foreground backdrop-blur-md">
              <Network className="size-3.5 text-brand" aria-hidden />
              <span className="font-mono text-foreground">
                {nodes.length - domainIds.size}
              </span>
              <span>components</span>
              {domainIds.size > 0 && (
                <>
                  <span className="opacity-40">·</span>
                  <span className="font-mono text-foreground">
                    {domainIds.size}
                  </span>
                  <span>domains</span>
                </>
              )}
              <span className="opacity-40">·</span>
              <span className="font-mono text-foreground">
                {visibleEdgeCount}
              </span>
              <span>dependencies</span>
              <span className="opacity-40">·</span>
              <span className="opacity-80">click a node for its files</span>
            </div>
          )}

          {/*
            Selection chip. The canvas already *shows* the selection, but a
            faded graph with no stated reason is confusing — this names what
            is selected and gives an explicit way out that doesn't require
            guessing "tap the background".
          */}
          {selectionSummary && (
            <div className="absolute top-3 right-3 z-20 flex max-w-[min(20rem,60%)] items-center gap-2 rounded-lg border border-border/70 bg-background/80 px-2.5 py-1.5 text-[11px] backdrop-blur-md">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: SELECTION_COLORS.focus,
                  boxShadow: `0 0 0 3px ${SELECTION_COLORS.neighbor}33`,
                }}
                aria-hidden
              />
              <span className="truncate font-medium text-foreground">
                {selectionSummary.name}
              </span>
              <span className="shrink-0 text-muted-foreground">
                <span className="font-mono text-foreground">
                  {selectionSummary.neighborCount}
                </span>{" "}
                connected
              </span>
              <button
                type="button"
                onClick={() => onSelectNode?.(null)}
                className="-mr-1 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                aria-label="Clear selection"
                title="Clear selection"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          <div
            ref={tooltipRef}
            className="pointer-events-none absolute z-30 hidden -translate-x-1/2 -translate-y-[calc(100%+16px)] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl shadow-black/40"
          />

          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3">
              <span className="flex size-11 items-center justify-center rounded-xl bg-secondary text-muted-foreground ring-1 ring-border">
                <Network className="size-5" />
              </span>
              <p className="text-sm text-muted-foreground">
                No components to display.
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }
);
