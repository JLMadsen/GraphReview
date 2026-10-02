// GraphReview before/after preview — the Node side of the sandbox (DESIGN.md §6.9).
//
// Runs INSIDE a throwaway container, once per side (base or head), never in
// the app or worker process. lib/preview/sandbox.ts copies this file and a
// `spec.json` into /job, the repo at that commit into /src, and mounts:
//   /src/<projectRoot>/node_modules  the repo's own dependencies (cached volume, may be empty)
//   /harness/node_modules            esbuild, react, react-dom, postcss (fallbacks)
//
// It bundles the changed file with esbuild (so TS/TSX/JSX, tsconfig paths and
// CSS imports just work), stubs any import that can't be resolved, then for
// each requested symbol either calls the function on every case or
// server-renders the component with every case's props. The result is one
// JSON line on stdout after RESULT_MARKER — anything else the code under test
// prints is captured per case, not mixed into the result.

import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { Writable } from "node:stream";

const RESULT_MARKER = "@@GRAPHREVIEW_PREVIEW_RESULT@@";
const SPEC = JSON.parse(readFileSync("/job/spec.json", "utf8"));
const SRC = "/src";
const PROJECT = path.join(SRC, SPEC.projectRoot || ".");
const OUT = "/tmp/graphreview-preview";
const MAX_REPR = 4000;
const MAX_HTML = 200_000;
const MAX_CSS = 400_000;
const MAX_LOG_LINES = 40;

const harnessRequire = createRequire("/harness/node_modules/");
// Packages are loaded by Node at runtime (not bundled), so they read this
// themselves; React and Next pick their development builds, as in `next dev`.
process.env.NODE_ENV ??= "development";
const stubbed = new Set();
const warnings = [];

// ---------------------------------------------------------------------------
// Console capture: user code may log; keep it per case, out of stdout.
// ---------------------------------------------------------------------------

let currentLogs = null;
const realStdoutWrite = process.stdout.write.bind(process.stdout);

/** Writes the result line and resolves once it is flushed: a pipe write of a big result is async, and exiting early cuts it off. */
function emit(result) {
  return new Promise((resolve) => realStdoutWrite(`${RESULT_MARKER}${JSON.stringify(result)}\n`, () => resolve()));
}
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...args) => {
    const line = args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 3 }))).join(" ");
    if (currentLogs && currentLogs.length < MAX_LOG_LINES) currentLogs.push(`${level}: ${line}`.slice(0, 500));
  };
}

function repr(value) {
  const text = inspect(value, {
    depth: 8,
    sorted: true,
    breakLength: 72,
    compact: 3,
    maxArrayLength: 200,
    maxStringLength: 2000,
    getters: false,
  });
  return text.length > MAX_REPR ? `${text.slice(0, MAX_REPR)}…` : text;
}

function errorText(error) {
  if (error instanceof Error) {
    // Next.js signals notFound()/redirect() by throwing; say what it means.
    const digest = String(error.digest ?? error.message);
    const http = /^NEXT_HTTP_ERROR_FALLBACK;(\d+)/.exec(digest);
    if (http) return http[1] === "404" ? "Calls notFound() — Next.js would show the 404 page" : `Next.js HTTP error ${http[1]} (forbidden()/unauthorized())`;
    const redirect = /^NEXT_REDIRECT;\w*;([^;]*)/.exec(digest);
    if (redirect) return `Calls redirect() to ${redirect[1] || "another page"} — Next.js would navigate away`;
    return `${error.name}: ${error.message}`;
  }
  return `thrown: ${repr(error)}`;
}

// Inputs are JSON; a few tagged objects stand in for values JSON can't hold.
function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const [k] = keys;
      const v = value[k];
      if (k === "$undefined") return undefined;
      if (k === "$date") return new Date(v);
      if (k === "$bigint") return BigInt(v);
      if (k === "$map") return new Map(v.map(([a, b]) => [revive(a), revive(b)]));
      if (k === "$set") return new Set(v.map(revive));
      if (k === "$nan") return NaN;
      if (k === "$promise") return awaitable(revive(v));
      if (k === "$infinity") return v < 0 ? -Infinity : Infinity;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = revive(v);
    return out;
  }
  return value;
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Bundling
// ---------------------------------------------------------------------------

