// The PR map's Functions view (DESIGN.md §6.10), as data: which function
// rows go on which card, and the calls between rows.
//
// Area cards (the PR map's own, minus docs/config/dependency cards) list the
// functions of their files that the change touches or that call / are called
// by something it touches. Functions in files outside every area — untouched
// callers and callees — go on neighbour cards, one per owning component.
//
// The reviewer can hide functions and whole cards (the eye on a row or a
// card). An untouched function that was only on the map because it calls or
// is called by something now hidden goes with it — hiding a helper the whole
// app uses takes its dozens of callers off the map too — and a card left
// with no rows disappears.
//
// Untouched functions that are on the map for one changed function only —
// the 28 pages that render a changed Topbar — are folded into one card
// ("Callers of Topbar") once there are more than {@link FOLD_ABOVE} of them,
// instead of a card per page folder. Pure, so the canvas and the inspector agree.

import type { CardFlowLink } from "./CardFlow";
import type { PrMapResponseDTO } from "./pr-map-types";
import type { CallGraphEdge, CallGraphFunction, FunctionStatus, TargetGraphData } from "./target-graph-types";

/** Rows shown per card before "+N more". */
export const MAX_FUNCTION_ROWS = 12;
/** More untouched callers (or callees) than this of one function share one card. */
export const FOLD_ABOVE = 8;

export interface FunctionCardModel {
  id: string;
  name: string;
  /** `area`: a PR map card; `neighbour`: untouched code the change calls or is called by. */
  role: "area" | "neighbour";
  functions: CallGraphFunction[];
  /** Functions of this card left off the rows by the cap. */
  hidden: number;
  /** Calls from this card's functions that name a repo function but couldn't be resolved (instance calls). */
  unresolved: number;
}

/** What the reviewer took off the map. */
export interface HiddenFunctions {
  functions: ReadonlySet<string>;
  cards: ReadonlySet<string>;
}

export const NOTHING_HIDDEN: HiddenFunctions = { functions: new Set(), cards: new Set() };

export interface FunctionView {
  cards: FunctionCardModel[];
  links: CardFlowLink[];
  /** Function id → card id, for the functions shown. */
  cardOf: Map<string, string>;
  /** Every function of the call graph, shown or not. */
  functionById: Map<string, CallGraphFunction>;
  /** Calls between the functions shown. */
  edges: CallGraphEdge[];
  /** What is off the map because the reviewer hid it, by name — for the toolbar's "Show all". */
  hiddenItems: Array<{ kind: "function" | "card"; id: string; label: string }>;
  /** Untouched functions dropped with them (only on the map because of something hidden). */
  prunedCount: number;
  /** Functions on the map, counting those behind "+N more". */
  shownCount: number;
}

const STATUS_RANK: Record<FunctionStatus, number> = { signature: 0, removed: 1, added: 2, body: 3, moved: 4, unchanged: 5 };

export function edgeId(edge: Pick<CallGraphEdge, "from" | "to">): string {
  return `${edge.from}=>${edge.to}`;
}

