/**
 * The endpoint catalog: every API a commit exposes, as found by static
 * analysis (DESIGN.md §6.11). Pure data — built by ./catalog.ts, compared
 * by ./compare.ts, stored as JSON and sent to the browser as-is.
 */

/**
 * - `http`    an HTTP route (Next.js route handler, Express, FastAPI, Spring, …)
 * - `action`  a Next.js server action — callable over the network, but made
 *             for the app's own pages (internal, a BFF), never a public API
 * - `trpc`    a tRPC procedure (`user.byId`)
 * - `graphql` a field of Query / Mutation / Subscription
 */
export type EndpointKind = "http" | "action" | "trpc" | "graphql";

export type ParamLocation = "path" | "query" | "body" | "header" | "cookie" | "form" | "input" | "arg";

export interface ApiParam {
  name: string;
  in: ParamLocation;
  /** As written in the code or the spec. */
  type?: string;
  required?: boolean;
}

export interface ApiField {
  name: string;
  type: string;
  required: boolean;
}

/**
 * A request or response body. `type` is what the code names it (`CreateOrder`,
 * `z.object({…})`); `fields` are its fields when they could be read.
 */
export interface ApiShape {
  type?: string;
  fields?: ApiField[];
  /** Where it came from: the code's types, the OpenAPI spec, or a model's guess (✦). */
  source: "static" | "spec" | "ai";
}

/** The code that answers the endpoint. */
export interface ApiHandler {
  file: string;
  /** Lines the handler occupies (an inline arrow function is its own range). */
  startLine: number;
  endLine: number;
  /** A name to show: the function, method or `(inline)`. */
  name: string;
  /** The declaration id (`<file>#<name>`) when the handler is a whole declaration. */
  declId?: string;
  /** Fingerprint of the handler's text — the cache key for an inferred shape. */
  hash?: string;
}

/** One function the handler reaches through resolved calls. Its file and name are in its id ({@link splitDeclId}). */
export interface ReachStep {
  id: string;
  line: number;
  /** 1 = called by the handler itself. */
  depth: number;
  /** The step it was reached from (`undefined` at depth 1). */
  via?: string;
  /** Looks like data access (a db / repository / model / store file). */
  data?: true;
}

export interface Endpoint {
  /**
   * Stable across commits: kind, method and path with parameter names
   * erased (`http GET /orders/{}`), or the action's declaration. An
   * endpoint that keeps its id between base and head is "the same one".
   */
  id: string;
  kind: EndpointKind;
  /** `GET`… for HTTP, `ANY` when the code doesn't say; `QUERY` / `MUTATION` / `SUBSCRIPTION` for tRPC and GraphQL; `POST` for actions. */
  method: string;
  /** `/orders/{id}`; `user.byId` (tRPC); `createOrder` (GraphQL); the function name (action). */
  path: string;
  /** Part of the path couldn't be read statically: holes show as `{expr}`, an unknown mount prefix as `…`. */
  partial?: true;
  /** `Next.js`, `Express`, `FastAPI`, `Spring`, `tRPC`, `GraphQL`, `OpenAPI`, … */
  framework: string;
  /** Resource the list groups it under: the first path segment, the router or the controller. */
  group: string;
  /** Absent only for an endpoint the OpenAPI spec lists that no code was found for. */
  handler?: ApiHandler;
  /** Where the route is registered, when that's not the handler itself (`router.get(…)` naming a function). */
  registeredAt?: { file: string; line: number };
  params: ApiParam[];
  request?: ApiShape;
  response?: ApiShape;
  /**
   * Middleware, guards and dependencies in front of the handler, as far as
   * they are visible statically. Never a claim that there is none: the UI
   * shows `?` when this is empty.
   */
  auth: string[];
  /** Server actions: made for the app's own pages, not third parties. */
  internal?: true;
  /** What the OpenAPI spec says about it, when one describes it. */
  spec?: { file: string; summary?: string; description?: string; operationId?: string; tags?: string[] };
  /** The code and the spec disagree: only one of them has it. */
  drift?: "code-only" | "spec-only";
  /** Files that call the server action (`action` only, at most 10). */
  callers?: string[];
  /** Functions the handler reaches, breadth first (at most {@link MAX_REACH_STEPS}). */
  reach: ReachStep[];
  /** More functions are reached than `reach` lists. */
  reachTruncated?: true;
}

export interface ApiCatalog {
  endpoints: Endpoint[];
  /** OpenAPI / Swagger files read. */
  specs: string[];
  /** Frameworks seen, for the empty state and the toolbar. */
  frameworks: string[];
  /** Routers mounted somewhere the analysis couldn't follow (their paths carry `…`). */
  unresolvedMounts: number;
}

export const MAX_REACH_STEPS = 50;

/** `lib/db/x.ts#Repo.save` → its file and qualified name. */
export function splitDeclId(id: string): { file: string; name: string } {
  const at = id.lastIndexOf("#");
  return at === -1 ? { file: id, name: id } : { file: id.slice(0, at), name: id.slice(at + 1) || "(top level)" };
}
export const MAX_REACH_DEPTH = 8;

// ---------------------------------------------------------------------------
// A review target's API change (./compare.ts)
// ---------------------------------------------------------------------------

/**
 * A change to the API itself — what a client sees: an endpoint added or
 * removed, or its path, method, parameters, request or response shape or
 * auth changed. Code changes behind an unchanged endpoint are not API
 * changes; they are {@link EndpointLogicChange}s.
 */
export type EndpointChangeStatus = "added" | "removed" | "changed";

/** One aspect of an endpoint's contract that differs between base and head. */
export interface EndpointDelta {
  aspect: "path" | "method" | "params" | "request" | "response" | "auth";
  before?: string;
  after?: string;
  /** A client written against the base can break (a removed field, a new required param, …). */
  breaking?: true;
}

export interface EndpointChange {
  /** Head id; base id for a removed endpoint. */
  id: string;
  status: EndpointChangeStatus;
  /** The endpoint as it is at the head (at the base when removed). */
  endpoint: Endpoint;
  /** For `changed`: the base version. */
  before?: Endpoint;
  deltas: EndpointDelta[];
  /** Any delta (or the removal) can break an existing client. */
  breaking?: true;
}

/** A changed function an endpoint's handler calls, with the call path from the handler. */
export interface EndpointReach {
  id: string;
  name: string;
  file: string;
  status: string;
  path: Array<{ id: string; name: string; file: string }>;
}

/**
 * Behaviour that may have changed behind an endpoint, without its contract
 * changing: its handler's code changed, or the handler calls code that did.
 * Not shown as an API change; handed to the AI review, the chat and agents
 * as context.
 */
export interface EndpointLogicChange {
  id: string;
  endpoint: Endpoint;
  /** The handler's own lines changed. */
  handlerChanged: boolean;
  /** Changed functions the handler calls (at most a few), each with its call path. */
  reaches: EndpointReach[];
}

export interface ApiChange {
  /** Changes to the API itself. */
  changes: EndpointChange[];
  /** Endpoints at the base and head whose code behind them changed. */
  logic: EndpointLogicChange[];
  counts: { added: number; removed: number; changed: number; breaking: number; logic: number };
  /** Endpoints at the head — for "N of M endpoints". */
  total: number;
  /** The reach search stopped early on a very large graph. */
  reachCapped?: true;
}

export const MAX_API_REACH_HOPS = 8;
export const MAX_API_REACH_FUNCTIONS = 2000;