const STUB_SOURCE = (name, names) => `
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

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Names an importer pulls from `specifier` via `import { a, b as c }` / `export { a } from` — a stub must export each one as ESM. */
function importedNames(importer, specifier) {
  let source;
  try {
    source = readFileSync(importer, "utf8");
  } catch {
    return [];
  }
  const pattern = new RegExp(
    `(?:import|export)\\s+(?:type\\s+)?(?:[\\w$]+\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*["']${escapeRegExp(specifier)}["']`,
    "g"
  );
  const names = new Set();
  for (const match of source.matchAll(pattern)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (IDENTIFIER.test(name) && name !== "default") names.add(name);
    }
  }
  return [...names];
}

/** Files Node can load natively, so a package file with one of these extensions is left external. */
const RUNTIME_LOADED = /\.(c|m)?js$|\.json$|\.node$/i;

/** Packages that only throw on import outside their intended bundler condition. */
const EMPTY_MODULES = new Set(["server-only", "client-only"]);

function stubPlugin() {
  return {
    name: "graphreview-stub-unresolved",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.graphreviewInner) return undefined;
        if (args.kind === "entry-point") return undefined;
        if (EMPTY_MODULES.has(args.path)) return { path: args.path, namespace: "graphreview-empty" };
        if (args.path.startsWith("node:")) return { path: args.path, external: true };
        const result = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: { graphreviewInner: true },
        });
        if (result.errors.length === 0) {
          // Installed packages are NOT bundled: Node loads them itself, from the
          // exact file esbuild resolved. Library code expects to run that way
          // (__dirname, optional require() in try/catch, relative file reads),
          // and bundling all of node_modules also cost over a gigabyte for a
          // Next.js layout. Only the repo's own code goes through esbuild —
          // plus package CSS/assets, which Node can't load.
          if (/[\\/]node_modules[\\/]/.test(result.path) && (RUNTIME_LOADED.test(result.path) || !path.extname(result.path))) {
            return { path: result.path, external: true };
          }
          return result;
        }
        // require() and import() can be caught, and libraries rely on that for
        // optional dependencies (Next.js: try require("@opentelemetry/api"),
        // else its own copy). A stand-in would make that try *succeed* with a
        // fake; a module that throws "Cannot find module" keeps the fallback.
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
      build.onLoad({ filter: /.*/, namespace: "graphreview-stub" }, (args) => ({
        contents: STUB_SOURCE(args.pluginData.specifier, args.pluginData.names),
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: "graphreview-empty" }, () => ({ contents: "", loader: "js" }));
      build.onLoad({ filter: /.*/, namespace: "graphreview-missing" }, (args) => ({
        contents: `const error = new Error(${JSON.stringify(`Cannot find module '${args.path}'`)}); error.code = "MODULE_NOT_FOUND"; throw error;`,
        loader: "js",
      }));
    },
  };
}

const ASSET_LOADERS = Object.fromEntries(
  [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm", ".mp3", ".wav"].map(
    (ext) => [ext, "dataurl"]
  )
);

