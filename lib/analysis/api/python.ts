/**
 * Python web frameworks:
 *
 * - FastAPI / Starlette / Flask / Quart / Django Ninja: decorated functions
 *   on an app or router (`@router.get("/x")`), routers mounted with
 *   `include_router(r, prefix=…)`, `register_blueprint(bp, url_prefix=…)`,
 *   `add_router("/x", r)`; FastAPI parameters say where each input comes
 *   from (path, query, a Pydantic body, `Depends(…)`).
 * - Django: `urlpatterns` followed through `include("app.urls")`, function
 *   and class-based views, and Django REST framework routers and viewsets.
 */
import type { ModelFact, PyDecoratedFact, Val } from "../ir";
import { declHandler, isBool, isStr, joinPath, modelFields, normalizePath, pathParams, pathValue, shapeOf, valText, type ApiContext, type PartialEndpoint } from "./context";
import type { ApiField, ApiHandler, ApiParam, ApiShape } from "./types";

const FACTORY_FRAMEWORK: Record<string, string> = {
  FastAPI: "FastAPI", APIRouter: "FastAPI", Flask: "Flask", Blueprint: "Flask", Quart: "Quart", Starlette: "Starlette",
  Router: "Django Ninja", NinjaAPI: "Django Ninja", Sanic: "Sanic", Litestar: "Litestar",
};
const ROOT_FACTORIES = new Set(["FastAPI", "Flask", "Quart", "Starlette", "NinjaAPI", "Sanic", "Litestar"]);
const ROUTE_VERBS: Record<string, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", head: "HEAD", options: "OPTIONS", websocket: "WS", route: "ROUTE", api_route: "ROUTE" };
const SKIP_PARAM_TYPES = /^(Request|Response|BackgroundTasks|WebSocket|Session|AsyncSession|HttpRequest|Depends)\b/;
const PY_IMPORTS = /^(fastapi|flask|starlette|quart|ninja|sanic|litestar)(\.|$)/;

const final = (callee: string) => callee.split(".").pop() ?? callee;
const strList = (v: Val | undefined): string[] => (!v ? [] : "list" in v ? v.list.filter(isStr).map((s) => s.s) : isStr(v) ? [v.s] : []);

interface PyRouter {
  id: string;
  framework: string;
  root: boolean;
  prefix: { text: string; partial: boolean };
  deps: string[];
  mounts: Array<{ parent: string; prefix: { text: string; partial: boolean }; deps: string[] }>;
}

/** `Depends(get_user)` / `Security(x, scopes=…)` → `get_user`. */
function dependsName(v: Val | undefined): string | undefined {
  if (!v || !("call" in v) || !/^(Depends|Security)$/.test(final(v.call))) return undefined;
  const target = v.args[0];
  return target ? valText(target).replace(/^\{|\}$/g, "") : final(v.call);
}

function depsOf(v: Val | undefined): string[] {
  return v && "list" in v ? v.list.map(dependsName).filter((n): n is string => Boolean(n)) : [];
}

/** A Django model field type, readable: `models.CharField` → `Char`, `serializers.EmailField` → `Email`. */
function friendlyType(type: string): string {
  return final(type).replace(/Field$/, "") || type;
}

