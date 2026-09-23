// Domain collapse/expand, replacing `cytoscape-expand-collapse`.
//
// Collapsing removes every domain's children (and, with them, every edge
// touching a child) and draws one *summary edge* per pair of connected
// endpoints in their place: a domain stands in for all of its members, a
// module with no domain stands for itself. A summary edge carries how many
// real dependency edges it replaces (`count`), which drives its width and
// its label, so a collapsed graph reads as "Checkout → Payments, 14
// dependencies" instead of fourteen overlapping lines.
//
// Expanding removes the summary edges and restores the removed collection
// as-is: same ids, same data, same `parent` links. Classes the other effects
// applied while collapsed are *not* on the restored elements, so
// GraphCanvas re-runs those effects on every toggle.

import type cytoscape from "cytoscape";

export interface CollapsedDomains {
  /** Everything taken off the canvas — the children plus their connected edges — to be restored on expand. */
  removed: cytoscape.CollectionReturnValue;
  /** Domain id → the ids of the members it now stands in for. */
  members: Map<string, string[]>;
}

export const SUMMARY_EDGE_CLASS = "summary-edge";
export const COLLAPSED_DOMAIN_CLASS = "collapsed-domain";

interface Summary {
  source: string;
  target: string;
  count: number;
}

/** Summary-edge width: grows with the number of edges it stands for, logarithmically so one huge bundle can't swamp the canvas. */
function summaryWidth(count: number): number {
  return 1 + Math.min(5, Math.log2(count + 1) * 1.2);
}

/** Collapses every compound node in `cy`. Returns `null` (and changes nothing) when there is nothing to collapse. */
export function collapseDomains(cy: cytoscape.Core): CollapsedDomains | null {
  const parents = cy.nodes(":parent");
  if (parents.empty()) return null;

  const owner = new Map<string, string>();
  const members = new Map<string, string[]>();
  parents.forEach((parent) => {
    const ids = parent.children().map((child) => child.id());
    members.set(parent.id(), ids);
    for (const id of ids) owner.set(id, parent.id());
  });

  const summaries = new Map<string, Summary>();
  cy.edges().forEach((edge) => {
    const rawSource = edge.data("source") as string;
    const rawTarget = edge.data("target") as string;
    // Edges between two domain-less modules survive the collapse untouched.
    if (!owner.has(rawSource) && !owner.has(rawTarget)) return;
    const source = owner.get(rawSource) ?? rawSource;
    const target = owner.get(rawTarget) ?? rawTarget;
    // Dependencies inside one domain have nowhere to be drawn once it is a
    // single node — that's the point of collapsing.
    if (source === target) return;
    const key = `${source}->${target}`;
    const existing = summaries.get(key);
    if (existing) existing.count += 1;
    else summaries.set(key, { source, target, count: 1 });
  });

  let removed!: cytoscape.CollectionReturnValue;
  cy.batch(() => {
    removed = parents.children().remove();
    parents.forEach((parent) => {
      const count = members.get(parent.id())?.length ?? 0;
      parent.addClass(COLLAPSED_DOMAIN_CLASS);
      parent.data(
        "collapsedLabel",
        `${parent.data("name") as string}\n${count} component${count === 1 ? "" : "s"}`
      );
    });
    cy.add(
      [...summaries.entries()].map(([key, summary]) => ({
        group: "edges" as const,
        classes: SUMMARY_EDGE_CLASS,
        data: {
          id: `summary:${key}`,
          source: summary.source,
          target: summary.target,
          count: summary.count,
          edgeWidth: summaryWidth(summary.count),
          countLabel: summary.count > 1 ? String(summary.count) : "",
        },
      }))
    );
  });

  return { removed, members };
}

/** Undoes `collapseDomains`. */
export function expandDomains(cy: cytoscape.Core, state: CollapsedDomains): void {
  cy.batch(() => {
    cy.edges(`.${SUMMARY_EDGE_CLASS}`).remove();
    cy.nodes(`.${COLLAPSED_DOMAIN_CLASS}`).removeClass(COLLAPSED_DOMAIN_CLASS);
    state.removed.restore();
  });
}