async function bundle(needsReact) {
  const esbuild = harnessRequire("esbuild");
  mkdirSync(OUT, { recursive: true });
  const entryFile = path.join(SRC, SPEC.file);
  const lines = [`export * as __mod from ${JSON.stringify(entryFile)};`];
  if (needsReact) {
    lines.push(`export * as __react from "react";`);
    lines.push(`export * as __server from "react-dom/server";`);
    // Next.js components (Link, useRouter, usePathname…) throw "expected app
    // router to be mounted" outside a running app. Bundling Next's own context
    // modules — the same instances the component imports — lets the render
    // provide a stand-in router. Only when the repo has Next installed.
    if (hasNext()) {
      lines.push(`export * as __nextRouter from "next/dist/shared/lib/app-router-context.shared-runtime";`);
      lines.push(`export * as __nextHooks from "next/dist/shared/lib/hooks-client-context.shared-runtime";`);
    }
  }
  const result = await esbuild.build({
    stdin: { contents: lines.join("\n"), resolveDir: path.dirname(entryFile), loader: "js", sourcefile: "graphreview-entry.js" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outdir: OUT,
    entryNames: "entry",
    write: true,
    jsx: "automatic",
    logLevel: "silent",
    absWorkingDir: PROJECT,
    nodePaths: [path.join(PROJECT, "node_modules"), "/src/node_modules", "/harness/node_modules"],
    loader: { ...ASSET_LOADERS, ".svg": "dataurl", ".txt": "text", ".md": "text", ".graphql": "text", ".gql": "text" },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    banner: {
      js: 'import { createRequire as __grCreateRequire } from "node:module"; const require = __grCreateRequire(import.meta.url);',
    },
    plugins: [stubPlugin()],
  });
  for (const w of result.warnings.slice(0, 5)) warnings.push(`bundler: ${w.text}`);
  const css = existsSync(path.join(OUT, "entry.css")) ? readFileSync(path.join(OUT, "entry.css"), "utf8") : "";
  return { modulePath: path.join(OUT, "entry.js"), css };
}

// ---------------------------------------------------------------------------
// Global CSS (Tailwind & co.) — best effort, components only
// ---------------------------------------------------------------------------

const GLOBAL_CSS_NAMES = ["globals.css", "global.css", "index.css", "app.css", "main.css", "styles.css", "tailwind.css"];
const GLOBAL_CSS_DIRS = ["app", "src/app", "src", "styles", "src/styles", "app/styles", "."];

function findGlobalCss() {
  for (const dir of GLOBAL_CSS_DIRS) {
    for (const name of GLOBAL_CSS_NAMES) {
      const candidate = path.join(PROJECT, dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function projectRequire() {
  return createRequire(path.join(PROJECT, "package.json"));
}

async function loadPostcssPlugins() {
  const names = ["postcss.config.mjs", "postcss.config.js", "postcss.config.cjs", ".postcssrc.json", ".postcssrc"];
  const file = names.map((n) => path.join(PROJECT, n)).find((p) => existsSync(p));
  if (!file) return null;
  let config;
  if (file.endsWith(".json") || file.endsWith(".postcssrc")) config = JSON.parse(readFileSync(file, "utf8"));
  else {
    const mod = await import(pathToFileURL(file).href);
    config = mod.default ?? mod;
    if (typeof config === "function") config = config({ env: "development" });
  }
  const req = projectRequire();
  const loadPlugin = async (name, options) => {
    const mod = await import(pathToFileURL(req.resolve(name)).href);
    const factory = mod.default ?? mod;
    return typeof factory === "function" ? factory(options === true ? {} : options ?? {}) : factory;
  };
  const plugins = [];
  const raw = config.plugins ?? {};
  if (Array.isArray(raw)) {
    for (const p of raw) plugins.push(typeof p === "string" ? await loadPlugin(p, {}) : p);
  } else {
    for (const [name, options] of Object.entries(raw)) {
      if (options === false) continue;
      plugins.push(await loadPlugin(name, options));
    }
  }
  return plugins;
}

async function buildGlobalCss() {
  const file = findGlobalCss();
  if (!file) return { css: "", note: "no global stylesheet found" };
  const source = readFileSync(file, "utf8");
  const relative = path.relative(SRC, file);
  try {
    const plugins = await loadPostcssPlugins();
    if (!plugins) return { css: source, note: `${relative} (raw — no PostCSS config)` };
    let postcss;
    try {
      postcss = projectRequire()("postcss");
    } catch {
      postcss = harnessRequire("postcss");
    }
    const result = await withTimeout(postcss(plugins).process(source, { from: file }), 60_000, "PostCSS");
    return { css: result.css, note: `${relative} (via PostCSS)` };
  } catch (error) {
    return { css: source, note: `${relative} (raw — PostCSS failed: ${errorText(error)})` };
  }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

async function runFunction(fn, symbol) {
  const cases = [];
  for (const c of symbol.cases) {
    const args = revive(Array.isArray(c.input?.args) ? c.input.args : []);
    const logs = [];
    currentLogs = logs;
    const started = Date.now();
    // Recorded so the UI can tell whether the call changed its own arguments.
    const outcome = { label: c.label, argsBefore: repr(args) };
    try {
      let value = fn(...args);
      if (value && typeof value.then === "function") value = await withTimeout(value, SPEC.caseTimeoutMs, "The returned promise");
      outcome.returned = repr(value);
    } catch (error) {
      outcome.threw = errorText(error);
    }
    outcome.argsAfter = repr(args);
    outcome.durationMs = Date.now() - started;
    outcome.logs = logs;
    currentLogs = null;
    cases.push(outcome);
  }
  return cases;
}

/** Wraps every rendered element; set up by `setUpNextRouter` when the repo uses Next.js. */
let wrapElement = (element) => element;

/**
 * A stand-in Next.js app router: pathname "/", no search params, and
 * navigation that does nothing — enough for Link, useRouter, usePathname and
 * useSearchParams to render instead of throwing.
 */
function setUpNextRouter(React, loaded) {
  const routerContext = loaded.__nextRouter?.AppRouterContext;
  if (!routerContext || typeof routerContext !== "object") return;
  const hooks = loaded.__nextHooks ?? {};
  const noop = () => {};
  const router = { push: noop, replace: noop, refresh: noop, prefetch: noop, back: noop, forward: noop, hmrRefresh: noop };
  wrapElement = (element) => {
    let tree = element;
    if (hooks.SearchParamsContext) tree = React.createElement(hooks.SearchParamsContext.Provider, { value: new URLSearchParams() }, tree);
    if (hooks.PathnameContext) tree = React.createElement(hooks.PathnameContext.Provider, { value: "/" }, tree);
    if (hooks.PathParamsContext) tree = React.createElement(hooks.PathParamsContext.Provider, { value: {} }, tree);
    return React.createElement(routerContext.Provider, { value: router }, tree);
  };
}

function hasNext() {
  return [PROJECT, SRC].some((dir) => existsSync(path.join(dir, "node_modules", "next", "package.json")));
}

function renderToHtml(React, server, Component, props) {
  const element = wrapElement(React.createElement(Component, props));
  if (typeof server.renderToPipeableStream !== "function") {
    return Promise.resolve(server.renderToStaticMarkup(element));
  }
  return new Promise((resolve, reject) => {
    let html = "";
    let failed = null;
    const sink = new Writable({
      write(chunk, _enc, done) {
        html += chunk.toString();
        done();
      },
    });
    sink.on("finish", () => (failed ? reject(failed) : resolve(html)));
    const stream = server.renderToPipeableStream(element, {
      onAllReady() {
        stream.pipe(sink);
      },
      onShellError(error) {
        reject(error);
      },
      onError(error) {
        failed ??= error;
      },
    });
    setTimeout(() => {
      stream.abort?.();
      reject(new Error(`Rendering did not finish within ${SPEC.caseTimeoutMs} ms`));
    }, SPEC.caseTimeoutMs).unref();
  });
}

/**
 * A value that works both awaited and read directly: Next 15 passes `params`
 * and `searchParams` as Promises (`const { id } = await params`), Next 14 and
 * older as plain objects (`params.id`). A resolved Promise carrying the
 * object's own properties satisfies both.
 */
function awaitable(value) {
  if (value && typeof value.then === "function") return value;
  const promise = Promise.resolve(value);
  return value && typeof value === "object" ? Object.assign(promise, value) : promise;
}

const NEXT_ROUTE_FILE = /(^|\/)app\/(.*\/)?(page|layout|template|default|not-found|error|loading)\.(t|j)sx?$/;

/** `app/repo/[repoId]/[...slug]/layout.tsx` → `{ repoId: "example-repoId", slug: ["example"] }`. */
function paramsFromRoute(file) {
  const params = {};
  for (const segment of file.split("/")) {
    const catchAll = /^\[\[?\.\.\.(\w+)\]?\]$/.exec(segment);
    if (catchAll) params[catchAll[1]] = ["example"];
    else {
      const dynamic = /^\[(\w+)\]$/.exec(segment);
      if (dynamic) params[dynamic[1]] = `example-${dynamic[1]}`;
    }
  }
  return params;
}

/**
 * Next.js app-router files get what Next would hand them: `params` and
 * `searchParams` made awaitable (filled in from the route folder when the
 * inputs leave them out), and layouts/templates a stand-in `children`, so
 * the shell renders around something.
 */
function nextRouteProps(React, props) {
  if (!NEXT_ROUTE_FILE.test(SPEC.file)) {
    // Outside route files, only make given params/searchParams awaitable.
    const out = { ...props };
    for (const key of ["params", "searchParams"]) if (key in out) out[key] = awaitable(out[key]);
    return out;
  }
  const out = { ...props };
  out.params = awaitable(out.params ?? paramsFromRoute(SPEC.file));
  out.searchParams = awaitable(out.searchParams ?? {});
  if (/(layout|template)\.(t|j)sx?$/.test(SPEC.file) && (out.children === undefined || out.children === null)) {
    out.children = React.createElement(
      "div",
      { style: { padding: "24px", border: "1px dashed #bbb", color: "#888", fontSize: "12px", textAlign: "center" } },
      "page content"
    );
  }
  return out;
}

async function runComponent(Component, symbol, React, server) {
  const cases = [];
  for (const c of symbol.cases) {
    const props = nextRouteProps(React, revive(c.input?.props ?? {}));
    const logs = [];
    currentLogs = logs;
    const started = Date.now();
    const outcome = { label: c.label };
    try {
      const html = await renderToHtml(React, server, Component, props);
      outcome.html = html.length > MAX_HTML ? `${html.slice(0, MAX_HTML)}<!-- truncated -->` : html;
    } catch (error) {
      outcome.threw = errorText(error);
    }
    outcome.durationMs = Date.now() - started;
    outcome.logs = logs;
    currentLogs = null;
    cases.push(outcome);
  }
  return cases;
}

function pickExport(mod, name) {
  if (name === "default") return mod.default;
  if (name in mod) return mod[name];
  // `export default function Foo` is detected as Foo but only reachable as default.
  if (mod.default && (mod.default.name === name || mod.default.displayName === name)) return mod.default;
  return undefined;
}

function unwrapComponent(value) {
  // memo()/forwardRef() objects are valid element types already.
  if (typeof value === "function") return value;
  if (value && typeof value === "object" && value.$$typeof) return value;
  return null;
}

async function main() {
  const result = { side: SPEC.side, symbols: [], stubbedModules: [], warnings, css: "", cssNote: undefined };
  const needsReact = SPEC.symbols.some((s) => s.kind === "component");

  let loaded;
  try {
    const { modulePath, css } = await bundle(needsReact);
    result.css = css;
    currentLogs = [];
    const importLogs = currentLogs;
    loaded = await withTimeout(import(pathToFileURL(modulePath).href), SPEC.caseTimeoutMs * 2, "Importing the module");
    currentLogs = null;
    if (importLogs.length) warnings.push(...importLogs.map((l) => `on import: ${l}`));
  } catch (error) {
    currentLogs = null;
    // esbuild's way of saying its process died — in practice, the memory cap.
    result.fatal = /service (was|is no longer running|stopped)/i.test(String(error?.message ?? error))
      ? `The bundler was killed while bundling ${SPEC.file}, almost certainly for running out of memory ` +
        `(this sandbox allows ${process.env.GRAPHREVIEW_MEMORY ?? "a fixed amount"}). Raise PREVIEW_MEMORY in docker/.env and run again.`
      : `Could not load ${SPEC.file}: ${errorText(error)}`;
    result.stubbedModules = [...stubbed];
    await emit(result);
    return;
  }

  const mod = loaded.__mod;
  if (needsReact) setUpNextRouter(loaded.__react, loaded);
  for (const symbol of SPEC.symbols) {
    const entry = { name: symbol.name, kind: symbol.kind };
    const value = pickExport(mod, symbol.name);
    if (value === undefined) {
      entry.error = `"${symbol.name}" is not exported from ${SPEC.file}, so it can't be called from outside.`;
    } else if (symbol.kind === "component") {
      const Component = unwrapComponent(value);
      entry.cases = Component
        ? await runComponent(Component, symbol, loaded.__react, loaded.__server)
        : undefined;
      if (!Component) entry.error = `"${symbol.name}" is not a component (${typeof value}).`;
    } else if (typeof value !== "function") {
      entry.error = `"${symbol.name}" is a ${typeof value}, not a function.`;
    } else if (/^class\s/.test(Function.prototype.toString.call(value))) {
      entry.error = `"${symbol.name}" is a class; only plain functions are run.`;
    } else {
      entry.cases = await runFunction(value, symbol);
    }
    result.symbols.push(entry);
  }

  if (needsReact) {
    const global = await buildGlobalCss();
    result.css = `${global.css}\n${result.css}`.slice(0, MAX_CSS);
    result.cssNote = global.note;
  }
  result.stubbedModules = [...stubbed];
  await emit(result);
}

main()
  .catch((error) => emit({ side: SPEC.side, symbols: [], fatal: errorText(error), warnings }))
  .finally(() => {
    // Exit once the result is flushed: lingering timers/sockets in user code must not keep the container alive.
    process.exit(0);
  });
