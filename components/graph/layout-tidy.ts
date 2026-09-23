// Post-processing for the Force layout once the domain tier exists.
//
// fcose handles compound nodes, but two things about its output made the
// domain view hard to read on real repos:
//
// 1. Unconnected members balloon their box. A module with no dependency
//    edges at all has nothing pulling it towards its siblings, only
//    repulsion pushing it away, so it drifts to the edge of its domain and
//    stretches the box around a lot of empty space. `packIsolatedMembers`
//    moves those members into a compact grid beside their domain's connected
//    core instead.
// 2. The overall picture comes out roughly square while the canvas is wide.
//    `spreadHorizontally` moves whole domains (never nodes within one)
//    apart along x until the graph's aspect ratio matches the canvas.
//
// Moving things around after the fact can make two boxes overlap, so
// `separateBodies` runs last and pushes overlapping boxes apart.

import type cytoscape from "cytoscape";

/** A grid cell for one packed member: room for the node and its label beneath it. */
const CELL_WIDTH = 120;
const LABEL_ALLOWANCE = 34;
/** Gap between a domain's connected core and its packed grid. */
const PACK_GAP = 36;
/** Minimum clear space kept between two boxes by `separateBodies`. */
const BODY_MARGIN = 60;
/** Never stretch the graph by more than this, however wide the canvas. */
const MAX_SPREAD = 2;

type Box = { x1: number; y1: number; x2: number; y2: number };

function shift(nodes: cytoscape.NodeCollection, dx: number, dy: number): void {
  nodes.positions((node) => ({
    x: node.position().x + dx,
    y: node.position().y + dy,
  }));
}

/** Members of `parent` with no dependency edge to anything. */
function isolatedChildren(parent: cytoscape.NodeSingular): cytoscape.NodeCollection {
  return parent.children().filter((child) => child.connectedEdges().empty());
}

export function packIsolatedMembers(cy: cytoscape.Core): void {
  cy.nodes(":parent").forEach((parent) => {
    const isolated = isolatedChildren(parent);
    if (isolated.empty()) return;
    const connected = parent.children().difference(isolated);

    const maxSize = isolated.reduce(
      (m, node) => Math.max(m, node.outerHeight()),
      0
    );
    const cellHeight = maxSize + LABEL_ALLOWANCE;
    const n = isolated.length;

    // Beside a tall core, below a wide one — whichever keeps the box nearer
    // square. With no connected core at all, the grid simply replaces the
    // scatter, centred where the members were.
    let originX: number;
    let originY: number;
    let cols: number;
    if (connected.nonempty()) {
      const core = connected.boundingBox();
      if (core.h > core.w) {
        const rows = Math.max(1, Math.floor(core.h / cellHeight));
        cols = Math.max(1, Math.ceil(n / rows));
        originX = core.x2 + PACK_GAP;
        originY = core.y1;
      } else {
        cols = Math.min(n, Math.max(Math.ceil(Math.sqrt(n)), Math.floor(core.w / CELL_WIDTH)));
        originX = core.x1;
        originY = core.y2 + PACK_GAP;
      }
    } else {
      const box = isolated.boundingBox();
      cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      originX = (box.x1 + box.x2) / 2 - (cols * CELL_WIDTH) / 2;
      originY = (box.y1 + box.y2) / 2 - (rows * cellHeight) / 2;
    }

    const sorted = isolated.sort((a, b) =>
      ((a.data("name") as string) ?? "").localeCompare((b.data("name") as string) ?? "")
    );
    sorted.forEach((node, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      node.position({
        x: originX + col * CELL_WIDTH + CELL_WIDTH / 2,
        y: originY + row * cellHeight + maxSize / 2,
      });
    });
  });
}

/** The things moved as rigid wholes: each domain (as its children) and each module outside any domain. */
function bodies(cy: cytoscape.Core): cytoscape.NodeCollection[] {
  const result: cytoscape.NodeCollection[] = [];
  cy.nodes(":parent").forEach((parent) => {
    result.push(parent.children());
  });
  cy.nodes()
    .not(":parent")
    .not(":child")
    .forEach((node) => {
      result.push(node);
    });
  return result;
}

export function spreadHorizontally(cy: cytoscape.Core): void {
  const width = cy.width();
  const height = cy.height();
  if (width <= 0 || height <= 0) return;
  const all = cy.nodes().boundingBox();
  if (all.w <= 0 || all.h <= 0) return;
  const factor = Math.min(MAX_SPREAD, width / height / (all.w / all.h));
  if (factor <= 1.05) return;

  const centerX = (all.x1 + all.x2) / 2;
  for (const body of bodies(cy)) {
    const box = body.boundingBox();
    const bodyCenter = (box.x1 + box.x2) / 2;
    shift(body, (bodyCenter - centerX) * (factor - 1), 0);
  }
}

/** Box of a body, including its compound padding and the domain label above it. */
function outerBox(body: cytoscape.NodeCollection): Box {
  const parent = body.parent();
  const box = parent.nonempty() ? parent.boundingBox() : body.boundingBox();
  return { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 };
}

export function separateBodies(cy: cytoscape.Core, maxIterations = 40): void {
  const all = bodies(cy);
  // Only domains need separating: fcose already keeps loose modules clear
  // of each other, and `packIsolatedMembers`/`spreadHorizontally` are what
  // can push a domain into something.
  const domains = all.filter((body) => body.parent().nonempty());
  if (domains.length === 0) return;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let moved = false;
    const boxes = all.map(outerBox);
    for (const domain of domains) {
      const i = all.indexOf(domain);
      for (let j = 0; j < all.length; j++) {
        if (j === i) continue;
        const a = boxes[i];
        const b = boxes[j];
        const overlapX = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) + BODY_MARGIN;
        const overlapY = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) + BODY_MARGIN;
        if (overlapX <= 0 || overlapY <= 0) continue;

        // Push along the axis that needs the smaller move, splitting it
        // between the two so neither drifts far from where fcose put it.
        const alongX = overlapX < overlapY;
        const amount = (alongX ? overlapX : overlapY) / 2;
        const direction = alongX
          ? a.x1 + a.x2 < b.x1 + b.x2 ? -1 : 1
          : a.y1 + a.y2 < b.y1 + b.y2 ? -1 : 1;
        const dx = alongX ? direction * amount : 0;
        const dy = alongX ? 0 : direction * amount;
        shift(all[i], dx, dy);
        shift(all[j], -dx, -dy);
        boxes[i] = outerBox(all[i]);
        boxes[j] = outerBox(all[j]);
        moved = true;
      }
    }
    if (!moved) return;
  }
}

/** All three passes, in order. */
export function tidyDomainLayout(cy: cytoscape.Core): void {
  if (cy.nodes(":parent").empty()) return;
  packIsolatedMembers(cy);
  spreadHorizontally(cy);
  separateBodies(cy);
}
