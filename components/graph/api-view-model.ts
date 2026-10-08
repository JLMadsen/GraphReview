// One object for the places the API shows (DESIGN.md §6.11): the API view's
// list and explainer and the left column's API section. Rows are the
// analysed commit's catalog with the selected diff's API changes laid over
// it — added and changed endpoints as they are at the head, removed ones
// kept and marked. Only changes to the API itself: code changed behind an
// unchanged endpoint isn't shown here.

import type { ApiCatalogResponseDTO, ApiChange, EndpointChange, ServedEndpoint } from "./api-types";

export interface ApiRow {
  endpoint: ServedEndpoint;
  change?: EndpointChange;
}

export function buildApiRows(catalog: ApiCatalogResponseDTO | null, api: ApiChange | undefined): ApiRow[] {
  const rows = new Map<string, ApiRow>();
  for (const endpoint of catalog?.endpoints ?? []) rows.set(endpoint.id, { endpoint });
  // Results stored before logic changes were split off can still say "reached".
  for (const change of (api?.changes ?? []).filter((c) => c.status in CHANGE_STYLES)) {
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
  changed: { word: "changed", className: "text-warning", title: "Its path, method, parameters, request or response shape, or auth changed" },
};

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
