/**
 * The API change in words, for the places that hand it to a model or an
 * agent: the review's per-component context and intent check, the PR chat
 * and the MCP server. One line per endpoint change.
 */
import type { ApiChange, Endpoint, EndpointChange } from "./types";

export function endpointLabel(e: Pick<Endpoint, "kind" | "method" | "path" | "internal">): string {
  if (e.kind === "action") return `server action ${e.path} (internal)`;
  if (e.kind === "trpc") return `tRPC ${e.method.toLowerCase()} ${e.path}`;
  if (e.kind === "graphql") return `GraphQL ${e.method.toLowerCase()} ${e.path}`;
  return `${e.method} ${e.path}`;
}

/** "GET /orders/{id} — changed (breaking): response field status removed; handler code changed". */
export function describeEndpointChange(c: EndpointChange): string {
  const head = `${endpointLabel(c.endpoint)} — ${c.status}${c.breaking ? " (can break clients)" : ""}`;
  const parts: string[] = [];
  for (const d of c.deltas) {
    if (d.aspect === "handler") parts.push(d.before ? `handler moved from ${d.before} to ${d.after}` : "handler code changed");
    else if (d.before && d.after) parts.push(`${d.aspect} ${d.before} → ${d.after}${d.breaking ? " [breaking]" : ""}`);
    else if (d.after) parts.push(`${d.aspect} added ${d.after}${d.breaking ? " [breaking]" : ""}`);
    else if (d.before) parts.push(`${d.aspect} removed ${d.before}${d.breaking ? " [breaking]" : ""}`);
  }
  for (const r of (c.reaches ?? []).slice(0, 3)) parts.push(`calls changed ${r.name} (${r.status}) via ${r.path.map((p) => p.name).join(" → ")}`);
  const handler = c.endpoint.handler ? ` [handler ${c.endpoint.handler.file}:${c.endpoint.handler.startLine}]` : "";
  return `${head}${parts.length ? `: ${parts.join("; ")}` : ""}${handler}`;
}

/** The changes touching any of `paths` (handler there, or reaching changed code there). */
export function changesTouching(api: ApiChange, paths: ReadonlySet<string>): EndpointChange[] {
  return api.changes.filter((c) => (c.endpoint.handler && paths.has(c.endpoint.handler.file)) || (c.reaches ?? []).some((r) => paths.has(r.file)));
}

/** A short summary block: counts, then up to `max` lines, breaking first. */
export function describeApiChange(api: ApiChange, max = 25): string[] {
  const { added, removed, changed, reached, breaking } = api.counts;
  if (api.changes.length === 0) return [`No endpoint is touched (${api.total} in all).`];
  const lines = [`${added} added, ${removed} removed, ${changed} changed (${breaking} can break clients), ${reached} reach changed code — of ${api.total} endpoints.`];
  for (const c of api.changes.slice(0, max)) lines.push(describeEndpointChange(c));
  if (api.changes.length > max) lines.push(`(${api.changes.length - max} more)`);
  return lines;
}
