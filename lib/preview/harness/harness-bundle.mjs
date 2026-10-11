// Bundling the repo's own code with esbuild, the way Next.js would see it: shims
// for next/headers, "use server" modules as action stubs, packages left to Node.

import Module from "node:module";
import { existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as fakes from "./preview-fakes.mjs";
import { ENTRIES, OUT, PROJECT, SHIMS, SPEC, SRC, directiveOf, errorText, exportedNames, harnessRequire, hasNext, importedNames, isRepoSource, state, stubbed, warnings } from "./harness-context.mjs";
import { importMetaEnv } from "./harness-env.mjs";

// ---------------------------------------------------------------------------
// Shims: next/headers outside a request, for repo code and packages alike
// ---------------------------------------------------------------------------

export const NEXT_HEADERS_SHIM = path.join(SHIMS, "next-headers.cjs");

export function writeShims() {
  mkdirSync(SHIMS, { recursive: true });
  // CommonJS, so both require() and import (via Node's CJS named-export detection) work.
  writeFileSync(
    NEXT_HEADERS_SHIM,
    `"use strict";
const awaitable = (value) => Object.assign(Promise.resolve(value), value);
const cookieStore = {
  get() { return undefined; }, getAll() { return []; }, has() { return false; },
  set() { return cookieStore; }, delete() { return cookieStore; }, clear() { return cookieStore; },
  toString() { return ""; }, size: 0, [Symbol.iterator]: function* () {},
};
exports.cookies = function cookies() { return awaitable(cookieStore); };
exports.headers = function headers() {
  const h = new Headers({ host: "localhost:3000", "user-agent": "GraphReview preview" });
  return Object.assign(Promise.resolve(h), {
    get: (k) => h.get(k), has: (k) => h.has(k), entries: () => h.entries(), keys: () => h.keys(),
    values: () => h.values(), forEach: (fn) => h.forEach(fn), [Symbol.iterator]: () => h[Symbol.iterator](),
  });
};
exports.draftMode = function draftMode() { return awaitable({ isEnabled: false, enable() {}, disable() {} }); };
`
  );
}

export const SHIMMED_SPECIFIERS = new Map([
  ["next/headers", NEXT_HEADERS_SHIM],
  ["next/headers.js", NEXT_HEADERS_SHIM],
]);

/** Redirects shimmed specifiers for packages Node loads itself (CommonJS and ESM). */
export function installModuleHooks() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function resolveWithShims(request, ...rest) {
    const shim = SHIMMED_SPECIFIERS.get(request);
    return shim ?? originalResolve.call(this, request, ...rest);
  };
  if (typeof Module.register === "function") {
    const hooks = path.join(SHIMS, "hooks.mjs");
    const table = JSON.stringify(Object.fromEntries([...SHIMMED_SPECIFIERS].map(([k, v]) => [k, pathToFileURL(v).href])));
    writeFileSync(
      hooks,
      `const table = ${table};
export async function resolve(specifier, context, next) {
  if (table[specifier]) return { url: table[specifier], shortCircuit: true, format: "commonjs" };
  return next(specifier, context);
}
`
    );
    try {
      Module.register(pathToFileURL(hooks).href);
    } catch (error) {
      warnings.push(`module hooks: ${errorText(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Bundling
// ---------------------------------------------------------------------------

export const STUB_SOURCE = (name, names) => `
const make = (label) => {
  const fn = function () { return null; };
  return new Proxy(fn, {
    get(target, key) {
      if (key === "__esModule") return true;
      if (key === "then" || key === "$$typeof" || key === "prototype") return undefined;
      if (key === Symbol.toPrimitive) return () => "[stub " + label + "]";
      if (key === Symbol.iterator) return function* () {};
      if (key === "toString" || key === "toJSON") return () => "[stub " + label + "]";
      return make(label + "." + String(key));
    },
    apply() { return null; },
    construct() { return make(label + "()"); },
  });
};
const stub = make(${JSON.stringify(name)});
export default stub;
${names.map((n) => `export const ${n} = stub[${JSON.stringify(n)}];`).join("\n")}
`;

/** What a client bundle gets for a "use server" module in Next.js: callable references, not the server code. */
export const SERVER_ACTION_SOURCE = (names, moduleId) => `
const action = (name) => Object.defineProperty(
  async function (...args) { return globalThis.__graphreviewServerCall(${JSON.stringify(moduleId)}, name, args); },
  "name",
  { value: name }
);
${names.map((n) => (n === "default" ? `export default action("default");` : `export const ${n} = action(${JSON.stringify(n)});`)).join("\n")}
`;

export const moduleTypeCache = new Map();

/** Whether Node loads this package file as CommonJS: .cjs, or .js under a package.json without "type": "module". */
export function isCommonJs(file) {
  if (/\.cjs$/i.test(file)) return true;
  if (!/\.js$/i.test(file) && path.extname(file)) return false;
  let dir = path.dirname(file);
  while (dir.includes(`${path.sep}node_modules`) || dir.includes("/node_modules")) {
    if (moduleTypeCache.has(dir)) return moduleTypeCache.get(dir);
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      let commonJs = true;
      try {
        commonJs = JSON.parse(readFileSync(manifest, "utf8")).type !== "module";
      } catch {
        /* unreadable: treat as CommonJS, Node's default */
      }
      moduleTypeCache.set(dir, commonJs);
      return commonJs;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return true;
}

/** Files Node can load natively, so a package file with one of these extensions is left external. */
export const RUNTIME_LOADED = /\.(c|m)?js$|\.json$|\.node$/i;

/** Packages that only throw on import outside their intended bundler condition. */
export const EMPTY_MODULES = new Set(["server-only", "client-only"]);

/** Repo modules reached from a "use client" boundary — where "use server" imports become action stubs. */
export const clientModules = new Set();

export function frameworkPlugin() {
  return {
    name: "graphreview-framework",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.graphreviewInner) return undefined;
        if (args.kind === "entry-point") return undefined;
        if (EMPTY_MODULES.has(args.path)) return { path: args.path, namespace: "graphreview-empty" };
        if (args.path.startsWith("node:")) return { path: args.path, external: true };
        const shim = SHIMMED_SPECIFIERS.get(args.path);
        if (shim) return { path: shim, external: true };
        // Auth libraries can't sign in offline: the repo's imports of them get a signed-in stand-in.
        if (fakes.isAuthModule(args.path) && (isRepoSource(args.importer) || args.importer.startsWith(ENTRIES))) {
          return {
            path: `${args.path}?from=${args.importer}`,
            namespace: "graphreview-auth",
            pluginData: { specifier: args.path, names: importedNames(args.importer, args.path) },
          };
        }
        // next/font only works through Next's compiler; stand in with a font object per imported loader.
        if (/^(@next\/font|next\/font)\/(google|local)(\/index(\.js)?)?$/.test(args.path)) {
          return {
            path: `${args.path}?from=${args.importer}`,
            namespace: "graphreview-font",
            pluginData: { names: importedNames(args.importer, args.path) },
          };
        }
        const result = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: { graphreviewInner: true },
        });
        if (result.errors.length === 0) {
          // Installed packages are NOT bundled: Node loads them itself, from the
          // exact file esbuild resolved. Library code expects to run that way
          // (__dirname, optional require() in try/catch, relative file reads).
          // Only the repo's own code goes through esbuild — plus package
          // CSS/assets, which Node can't load.
          if (/[\\/]node_modules[\\/]/.test(result.path) && (RUNTIME_LOADED.test(result.path) || !path.extname(result.path))) {
            // A CommonJS package imported from ESM: Node hands back the whole
            // module.exports as the default, ignoring `__esModule` — so
            // `import Image from "next/image"` would be `{ default: Image }`.
            // A small wrapper gives the default bundlers give (and keeps the
            // named exports). Static imports only; require() is already right.
            if (args.namespace === "graphreview-cjs" || args.kind !== "import-statement" || !isCommonJs(result.path)) {
              return { path: result.path, external: true };
            }
            return { path: result.path, namespace: "graphreview-cjs" };
          }
          if (clientModules.has(args.importer) && isRepoSource(result.path)) clientModules.add(result.path);
          return result;
        }
        // A provider candidate that can't be resolved is simply not available.
        if (args.importer.startsWith(ENTRIES)) return { path: args.path, namespace: "graphreview-empty" };
        // A CSS @import that doesn't resolve (Tailwind v4's `@import "tailwindcss"`
        // needs the "style" condition) becomes empty CSS: CSS can't import a JS
        // stand-in, and the global stylesheet goes through PostCSS separately.
        if (args.kind === "import-rule" || args.kind === "url-token" || /\.(css|scss|sass|less)$/i.test(args.importer)) {
          return { path: args.path, namespace: "graphreview-empty-css" };
        }
        // require() and import() can be caught, and libraries rely on that for
        // optional dependencies; a module that throws keeps that fallback.
        if (args.kind === "require-call" || args.kind === "dynamic-import" || args.kind === "require-resolve") {
          return { path: args.path, namespace: "graphreview-missing" };
        }
        stubbed.add(args.path);
        // One stub module per importer, so each exports exactly the names its importer asks for.
        return {
          path: `${args.path}?from=${args.importer}`,
          namespace: "graphreview-stub",
          pluginData: { specifier: args.path, names: importedNames(args.importer, args.path) },
        };
      });

      // Next.js semantics for directives: a "use client" file starts a client
      // boundary; a "use server" file imported from inside one is replaced by
      // action references, exactly as Next's bundler does — the server code
      // (database clients, secret checks) never runs in a client component.
      build.onLoad({ filter: /\.(c|m)?(j|t)sx?$/ }, (args) => {
        if (!isRepoSource(args.path)) return undefined;
        const source = readFileSync(args.path, "utf8");
        const directive = directiveOf(source);
        if (directive === "client") clientModules.add(args.path);
        if (directive === "server" && clientModules.has(args.path)) {
          state.serverActionModules += 1;
          return { contents: SERVER_ACTION_SOURCE(exportedNames(source), path.relative(SRC, args.path).split(path.sep).join("/")), loader: "js" };
        }
        return undefined;
      });

      build.onLoad({ filter: /.*/, namespace: "graphreview-stub" }, (args) => ({
        contents: STUB_SOURCE(args.pluginData.specifier, args.pluginData.names),
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: "graphreview-auth" }, (args) => ({
        contents: fakes.authModuleSource(args.pluginData.specifier, args.pluginData.names),
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: "graphreview-empty" }, () => ({ contents: "", loader: "js" }));
      build.onLoad({ filter: /.*/, namespace: "graphreview-empty-css" }, () => ({ contents: "", loader: "css" }));
      // A namespace import works whichever way Node ends up loading the file:
      // CommonJS (module.exports arrives as `default`) or, since Node 22 also
      // detects ESM syntax in a .js file without "type", as ESM (which may
      // have no default export at all).
      build.onLoad({ filter: /.*/, namespace: "graphreview-cjs" }, (args) => ({
        contents: `import * as __ns from ${JSON.stringify(args.path)};
export * from ${JSON.stringify(args.path)};
const __cjs = "default" in __ns ? __ns.default : __ns;
export default __cjs && __cjs.__esModule && "default" in __cjs ? __cjs.default : __cjs;`,
        loader: "js",
        resolveDir: path.dirname(args.path),
      }));
      build.onLoad({ filter: /.*/, namespace: "graphreview-font" }, (args) => ({
        contents: `const font = () => ({ className: "", variable: "", style: { fontFamily: "system-ui, sans-serif" } });
export default font;
${args.pluginData.names.map((n) => `export const ${n} = font;`).join("\n")}`,
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: "graphreview-missing" }, (args) => ({
        contents: `const error = new Error(${JSON.stringify(`Cannot find module '${args.path}'`)}); error.code = "MODULE_NOT_FOUND"; throw error;`,
        loader: "js",
      }));
    },
  };
}

export const ASSET_LOADERS = Object.fromEntries(
  [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm", ".mp3", ".wav"].map(
    (ext) => [ext, "dataurl"]
  )
);

/**
 * Bundles the changed file (entry "entry") and the provider candidates
 * (entries "p0", "p1", …) in one build with code splitting, so modules they
 * share — a context object, a store — are one instance, like in the app.
 */
export async function bundle(needsReact, providerCandidates) {
  const esbuild = harnessRequire("esbuild");
  mkdirSync(OUT, { recursive: true });
  mkdirSync(ENTRIES, { recursive: true });
  const entryFile = path.join(SRC, SPEC.file);
  if (directiveOf(readFileSync(entryFile, "utf8")) === "client") clientModules.add(entryFile);

  const lines = [`export * as __mod from ${JSON.stringify(entryFile)};`];
  if (needsReact) {
    lines.push(`export * as __react from "react";`);
    lines.push(`export * as __server from "react-dom/server";`);
    lines.push(`export * as __client from "react-dom/client";`);
    if (hasNext()) {
      // Next's own router context modules — the same instances the component
      // imports — so the render can provide a stand-in app router.
      lines.push(`export * as __nextRouter from "next/dist/shared/lib/app-router-context.shared-runtime";`);
      lines.push(`export * as __nextHooks from "next/dist/shared/lib/hooks-client-context.shared-runtime";`);
    }
  }
  const entryPoints = { entry: path.join(ENTRIES, "entry.js") };
  writeFileSync(entryPoints.entry, lines.join("\n"));
  providerCandidates.forEach((candidate, index) => {
    const file = path.join(ENTRIES, `p${index}.js`);
    // A namespace export can't fail on a missing named export; the name is picked at runtime.
    writeFileSync(file, `export * as ns from ${JSON.stringify(candidate.spec)};`);
    entryPoints[`p${index}`] = file;
    candidate.out = path.join(OUT, `p${index}.js`);
  });

  const result = await esbuild.build({
    entryPoints,
    bundle: true,
    splitting: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outdir: OUT,
    entryNames: "[name]",
    chunkNames: "chunk-[hash]",
    write: true,
    jsx: "automatic",
    logLevel: "silent",
    absWorkingDir: PROJECT,
    // Installed packages are left for Node to load (see frameworkPlugin), so
    // they must resolve to the file Node itself would pick. esbuild's defaults
    // add the bundler-only "module" condition and main field, which can land
    // on an ESM build inside a package without "type": "module" (e.g.
    // @xyflow/react's dist/esm/index.js) — a file Node then loads differently
    // from what the wrapper below expects.
    conditions: [],
    mainFields: ["main"],
    nodePaths: [path.join(PROJECT, "node_modules"), "/src/node_modules", "/harness/node_modules"],
    loader: { ...ASSET_LOADERS, ".svg": "dataurl", ".txt": "text", ".md": "text", ".graphql": "text", ".gql": "text" },
    define: {
      "process.env.NODE_ENV": JSON.stringify("development"),
      "import.meta.env": JSON.stringify(importMetaEnv()),
    },
    banner: {
      js: 'import { createRequire as __grCreateRequire } from "node:module"; const require = __grCreateRequire(import.meta.url);',
    },
    plugins: [frameworkPlugin()],
  });
  for (const w of result.warnings.slice(0, 5)) warnings.push(`bundler: ${w.text}`);
  let css = "";
  for (const name of readdirSync(OUT)) {
    if (name.endsWith(".css")) css += readFileSync(path.join(OUT, name), "utf8");
  }
  return { css };
}
