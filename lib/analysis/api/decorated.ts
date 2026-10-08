/**
 * Endpoints declared by decorators and annotations on classes and methods:
 * NestJS controllers (and its GraphQL resolvers, like type-graphql's),
 * Spring MVC / WebFlux controllers, JAX-RS resources and Micronaut
 * controllers.
 */
import type { RouteDecorator, RouteParamFact, Val } from "../ir";
import { isBool, isStr, joinPath, normalizePath, pathParams, shapeOf, valText, type ApiContext, type PartialEndpoint } from "./context";
import type { ApiParam, ApiShape } from "./types";

const short = (name: string) => name.split(".").pop() ?? name;

function strings(v: Val | undefined): string[] {
  if (!v) return [];
  if ("s" in v) return [v.s];
  if ("list" in v) return v.list.flatMap(strings);
  if ("obj" in v && v.obj.path) return strings(v.obj.path);
  if ("t" in v) return [v.t];
  return [];
}

/** The path(s) an annotation names: its first argument, `value`, `path` or `uri`. */
function pathsOf(d: RouteDecorator | undefined): string[] {
  if (!d) return [];
  const fromKw = d.kw ? strings(d.kw.value ?? d.kw.path ?? d.kw.uri) : [];
  const fromArgs = d.args.length ? strings(d.args[0]) : [];
  const all = [...fromArgs, ...fromKw];
  return all.length ? all : [];
}

const AUTH_NAME = /auth|role|guard|public|permission|scope|secur|permit|deny|login|admin|jwt|session/i;

function decoratorLabel(d: RouteDecorator): string {
  const args = [...d.args.map((a) => ("s" in a ? JSON.stringify(a.s) : valText(a).replace(/^\{|\}$/g, ""))), ...Object.entries(d.kw ?? {}).map(([k, v]) => `${k}=${"s" in v ? JSON.stringify(v.s) : valText(v).replace(/^\{|\}$/g, "")}`)];
  const inner = args.join(", ");
  return `${short(d.name)}${inner ? `(${inner.length > 60 ? `${inner.slice(0, 60)}…` : inner})` : ""}`;
}

// ---------------------------------------------------------------------------
// NestJS (+ GraphQL resolvers)
// ---------------------------------------------------------------------------

