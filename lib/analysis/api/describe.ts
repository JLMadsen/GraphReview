/**
 * The API change in words, for the places that hand it to a model or an
 * agent: the review's per-component context and intent check, the PR chat
 * and the MCP server. One line per endpoint. API changes (the contract a
 * client sees) and logic changes (code behind an unchanged endpoint) are
 * always kept apart.
 */
import type { ApiChange, Endpoint, EndpointChange, EndpointLogicChange } from "./types";

export function endpointLabel(e: Pick<Endpoint, "kind" | "method" | "path" | "internal">): string {
  if (e.kind === "action") return `server action ${e.path} (internal)`;
  if (e.kind === "trpc") return `tRPC ${e.method.toLowerCase()} ${e.path}`;
  if (e.kind === "graphql") return `GraphQL ${e.method.toLowerCase()} ${e.path}`;
  return `${e.method} ${e.path}`;
}

/** "GET /orders/{id} — changed (can break clients): response removed status: string". */
export function describeEndpointChange(c: EndpointChange): string {
  const head = `${endpointLabel(c.endpoint)} — ${c.status}${c.breaking ? " (can break clients)" : ""}`;
  const parts: string[] = [];
  for (const d of c.deltas) {
    if (d.before && d.after) parts.push(`${d.aspect} ${d.before} → ${d.after}${d.breaking ? " [breaking]" : ""}`);
    else if (d.after) parts.push(`${d.aspect} added ${d.after}${d.breaking ? " [breaking]" : ""}`);
    else if (d.before) parts.push(`${d.aspect} removed ${d.before}${d.breaking ? " [breaking]" : ""}`);
  }
  const handler = c.endpoint.handler ? ` [handler ${c.endpoint.handler.file}:${c.endpoint.handler.startLine}]` : "";
  return `${head}${parts.length ? `: ${parts.join("; ")}` : ""}${handler}`;
}

/** "GET /orders/{id} — same contract, handler code changed; calls changed save via load → save". */
export function describeLogicChange(l: EndpointLogicChange): string {
  const parts: string[] = [];
  if (l.handlerChanged) parts.push("handler code changed");
  for (const r of l.reaches.slice(0, 3)) parts.push(`calls changed ${r.name} (${r.status}) via ${r.path.map((p) => p.name).join(" → ")}`);
  const handler = l.endpoint.handler ? ` [handler ${l.endpoint.handler.file}:${l.endpoint.handler.startLine}]` : "";
  return `${endpointLabel(l.endpoint)} — same contract, ${parts.join("; ")}${handler}`;
}

/** The changes touching any of `paths`: the endpoint's handler is there. */
export function changesTouching(api: ApiChange, paths: ReadonlySet<string>): EndpointChange[] {
  return api.changes.filter((c) => c.endpoint.handler && paths.has(c.endpoint.handler.file));
}

/** The logic changes touching any of `paths`: the handler, or changed code it calls, is there. */
export function logicTouching(api: ApiChange, paths: ReadonlySet<string>): EndpointLogicChange[] {
  return (api.logic ?? []).filter((l) => (l.handlerChanged && l.endpoint.handler && paths.has(l.endpoint.handler.file)) || l.reaches.some((r) => paths.has(r.file)));
}

/** One summary line: "1 added, 0 removed, 2 changed (1 can break clients) — of 51 endpoints". */
export function apiChangeSummary(api: ApiChange): string {
  const { added, removed, changed, breaking } = api.counts;
  if (api.changes.length === 0) return `No API change (${api.total} endpoints).`;
  return `${added} added, ${removed} removed, ${changed} changed (${breaking} can break clients) — of ${api.total} endpoints.`;
}

/** The API changes, breaking first, then (separately labelled) a few endpoints whose logic changed. */
export function describeApiChange(api: ApiChange, max = 25, maxLogic = 10): string[] {
  const lines = [apiChangeSummary(api)];
  for (const c of api.changes.slice(0, max)) lines.push(describeEndpointChange(c));
  if (api.changes.length > max) lines.push(`(${api.changes.length - max} more API changes)`);
  const logic = api.logic ?? [];
  if (maxLogic > 0 && logic.length > 0) {
    lines.push(`Not API changes, but the code behind ${logic.length} endpoint(s) changed:`);
    for (const l of logic.slice(0, maxLogic)) lines.push(describeLogicChange(l));
    if (logic.length > maxLogic) lines.push(`(${logic.length - maxLogic} more)`);
  }
  return lines;
}
