// One object for every place the API shows (DESIGN.md §6.11): the API view's
// list and explainer, the left column's API section, the PR map's area cards
// and inspector, and the Endpoints mode. Rows are the analysed commit's
// catalog with the selected change laid over it — added and changed
// endpoints as they are at the head, removed ones kept and marked.

import type { ApiCatalogResponseDTO, ApiChange, EndpointChange, ServedEndpoint } from "./api-types";
import type { PrMapResponseDTO } from "./pr-map-types";

export interface ApiRow {
  endpoint: ServedEndpoint;
  change?: EndpointChange;
}

export function buildApiRows(catalog: ApiCatalogResponseDTO | null, api: ApiChange | undefined): ApiRow[] {
  const rows = new Map<string, ApiRow>();
  for (const endpoint of catalog?.endpoints ?? []) rows.set(endpoint.id, { endpoint });
  for (const change of api?.changes ?? []) {
    const existing = rows.get(change.id);
    // The catalog's copy carries inferred shapes; the change's is the head as compared.
    const endpoint = existing && change.status !== "removed" && change.status !== "added" ? { ...change.endpoint, ...pickInferred(existing.endpoint) } : change.endpoint;
    rows.set(change.id, { endpoint, change });
    if (change.before && change.before.id !== change.id) rows.delete(change.before.id);
  }
  return [...rows.values()];
}

function pickInferred(e: ServedEndpoint): Partial<ServedEndpoint> {
  if (!e.inferred) return {};
  return {
    inferred: true,
    ...(e.summary ? { summary: e.summary } : {}),
    ...(e.request?.source === "ai" ? { request: e.request } : {}),
    ...(e.response?.source === "ai" ? { response: e.response } : {}),
  };
}

export const KIND_LABELS: Record<ServedEndpoint["kind"], string> = {
  http: "HTTP",
  action: "Server action",
  trpc: "tRPC",
  graphql: "GraphQL",
};

/** Method badge colours: reads first, writes warm, deletes red. Literal hues tuned for both themes. */
export function methodTone(method: string): string {
  switch (method) {
    case "GET":
    case "QUERY":
      return "text-info";
    case "POST":
    case "MUTATION":
      return "text-success";
    case "PUT":
    case "PATCH":
      return "text-warning";
    case "DELETE":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

export const CHANGE_STYLES: Record<EndpointChange["status"], { word: string; className: string; title: string }> = {
  added: { word: "new", className: "text-success", title: "This change adds the endpoint" },
  removed: { word: "removed", className: "text-destructive", title: "This change removes the endpoint" },
  changed: { word: "changed", className: "text-warning", title: "Its path, inputs, outputs, auth or handler code changed" },
  reached: { word: "reached", className: "text-info", title: "Its handler didn't change, but it calls code that did" },
};

/** The PR map area (card) holding a file, if any. */
function areaOfFile(map: PrMapResponseDTO, file: string): string | undefined {
  return map.nodes.find((n) => n.role !== "context" && n.files.some((f) => f.path === file))?.id;
}

/** Areas an endpoint change lands in: its handler's, and those holding the changed code it reaches. */
export function areasOfChange(map: PrMapResponseDTO, change: EndpointChange): Array<{ areaId: string; via: "handler" | "reach"; fn?: string }> {
  const out: Array<{ areaId: string; via: "handler" | "reach"; fn?: string }> = [];
  const handlerFile = change.endpoint.handler?.file;
  const handlerArea = handlerFile ? areaOfFile(map, handlerFile) : undefined;
  if (handlerArea && change.status !== "reached") out.push({ areaId: handlerArea, via: "handler" });
  for (const r of change.reaches ?? []) {
    const area = areaOfFile(map, r.file);
    if (area && !out.some((o) => o.areaId === area)) out.push({ areaId: area, via: "reach", fn: r.name });
  }
  return out;
}

/** Each area's endpoint changes. */
export function apiChangesByArea(map: PrMapResponseDTO | null, api: ApiChange | undefined): Map<string, EndpointChange[]> {
  const out = new Map<string, EndpointChange[]>();
  if (!map || !api) return out;
  for (const change of api.changes) {
    for (const { areaId } of areasOfChange(map, change)) {
      const list = out.get(areaId) ?? [];
      list.push(change);
      out.set(areaId, list);
    }
  }
  return out;
}

/** `/orders/{id}` with its parameters picked out, for rendering. */
export function pathParts(path: string): Array<{ text: string; param: boolean }> {
  const parts: Array<{ text: string; param: boolean }> = [];
  let last = 0;
  for (const m of path.matchAll(/\{[^}]*\}/g)) {
    if (m.index! > last) parts.push({ text: path.slice(last, m.index), param: false });
    parts.push({ text: m[0], param: true });
    last = m.index! + m[0].length;
  }
  if (last < path.length) parts.push({ text: path.slice(last), param: false });
  return parts;
}
