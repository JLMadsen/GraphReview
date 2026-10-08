// The PR map's Functions view (DESIGN.md §6.10), as data: which function
// rows go on which card, and the calls between rows.
//
// Area cards (the PR map's own, minus docs/config/dependency cards) list the
// functions of their files that the change touches or that call / are called
// by something it touches. Functions in files outside every area — untouched
// callers and callees — go on neighbour cards, one per owning component.
// Pure, so the canvas and the inspector agree.

import type { CardFlowLink } from "./CardFlow";
import type { PrMapResponseDTO } from "./pr-map-types";
import type { CallGraphEdge, CallGraphFunction, FunctionStatus, TargetGraphData } from "./target-graph-types";

/** Rows shown per card before "+N more". */
export const MAX_FUNCTION_ROWS = 12;

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

export interface FunctionView {
  cards: FunctionCardModel[];
  links: CardFlowLink[];
  /** Function id → card id, for the functions shown. */
  cardOf: Map<string, string>;
  functionById: Map<string, CallGraphFunction>;
  edges: CallGraphEdge[];
}

const STATUS_RANK: Record<FunctionStatus, number> = { signature: 0, removed: 1, added: 2, body: 3, unchanged: 4 };

export function edgeId(edge: Pick<CallGraphEdge, "from" | "to">): string {
  return `${edge.from}=>${edge.to}`;
}

export function buildFunctionView(map: PrMapResponseDTO | null, data: TargetGraphData | undefined): FunctionView | null {
  if (!map || !data) return null;
  const graph = data.callGraph;
  const functionById = new Map(graph.functions.map((f) => [f.id, f]));
  const areaOfFile = new Map<string, { id: string; name: string }>();
  for (const node of map.nodes) {
    if (node.role === "context" || node.role === "docs" || node.role === "config" || node.role === "dependency") continue;
    for (const file of node.files) if (!areaOfFile.has(file.path)) areaOfFile.set(file.path, { id: node.id, name: node.name });
  }

  const groups = new Map<string, { name: string; role: FunctionCardModel["role"]; functions: CallGraphFunction[] }>();
  for (const fn of graph.functions) {
    const area = areaOfFile.get(fn.file);
    let key: string;
    let name: string;
    let role: FunctionCardModel["role"];
    if (area) {
      key = area.id;
      name = area.name;
      role = "area";
    } else {
      const component = data.fileComponents[fn.file];
      const folder = fn.file.includes("/") ? fn.file.slice(0, fn.file.lastIndexOf("/")) : "(root)";
      key = `fn:${component?.id ?? folder}`;
      name = component?.name ?? folder;
      role = "neighbour";
    }
    const group = groups.get(key) ?? { name, role, functions: [] };
    group.functions.push(fn);
    groups.set(key, group);
  }

  const degree = new Map<string, number>();
  for (const e of graph.edges) for (const end of [e.from, e.to]) degree.set(end, (degree.get(end) ?? 0) + 1);

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
  for (const edge of graph.edges) {
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
  return { cards, links, cardOf, functionById, edges: graph.edges };
}

/** The links lit when a function is selected: its calls in and out. */
export function activeLinksFor(view: FunctionView, functionId: string | null): Set<string> | undefined {
  if (!functionId) return undefined;
  return new Set(view.edges.filter((e) => e.from === functionId || e.to === functionId).map(edgeId));
}