function fieldsOfModel(m: ModelFact): ApiField[] {
  return m.fields.map((f) => ({
    name: f.name,
    type: f.call ? friendlyType(f.type) : f.type,
    required: !f.optional && !/required\s*=\s*False|null\s*=\s*True|blank\s*=\s*True|read_only\s*=\s*True|default\s*=/.test(f.call ?? "") && !/^Optional\[|\|\s*None$/.test(f.type),
  }));
}

export function resolvePython(ctx: ApiContext): PartialEndpoint[] {
  const out: PartialEndpoint[] = [];
  const routers = new Map<string, PyRouter>();
  const pyFiles = [...ctx.files.values()].filter((e) => e.language === "python");
  if (pyFiles.length === 0) return out;

  for (const entry of pyFiles) {
    for (const create of entry.routes.creates ?? []) {
      const name = final(create.callee);
      const framework = FACTORY_FRAMEWORK[name];
      if (!framework) continue;
      const prefixVal = create.kw?.prefix ?? create.kw?.url_prefix;
      routers.set(`${entry.file}#${create.local}`, {
        id: `${entry.file}#${create.local}`,
        framework,
        root: ROOT_FACTORIES.has(name),
        prefix: prefixVal ? pathValue(ctx, entry.file, prefixVal) : { text: "", partial: false },
        deps: depsOf(create.kw?.dependencies),
        mounts: [],
      });
    }
  }

  const routerFor = (file: string, ref: string): PyRouter | undefined => {
    const hit = ctx.lookup(file, ref);
    if (hit) {
      const r = routers.get(`${hit.file}#${hit.name}`);
      if (r) return r;
    }
    const own = routers.get(`${file}#${ref}`);
    if (own) return own;
    // A module imported whole: `users.router` where `users` is `from . import users`.
    const [head, ...rest] = ref.split(".");
    const sourceFile = rest.length ? ctx.moduleOf(file, head) : undefined;
    return sourceFile ? routers.get(`${sourceFile}#${rest.join(".")}`) : undefined;
  };

  for (const entry of pyFiles) {
    for (const call of entry.routes.calls ?? []) {
      const parent = routerFor(entry.file, call.obj);
      if (!parent) continue;
      let childVal: Val | undefined;
      let prefixVal: Val | undefined;
      if (call.m === "include_router" || call.m === "register_blueprint") {
        childVal = call.args[0];
        prefixVal = call.kw?.prefix ?? call.kw?.url_prefix;
      } else if (call.m === "add_router" || call.m === "mount") {
        prefixVal = call.args[0];
        childVal = call.args[1] ?? call.kw?.app ?? call.kw?.router;
      } else continue;
      const child = childVal && "id" in childVal ? routerFor(entry.file, childVal.id) : undefined;
      if (!child) {
        ctx.unresolvedMounts++;
        continue;
      }
      child.mounts.push({ parent: parent.id, prefix: prefixVal ? pathValue(ctx, entry.file, prefixVal) : { text: "", partial: false }, deps: depsOf(call.kw?.dependencies) });
    }
  }

  const prefixesOf = (id: string, depth: number): Array<{ text: string; partial: boolean; deps: string[] }> => {
    const r = routers.get(id);
    if (!r) return [{ text: "", partial: false, deps: [] }];
    if (r.mounts.length === 0 || depth > 6) {
      const unknown = r.mounts.length === 0 && !r.root;
      if (unknown) ctx.unresolvedMounts++;
      return [{ text: unknown ? joinPath("…", r.prefix.text) : r.prefix.text, partial: unknown || r.prefix.partial, deps: r.deps }];
    }
    return r.mounts.slice(0, 4).flatMap((m) =>
      prefixesOf(m.parent, depth + 1).map((up) => ({
        text: joinPath(up.text, m.prefix.text, r.prefix.text),
        partial: up.partial || m.prefix.partial || r.prefix.partial,
        deps: [...up.deps, ...m.deps, ...r.deps],
      })),
    );
  };

  // Decorated route functions.
  for (const entry of pyFiles) {
    const file = entry.file;
    const usesFramework = entry.facts.imports.some((i) => PY_IMPORTS.test(i.source));
    for (const fn of entry.routes.decorated ?? []) {
      if (fn.kind === "class") continue;
      for (const dec of fn.decorators) {
        const parts = dec.name.split(".");
        const verbName = parts.pop()!;
        const verb = ROUTE_VERBS[verbName];
        if (!verb || parts.length === 0) continue;
        const objRef = parts.join(".");
        let router = routerFor(file, objRef);
        if (!router && usesFramework && /^(app|router|api|bp|blueprint|v\d+)$/i.test(objRef)) {
          router = { id: `${file}#${objRef}`, framework: "FastAPI", root: /^(app|api)$/i.test(objRef), prefix: { text: "", partial: false }, deps: [], mounts: [] };
          routers.set(router.id, router);
        }
        if (!router) continue;
        const pathVal = dec.args[0] ?? dec.kw?.path ?? dec.kw?.rule;
        const own = pathValue(ctx, file, pathVal);
        const methods = verb === "ROUTE" ? (strList(dec.kw?.methods).map((m) => m.toUpperCase()) as string[]) : [verb];
        if (methods.length === 0) methods.push(router.framework === "Flask" || router.framework === "Quart" ? "GET" : "ANY");
        const handler: ApiHandler = declHandler(ctx, file, fn.parent ? `${fn.parent}.${fn.name}` : fn.name) ?? { file, startLine: fn.line, endLine: fn.endLine, name: fn.name, hash: fn.hash };
        const routeDeps = depsOf(dec.kw?.dependencies);
        const otherDecorators = fn.decorators.filter((d) => d !== dec).map((d) => d.name.split("(")[0]);
        for (const prefix of prefixesOf(router.id, 0)) {
          const path = normalizePath(joinPath(prefix.text, own.text));
          const { params, request, deps } = fastapiParams(ctx, file, fn, path);
          const responseModel = dec.kw?.response_model;
          const response = responseModel ? shapeOf(ctx, file, valText(responseModel).replace(/^\{|\}$/g, "")) : shapeOf(ctx, file, fn.returns);
          for (const method of methods) {
            out.push({
              kind: "http",
              method,
              path,
              ...(prefix.partial || own.partial ? { partial: true as const } : {}),
              framework: router.framework,
              handler,
              params,
              ...(request ? { request } : {}),
              ...(response ? { response } : {}),
              auth: [...new Set([...prefix.deps, ...routeDeps, ...deps, ...otherDecorators])],
            });
          }
        }
      }
    }
  }

  out.push(...resolveDjango(ctx, pyFiles.map((e) => e.file)));
  return out;
}

/** FastAPI's reading of a route function's parameters. */
function fastapiParams(ctx: ApiContext, file: string, fn: PyDecoratedFact, path: string): { params: ApiParam[]; request?: ApiShape; deps: string[] } {
  const inPath = new Set(pathParams(path));
  const params: ApiParam[] = [];
  const deps: string[] = [];
  let request: ApiShape | undefined;
  for (const p of fn.params) {
    if (p.name === "self" || p.name === "cls") continue;
    const dep = dependsName(p.default) ?? (p.type ? /Annotated\[[^,]+,\s*Depends\(([\w.]+)/.exec(p.type)?.[1] : undefined);
    if (dep) {
      deps.push(dep);
      continue;
    }
    if (p.type && SKIP_PARAM_TYPES.test(p.type)) continue;
    const marker = p.default && "call" in p.default ? final(p.default.call) : p.type ? /Annotated\[[^,]+,\s*(Path|Query|Body|Header|Cookie|Form|File)\(/.exec(p.type)?.[1] : undefined;
    const required = !p.default || (p.default && "call" in p.default && (p.default.args.length === 0 || valText(p.default.args[0]) === "{...}" || ("x" in p.default.args[0] && p.default.args[0].x === "...")));
    const location = marker === "Path" ? "path" : marker === "Query" ? "query" : marker === "Header" ? "header" : marker === "Cookie" ? "cookie" : marker === "Form" || marker === "File" ? "form" : marker === "Body" ? "body" : undefined;
    if (inPath.has(p.name) || location === "path") {
      params.push({ name: p.name, in: "path", ...(p.type ? { type: p.type } : {}), required: true });
      continue;
    }
    const fields = p.type ? modelFields(ctx, file, p.type.replace(/^Annotated\[([^,]+),[\s\S]*\]$/, "$1").trim()) : undefined;
    if ((fields && location !== "query") || location === "body") {
      request = { type: p.type, ...(fields ? { fields } : {}), source: "static" };
      continue;
    }
    params.push({ name: p.name, in: location ?? "query", ...(p.type ? { type: p.type } : {}), required: Boolean(required) });
  }
  for (const name of inPath) if (!params.some((p) => p.name === name)) params.push({ name, in: "path", required: true });
  return { params, ...(request ? { request } : {}), deps };
}

// ---------------------------------------------------------------------------
// Django + Django REST framework
// ---------------------------------------------------------------------------

const GENERIC_VIEW_METHODS: Array<[RegExp, string[]]> = [
  [/RetrieveUpdateDestroy/, ["GET", "PUT", "PATCH", "DELETE"]],
  [/RetrieveUpdate/, ["GET", "PUT", "PATCH"]],
  [/RetrieveDestroy/, ["GET", "DELETE"]],
  [/ListCreate/, ["GET", "POST"]],
  [/(List|Retrieve|Detail|Template|Redirect)(API)?View/, ["GET"]],
  [/Create(API)?View/, ["POST"]],
  [/Update(API)?View/, ["PUT", "PATCH"]],
  [/Destroy(API)?View|DeleteView/, ["DELETE"]],
  [/FormView/, ["GET", "POST"]],
];
const VIEWSET_ACTIONS: Array<{ action: string; method: string; detail: boolean }> = [
  { action: "list", method: "GET", detail: false },
  { action: "create", method: "POST", detail: false },
  { action: "retrieve", method: "GET", detail: true },
  { action: "update", method: "PUT", detail: true },
  { action: "partial_update", method: "PATCH", detail: true },
  { action: "destroy", method: "DELETE", detail: true },
];

function resolveDjango(ctx: ApiContext, pyFiles: string[]): PartialEndpoint[] {
  const out: PartialEndpoint[] = [];
  const urlFiles = pyFiles.filter((f) => ctx.files.get(f)!.routes.urlpatterns?.length);
  if (urlFiles.length === 0) return out;

  /** `"shop.urls"` → the file. */
  const moduleFile = (dotted: string): string | undefined => {
    const base = dotted.replace(/\./g, "/");
    return pyFiles.find((f) => f === `${base}.py` || f.endsWith(`/${base}.py`) || f === `${base}/__init__.py` || f.endsWith(`/${base}/__init__.py`));
  };

  const included = new Set<string>();
  const includesOf = (file: string): string[] => {
    const found: string[] = [];
    const visit = (v: Val) => {
      if ("list" in v) v.list.forEach(visit);
      else if ("call" in v) {
        if (final(v.call) === "include") {
          const arg = v.args[0];
          const target = arg && isStr(arg) ? moduleFile(arg.s) : arg && "list" in arg && arg.list[0] && isStr(arg.list[0]) ? moduleFile(arg.list[0].s) : undefined;
          if (target) found.push(target);
        }
        v.args.forEach(visit);
      }
    };
    for (const p of ctx.files.get(file)!.routes.urlpatterns ?? []) visit(p.value);
    return found;
  };
  for (const f of urlFiles) for (const t of includesOf(f)) included.add(t);
  const roots = urlFiles.filter((f) => !included.has(f));

  const modelOf = (file: string, name: string): { file: string; model: ModelFact } | undefined => {
    const hit = ctx.lookup(file, name);
    const target = hit?.file ?? file;
    const short = (hit?.name ?? name).split(".").pop()!;
    const model = ctx.files.get(target)?.routes.models?.find((m) => m.name === short);
    return model ? { file: target, model } : undefined;
  };

  const serializerShape = (file: string, viewModel: ModelFact | undefined): ApiShape | undefined => {
    const ser = viewModel?.attrs?.serializer_class;
    if (!ser || !("id" in ser)) return undefined;
    const found = modelOf(file, ser.id);
    if (!found) return { type: ser.id, source: "static" };
    let fields = fieldsOfModel(found.model);
    const metaFields = found.model.meta?.fields;
    if (metaFields && "list" in metaFields) {
      const names = metaFields.list.filter(isStr).map((s) => s.s);
      const modelRef = found.model.meta?.model;
      const target = modelRef && "id" in modelRef ? modelOf(found.file, modelRef.id) : undefined;
      const modelFieldsByName = new Map((target ? fieldsOfModel(target.model) : []).map((f) => [f.name, f]));
      for (const n of names) if (!fields.some((f) => f.name === n)) fields.push(modelFieldsByName.get(n) ?? { name: n, type: n === "id" ? "id" : "?", required: n !== "id" });
    }
    if (fields.length === 0) fields = [];
    return { type: ser.id, ...(fields.length ? { fields } : {}), source: "static" };
  };

  const authOf = (model: ModelFact | undefined, decorators: string[]): string[] => {
    const perms = model?.attrs?.permission_classes;
    const list = perms && "list" in perms ? perms.list.map((p) => valText(p).replace(/^\{|\}$/g, "")) : [];
    return [...list, ...decorators];
  };

  const emitView = (file: string, view: Val, path: string, partial: boolean, extra?: Val) => {
    // `views.home`, `home`
    if ("id" in view) {
      const hit = ctx.lookup(file, view.id) ?? (() => {
        const [head, ...rest] = view.id.split(".");
        const sourceFile = rest.length ? ctx.moduleOf(file, head) : undefined;
        return sourceFile ? { file: sourceFile, name: rest.join(".") } : undefined;
      })();
      if (!hit) {
        out.push({ kind: "http", method: "ANY", path, ...(partial ? { partial: true as const } : {}), framework: "Django", handler: { file, startLine: 1, endLine: 1, name: view.id }, params: pathParamsOf(path), auth: [] });
        return;
      }
      const decorated = ctx.files.get(hit.file)?.routes.decorated?.find((d) => d.name === hit.name && !d.parent);
      const methodsDec = decorated?.decorators.find((d) => /^(api_view|require_http_methods)$/.test(final(d.name)));
      const methods = methodsDec ? strList(methodsDec.args[0]).map((m) => m.toUpperCase()) : decorated?.decorators.some((d) => final(d.name) === "require_GET") ? ["GET"] : decorated?.decorators.some((d) => final(d.name) === "require_POST") ? ["POST"] : ["ANY"];
      const handler = declHandler(ctx, hit.file, hit.name) ?? { file: hit.file, startLine: 1, endLine: 1, name: hit.name };
      const auth = (decorated?.decorators ?? []).filter((d) => d !== methodsDec && !/^require_(GET|POST|http_methods)$/.test(final(d.name))).map((d) => final(d.name));
      for (const method of methods.length ? methods : ["ANY"]) out.push({ kind: "http", method, path, ...(partial ? { partial: true as const } : {}), framework: methodsDec?.name === "api_view" ? "Django REST" : "Django", handler, params: pathParamsOf(path), auth });
      return;
    }
    // `UserView.as_view()` / `UserViewSet.as_view({"get": "list"})`
    if ("call" in view && /\.as_view$/.test(view.call)) {
      const className = view.call.replace(/\.as_view$/, "");
      const hit = ctx.lookup(file, className) ?? { file, name: className };
      const short = hit.name.split(".").pop()!;
      const model = ctx.files.get(hit.file)?.routes.models?.find((m) => m.name === short);
      const decl = ctx.declById.get(`${hit.file}#${short}`);
      const shape = serializerShape(hit.file, model);
      const auth = authOf(model, []);
      const mapping = view.args[0] && "obj" in view.args[0] ? view.args[0].obj : undefined;
      const routes: Array<{ method: string; handler: string | undefined }> = [];
      if (mapping) for (const [m, action] of Object.entries(mapping)) routes.push({ method: m.toUpperCase(), handler: isStr(action) ? action.s : undefined });
      else {
        for (const m of ["get", "post", "put", "patch", "delete"]) if (ctx.declById.has(`${hit.file}#${short}.${m}`)) routes.push({ method: m.toUpperCase(), handler: m });
        if (routes.length === 0) {
          const bases = decl?.signature ?? "";
          const methods = GENERIC_VIEW_METHODS.find(([re]) => re.test(bases))?.[1] ?? ["ANY"];
          for (const m of methods) routes.push({ method: m, handler: undefined });
        }
      }
      for (const r of routes) {
        const handler: ApiHandler =
          (r.handler ? declHandler(ctx, hit.file, `${short}.${r.handler}`) : undefined) ??
          declHandler(ctx, hit.file, short) ?? { file: hit.file, startLine: 1, endLine: 1, name: short };
        const writes = r.method === "POST" || r.method === "PUT" || r.method === "PATCH";
        out.push({
          kind: "http",
          method: r.method,
          path,
          ...(partial ? { partial: true as const } : {}),
          framework: model?.attrs?.serializer_class ? "Django REST" : "Django",
          handler,
          params: pathParamsOf(path),
          ...(shape && writes ? { request: shape } : {}),
          ...(shape && r.method !== "DELETE" ? { response: shape } : {}),
          auth,
        });
      }
      return;
    }
    void extra;
  };

  const emitRouter = (file: string, routerRef: string, prefix: string, partial: boolean) => {
    const hit = ctx.lookup(file, routerRef);
    const routerFile = hit?.file ?? file;
    const name = (hit?.name ?? routerRef).split(".")[0];
    for (const call of ctx.files.get(routerFile)?.routes.calls ?? []) {
      if (call.m !== "register" || call.obj !== name) continue;
      const resource = pathValue(ctx, routerFile, call.args[0]);
      const viewset = call.args[1];
      if (!viewset || !("id" in viewset)) continue;
      const vsHit = ctx.lookup(routerFile, viewset.id) ?? { file: routerFile, name: viewset.id };
      const short = vsHit.name.split(".").pop()!;
      const model = ctx.files.get(vsHit.file)?.routes.models?.find((m) => m.name === short);
      const decl = ctx.declById.get(`${vsHit.file}#${short}`);
      const shape = serializerShape(vsHit.file, model);
      const auth = authOf(model, []);
      const lookupField = model?.attrs?.lookup_field && isStr(model.attrs.lookup_field) ? model.attrs.lookup_field.s : "pk";
      const base = joinPath(prefix, resource.text);
      const isModelViewSet = /ModelViewSet/.test(decl?.signature ?? "") && !/ReadOnlyModelViewSet/.test(decl?.signature ?? "");
      const readOnly = /ReadOnlyModelViewSet/.test(decl?.signature ?? "");
      for (const a of VIEWSET_ACTIONS) {
        const own = ctx.declById.has(`${vsHit.file}#${short}.${a.action}`);
        const inherited = isModelViewSet || (readOnly && (a.action === "list" || a.action === "retrieve")) || new RegExp(`${a.action.replace("partial_", "").replace(/^./, (c) => c.toUpperCase())}ModelMixin`, "i").test(decl?.signature ?? "");
        if (!own && !inherited) continue;
        const path = normalizePath(a.detail ? joinPath(base, `{${lookupField}}`) : base);
        const writes = a.method !== "GET" && a.method !== "DELETE";
        out.push({
          kind: "http",
          method: a.method,
          path,
          ...(partial || resource.partial ? { partial: true as const } : {}),
          framework: "Django REST",
          group: resource.text.replace(/^\^|\/?\$?$/g, "") || short,
          handler: (own ? declHandler(ctx, vsHit.file, `${short}.${a.action}`) : undefined) ?? declHandler(ctx, vsHit.file, short) ?? { file: vsHit.file, startLine: 1, endLine: 1, name: `${short}.${a.action}` },
          params: pathParamsOf(path),
          ...(shape && writes ? { request: shape } : {}),
          ...(shape && a.method !== "DELETE" ? { response: shape } : {}),
          auth,
        });
      }
      // @action(detail=True, methods=["post"]) extra routes.
      for (const fn of ctx.files.get(vsHit.file)?.routes.decorated ?? []) {
        if (fn.parent !== short) continue;
        const dec = fn.decorators.find((d) => final(d.name) === "action");
        if (!dec) continue;
        const detail = isBool(dec.kw?.detail, true);
        const urlPath = dec.kw?.url_path && isStr(dec.kw.url_path) ? dec.kw.url_path.s : fn.name;
        const path = normalizePath(detail ? joinPath(base, `{${lookupField}}`, urlPath) : joinPath(base, urlPath));
        for (const m of strList(dec.kw?.methods).length ? strList(dec.kw?.methods) : ["get"]) {
          out.push({
            kind: "http",
            method: m.toUpperCase(),
            path,
            ...(partial ? { partial: true as const } : {}),
            framework: "Django REST",
            group: resource.text || short,
            handler: declHandler(ctx, vsHit.file, `${short}.${fn.name}`) ?? { file: vsHit.file, startLine: fn.line, endLine: fn.endLine, name: fn.name, hash: fn.hash },
            params: pathParamsOf(path),
            auth,
          });
        }
      }
    }
  };

  const walk = (file: string, prefix: string, partial: boolean, depth: number, seen: Set<string>) => {
    if (depth > 6 || seen.has(file)) return;
    const nextSeen = new Set(seen).add(file);
    const visit = (v: Val) => {
      if ("list" in v) {
        v.list.forEach(visit);
        return;
      }
      // `router.urls` joined into urlpatterns.
      if ("id" in v && v.id.endsWith(".urls")) {
        emitRouter(file, v.id.slice(0, -5), prefix, partial);
        return;
      }
      if (!("call" in v) || !/^(path|re_path|url)$/.test(final(v.call))) return;
      const route = pathValue(ctx, file, v.args[0]);
      const full = joinPath(prefix, route.text.replace(/^\^/, "").replace(/\$$/, ""));
      const target = v.args[1];
      if (!target) return;
      if ("call" in target && final(target.call) === "include") {
        const arg = target.args[0];
        if (arg && "id" in arg && arg.id.endsWith(".urls")) emitRouter(file, arg.id.slice(0, -5), full, partial || route.partial);
        else if (arg && "list" in arg && !isStr(arg.list[0])) {
          for (const item of arg.list) visit({ call: "path", args: [{ s: route.text }, ...("call" in item ? [item] : [])] } as Val);
        } else {
          const sourceFile = arg && isStr(arg) ? moduleFile(arg.s) : arg && "list" in arg && arg.list[0] && isStr(arg.list[0]) ? moduleFile(arg.list[0].s) : undefined;
          if (sourceFile) walk(sourceFile, full, partial || route.partial, depth + 1, nextSeen);
          else ctx.unresolvedMounts++;
        }
        return;
      }
      emitView(file, target, normalizePath(full), partial || route.partial);
    };
    for (const p of ctx.files.get(file)!.routes.urlpatterns ?? []) visit(p.value);
  };
  for (const root of roots) walk(root, "", false, 0, new Set());
  return out;
}

function pathParamsOf(path: string): ApiParam[] {
  return pathParams(path).map((name) => ({ name, in: "path" as const, required: true }));
}
