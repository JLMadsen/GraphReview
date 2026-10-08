/**
 * Next.js: App Router route handlers (`app/**\/route.ts` exporting GET,
 * POST, …), Pages Router API routes (`pages/api/**`, any method), server
 * actions (`"use server"` files and functions — listed, but marked
 * internal: they are the app's own backend-for-frontend), and
 * `middleware.ts` matchers in front of the HTTP ones.
 */
import { declHandler, normalizePath, parseTsFields, shapeOf, splitTop, type ApiContext, type PartialEndpoint } from "./context";
import type { ApiParam, ApiShape } from "./types";

const HTTP_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const CODE = /\.(tsx?|jsx?|mjs|cjs)$/;

/** Where an app's `app/` or `pages/` folder sits, and the URL a file under it serves. */
function routeOf(file: string, kind: "app" | "pages"): { root: string; url: string } | undefined {
  const segments = file.split("/");
  const name = segments[segments.length - 1];
  if (!CODE.test(name)) return undefined;
  if (kind === "app" && !/^route\.(tsx?|jsx?|mjs)$/.test(name)) return undefined;
  const at = segments.lastIndexOf(kind === "app" ? "app" : "pages", segments.length - 2);
  if (at === -1) return undefined;
  const rest = segments.slice(at + 1, kind === "app" ? -1 : undefined);
  if (kind === "pages") {
    if (rest[0] !== "api") return undefined;
    rest[rest.length - 1] = rest[rest.length - 1].replace(CODE, "");
    if (rest[rest.length - 1] === "index") rest.pop();
  }
  const url = rest
    .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@") && s !== "")
    .map((s) => s.replace(/^\[\[\.\.\.(\w+)\]\]$/, "{$1*?}").replace(/^\[\.\.\.(\w+)\]$/, "{$1*}").replace(/^\[(\w+)\]$/, "{$1}"));
  let root = segments.slice(0, at).join("/");
  if (root.endsWith("src")) root = root.slice(0, -3).replace(/\/$/, "");
  return { root, url: `/${url.join("/")}` };
}