const NEST_VERBS: Record<string, string> = { Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE", Options: "OPTIONS", Head: "HEAD", All: "ANY" };
const GQL_OPS: Record<string, string> = { Query: "QUERY", Mutation: "MUTATION", Subscription: "SUBSCRIPTION" };

function nestParam(ctx: ApiContext, file: string, p: RouteParamFact): { param?: ApiParam; body?: ApiShape; query?: ApiParam[] } {
  const d = p.decorators?.[0];
  if (!d) return {};
  const name = d.args[0] && isStr(d.args[0]) ? d.args[0].s : undefined;
  switch (short(d.name)) {
    case "Param":
      return name ? { param: { name, in: "path", type: p.type, required: true } } : {};
    case "Query":
      if (name) return { param: { name, in: "query", type: p.type, required: !p.optional } };
      return { query: (shapeOf(ctx, file, p.type)?.fields ?? []).map((f) => ({ name: f.name, in: "query" as const, type: f.type, required: f.required })) };
    case "Body":
      if (name) return { param: { name, in: "body", type: p.type, required: true } };
      return { body: shapeOf(ctx, file, p.type) };
    case "Headers":
      return name ? { param: { name, in: "header", type: p.type } } : {};
    case "Args":
      return { param: { name: name ?? p.name, in: "arg", type: p.type, required: !p.optional } };
    default:
      return {};
  }
}

function resolveNest(ctx: ApiContext): PartialEndpoint[] {
  const out: PartialEndpoint[] = [];
  let globalPrefix = "";
  for (const entry of ctx.files.values()) {
    const call = entry.routes.calls?.find((c) => c.m === "setGlobalPrefix" && c.args[0] && isStr(c.args[0]));
    if (call) globalPrefix = (call.args[0] as { s: string }).s;
  }
  for (const entry of ctx.files.values()) {
    const file = entry.file;
    for (const cls of entry.routes.classes ?? []) {
      const decorators = cls.decorators ?? [];
      const controller = decorators.find((d) => short(d.name) === "Controller");
      const resolver = decorators.find((d) => short(d.name) === "Resolver");
      if (!controller && !resolver) continue;
      const classAuth = decorators.filter((d) => short(d.name) === "UseGuards" || AUTH_NAME.test(short(d.name))).flatMap((d) => (short(d.name) === "UseGuards" ? d.args.map((a) => valText(a).replace(/^\{|\}$/g, "")) : [decoratorLabel(d)]));
      const prefixes = controller ? (pathsOf(controller).length ? pathsOf(controller) : [""]) : [""];
      for (const method of cls.methods) {
        const own = method.decorators ?? [];
        const auth = [...classAuth, ...own.filter((d) => short(d.name) === "UseGuards" || AUTH_NAME.test(short(d.name))).flatMap((d) => (short(d.name) === "UseGuards" ? d.args.map((a) => valText(a).replace(/^\{|\}$/g, "")) : [decoratorLabel(d)]))];
        const handler = { file, startLine: method.line, endLine: method.endLine, name: `${cls.name}.${method.name}`, declId: `${file}#${cls.name}.${method.name}`, hash: method.hash };
        const params: ApiParam[] = [];
        let request: ApiShape | undefined;
        for (const p of method.params) {
          const r = nestParam(ctx, file, p);
          if (r.param) params.push(r.param);
          if (r.query) params.push(...r.query);
          if (r.body) request = r.body;
        }
        const response = shapeOf(ctx, file, method.returns);
        if (controller) {
          const verb = own.find((d) => NEST_VERBS[short(d.name)]);
          if (!verb) continue;
          const paths = pathsOf(verb).length ? pathsOf(verb) : [""];
          for (const prefix of prefixes) {
            for (const sub of paths) {
              const path = normalizePath(joinPath(globalPrefix, prefix, sub));
              for (const name of pathParams(path)) if (!params.some((p) => p.name === name && p.in === "path")) params.push({ name, in: "path", required: true });
              out.push({ kind: "http", method: NEST_VERBS[short(verb.name)], path, framework: "NestJS", handler, params, ...(request ? { request } : {}), ...(response ? { response } : {}), auth });
            }
          }
        } else {
          const op = own.find((d) => GQL_OPS[short(d.name)]);
          if (!op) continue;
          const options = op.args.find((a) => "obj" in a) as { obj: Record<string, Val> } | undefined;
          const name = options?.obj.name && isStr(options.obj.name) ? options.obj.name.s : method.name;
          const returnFn = op.args.find((a) => "fn" in a) as { sig?: string } | undefined;
          const returnType = /=>\s*\[?\s*([\w.]+)/.exec(op.args.map((a) => valText(a)).join(" ") + (returnFn?.sig ?? ""))?.[1];
          out.push({
            kind: "graphql",
            method: GQL_OPS[short(op.name)],
            path: name,
            framework: "GraphQL",
            group: cls.name.replace(/Resolver$/, "") || cls.name,
            handler,
            params,
            ...(response ?? (returnType ? shapeOf(ctx, file, returnType) : undefined) ? { response: response ?? shapeOf(ctx, file, returnType) } : {}),
            auth,
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spring, JAX-RS, Micronaut
// ---------------------------------------------------------------------------

const SPRING_VERBS: Record<string, string> = { GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", DeleteMapping: "DELETE", PatchMapping: "PATCH" };
const JAXRS_VERBS: Record<string, string> = { GET: "GET", POST: "POST", PUT: "PUT", DELETE: "DELETE", PATCH: "PATCH", HEAD: "HEAD", OPTIONS: "OPTIONS" };
const MICRONAUT_VERBS: Record<string, string> = { Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE", Patch: "PATCH", Head: "HEAD", Options: "OPTIONS" };
const JVM_AUTH = new Set(["PreAuthorize", "PostAuthorize", "Secured", "RolesAllowed", "PermitAll", "DenyAll", "Authenticated", "Anonymous"]);

function jvmParam(ctx: ApiContext, file: string, p: RouteParamFact, jaxrs: boolean): { param?: ApiParam; body?: ApiShape } {
  const ann = p.annotations ?? [];
  const named = (a: RouteDecorator) => (a.args[0] && isStr(a.args[0]) ? a.args[0].s : a.kw?.value && isStr(a.kw.value) ? a.kw.value.s : a.kw?.name && isStr(a.kw.name) ? a.kw.name.s : p.name);
  const optional = (a: RouteDecorator) => isBool(a.kw?.required, false) || Boolean(a.kw?.defaultValue);
  for (const a of ann) {
    switch (short(a.name)) {
      case "PathVariable":
      case "PathParam":
        return { param: { name: named(a), in: "path", type: p.type, required: true } };
      case "RequestParam":
      case "QueryParam":
      case "QueryValue":
        return { param: { name: named(a), in: "query", type: p.type, required: !optional(a) } };
      case "RequestHeader":
      case "HeaderParam":
      case "Header":
        return { param: { name: named(a), in: "header", type: p.type, required: !optional(a) } };
      case "CookieValue":
      case "CookieParam":
        return { param: { name: named(a), in: "cookie", type: p.type } };
      case "RequestBody":
      case "Body":
        return { body: shapeOf(ctx, file, p.type) };
      case "FormParam":
      case "RequestPart":
        return { param: { name: named(a), in: "form", type: p.type } };
      default:
    }
  }
  // JAX-RS: the one un-annotated parameter is the entity body.
  if (jaxrs && ann.length === 0 && p.type && !/^(HttpServletRequest|HttpServletResponse|Principal|Authentication|Model|BindingResult|Locale)$/.test(p.type)) return { body: shapeOf(ctx, file, p.type) };
  return {};
}

function resolveJvm(ctx: ApiContext): PartialEndpoint[] {
  const out: PartialEndpoint[] = [];
  for (const entry of ctx.files.values()) {
    const file = entry.file;
    for (const cls of entry.routes.classes ?? []) {
      const ann = cls.annotations ?? [];
      const names = new Set(ann.map((a) => short(a.name)));
      const spring = names.has("RestController") || (names.has("Controller") && !ann.find((a) => short(a.name) === "Controller")?.args.length) || names.has("RequestMapping");
      const jaxrs = names.has("Path");
      const micronaut = names.has("Controller") && !spring;
      if (!spring && !jaxrs && !micronaut) continue;
      const prefixAnn = ann.find((a) => ["RequestMapping", "Path"].includes(short(a.name))) ?? (micronaut ? ann.find((a) => short(a.name) === "Controller") : undefined);
      const prefixes = pathsOf(prefixAnn).length ? pathsOf(prefixAnn) : [""];
      const classAuth = ann.filter((a) => JVM_AUTH.has(short(a.name))).map(decoratorLabel);
      for (const method of cls.methods) {
        const mAnn = method.annotations ?? [];
        let verbs: string[] = [];
        let paths: string[] = [];
        for (const a of mAnn) {
          const n = short(a.name);
          if (spring && SPRING_VERBS[n]) {
            verbs = [SPRING_VERBS[n]];
            paths = pathsOf(a);
          } else if (spring && n === "RequestMapping") {
            const m = a.kw?.method;
            verbs = m ? ("list" in m ? m.list : [m]).map((v) => valText(v).replace(/^\{|\}$/g, "").split(".").pop()!.toUpperCase()) : ["ANY"];
            paths = pathsOf(a);
          } else if (jaxrs && JAXRS_VERBS[n]) verbs = [JAXRS_VERBS[n]];
          else if (jaxrs && n === "Path") paths = pathsOf(a);
          else if (micronaut && MICRONAUT_VERBS[n]) {
            verbs = [MICRONAUT_VERBS[n]];
            paths = pathsOf(a);
          }
        }
        if (verbs.length === 0) continue;
        if (paths.length === 0) paths = [""];
        const params: ApiParam[] = [];
        let request: ApiShape | undefined;
        for (const p of method.params) {
          const r = jvmParam(ctx, file, p, jaxrs);
          if (r.param) params.push(r.param);
          if (r.body) request = r.body;
        }
        const response = shapeOf(ctx, file, method.returns);
        const auth = [...classAuth, ...mAnn.filter((a) => JVM_AUTH.has(short(a.name))).map(decoratorLabel)];
        const handler = { file, startLine: method.line, endLine: method.endLine, name: `${cls.name}.${method.name}`, declId: `${file}#${cls.name}.${method.name}`, hash: method.hash };
        const framework = spring ? "Spring" : jaxrs ? "JAX-RS" : "Micronaut";
        for (const prefix of prefixes) {
          for (const sub of paths) {
            const path = normalizePath(joinPath(prefix, sub));
            for (const verb of verbs) {
              out.push({ kind: "http", method: verb, path, framework, handler, params, ...(request ? { request } : {}), ...(response ? { response } : {}), auth });
            }
          }
        }
      }
    }
  }
  return out;
}

export function resolveDecorated(ctx: ApiContext): PartialEndpoint[] {
  const js: PartialEndpoint[] = [];
  const jvm: PartialEndpoint[] = [];
  const hasJs = [...ctx.files.values()].some((e) => e.routes.classes && /\.(tsx?|jsx?|mjs)$/.test(e.file));
  const hasJvm = [...ctx.files.values()].some((e) => e.routes.classes && /\.(java|kt)$/.test(e.file));
  if (hasJs) js.push(...resolveNest(ctx));
  if (hasJvm) jvm.push(...resolveJvm(ctx));
  return [...js, ...jvm];
}
