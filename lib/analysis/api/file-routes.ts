/**
 * File-system routers besides Next.js (./next.ts): SvelteKit `+server.ts`
 * files and Astro endpoints export one function per HTTP method; Nuxt /
 * Nitro `server/api/**` and `server/routes/**` files default-export one
 * handler, the method in the file name (`orders.post.ts`).
 */
import { declHandler, normalizePath, shapeOf, type ApiContext, type PartialEndpoint } from "./context";
import { returnTypeOf, wrapperOf, zodParsedIn } from "./next";
import type { ApiHandler } from "./types";

const VERB_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ALL"]);
const CODE = /\.(ts|js|mjs)$/;

/** `[id]` → `{id}`, `[...rest]` → `{rest*}`, `[[opt]]` → `{opt?}`, `[id=uuid]` → `{id}`; groups `(x)` dropped. */
function segmentUrl(segments: string[]): string {
  return `/${segments
    .filter((s) => s !== "" && s !== "index" && !/^\(.*\)$/.test(s))
    .map((s) =>
      s
        .replace(/^\[\[\.\.\.(\w+)\]\]$/, "{$1*?}")
        .replace(/^\[\[(\w+)(=\w+)?\]\]$/, "{$1?}")
        .replace(/^\[\.\.\.(\w+)(=\w+)?\]$/, "{$1*}")
        .replace(/^\[(\w+)(=\w+)?\]$/, "{$1}"),
    )
    .join("/")}`;
}

function verbExports(ctx: ApiContext, file: string): Array<{ method: string; handler: ApiHandler; signature?: string }> {
  const entry = ctx.files.get(file)!;
  const out: Array<{ method: string; handler: ApiHandler; signature?: string }> = [];
  for (const decl of entry.facts.decls) {
    if (decl.parent || !decl.exported || !VERB_EXPORTS.has(decl.exported)) continue;
    out.push({ method: decl.exported === "ALL" ? "ANY" : decl.exported, handler: declHandler(ctx, file, decl.name)!, signature: decl.signature });
  }
  for (const exp of entry.facts.exports) {
    if (!VERB_EXPORTS.has(exp.exported) || !exp.local || out.some((o) => o.method === exp.exported)) continue;
    const handler = declHandler(ctx, file, exp.local);
    if (handler) out.push({ method: exp.exported === "ALL" ? "ANY" : exp.exported, handler, signature: ctx.declById.get(handler.declId!)?.signature });
  }
  return out;
}

export function resolveFileRoutes(ctx: ApiContext): PartialEndpoint[] {
  const out: PartialEndpoint[] = [];
  const push = (framework: string, method: string, path: string, handler: ApiHandler, signature?: string) => {
    const request = zodParsedIn(ctx, handler.file, handler.startLine, handler.endLine);
    const response = signature ? shapeOf(ctx, handler.file, returnTypeOf(signature)) : undefined;
    const wrapper = wrapperOf(signature);
    out.push({
      kind: "http",
      method,
      path: normalizePath(path),
      framework,
      handler,
      params: [],
      ...(request ? { request } : {}),
      ...(response?.fields ? { response } : {}),
      auth: wrapper && !/^(defineEventHandler|eventHandler|defineCachedEventHandler)$/.test(wrapper) ? [wrapper] : [],
    });
  };

  for (const entry of ctx.files.values()) {
    const file = entry.file;
    const segments = file.split("/");
    const name = segments[segments.length - 1];

    // SvelteKit: src/routes/**/+server.ts
    if (/^\+server\.(ts|js)$/.test(name)) {
      const at = segments.lastIndexOf("routes");
      if (at === -1) continue;
      for (const v of verbExports(ctx, file)) push("SvelteKit", v.method, segmentUrl(segments.slice(at + 1, -1)), v.handler, v.signature);
      continue;
    }

    // Nuxt / Nitro: server/api/** and server/routes/**
    const server = segments.lastIndexOf("server");
    if (server !== -1 && (segments[server + 1] === "api" || segments[server + 1] === "routes") && CODE.test(name)) {
      const parts = name.replace(CODE, "").split(".");
      const method = parts.length > 1 && VERB_EXPORTS.has(parts[parts.length - 1].toUpperCase()) ? parts.pop()!.toUpperCase() : "ANY";
      const base = segments[server + 1] === "api" ? ["api"] : [];
      const url = segmentUrl([...base, ...segments.slice(server + 2, -1), parts.join(".")]);
      const def = entry.facts.decls.find((d) => d.exported === "default" && !d.parent);
      const local = def?.name ?? entry.facts.exports.find((e) => e.exported === "default")?.local;
      const handler = (local ? declHandler(ctx, file, local) : undefined) ?? { file, startLine: 1, endLine: 1, name: "default" };
      push("Nuxt", method, url, handler, def?.signature);
      continue;
    }

    // Astro: src/pages/**/*.ts exporting GET / POST / …
    const pages = segments.lastIndexOf("pages");
    if (pages !== -1 && segments[pages - 1] === "src" && CODE.test(name) && ctx.importsOf(file).some((s) => s === "astro" || s.startsWith("astro:"))) {
      const url = segmentUrl([...segments.slice(pages + 1, -1), name.replace(CODE, "").replace(/\.(json|xml|txt)$/, "")]);
      for (const v of verbExports(ctx, file)) push("Astro", v.method, url, v.handler, v.signature);
    }
  }
  return out;
}
