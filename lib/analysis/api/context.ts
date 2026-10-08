/**
 * What every framework resolver in this folder shares: the files that have
 * route facts, name lookup across files (through the symbol graph's
 * resolved imports), path helpers, request/response shapes from the code's
 * own types, and the call reach of a handler.
 */
import type { FileAnalysis, ModelFact, RouteFacts, SymbolFacts, Val } from "../ir";
import type { SymbolCall, SymbolDecl, SymbolGraph } from "../symbols";
import { MAX_REACH_DEPTH, MAX_REACH_STEPS, type ApiField, type ApiHandler, type ApiShape, type Endpoint, type ReachStep } from "./types";

export interface ApiFile {
  file: string;
  language: string;
  facts: SymbolFacts;
  routes: RouteFacts;
}

export interface ApiContext {
  /** Files with symbol facts, by path. */
  files: Map<string, ApiFile>;
  /** Every path in the tree (non-code files included). */
  allFiles: ReadonlySet<string>;
  symbols: SymbolGraph;
  declById: Map<string, SymbolDecl>;
  /** Where a name used in `file` is declared — its own module level first, then its resolved imports. */
  lookup(file: string, name: string): { file: string; name: string; decl?: SymbolDecl } | undefined;
  /** Import specifiers of a file, as written. */
  importsOf(file: string): string[];
  /** The repo file an import specifier of `file` resolves to. */
  resolveImport(file: string, specifier: string): string | undefined;
  /** The repo file a module-level name of `file` was imported from (`const users = require("./users")`). */
  moduleOf(file: string, local: string): string | undefined;
  readText(relPath: string): Promise<string | null>;
  /** Counted by the resolvers: mounts whose target couldn't be followed. */
  unresolvedMounts: number;
}

export function buildContext(
  files: readonly FileAnalysis[],
  symbols: SymbolGraph,
  allFiles: ReadonlySet<string>,
  readText: (relPath: string) => Promise<string | null>,
): ApiContext {
  const byPath = new Map<string, ApiFile>();
  for (const f of files) {
    if (!f.symbols) continue;
    byPath.set(f.file, { file: f.file, language: f.language, facts: f.symbols, routes: f.symbols.routes ?? {} });
  }
  const declById = new Map(symbols.decls.map((d) => [d.id, d]));
  const resolved = new Map<string, string>();
  for (const f of files) for (const imp of f.imports) if (imp.resolvedPath) resolved.set(`${f.file}\u0000${imp.raw}`, imp.resolvedPath);
  const useByLocal = new Map<string, string>();
  for (const use of symbols.uses) {
    const key = `${use.file}\u0000${use.local}`;
    if (!useByLocal.has(key)) useByLocal.set(key, use.target);
  }
  return {
    files: byPath,
    allFiles,
    symbols,
    declById,
    lookup(file, name) {
      const own = declById.get(`${file}#${name}`);
      if (own) return { file, name, decl: own };
      const entry = byPath.get(file);
      if (entry?.routes.creates?.some((c) => c.local === name)) return { file, name };
      const target = useByLocal.get(`${file}\u0000${name}`);
      if (target) {
        const decl = declById.get(target);
        if (decl) return { file: decl.file, name: decl.qualified, decl };
      }
      return undefined;
    },
    importsOf(file) {
      return byPath.get(file)?.facts.imports.map((i) => i.source) ?? [];
    },
    resolveImport(file, specifier) {
      return resolved.get(`${file}\u0000${specifier}`);
    },
    moduleOf(file, local) {
      const imp = byPath.get(file)?.facts.imports.find((i) => i.bindings.some((b) => b.local === local));
      return imp ? resolved.get(`${file}\u0000${imp.source}`) : undefined;
    },
    readText,
    unresolvedMounts: 0,
  };
}

// ---------------------------------------------------------------------------
// Values and paths
// ---------------------------------------------------------------------------

export function isStr(v: Val | undefined): v is { s: string } {
  return Boolean(v && "s" in v);
}

/** A boolean literal as written in any of the languages (`true`, `True`). */
export function isBool(v: Val | undefined, value: boolean): boolean {
  if (!v) return false;
  const text = "id" in v ? v.id : "x" in v ? v.x : undefined;
  return text !== undefined && text.toLowerCase() === String(value);
}

/** A value's text in a path: the string, or `{hole}` for what isn't one. */
export function valText(v: Val | undefined): string {
  if (!v) return "";
  if ("s" in v) return v.s;
  if ("t" in v) return v.t;
  if ("id" in v) return `{${v.id}}`;
  return "{…}";
}

