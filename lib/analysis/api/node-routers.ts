/**
 * Express, Fastify, Hono, Koa and Elysia: routes registered by calls on a
 * router object (`router.get("/x", auth, handler)`), routers mounted under
 * prefixes (`app.use("/api", router)`, `app.route("/api", sub)`,
 * `fastify.register(plugin, { prefix })`), across files.
 *
 * A call only counts when its object is something the analysis can tie to a
 * framework: a router created in the repo (`express.Router()`, `new Hono()`
 * …, followed through imports), the parameter of a function in a file that
 * imports a framework (a Fastify plugin, `registerRoutes(app)`), or a
 * router-like name in such a file. `axios.get("/x")` never qualifies.
 */
import type { RouteCallFact, Val } from "../ir";
import {
  declHandler,
  inlineHandler,
  isStr,
  joinPath,
  normalizePath,
  pathValue,
  shapeOf,
  valText,
  type ApiContext,
  type PartialEndpoint,
} from "./context";
import { zodParsedIn } from "./next";
import type { ApiHandler, ApiParam, ApiShape } from "./types";

const FRAMEWORKS: Array<[RegExp, string]> = [
  [/^express$/, "Express"],
  [/^router$/, "Express"],
  [/^fastify$/, "Fastify"],
  [/^(hono|@hono\/)/, "Hono"],
  [/^(koa|@koa\/router|koa-router)$/, "Koa"],
  [/^elysia$/, "Elysia"],
  [/^polka$/, "Polka"],
  [/^restify$/, "Restify"],
  [/^lambda-api$/, "lambda-api"],
  [/^(@tinyhttp\/app|h3)$/, "h3"],
];
const TYPE_HINTS: Array<[RegExp, string]> = [
  [/\b(Express|Application|Router|IRouter)\b/, "Express"],
  [/\bFastify(Instance|PluginAsync|PluginCallback)\b/, "Fastify"],
  [/\b(Hono|OpenAPIHono)\b/, "Hono"],
  [/\bElysia\b/, "Elysia"],
];
const APP_FACTORY = /^(express|fastify|Fastify|new (Hono|OpenAPIHono|Koa|Elysia)\b|polka|createServer|createApp)/;
const ROUTER_LIKE = /^(app|router|server|api|apiRouter|routes?|r|fastify|instance|v\d+)$/i;
const APP_LIKE = /^(app|server|fastify|instance|api)$/i;
/** Middleware that says nothing about who may call the endpoint. */
const NOISE = /^(express\.)?(json|urlencoded|static|text|raw)$|^(cors|helmet|compression|morgan|cookieParser|bodyParser(\.\w+)?|logger|requestLogger|pinoHttp|timeout|prettyJSON|secureHeaders|etag|poweredBy)$/;
const VERB: Record<string, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", del: "DELETE", head: "HEAD", options: "OPTIONS", all: "ANY", any: "ANY" };

interface Mount {
  parent: string;
  prefix: { text: string; partial: boolean };
  file: string;
  line: number;
}

interface RouterNode {
  id: string;
  framework: string;
  /** A root by construction (`express()`, `new Hono()`, an `app` parameter). */
  root: boolean;
  prefix: { text: string; partial: boolean };
  /** `use(mw)` / `use("/scope", mw)` calls on this router, in order. */
  middleware: Array<{ name: string; file: string; line: number; scope: string }>;
  mounts: Mount[];
}

interface RawRoute {
  node: string;
  method: string;
  path: { text: string; partial: boolean };
  handler: ApiHandler;
  registeredAt: { file: string; line: number };
  middleware: string[];
  params: ApiParam[];
  request?: ApiShape;
  response?: ApiShape;
  file: string;
  line: number;
}

function frameworkOfFile(ctx: ApiContext, file: string): string | undefined {
  for (const source of ctx.importsOf(file)) for (const [re, name] of FRAMEWORKS) if (re.test(source)) return name;
  return undefined;
}

/** Middleware's display name: `requireAuth`, `requireRole("admin")`. */
function middlewareName(v: Val): string | undefined {
  if ("id" in v) return v.id;
  if ("call" in v) {
    const args = v.args.map((a) => ("s" in a ? JSON.stringify(a.s) : "id" in a ? a.id : "…")).join(", ");
    return `${v.call}(${args.length > 40 ? "…" : args})`;
  }
  // An inline function has no name worth showing; it says nothing about who may call.
  return undefined;
}