/** `basePath` from the app's next.config. */
async function basePathOf(ctx: ApiContext, root: string, cache: Map<string, string>): Promise<string> {
  const hit = cache.get(root);
  if (hit !== undefined) return hit;
  let base = "";
  for (const name of ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"]) {
    const path = root ? `${root}/${name}` : name;
    if (!ctx.allFiles.has(path)) continue;
    const text = await ctx.readText(path);
    const m = text ? /basePath\s*:\s*['"`]([^'"`]*)['"`]/.exec(text) : null;
    if (m) base = m[1];
    break;
  }
  cache.set(root, base);
  return base;
}

/** `middleware.ts` (or Next 16's `proxy.ts`) of an app, and which paths it runs for. */
function middlewareOf(ctx: ApiContext, root: string): { file: string; matches: (path: string) => boolean } | undefined {
  for (const dir of [root, root ? `${root}/src` : "src"]) {
    for (const base of ["middleware", "proxy"]) {
      for (const ext of ["ts", "js", "mjs"]) {
        const file = dir ? `${dir}/${base}.${ext}` : `${base}.${ext}`;
        if (!ctx.files.has(file)) continue;
        const config = ctx.declById.get(`${file}#config`)?.signature ?? "";
        const matcherText = /matcher\s*:\s*(\[[\s\S]*?\]|(['"`])[^'"`]*\2)/.exec(config)?.[1];
        if (!matcherText) return { file, matches: () => true };
        const patterns = [...matcherText.matchAll(/(['"`])([^'"`]+)\1/g)].map((m) => m[2]);
        const regexes = patterns.map((p) => {
          try {
            const source = p
              .replace(/\/:(\w+)\*/g, "(?:/.*)?")
              .replace(/\/:(\w+)\+/g, "/.+")
              .replace(/\/:(\w+)\?/g, "(?:/[^/]+)?")
              .replace(/:(\w+)/g, "[^/]+");
            return new RegExp(`^${source}$`);
          } catch {
            return null;
          }
        });
        return {
          file,
          matches: (path) => regexes.length === 0 || regexes.some((re) => re === null || re.test(path.replace(/\{[^}]*\}/g, "x"))),
        };
      }
    }
  }
  return undefined;
}

/** The type after a function head's `):`, if it says one. */
export function returnTypeOf(signature: string): string | undefined {
  const m = /\)\s*:\s*([^=]+?)\s*(=>\s*)?\{?\s*$/.exec(signature);
  return m?.[1]?.trim() || undefined;
}

/** `export const GET = withAuth(async (req) => …)`: the wrapper, which usually is the auth. */
export function wrapperOf(signature: string | undefined): string | undefined {
  const m = signature ? /^\s*[\w$]+\s*(?::[^=]+)?=\s*(?:await\s+)?([\w$.]+)\s*\(/.exec(signature) : null;
  return m && !/^(async|function)$/.test(m[1]) ? m[1] : undefined;
}

/** A zod schema the handler `.parse`s or `.safeParse`s — the request body, most of the time. */
export function zodParsedIn(ctx: ApiContext, file: string, start: number, end: number): ApiShape | undefined {
  const entry = ctx.files.get(file);
  if (!entry) return undefined;
  for (const [key, lines] of Object.entries(entry.facts.members)) {
    const m = /^([\w$]+)\.(parse|safeParse|parseAsync|safeParseAsync)$/.exec(key);
    if (!m || !lines.some((l) => l >= start && l <= end)) continue;
    const hit = ctx.lookup(file, m[1]);
    const sig = hit?.decl?.signature;
    if (sig && /\bz\.object\(/.test(sig)) {
      const fields = parseTsFields(sig);
      return { type: m[1], ...(fields ? { fields } : {}), source: "static" };
    }
  }
  return undefined;
}

/** A function head's parameters: `(id: string, data: Partial<X>)`. */
function argParams(signature: string): ApiParam[] {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open === -1 || close <= open) return [];
  return splitTop(signature.slice(open + 1, close), ",")
    .map((part): ApiParam | null => {
      const m = /^([\w$]+)(\?)?\s*(?::\s*([\s\S]+?))?(\s*=\s*[\s\S]+)?$/.exec(part.trim());
      if (!m) return null;
      return { name: m[1], in: "arg", ...(m[3] ? { type: m[3].trim() } : {}), required: !m[2] && !m[4] };
    })
    .filter((p): p is ApiParam => p !== null);
}

export async function resolveNext(ctx: ApiContext): Promise<PartialEndpoint[]> {
  const out: PartialEndpoint[] = [];
  const bases = new Map<string, string>();
  const middleware = new Map<string, ReturnType<typeof middlewareOf>>();
  const middlewareFor = (root: string) => {
    if (!middleware.has(root)) middleware.set(root, middlewareOf(ctx, root));
    return middleware.get(root);
  };

  for (const entry of ctx.files.values()) {
    const file = entry.file;
    const app = routeOf(file, "app");
    const pages = app ? undefined : routeOf(file, "pages");
    const route = app ?? pages;
    if (route) {
      const base = await basePathOf(ctx, route.root, bases);
      const path = normalizePath(`${base}${route.url}`);
      const mw = middlewareFor(route.root);
      const auth = mw && mw.matches(path) ? [mw.file.split("/").pop()!] : [];
      const params: ApiParam[] = [...path.matchAll(/\{(\w+)(\*)?(\?)?\}/g)].map((m) => ({ name: m[1], in: "path", type: m[2] ? "string[]" : "string", required: !m[3] }));
      const handlers: Array<{ method: string; qualified: string }> = [];
      if (app) {
        for (const decl of entry.facts.decls) if (!decl.parent && decl.exported && HTTP_EXPORTS.has(decl.exported)) handlers.push({ method: decl.exported, qualified: decl.name });
        for (const exp of entry.facts.exports) {
          if (!HTTP_EXPORTS.has(exp.exported) || handlers.some((h) => h.method === exp.exported)) continue;
          if (exp.local) handlers.push({ method: exp.exported, qualified: exp.local });
          else if (exp.from) handlers.push({ method: exp.exported, qualified: exp.imported ?? exp.exported });
        }
      } else {
        const def = entry.facts.decls.find((d) => d.exported === "default" && !d.parent);
        const local = def?.name ?? entry.facts.exports.find((e) => e.exported === "default")?.local;
        if (local) handlers.push({ method: "ANY", qualified: local });
      }
      for (const h of handlers) {
        const target = entry.facts.decls.some((d) => d.name === h.qualified) ? { file, name: h.qualified } : ctx.lookup(file, h.qualified);
        const handler = (target && declHandler(ctx, target.file, target.name)) ?? { file, startLine: 1, endLine: 1, name: h.qualified };
        const decl = handler.declId ? ctx.declById.get(handler.declId) : undefined;
        const request = zodParsedIn(ctx, handler.file, handler.startLine, handler.endLine);
        const response = decl ? shapeOf(ctx, handler.file, returnTypeOf(decl.signature)) : undefined;
        out.push({
          kind: "http",
          method: h.method,
          path,
          framework: "Next.js",
          handler,
          params,
          ...(request ? { request } : {}),
          ...(response && response.fields ? { response } : {}),
          auth: [...auth, ...(wrapperOf(decl?.signature) ? [wrapperOf(decl?.signature)!] : [])],
        });
      }
      continue;
    }

    // Server actions.
    const inline = new Set(entry.routes.actions ?? []);
    if (!entry.routes.useServer && inline.size === 0) continue;
    for (const decl of entry.facts.decls) {
      if (decl.parent || decl.kind !== "function") continue;
      const isAction = inline.has(decl.name) || (entry.routes.useServer && decl.exported !== null);
      if (!isAction) continue;
      const handler = declHandler(ctx, file, decl.name)!;
      const callers = [...new Set(ctx.symbols.uses.filter((u) => u.target === `${file}#${decl.name}` && u.file !== file).map((u) => u.file))];
      const params = argParams(decl.signature);
      const objectParam = params.length === 1 && params[0].type && !/^(FormData|string|number|boolean)$/.test(params[0].type) ? params[0].type : undefined;
      const request = zodParsedIn(ctx, file, decl.startLine, decl.endLine) ?? shapeOf(ctx, file, objectParam);
      const response = shapeOf(ctx, file, returnTypeOf(decl.signature));
      const folder = file.split("/").slice(-2, -1)[0] ?? "";
      out.push({
        kind: "action",
        method: "POST",
        path: decl.exported && decl.exported !== "default" ? decl.exported : decl.name,
        framework: "Next.js",
        group: file.split("/").pop()!.replace(CODE, "") === "actions" ? folder || "actions" : file.split("/").pop()!.replace(CODE, ""),
        handler,
        params,
        ...(request && (request.fields || objectParam) ? { request } : {}),
        ...(response && response.fields ? { response } : {}),
        auth: wrapperOf(decl.signature) ? [wrapperOf(decl.signature)!] : [],
        internal: true,
        callers: callers.slice(0, 10),
      });
    }
  }
  return out;
}