export function buildFunctionView(
  map: PrMapResponseDTO | null,
  data: TargetGraphData | undefined,
  hidden: HiddenFunctions = NOTHING_HIDDEN
): FunctionView | null {
  if (!map || !data) return null;
  const graph = data.callGraph;
  const functionById = new Map(graph.functions.map((f) => [f.id, f]));
  const areaOfFile = new Map<string, { id: string; name: string }>();
  for (const node of map.nodes) {
    if (node.role === "context" || node.role === "docs" || node.role === "config" || node.role === "dependency") continue;
    for (const file of node.files) if (!areaOfFile.has(file.path)) areaOfFile.set(file.path, { id: node.id, name: node.name });
  }

  // Untouched functions that only connect to one function, by that function
  // and direction; groups over the threshold share a card.
  const partners = new Map<string, Map<string, "calls" | "called">>();
  for (const e of graph.edges) {
    const from = functionById.get(e.from);
    const to = functionById.get(e.to);
    if (from?.status === "unchanged") (partners.get(e.from) ?? partners.set(e.from, new Map()).get(e.from)!).set(e.to, "calls");
    if (to?.status === "unchanged") (partners.get(e.to) ?? partners.set(e.to, new Map()).get(e.to)!).set(e.from, "called");
  }
  const foldKey = new Map<string, { key: string; name: string }>();
  const foldGroups = new Map<string, string[]>();
  for (const [id, links] of partners) {
    if (links.size !== 1 || areaOfFile.has(functionById.get(id)!.file)) continue;
    const [[anchor, direction]] = [...links];
    const key = `fold:${direction}:${anchor}`;
    (foldGroups.get(key) ?? foldGroups.set(key, []).get(key)!).push(id);
  }
  for (const [key, ids] of foldGroups) {
    if (ids.length <= FOLD_ABOVE) continue;
    const [, direction, anchor] = /^fold:(calls|called):(.*)$/.exec(key)!;
    const anchorName = functionById.get(anchor)?.qualified ?? anchor;
    const name = direction === "calls" ? `Callers of ${anchorName}` : `Called by ${anchorName}`;
    for (const id of ids) foldKey.set(id, { key, name });
  }

  /** Which card a function belongs on, whether or not it ends up shown. */
  const placeOf = (fn: CallGraphFunction): { key: string; name: string; role: FunctionCardModel["role"] } => {
    const area = areaOfFile.get(fn.file);
    if (area) return { key: area.id, name: area.name, role: "area" };
    const folded = foldKey.get(fn.id);
    if (folded) return { ...folded, role: "neighbour" };
    const component = data.fileComponents[fn.file];
    const folder = fn.file.includes("/") ? fn.file.slice(0, fn.file.lastIndexOf("/")) : "(root)";
    return { key: `fn:${component?.id ?? folder}`, name: component?.name ?? folder, role: "neighbour" };
  };
  const cardNames = new Map<string, string>();
  for (const fn of graph.functions) {
    const place = placeOf(fn);
    if (!cardNames.has(place.key)) cardNames.set(place.key, place.name);
  }

  // --- what stays on the map ----------------------------------------------
  const visible = new Set(
    graph.functions
      .filter((fn) => !hidden.functions.has(fn.id) && !hidden.cards.has(placeOf(fn).key))
      .map((fn) => fn.id)
  );
  const reviewerHidden = graph.functions.length - visible.size;
  if (reviewerHidden > 0) {
    // An untouched function is only here for its calls: once none of them
    // reaches anything still shown, it goes too. Repeat until nothing changes.
    for (let changed = true; changed; ) {
      changed = false;
      const connected = new Set<string>();
      for (const e of graph.edges) {
        if (visible.has(e.from) && visible.has(e.to)) {
          connected.add(e.from);
          connected.add(e.to);
        }
      }
      for (const id of [...visible]) {
        if (functionById.get(id)!.status === "unchanged" && !connected.has(id)) {
          visible.delete(id);
          changed = true;
        }
      }
    }
  }
  const prunedCount = graph.functions.length - visible.size - reviewerHidden;

  const groups = new Map<string, { name: string; role: FunctionCardModel["role"]; functions: CallGraphFunction[] }>();
  for (const fn of graph.functions) {
    if (!visible.has(fn.id)) continue;
    const place = placeOf(fn);
    const group = groups.get(place.key) ?? { name: place.name, role: place.role, functions: [] };
    group.functions.push(fn);
    groups.set(place.key, group);
  }

  const shownEdges = graph.edges.filter((e) => visible.has(e.from) && visible.has(e.to));
  const degree = new Map<string, number>();
  for (const e of shownEdges) for (const end of [e.from, e.to]) degree.set(end, (degree.get(end) ?? 0) + 1);

  const cards: FunctionCardModel[] = [];
  const cardOf = new Map<string, string>();
  for (const [id, group] of groups) {
    const sorted = group.functions.sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
        a.file.localeCompare(b.file) ||
        a.startLine - b.startLine
    );
    const shown = sorted.slice(0, MAX_FUNCTION_ROWS);
    for (const fn of shown) cardOf.set(fn.id, id);
    cards.push({
      id,
      name: group.name,
      role: group.role,
      functions: shown,
      hidden: sorted.length - shown.length,
      unresolved: group.functions.reduce((n, f) => n + f.unresolvedCalls, 0),
    });
  }
  // Areas first, in the PR map's order; then neighbours by name.
  const order = new Map(map.nodes.map((n, i) => [n.id, i]));
  cards.sort(
    (a, b) =>
      Number(a.role === "neighbour") - Number(b.role === "neighbour") ||
      (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) ||
      a.name.localeCompare(b.name)
  );

  const links: CardFlowLink[] = [];
  for (const edge of shownEdges) {
    const source = cardOf.get(edge.from);
    const target = cardOf.get(edge.to);
    if (!source || !target) continue;
    links.push({
      id: edgeId(edge),
      source,
      target,
      sourcePort: edge.from,
      targetPort: edge.to,
      label: "",
      weight: 1,
      ...(edge.notUpdated ? { tone: "broken" as const } : edge.status === "new" ? { tone: "new" as const } : edge.status === "removed" ? { tone: "removed" as const } : {}),
    });
  }

  const hiddenItems: FunctionView["hiddenItems"] = [
    ...[...hidden.cards].filter((id) => cardNames.has(id)).map((id) => ({ kind: "card" as const, id, label: cardNames.get(id)! })),
    ...[...hidden.functions]
      .filter((id) => functionById.has(id))
      .map((id) => ({ kind: "function" as const, id, label: functionById.get(id)!.qualified })),
  ];

  return { cards, links, cardOf, functionById, edges: shownEdges, hiddenItems, prunedCount, shownCount: visible.size };
}

/** The links lit when a function is selected: its calls in and out. */
export function activeLinksFor(view: FunctionView, functionId: string | null): Set<string> | undefined {
  if (!functionId) return undefined;
  return new Set(view.edges.filter((e) => e.from === functionId || e.to === functionId).map(edgeId));
}