/** A string constant a name refers to (`const PREFIX = "/api"`, `PREFIX = "/api"`), when it is one. */
function constantString(ctx: ApiContext, file: string, name: string): string | undefined {
  const hit = ctx.lookup(file, name);
  const sig = hit?.decl?.signature;
  if (!sig || (hit.decl!.kind !== "const" && hit.decl!.kind !== "variable")) return undefined;
  const m = /=\s*(['"`])([^'"`$]*)\1\s*;?\s*$/.exec(sig);
  return m ? m[2] : undefined;
}

/** A path written as `v` in `file`: constants resolved, holes left as `{expr}` and marked partial. */
export function pathValue(ctx: ApiContext, file: string, v: Val | undefined): { text: string; partial: boolean } {
  if (!v) return { text: "", partial: false };
  if ("s" in v) return { text: v.s, partial: false };
  if ("id" in v) {
    const value = constantString(ctx, file, v.id);
    return value !== undefined ? { text: value, partial: false } : { text: `{${v.id}}`, partial: true };
  }
  if ("t" in v) {
    let partial = false;
    const text = v.t.replace(/\{([\w$.]+)\}/g, (whole, name: string) => {
      const value = constantString(ctx, file, name);
      if (value !== undefined) return value;
      partial = true;
      return whole;
    });
    return { text, partial: partial || /\{[^}]*[^\w$.}][^}]*\}/.test(text) };
  }
  return { text: "{…}", partial: true };
}

export function joinPath(...parts: string[]): string {
  const joined = parts
    .filter((p) => p !== "")
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p !== "")
    .join("/");
  return `/${joined}`;
}

/**
 * One parameter syntax for every framework: `:id`, `<int:id>`, `{id:\d+}`,
 * `(?P<id>…)` and `[id]` all become `{id}`; regex anchors go.
 */
export function normalizePath(path: string): string {
  let p = path.trim();
  p = p.replace(/^\^|\$$/g, "");
  p = p.replace(/\(\?P<(\w+)>[^)]*\)/g, "{$1}");
  p = p.replace(/<(?:\w+:)?(\w+)>/g, "{$1}");
  p = p.replace(/:(\w+)\??(\([^)]*\))?/g, "{$1}");
  p = p.replace(/\{(\w+):[^}]*\}/g, "{$1}");
  p = p.replace(/\/{2,}/g, "/");
  if (!p.startsWith("/") && !p.startsWith("…")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** The path with parameter names erased, for matching across commits and against a spec. */
export function pathKey(path: string): string {
  return normalizePath(path).replace(/\{[^}]*\}/g, "{}").toLowerCase();
}

export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\*?\??\}/g)].map((m) => m[1]);
}

const GROUP_SKIP = /^(api|rest|v\d+|public|internal|\{.*\}|…)$/i;

/**
 * The resource an HTTP path belongs to: its first meaningful segment, and
 * a sub-resource that follows a parameter (`/repos/{id}/branches` →
 * `repos › branches`).
 */
export function groupOfPath(path: string, subResources = true): string {
  const segments = path.split("/").filter(Boolean);
  const first = segments.findIndex((s) => !GROUP_SKIP.test(s));
  if (first === -1) return "/";
  const param = subResources ? segments.findIndex((s, i) => i > first && /^{.*}$/.test(s)) : -1;
  const nested = param !== -1 ? segments[param + 1] : undefined;
  return nested && !/^{.*}$/.test(nested) ? `${segments[first]} › ${nested}` : segments[first];
}

const DATA_FILE = /(^|\/)(db|database|repositor(y|ies)|models?|prisma|dao|daos|persistence|entit(y|ies)|sql|queries|drizzle|typeorm|sequelize|mongoose)(\/|\.|$)/i;
const DATA_NAME = /(Repository|Repo|Dao|Store|Model|Mapper)$/;

export function looksLikeData(file: string, name: string): boolean {
  return DATA_FILE.test(file) || DATA_NAME.test(name.split(".")[0] ?? "");
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Split `text` at top-level `sep`s (not inside brackets or strings). */
export function splitTop(text: string, seps: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c) && !(c === ">" && text[i - 1] === "=")) depth--;
    else if (depth === 0 && seps.includes(c)) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The text between the first `open` and its matching close. */
function braced(text: string, open = "{", close = "}"): string | undefined {
  const start = text.indexOf(open);
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start + 1, i);
  }
  return undefined;
}

