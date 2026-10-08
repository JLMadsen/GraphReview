/**
 * The endpoint catalog of one analysed tree (DESIGN.md §6.11): every
 * framework resolver's endpoints, merged with the repo's OpenAPI documents
 * (descriptions and schemas in, drift out), each with the functions its
 * handler reaches.
 *
 * Static analysis only — no model. A resolver that throws costs its own
 * endpoints, never the analysis.
 */
import type { FileAnalysis } from "../ir";
import type { SymbolGraph } from "../symbols";
import { buildContext, groupOfPath, indexCalls, pathKey, pathParams, reachOf, type ApiContext, type PartialEndpoint } from "./context";
import { resolveDecorated } from "./decorated";
import { resolveFileRoutes } from "./file-routes";
import { resolveNext } from "./next";
import { resolveNodeRouters } from "./node-routers";
import { resolvePython } from "./python";
import { resolveGraphql, resolveTrpc } from "./rpc";
import { readSpecs, specKeys, type SpecOperation } from "./spec";
import type { ApiCatalog, Endpoint } from "./types";

export interface BuildApiCatalogInput {
  files: readonly FileAnalysis[];
  symbols: SymbolGraph;
  /** Every path in the tree, non-code files included (specs, `.graphql`, next.config). */
  allFiles: ReadonlySet<string>;
  readText: (relPath: string) => Promise<string | null>;
}

/** A resource with more endpoints than this is listed by sub-resource. */
const GROUP_SPLIT_AT = 12;
const KIND_ORDER = { http: 0, trpc: 1, graphql: 2, action: 3 } as const;
const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE", "ANY", "HEAD", "OPTIONS", "WS", "QUERY", "MUTATION", "SUBSCRIPTION"];

/** The id an endpoint keeps across commits (see {@link Endpoint.id}). */
export function endpointId(e: Pick<Endpoint, "kind" | "method" | "path" | "handler">): string {
  switch (e.kind) {
    case "http":
      return `http ${e.method} ${pathKey(e.path)}`;
    case "action":
      return `action ${e.handler?.file ?? ""}#${e.path}`;
    case "trpc":
      return `trpc ${e.path}`;
    case "graphql":
      return `graphql ${e.method} ${e.path}`;
  }
}

/**
 * Two finds of one endpoint: the same handler registered twice, a GraphQL
 * field from the schema and from its resolver, or a handler only one of
 * them could pin down.
 */
function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  if (a.kind === "graphql") return true;
  if (!a.handler || !b.handler) return true;
  if (a.handler.file === b.handler.file && a.handler.name === b.handler.name) return true;
  return a.framework === b.framework && a.handler.file.split("/")[0] === b.handler.file.split("/")[0];
}