function firstParamName(sig: string | undefined): string | undefined {
  if (!sig) return undefined;
  const m = /\(\s*([A-Za-z_$][\w$]*)/.exec(sig) ?? /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(sig);
  return m?.[1];
}

/** Fastify JSON-schema `{ type: "object", properties, required }` → fields. */
function jsonSchemaShape(v: Val | undefined): ApiShape | undefined {
  if (!v || !("obj" in v)) return v && "id" in v ? { type: v.id, source: "static" } : undefined;
  const props = v.obj.properties;
  if (!props || !("obj" in props)) return { type: "object", source: "static" };
  const required = new Set(v.obj.required && "list" in v.obj.required ? v.obj.required.list.filter(isStr).map((s) => s.s) : []);
  return {
    type: "object",
    fields: Object.entries(props.obj).map(([name, p]) => ({ name, type: "obj" in p && p.obj.type && isStr(p.obj.type) ? p.obj.type.s : "unknown", required: required.has(name) })),
    source: "static",
  };
}

export function resolveNodeRouters(ctx: ApiContext): PartialEndpoint[] {
  const nodes = new Map<string, RouterNode>();
  const frameworkByFile = new Map<string, string | undefined>();
  const fw = (file: string) => {
    if (!frameworkByFile.has(file)) frameworkByFile.set(file, frameworkOfFile(ctx, file));
    return frameworkByFile.get(file);
  };

  // Routers created in the repo.
  for (const entry of ctx.files.values()) {
    for (const create of entry.routes.creates ?? []) {
      const callee = create.callee;
      const framework =
        fw(entry.file) ??
        (/Hono/.test(callee) ? "Hono" : /fastify/i.test(callee) ? "Fastify" : /express|Router/.test(callee) ? "Express" : /Elysia/.test(callee) ? "Elysia" : /Koa/.test(callee) ? "Koa" : undefined);
      if (!framework) continue;
      const first = create.args[0];
      let prefix = { text: "", partial: false };
      if (/\.basePath$/.test(callee) && first) prefix = pathValue(ctx, entry.file, first);
      else if (first && "obj" in first && first.obj.prefix) prefix = pathValue(ctx, entry.file, first.obj.prefix);
      nodes.set(`${entry.file}#${create.local}`, {
        id: `${entry.file}#${create.local}`,
        framework,
        root: APP_FACTORY.test(callee) && !/Router/.test(callee),
        prefix,
        middleware: [],
        mounts: [],
      });
    }
  }

  // Inline plugin / group functions: `fastify.register(async (instance) => …)`, `app.group("/x", (g) => …)`.
  const inlineScopes = new Map<string, Array<{ start: number; end: number; param: string; node: string }>>();
  for (const entry of ctx.files.values()) {
    for (const call of entry.routes.calls ?? []) {
      if (call.m !== "register" && call.m !== "group") continue;
      const fn = call.args.find((a): a is Extract<Val, { fn: [number, number] }> => "fn" in a);
      const param = firstParamName(fn?.sig);
      if (!fn || !param) continue;
      const id = `inline:${entry.file}:${fn.fn[0]}`;
      (inlineScopes.get(entry.file) ?? inlineScopes.set(entry.file, []).get(entry.file)!).push({ start: fn.fn[0], end: fn.fn[1], param, node: id });
    }
  }

  /** The one router a file creates (a sub-router, when it also creates an app). */
  const routersIn = (file: string): RouterNode | undefined => {
    const own = [...nodes.values()].filter((n) => n.id.startsWith(`${file}#`));
    const routers = own.filter((n) => !n.root);
    return routers.length === 1 ? routers[0] : own.length === 1 ? own[0] : undefined;
  };

  const ensure = (id: string, framework: string, root: boolean): RouterNode => {
    let node = nodes.get(id);
    if (!node) nodes.set(id, (node = { id, framework, root, prefix: { text: "", partial: false }, middleware: [], mounts: [] }));
    return node;
  };

  /** The router node `obj` stands for in `file`, or `undefined` when it isn't one. */
  const resolveNode = (file: string, obj: string, call: Pick<RouteCallFact, "inDecl" | "line">): RouterNode | undefined => {
    const name = obj.replace(/\.(routes|router|middleware|allowedMethods)\(\)$/, "");
    const scope = inlineScopes.get(file)?.find((s) => call.line > s.start && call.line <= s.end && s.param === name);
    if (scope) return ensure(scope.node, fw(file) ?? "Fastify", false);
    const hit = /^[\w$]+$/.test(name) ? ctx.lookup(file, name) : undefined;
    if (hit) {
      const node = nodes.get(`${hit.file}#${hit.name}`);
      if (node) return node;
    }
    // CommonJS: `const users = require("./users")` of a file that ends `module.exports = router`.
    const sourceFile = /^[\w$]+$/.test(name) ? ctx.moduleOf(file, name) : undefined;
    if (sourceFile) {
      const own = routersIn(sourceFile);
      if (own) return own;
    }
    const entry = ctx.files.get(file);
    const decl = call.inDecl !== undefined && call.inDecl >= 0 ? entry?.facts.decls[call.inDecl] : undefined;
    if (decl && new RegExp(`[(,]\\s*${name.replace(/\$/g, "\\$")}\\s*[:,)?=]`).test(decl.signature)) {
      const typed = TYPE_HINTS.find(([re]) => re.test(decl.signature))?.[1];
      const framework = fw(file) ?? typed;
      if (!framework) return undefined;
      const declId = `${file}#${decl.parent ? `${decl.parent}.${decl.name}` : decl.name}`;
      return ensure(`param:${declId}:${name}`, framework, APP_LIKE.test(name));
    }
    const framework = fw(file);
    if (framework && ROUTER_LIKE.test(name)) return ensure(`${file}#${name}`, framework, APP_LIKE.test(name));
    return undefined;
  };

  const handlerOf = (file: string, v: Val, line: number): ApiHandler => {
    if ("fn" in v) return inlineHandler(file, v);
    if ("id" in v) {
      const hit = ctx.lookup(file, v.id);
      if (hit) {
        const own = declHandler(ctx, hit.file, hit.name);
        if (own) return own;
      }
      const [head, ...rest] = v.id.split(".");
      const target = rest.length ? ctx.lookup(file, head) : undefined;
      if (target) {
        const method = declHandler(ctx, target.file, `${target.name}.${rest.join(".")}`) ?? declHandler(ctx, target.file, rest.join("."));
        if (method) return method;
      }
      return { file, startLine: line, endLine: line, name: v.id };
    }
    if ("call" in v) {
      // asyncHandler(fn), wrap(controller.list): the wrapped function.
      const inner = v.args.find((a) => "fn" in a || "id" in a);
      if (inner) return handlerOf(file, inner, line);
    }
    return { file, startLine: line, endLine: line, name: valText(v) };
  };

  const routes: RawRoute[] = [];
  const addRoute = (
    node: RouterNode,
    file: string,
    call: RouteCallFact,
    method: string,
    pathVal: Val | undefined,
    handlerArgs: Val[],
    options?: Record<string, Val>,
  ) => {
    const handlerVal = handlerArgs[handlerArgs.length - 1] ?? options?.handler;
    if (!handlerVal) return;
    const route = call.route ? pathValue(ctx, file, call.route) : { text: "", partial: false };
    const own = pathValue(ctx, file, pathVal);
    const middleware: string[] = [];
    const params: ApiParam[] = [];
    let request: ApiShape | undefined;
    let response: ApiShape | undefined;
    for (const mw of handlerArgs.slice(0, -1)) {
      if ("obj" in mw) {
        options = { ...mw.obj, ...options };
        continue;
      }
      const name = middlewareName(mw);
      // Hono / Express validators carry the request's shape: zValidator("json", schema).
      if ("call" in mw && /validat/i.test(mw.call) && mw.args.length >= 2 && isStr(mw.args[0])) {
        const target = mw.args[0].s;
        const schema = mw.args[1];
        const schemaShape = shapeOf(ctx, file, "id" in schema ? schema.id : valText(schema));
        if (target === "json" || target === "form") request = schemaShape ? { ...schemaShape, type: valText(schema).replace(/^\{|\}$/g, "") } : request;
        else if (target === "query" || target === "param") for (const f of schemaShape?.fields ?? []) params.push({ name: f.name, in: target === "query" ? "query" : "path", type: f.type, required: f.required });
        continue;
      }
      if (name && !NOISE.test(name.replace(/\(.*$/, ""))) middleware.push(name);
    }
    if (options) {
      for (const key of ["preHandler", "onRequest", "preValidation", "beforeHandle"]) {
        const v = options[key];
        for (const item of v ? ("list" in v ? v.list : [v]) : []) {
          const name = middlewareName(item);
          if (name) middleware.push(name);
        }
      }
      const schema = options.schema;
      if (schema && "obj" in schema) {
        request = jsonSchemaShape(schema.obj.body) ?? request;
        const okResponse = schema.obj.response && "obj" in schema.obj.response ? (schema.obj.response.obj["200"] ?? schema.obj.response.obj["201"] ?? Object.values(schema.obj.response.obj)[0]) : undefined;
        response = jsonSchemaShape(okResponse);
        for (const [location, key] of [["query", "querystring"], ["path", "params"], ["header", "headers"]] as const) {
          const shape = jsonSchemaShape(schema.obj[key]);
          for (const f of shape?.fields ?? []) params.push({ name: f.name, in: location, type: f.type, required: f.required });
        }
      }
    }
    const handler = handlerOf(file, handlerVal, call.line);
    // No validator or schema: a zod schema the handler itself .parse()s is the body.
    if (!request && method !== "GET" && method !== "DELETE") request = zodParsedIn(ctx, handler.file, handler.startLine, handler.endLine);
    routes.push({
      node: node.id,
      method,
      path: { text: joinPath(route.text, own.text), partial: route.partial || own.partial },
      handler,
      registeredAt: { file, line: call.line },
      middleware,
      params,
      ...(request ? { request } : {}),
      ...(response ? { response } : {}),
      file,
      line: call.line,
    });
  };

  for (const entry of ctx.files.values()) {
    const file = entry.file;
    for (const call of entry.routes.calls ?? []) {
      const node = resolveNode(file, call.obj, call);
      if (!node) continue;
      const [first, ...rest] = call.args;
      const verb = VERB[call.m];
      if (verb) {
        // `router.route("/x").put(handler)`: the path is the route()'s, every argument a handler.
        if (call.route && first && !("s" in first || "t" in first)) addRoute(node, file, call, verb, undefined, call.args);
        else addRoute(node, file, call, verb, first, rest);
        continue;
      }
      if (call.m === "on" && first) {
        const methods = "list" in first ? first.list.filter(isStr).map((s) => s.s) : isStr(first) ? [first.s] : [];
        for (const m of methods) addRoute(node, file, call, m.toUpperCase(), rest[0], rest.slice(1));
        continue;
      }
      if (call.m === "route" && first && "obj" in first) {
        // Fastify `route({ method, url, handler, schema, preHandler })`.
        const o = first.obj;
        const methods = o.method ? ("list" in o.method ? o.method.list.filter(isStr).map((s) => s.s) : isStr(o.method) ? [o.method.s] : ["ANY"]) : ["ANY"];
        for (const m of methods) addRoute(node, file, call, m.toUpperCase(), o.url ?? o.path, o.handler ? [o.handler] : [], o);
        continue;
      }
      const mountChild = (v: Val, prefix: { text: string; partial: boolean }): boolean => {
        const ref = "id" in v ? v.id : "call" in v && v.args.length === 0 ? `${v.call}()` : undefined;
        if (!ref) return false;
        const child = resolveNode(file, ref, call);
        if (!child || child === node) return false;
        child.mounts.push({ parent: node.id, prefix, file, line: call.line });
        return true;
      };
      if (call.m === "use") {
        const pathy = first && ("s" in first || "t" in first);
        const prefix = pathy ? pathValue(ctx, file, first) : { text: "", partial: false };
        for (const arg of pathy ? rest : call.args) {
          if (mountChild(arg, prefix)) continue;
          if ("call" in arg && arg.call === "require") {
            const spec = arg.args[0];
            const target = spec && isStr(spec) ? ctx.resolveImport(file, spec.s) : undefined;
            const child = target ? routersIn(target) : undefined;
            if (child && child !== node) child.mounts.push({ parent: node.id, prefix, file, line: call.line });
            else ctx.unresolvedMounts++;
            continue;
          }
          const name = middlewareName(arg);
          if (name && !NOISE.test(name.replace(/\(.*$/, ""))) node.middleware.push({ name, file, line: call.line, scope: pathy ? normalizePath(prefix.text) : "" });
        }
        continue;
      }
      if ((call.m === "route" || call.m === "mount") && first && rest[0]) {
        const prefix = pathValue(ctx, file, first);
        if (!mountChild(rest[0], prefix) && !("fn" in rest[0])) ctx.unresolvedMounts++;
        continue;
      }
      if (call.m === "register" && first) {
        const opts = rest[0] && "obj" in rest[0] ? rest[0].obj : undefined;
        const prefix = opts?.prefix ? pathValue(ctx, file, opts.prefix) : { text: "", partial: false };
        if ("fn" in first) {
          const child = ensure(`inline:${file}:${first.fn[0]}`, node.framework, false);
          child.mounts.push({ parent: node.id, prefix, file, line: call.line });
        } else if ("id" in first) {
          const hit = ctx.lookup(file, first.id);
          const decl = hit?.decl;
          const param = firstParamName(decl?.signature);
          if (decl && param) {
            const child = ensure(`param:${decl.id}:${param}`, node.framework, false);
            child.mounts.push({ parent: node.id, prefix, file, line: call.line });
          }
        }
        continue;
      }
      if (call.m === "group" && first && rest[0] && "fn" in rest[0]) {
        const child = ensure(`inline:${file}:${rest[0].fn[0]}`, node.framework, false);
        child.mounts.push({ parent: node.id, prefix: pathValue(ctx, file, first), file, line: call.line });
      }
    }
  }

  /** Middleware registered before `line` (or in the same `use` call, for a mount) whose scope covers `path`. */
  const applies = (m: RouterNode["middleware"][number], file: string, line: number, path: string, sameCall: boolean): boolean => {
    if (m.file === file && (sameCall ? m.line > line : m.line >= line)) return false;
    if (m.scope === "" || m.scope === "/") return true;
    const own = normalizePath(path);
    return own === m.scope || own.startsWith(`${m.scope}/`);
  };

  // Full paths: every chain of mounts up to a root.
  const prefixMemo = new Map<string, Array<{ text: string; partial: boolean; middleware: string[] }>>();
  const prefixesOf = (id: string, depth: number): Array<{ text: string; partial: boolean; middleware: string[] }> => {
    const memo = prefixMemo.get(id);
    if (memo) return memo;
    const node = nodes.get(id);
    if (!node) return [{ text: "", partial: false, middleware: [] }];
    let out: Array<{ text: string; partial: boolean; middleware: string[] }>;
    if (node.mounts.length === 0 || depth > 6) {
      const unknownMount = node.mounts.length === 0 && !node.root;
      if (unknownMount) ctx.unresolvedMounts++;
      out = [{ text: unknownMount ? joinPath("…", node.prefix.text) : node.prefix.text, partial: unknownMount || node.prefix.partial, middleware: [] }];
    } else {
      out = [];
      for (const mount of node.mounts.slice(0, 4)) {
        const parent = nodes.get(mount.parent);
        const parentMiddleware = (parent?.middleware ?? []).filter((m) => applies(m, mount.file, mount.line, mount.prefix.text, true)).map((m) => m.name);
        for (const up of prefixesOf(mount.parent, depth + 1)) {
          out.push({
            text: joinPath(up.text, mount.prefix.text, node.prefix.text),
            partial: up.partial || mount.prefix.partial || node.prefix.partial,
            middleware: [...up.middleware, ...parentMiddleware],
          });
        }
      }
    }
    prefixMemo.set(id, out);
    return out;
  };

  const endpoints: PartialEndpoint[] = [];
  for (const route of routes) {
    const node = nodes.get(route.node)!;
    const own = node.middleware.filter((m) => applies(m, route.file, route.line, route.path.text, false)).map((m) => m.name);
    for (const prefix of prefixesOf(route.node, 0)) {
      const path = normalizePath(joinPath(prefix.text, route.path.text));
      endpoints.push({
        kind: "http",
        method: route.method,
        path,
        ...(prefix.partial || route.path.partial ? { partial: true as const } : {}),
        framework: node.framework,
        handler: route.handler,
        ...(route.handler.file !== route.registeredAt.file || route.handler.startLine !== route.registeredAt.line ? { registeredAt: route.registeredAt } : {}),
        params: route.params,
        ...(route.request ? { request: route.request } : {}),
        ...(route.response ? { response: route.response } : {}),
        auth: [...new Set([...prefix.middleware, ...own, ...route.middleware])],
      });
    }
  }
  return endpoints;
}
