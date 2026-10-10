// Wire shapes for the API view (DESIGN.md §6.11):
//   GET  /api/repos/[repoId]/api-catalog         the analysed commit's endpoints
//   POST /api/repos/[repoId]/api-catalog/infer   ✦ infer one endpoint's shapes
// The PR's API change rides on the target graph (target-graph-types.ts).
// Type-only imports: nothing server-side reaches the client bundle.

import type {
  ApiCatalog,
  ApiChange,
  ApiField,
  ApiHandler,
  ApiParam,
  ApiShape,
  Endpoint,
  EndpointChange,
  EndpointChangeStatus,
  EndpointDelta,
  EndpointKind,
  ReachStep,
} from "@/lib/analysis/api/types";

export type { ApiCatalog, ApiChange, ApiField, ApiHandler, ApiParam, ApiShape, EndpointChange, EndpointChangeStatus, EndpointDelta, EndpointKind, ReachStep };

/** An endpoint as served: with a model's guess (✦) filled in where the code said nothing. */
export type ServedEndpoint = Endpoint & { summary?: string; inferred?: boolean };

export interface ApiCatalogResponseDTO {
  /** `none`: the repo hasn't been analysed by a version that builds the catalog yet. */
  state: "ready" | "none";
  sha?: string;
  computedAt?: string;
  endpoints: ServedEndpoint[];
  specs: string[];
  frameworks: string[];
  unresolvedMounts: number;
  /** An AI provider is set up, so ✦ Infer can run. */
  aiConfigured: boolean;
}

export interface ApiInferResponseDTO {
  endpoint: ServedEndpoint;
}

/** A shape a model could still add to (mirrors shapeIncomplete in lib/analysis/api/types.ts). */
export function shapeIncomplete(shape: ApiShape | undefined): boolean {
  if (!shape) return true;
  if (shape.opaque) return false;
  if (!shape.fields?.length) return true;
  return shape.source === "code" && shape.fields.some((f) => f.type === "unknown");
}

/** Whether an endpoint takes a body at all, as far as its method says (mirrors takesBody). */
export function takesBody(e: Pick<Endpoint, "kind" | "method">): boolean {
  return e.kind !== "http" || /^(POST|PUT|PATCH|ANY)$/.test(e.method);
}

/** A proxy with no auth in front of it that forwards to a URL the caller picks — anyone can make the server fetch anything. */
export function openProxy(e: Pick<Endpoint, "proxy" | "auth">, gatewayAuth?: string[]): boolean {
  return Boolean(e.proxy && !e.proxy.upstream && e.auth.length === 0 && !gatewayAuth?.length);
}

/** `lib/x.ts#Repo.save` → file and name (mirrors lib/analysis/api/types.ts, which the client can't import values from). */
export function splitDeclId(id: string): { file: string; name: string } {
  const at = id.lastIndexOf("#");
  return at === -1 ? { file: id, name: id } : { file: id.slice(0, at), name: id.slice(at + 1) || "(top level)" };
}