const ZOD_TYPES: Record<string, string> = {
  string: "string", number: "number", boolean: "boolean", date: "Date", bigint: "bigint", array: "array", object: "object",
  enum: "enum", literal: "literal", union: "union", any: "any", unknown: "unknown", record: "record", nativeEnum: "enum",
};

/** Fields of a TS type literal / interface body or a `z.object({…})`. */
export function parseTsFields(text: string): ApiField[] | undefined {
  const zod = /\bz\.object\(\s*\{/.test(text);
  const body = zod ? braced(text.slice(text.search(/\bz\.object\(/))) : braced(text);
  if (body === undefined) return undefined;
  const fields: ApiField[] = [];
  for (const part of splitTop(body, zod ? "," : ";,")) {
    const m = /^(?:readonly\s+)?["']?([\w$-]+)["']?(\?)?\s*:\s*([\s\S]+)$/.exec(part);
    if (!m) continue;
    let type = m[3].trim();
    let required = !m[2];
    if (zod) {
      const kind = /z\.(\w+)/.exec(type)?.[1];
      required = !/\.(optional|nullish|default)\(/.test(type);
      type = kind ? (ZOD_TYPES[kind] ?? kind) : type;
      if (/^z\.array\(/.test(m[3].trim())) type = "array";
    }
    fields.push({ name: m[1], type: type.length > 80 ? `${type.slice(0, 80)}…` : type, required });
    if (fields.length >= 40) break;
  }
  return fields;
}

/** `Promise<ResponseEntity<List<Order>>>` → `Order` (and whether it's a list). */
export function innerTypeName(type: string): { name: string; list: boolean } | undefined {
  let t = type.trim().replace(/^:\s*/, "");
  let list = false;
  for (let i = 0; i < 6; i++) {
    const wrapper = /^(Promise|ResponseEntity|Mono|Optional|NextResponse|Response|Awaited|CompletableFuture|Uni|HttpResponse|Single|Maybe|Observable|Readonly|JSONResponse|TypedResponse)\s*<([\s\S]+)>$/.exec(t);
    const listy = /^(List|Set|Collection|Iterable|Flux|Array|Multi|list|List|Sequence|set)\s*[<[]([\s\S]+)[>\]]$/.exec(t);
    if (wrapper) t = wrapper[2].trim();
    else if (listy) {
      t = listy[2].trim();
      list = true;
    } else if (t.endsWith("[]")) {
      t = t.slice(0, -2).trim();
      list = true;
    } else break;
  }
  t = t.replace(/\s*\|\s*(None|null|undefined)$/, "").replace(/^Optional\[(.+)\]$/, "$1");
  const name = /^[A-Za-z_][\w.]*$/.exec(t)?.[0];
  return name ? { name, list } : undefined;
}

const PRIMITIVE = /^(string|number|boolean|int|float|str|bool|bytes|dict|Dict|Any|any|unknown|void|None|null|undefined|Object|String|Integer|Long|Double|Boolean|Void|UUID|Date|datetime|date|object|Map|Record|JsonNode|Response|HttpResponse|NextResponse|Request|NextRequest)$/;

/** Fields of the named model as `file` sees it: a Pydantic / dataclass / DTO / serializer, a TS interface or type, a zod schema. */
export function modelFields(ctx: ApiContext, file: string, name: string): ApiField[] | undefined {
  const short = name.split(".").pop()!;
  const hit = ctx.lookup(file, name) ?? ctx.lookup(file, short);
  const fromModel = (m: ModelFact): ApiField[] =>
    m.fields.map((f) => ({ name: f.name, type: f.type, required: !f.optional && !/required\s*=\s*False|null\s*=\s*True|blank\s*=\s*True/.test(f.call ?? "") && !/^Optional\[|\|\s*None$/.test(f.type) }));
  const inFile = (path: string, model: string): ApiField[] | undefined => {
    const entry = ctx.files.get(path);
    const m = entry?.routes.models?.find((x) => x.name === model || x.name.endsWith(`.${model}`));
    if (m && m.fields.length) return fromModel(m);
    const decl = ctx.declById.get(`${path}#${model}`);
    if (decl && (decl.kind === "interface" || decl.kind === "type" || decl.kind === "const")) return parseTsFields(decl.signature);
    return undefined;
  };
  if (hit) {
    const found = inFile(hit.file, hit.name.split(".").pop()!);
    if (found) return found;
  }
  const own = inFile(file, short);
  if (own) return own;
  // A unique name across the repo (JVM DTOs in another package, Python models imported by star).
  let match: ApiField[] | undefined;
  let count = 0;
  for (const entry of ctx.files.values()) {
    const m = entry.routes.models?.find((x) => x.name === short);
    if (m && m.fields.length) {
      count++;
      match = fromModel(m);
      if (count > 1) return undefined;
    }
  }
  return match;
}

/** A shape for a type as written, with its fields when its model can be read. */
export function shapeOf(ctx: ApiContext, file: string, type: string | undefined): ApiShape | undefined {
  if (!type) return undefined;
  const clean = type.replace(/\s+/g, " ").trim();
  if (!clean || /^(void|None|Promise<void>|Void|Unit)$/.test(clean)) return undefined;
  if (/\bz\.object\(/.test(clean) || /^\{/.test(clean)) {
    const fields = parseTsFields(clean);
    return { type: clean.length > 120 ? `${clean.slice(0, 120)}…` : clean, ...(fields ? { fields } : {}), source: "static" };
  }
  const inner = innerTypeName(clean);
  if (!inner || PRIMITIVE.test(inner.name)) return { type: clean, source: "static" };
  const fields = modelFields(ctx, file, inner.name);
  return { type: clean, ...(fields ? { fields } : {}), source: "static" };
}

// ---------------------------------------------------------------------------
// Reach
// ---------------------------------------------------------------------------

export interface CallIndex {
  from: Map<string, SymbolCall[]>;
  inFile: Map<string, SymbolCall[]>;
}

export function indexCalls(symbols: SymbolGraph): CallIndex {
  const from = new Map<string, SymbolCall[]>();
  const inFile = new Map<string, SymbolCall[]>();
  for (const call of symbols.calls) {
    (from.get(call.from) ?? from.set(call.from, []).get(call.from)!).push(call);
    (inFile.get(call.file) ?? inFile.set(call.file, []).get(call.file)!).push(call);
  }
  return { from, inFile };
}

/** Calls made from inside the handler's lines. */
export function handlerCalls(index: CallIndex, handler: ApiHandler): SymbolCall[] {
  if (handler.declId) {
    const own = index.from.get(handler.declId);
    if (own) return own;
  }
  return (index.inFile.get(handler.file) ?? []).filter((c) => c.line >= handler.startLine && c.line <= handler.endLine);
}

/** Functions the handler reaches through resolved calls, breadth first. */
export function reachOf(ctx: ApiContext, index: CallIndex, handler: ApiHandler): { steps: ReachStep[]; truncated: boolean } {
  const steps: ReachStep[] = [];
  const seen = new Set<string>(handler.declId ? [handler.declId] : []);
  let frontier: Array<{ id: string; via?: string; line: number }> = handlerCalls(index, handler).map((c) => ({ id: c.to, line: c.line }));
  let truncated = false;
  for (let depth = 1; depth <= MAX_REACH_DEPTH && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const item of frontier) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (steps.length >= MAX_REACH_STEPS) {
        truncated = true;
        continue;
      }
      const decl = ctx.declById.get(item.id);
      if (!decl) continue;
      steps.push({
        id: item.id,
        line: decl.startLine,
        depth,
        ...(item.via ? { via: item.via } : {}),
        ...(looksLikeData(decl.file, decl.qualified) ? { data: true as const } : {}),
      });
      for (const call of index.from.get(item.id) ?? []) if (!seen.has(call.to)) next.push({ id: call.to, via: item.id, line: call.line });
    }
    frontier = next;
  }
  if (frontier.length > 0 && steps.length >= MAX_REACH_STEPS) truncated = true;
  return { steps, truncated };
}

/** The handler of a whole declaration. */
export function declHandler(ctx: ApiContext, file: string, qualified: string): ApiHandler | undefined {
  const decl = ctx.declById.get(`${file}#${qualified}`);
  if (!decl) return undefined;
  return { file, startLine: decl.startLine, endLine: decl.endLine, name: decl.qualified, declId: decl.id, ...(decl.textHash ? { hash: decl.textHash } : {}) };
}

/** A handler for an inline function value (`router.get("/x", async (req, res) => …)`). */
export function inlineHandler(file: string, v: Extract<Val, { fn: [number, number] }>, name = "(inline)"): ApiHandler {
  return { file, startLine: v.fn[0], endLine: v.fn[1], name, hash: v.hash };
}

export type PartialEndpoint = Omit<Endpoint, "id" | "reach" | "group"> & { group?: string };