async function run<T>(name: string, fn: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[api] ${name} failed: ${(error as Error).message}`);
    return fallback;
  }
}

/** Fill what the code didn't say from the spec; the code wins where both speak. */
function mergeSpec(e: Endpoint, op: SpecOperation): void {
  e.spec = {
    file: op.file,
    ...(op.summary ? { summary: op.summary } : {}),
    ...(op.description ? { description: op.description } : {}),
    ...(op.operationId ? { operationId: op.operationId } : {}),
    ...(op.tags?.length ? { tags: op.tags } : {}),
  };
  if (!e.request?.fields && op.request) e.request = op.request;
  if (!e.response?.fields && op.response) e.response = op.response;
  for (const p of op.params) {
    const own = e.params.find((x) => x.name === p.name && x.in === p.in);
    if (!own) e.params.push(p);
    else if (!own.type && p.type) own.type = p.type;
  }
}

export async function buildApiCatalog(input: BuildApiCatalogInput): Promise<ApiCatalog> {
  const ctx: ApiContext = buildContext(input.files, input.symbols, input.allFiles, input.readText);
  const partials: PartialEndpoint[] = [
    ...(await run("Next.js", () => resolveNext(ctx), [])),
    ...(await run("file routes", () => resolveFileRoutes(ctx), [])),
    ...(await run("Node routers", () => resolveNodeRouters(ctx), [])),
    ...(await run("decorators", () => resolveDecorated(ctx), [])),
    ...(await run("Python", () => resolvePython(ctx), [])),
    ...(await run("tRPC", () => resolveTrpc(ctx), [])),
    ...(await run("GraphQL", () => resolveGraphql(ctx), [])),
  ];

  // Ids, groups, path parameters; one endpoint per id (a second registration
  // of the same route keeps the first, an SDL field keeps its code-first resolver).
  const byId = new Map<string, Endpoint>();
  for (const p of partials) {
    const params = [...p.params];
    if (p.kind === "http") for (const name of pathParams(p.path)) if (!params.some((x) => x.name === name && x.in === "path")) params.push({ name, in: "path", required: true });
    const endpoint: Endpoint = { ...p, params, group: p.group ?? (p.kind === "http" ? groupOfPath(p.path) : p.path.split(".")[0]), id: "", reach: [] };
    endpoint.id = endpointId(endpoint);
    let existing = byId.get(endpoint.id);
    // Two services of a monorepo can serve the same route: keep both, the
    // second under its framework (or its folder) so its id stays stable.
    if (existing && !sameEndpoint(existing, endpoint)) {
      const top = endpoint.handler?.file.split("/")[0] ?? "";
      endpoint.id = `${endpoint.id} @${existing.framework !== endpoint.framework ? endpoint.framework : top}`;
      existing = byId.get(endpoint.id);
      if (existing && !sameEndpoint(existing, endpoint)) endpoint.id = `${endpoint.id} @${endpoint.handler?.file ?? partials.indexOf(p)}`;
      existing = byId.get(endpoint.id);
    }
    if (!existing) {
      byId.set(endpoint.id, endpoint);
      continue;
    }
    // Prefer a handler that is a real declaration; keep shapes either one has.
    const better = !existing.handler?.declId && endpoint.handler?.declId ? endpoint : existing;
    const other = better === existing ? endpoint : existing;
    better.request ??= other.request;
    better.response ??= other.response;
    if (better.params.length === 0) better.params = other.params;
    better.auth = [...new Set([...better.auth, ...other.auth])];
    byId.set(endpoint.id, better);
  }
  const endpoints = [...byId.values()];
  // A large resource splits into its sub-resources (`repos › branches`); a small one stays whole.
  const resourceSize = new Map<string, number>();
  for (const e of endpoints) if (e.kind === "http") resourceSize.set(groupOfPath(e.path, false), (resourceSize.get(groupOfPath(e.path, false)) ?? 0) + 1);
  for (const e of endpoints) {
    if (e.kind !== "http" || !e.group.includes(" › ")) continue;
    const top = groupOfPath(e.path, false);
    if ((resourceSize.get(top) ?? 0) <= GROUP_SPLIT_AT) e.group = top;
  }

  // OpenAPI documents: enrich and compare.
  const specs = await run("OpenAPI", () => readSpecs(ctx), { files: [], operations: [] });
  if (specs.operations.length > 0) {
    const opsByKey = new Map<string, SpecOperation>();
    for (const op of specs.operations) for (const key of specKeys(op)) if (!opsByKey.has(key)) opsByKey.set(key, op);
    const used = new Set<SpecOperation>();
    for (const e of endpoints) {
      if (e.kind !== "http" || e.internal) continue;
      const methods = e.method === "ANY" ? ["GET", "POST", "PUT", "PATCH", "DELETE"] : [e.method];
      const key = pathKey(e.path);
      const matches = methods.map((m) => opsByKey.get(`${m} ${key}`)).filter((op): op is SpecOperation => Boolean(op));
      if (matches.length > 0) {
        mergeSpec(e, matches[0]);
        for (const op of matches) used.add(op);
      } else if (!e.partial) {
        e.drift = "code-only";
      }
    }
    for (const op of specs.operations) {
      if (used.has(op)) continue;
      // A spec that lists the path without its base matches the code under the base; only list it once.
      const e: Endpoint = {
        id: "",
        kind: "http",
        method: op.method,
        path: op.fullPath,
        framework: "OpenAPI",
        group: op.tags?.[0] ?? groupOfPath(op.fullPath),
        params: op.params,
        ...(op.request ? { request: op.request } : {}),
        ...(op.response ? { response: op.response } : {}),
        auth: [],
        drift: "spec-only",
        reach: [],
      };
      e.id = endpointId(e);
      if (byId.has(e.id)) continue;
      byId.set(e.id, e);
      mergeSpec(e, op);
      endpoints.push(e);
    }
  }

  const calls = indexCalls(input.symbols);
  for (const e of endpoints) {
    if (!e.handler) continue;
    const { steps, truncated } = reachOf(ctx, calls, e.handler);
    e.reach = steps;
    if (truncated) e.reachTruncated = true;
  }

  endpoints.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.group.localeCompare(b.group) ||
      a.path.localeCompare(b.path) ||
      METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
  );
  return {
    endpoints,
    specs: specs.files,
    frameworks: [...new Set(endpoints.map((e) => e.framework))].sort(),
    unresolvedMounts: ctx.unresolvedMounts,
  };
}
