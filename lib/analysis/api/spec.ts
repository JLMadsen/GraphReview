/**
 * OpenAPI 3 / Swagger 2 documents in the repo (`openapi.yaml`,
 * `swagger.json`, `docs/api/openapi.yml`, …): their operations, with
 * summaries, parameters and request/response schemas, to enrich the
 * endpoints found in code and to tell where the two disagree.
 */
import { load } from "js-yaml";
import { normalizePath, pathKey, type ApiContext } from "./context";
import type { ApiField, ApiParam, ApiShape } from "./types";

const SPEC_FILE = /(^|\/)([\w.-]*\.)?(openapi|swagger|api-docs?)([\w.-]*)?\.(ya?ml|json)$/i;
const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|\.next|target|out)\//;
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const MAX_SPEC_BYTES = 5_000_000;

export interface SpecOperation {
  file: string;
  method: string;
  /** Path as the spec writes it, normalized (`/orders/{id}`). */
  path: string;
  /** The same path under the spec's server / base path, when it has one. */
  fullPath: string;
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  params: ApiParam[];
  request?: ApiShape;
  response?: ApiShape;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function deref(doc: Json, value: unknown, depth = 0): unknown {
  if (!isObj(value) || typeof value.$ref !== "string" || depth > 5) return value;
  const ref = value.$ref;
  if (!ref.startsWith("#/")) return value;
  let cursor: unknown = doc;
  for (const part of ref.slice(2).split("/")) cursor = isObj(cursor) ? cursor[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  return deref(doc, cursor, depth + 1);
}

function refName(value: unknown): string | undefined {
  return isObj(value) && typeof value.$ref === "string" ? value.$ref.split("/").pop() : undefined;
}

function schemaType(doc: Json, schema: unknown): string {
  const name = refName(schema);
  if (name) return name;
  const s = deref(doc, schema);
  if (!isObj(s)) return "unknown";
  if (s.type === "array") return `${schemaType(doc, s.items)}[]`;
  if (typeof s.type === "string") return s.format ? `${s.type} (${s.format})` : s.type;
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) return ((s.oneOf ?? s.anyOf) as unknown[]).map((x) => schemaType(doc, x)).join(" | ");
  if (Array.isArray(s.allOf)) return ((s.allOf as unknown[]).map((x) => schemaType(doc, x))).join(" & ");
  return s.properties ? "object" : "unknown";
}

function shapeOfSchema(doc: Json, schema: unknown): ApiShape | undefined {
  if (!schema) return undefined;
  const type = schemaType(doc, schema);
  let s = deref(doc, schema);
  if (isObj(s) && s.type === "array") s = deref(doc, s.items);
  if (isObj(s) && Array.isArray(s.allOf)) {
    const merged: Json = { properties: {}, required: [] };
    for (const part of s.allOf) {
      const p = deref(doc, part);
      if (!isObj(p)) continue;
      Object.assign(merged.properties as Json, isObj(p.properties) ? p.properties : {});
      (merged.required as string[]).push(...(Array.isArray(p.required) ? (p.required as string[]) : []));
    }
    s = merged;
  }
  const props = isObj(s) && isObj(s.properties) ? s.properties : undefined;
  const required = new Set(isObj(s) && Array.isArray(s.required) ? (s.required as string[]) : []);
  const fields: ApiField[] | undefined = props ? Object.entries(props).slice(0, 40).map(([name, p]) => ({ name, type: schemaType(doc, p), required: required.has(name) })) : undefined;
  return { type, ...(fields ? { fields } : {}), source: "spec" };
}

/** The JSON media type's schema of a request body or response. */
function contentSchema(doc: Json, holder: unknown): unknown {
  const h = deref(doc, holder);
  if (!isObj(h)) return undefined;
  if (h.schema) return h.schema; // Swagger 2 response
  const content = isObj(h.content) ? h.content : undefined;
  if (!content) return undefined;
  const key = Object.keys(content).find((k) => /json/.test(k)) ?? Object.keys(content)[0];
  const media = key ? content[key] : undefined;
  return isObj(media) ? media.schema : undefined;
}

function basePathOf(doc: Json): string {
  if (typeof doc.basePath === "string") return doc.basePath;
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const url = isObj(servers[0]) && typeof servers[0].url === "string" ? servers[0].url : "";
  if (!url) return "";
  try {
    return new URL(url, "http://x").pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function operationsOf(file: string, doc: Json): SpecOperation[] {
  const paths = isObj(doc.paths) ? doc.paths : {};
  const base = basePathOf(doc);
  const ops: SpecOperation[] = [];
  for (const [rawPath, item] of Object.entries(paths)) {
    const pathItem = deref(doc, item);
    if (!isObj(pathItem)) continue;
    const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!isObj(op)) continue;
      const params: ApiParam[] = [];
      let request: ApiShape | undefined;
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = deref(doc, raw);
        if (!isObj(p) || typeof p.name !== "string") continue;
        if (p.in === "body") {
          request = shapeOfSchema(doc, p.schema);
          continue;
        }
        const location = p.in === "formData" ? "form" : (p.in as ApiParam["in"]);
        params.push({ name: p.name, in: location, type: p.schema ? schemaType(doc, p.schema) : typeof p.type === "string" ? p.type : undefined, required: p.required === true || p.in === "path" });
      }
      if (op.requestBody) request = shapeOfSchema(doc, contentSchema(doc, op.requestBody)) ?? request;
      const responses = isObj(op.responses) ? op.responses : {};
      const okKey = Object.keys(responses).find((k) => /^2\d\d$/.test(k)) ?? (responses.default ? "default" : undefined);
      const response = okKey ? shapeOfSchema(doc, contentSchema(doc, responses[okKey])) : undefined;
      const path = normalizePath(rawPath);
      ops.push({
        file,
        method: method.toUpperCase(),
        path,
        fullPath: base ? normalizePath(`${base}${path}`) : path,
        ...(typeof op.summary === "string" ? { summary: op.summary } : {}),
        ...(typeof op.description === "string" ? { description: op.description.slice(0, 600) } : {}),
        ...(typeof op.operationId === "string" ? { operationId: op.operationId } : {}),
        ...(Array.isArray(op.tags) ? { tags: (op.tags as unknown[]).filter((t): t is string => typeof t === "string") } : {}),
        params,
        ...(request ? { request } : {}),
        ...(response ? { response } : {}),
      });
    }
  }
  return ops;
}

/** Every OpenAPI / Swagger document in the tree, as operations. */
export async function readSpecs(ctx: ApiContext): Promise<{ files: string[]; operations: SpecOperation[] }> {
  const files: string[] = [];
  const operations: SpecOperation[] = [];
  for (const path of ctx.allFiles) {
    if (!SPEC_FILE.test(path) || SKIP_DIR.test(path) || files.length >= 20) continue;
    const text = await ctx.readText(path);
    if (!text || text.length > MAX_SPEC_BYTES || !/(openapi|swagger)["']?\s*:/.test(text)) continue;
    let doc: unknown;
    try {
      doc = path.endsWith(".json") ? JSON.parse(text) : load(text);
    } catch {
      continue;
    }
    if (!isObj(doc) || !(doc.openapi || doc.swagger) || !isObj(doc.paths)) continue;
    files.push(path);
    operations.push(...operationsOf(path, doc));
  }
  return { files, operations };
}

/** Match keys an operation can be found under: method + path, at and below its base path. */
export function specKeys(op: SpecOperation): string[] {
  return [...new Set([`${op.method} ${pathKey(op.path)}`, `${op.method} ${pathKey(op.fullPath)}`])];
}
