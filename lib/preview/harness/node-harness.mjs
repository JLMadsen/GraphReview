// GraphReview before/after preview — the Node side of the sandbox (DESIGN.md §6.9).
//
// Runs INSIDE a throwaway container, once per side (base or head), never in
// the app or worker process. lib/preview/sandbox.ts copies this file and a
// `spec.json` into /job, the repo at that commit into /src, and mounts:
//   /src/<projectRoot>/node_modules  the repo's own dependencies (cached volume, may be empty)
//   /harness/node_modules            esbuild, react, react-dom, postcss, happy-dom (fallbacks + tools)
//
// The goal is that ordinary React and Next.js apps preview without anyone
// adapting the sandbox to them, so this file mimics what the framework and the
// browser would provide, in general terms rather than per repo:
//
//   bundling    esbuild bundles the repo's own code only; installed packages are
//               left to Node (they expect __dirname, optional require(), …)
//   Next.js     "use server" modules imported from client code become action
//               stubs (as Next does); next/headers gets a stand-in request; route
//               files get params/searchParams/children; a stand-in app router
//   env         committed .env.example-style files, then typed placeholders for
//               every other process.env / import.meta.env key the repo's code reads
//   providers   the repo's own Providers component wraps each render, if any;
//               library providers (Redux, Apollo, next-intl, react-hook-form,
//               themes) are added when an error points at them
//   contexts    a repo context read with no provider above it gets a plainly
//               fake value on a retry (preview-fakes.mjs), and auth libraries
//               (next-auth, Clerk, Auth0) are replaced by a signed-in stand-in
//   rendering   client components render with react-dom/client inside happy-dom,
//               so effects run and portals (dialogs, popovers) are captured;
//               async server components render with react-dom/server; the other
//               is the fallback when one fails
//   props       callback-looking props the model gave as {} become no-op functions
//
// The result is one JSON line on stdout after RESULT_MARKER — anything the code
// under test prints is captured per case, not mixed into the result.

import Module, { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { Writable } from "node:stream";
import * as fakes from "./preview-fakes.mjs";

const RESULT_MARKER = "@@GRAPHREVIEW_PREVIEW_RESULT@@";
const SPEC = JSON.parse(readFileSync("/job/spec.json", "utf8"));
const SRC = "/src";
const PROJECT = path.join(SRC, SPEC.projectRoot || ".");
const OUT = "/tmp/graphreview-preview";
// Inside the project, so the repo's tsconfig paths (`@/…`) resolve for the entries' imports.
const ENTRIES = path.join(PROJECT, ".graphreview-entries");
const SHIMS = "/tmp/graphreview-shims";
const MAX_REPR = 4000;
const MAX_HTML = 200_000;
const MAX_CSS = 400_000;
const MAX_LOG_LINES = 40;
/** How long a client render may keep settling (effects, timers, lazy imports) before its DOM is captured. */
const SETTLE_MS = 400;

const harnessRequire = createRequire("/harness/node_modules/");
// Packages are loaded by Node at runtime (not bundled), so they read this
// themselves; React and Next pick their development builds, as in `next dev`.
process.env.NODE_ENV ??= "development";
const stubbed = new Set();
const warnings = [];
const notes = new Set();
// The bundled repo code reaches the fakes (replaced auth modules) through here.
globalThis.__graphreviewFakes = fakes;

// Errors thrown after a render returned — in an effect, a timer, a rejected
// fetch — must not kill the run (and every other case with it). They're kept
// in the current case's log instead.
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (currentLogs && currentLogs.length < MAX_LOG_LINES) currentLogs.push(`error (after render): ${text}`.slice(0, 500));
  });
}

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
    if (/WebGL/i.test(error.message)) {
      return "Needs WebGL (a map or 3D view) — the sandbox has no GPU, so this can't be rendered here";
    }
    // Network failures often arrive as an AggregateError with an empty message; the cause is inside.
    if (error.name === "AggregateError" || (error.message === "" && Array.isArray(error.errors))) {
      const inner = (error.errors ?? []).map((e) => e?.code ?? e?.message).filter(Boolean);
      if (inner.some((m) => /WebGL/i.test(String(m)))) {
        return "Needs WebGL (a map or 3D view) — the sandbox has no GPU, so this can't be rendered here";
      }
      const network = inner.some((m) => /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|fetch failed/i.test(String(m)));
      return network
        ? `A network request failed (${[...new Set(inner)].slice(0, 2).join(", ")}) — the sandbox is offline, and this request wasn't a server action or fetch it could mock`
        : `AggregateError: ${inner.slice(0, 3).join("; ") || "several errors"}`;
    }
    if (error.cause && !error.message.includes(String(error.cause?.message ?? ""))) {
      return `${error.name}: ${error.message} (cause: ${error.cause?.code ?? error.cause?.message ?? error.cause})`;
    }
    return `${error.name}: ${error.message}`;
  }
  return `thrown: ${repr(error)}`;
}

const noop = () => {};

// Inputs are JSON; a few tagged objects stand in for values JSON can't hold.
function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const [k] = keys;
      const v = value[k];
      if (k === "$undefined") return undefined;
      if (k === "$fn" || k === "$function") return noop;
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// ---------------------------------------------------------------------------
// Directives and source helpers
// ---------------------------------------------------------------------------

const DIRECTIVE = /^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*(?:#![^\n]*\n\s*)?["']use (client|server)["']/;

function directiveOf(source) {
  return DIRECTIVE.exec(source)?.[1] ?? null;
}

function isRepoSource(file) {
  return /\.(c|m)?(j|t)sx?$/.test(file) && !/[\\/]node_modules[\\/]/.test(file) && file.startsWith(SRC);
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Names a module exports, from its source (good enough for action modules: functions and consts). */
function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (name && IDENTIFIER.test(name)) names.add(name);
    }
  }
  if (/export\s+default\b/.test(source)) names.add("default");
  return [...names];
}

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

// ---------------------------------------------------------------------------
// Shims: next/headers outside a request, for repo code and packages alike
// ---------------------------------------------------------------------------

const NEXT_HEADERS_SHIM = path.join(SHIMS, "next-headers.cjs");

function writeShims() {
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

const SHIMMED_SPECIFIERS = new Map([
  ["next/headers", NEXT_HEADERS_SHIM],
  ["next/headers.js", NEXT_HEADERS_SHIM],
]);

/** Redirects shimmed specifiers for packages Node loads itself (CommonJS and ESM). */
function installModuleHooks() {
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
// Environment
// ---------------------------------------------------------------------------

const ENV_FILES = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.defaults",
  ".env.development",
  ".env.local.example",
  ".env.development.example",
  ".env.test",
];

/** Keys left alone: runtime/framework switches, where a fake value changes behaviour. */
const ENV_LEAVE_ALONE = /^(NODE_ENV|NODE_\w+|NEXT_RUNTIME|NEXT_PHASE|__NEXT\w*|TURBOPACK|CI|VERCEL\w*|DEBUG|PORT|HOSTNAME|HOME|PATH|PWD|TZ|LANG|npm_\w+)$/;
/** Feature flags stay unset rather than accidentally on. */
const ENV_FLAG = /(^|_)(ENABLE|ENABLED|DISABLE|DISABLED|FEATURE|FLAG|USE|IS|SHOW|HIDE|SKIP|MOCK)(_|$)/;

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]] = value;
  }
  return out;
}

/** A plausible placeholder by the key's name — long enough for secret-length checks, valid as a URL where one is expected. */
function placeholderFor(key) {
  const k = key.toUpperCase();
  if (/(DATABASE|DB|POSTGRES|PG|MYSQL|MONGO|REDIS|VALKEY)_?(URL|URI|DSN)$/.test(k)) {
    if (k.includes("MONGO")) return "mongodb://localhost.invalid:27017/preview";
    if (k.includes("REDIS") || k.includes("VALKEY")) return "redis://localhost.invalid:6379";
    if (k.includes("MYSQL")) return "mysql://preview:preview@localhost.invalid:3306/preview";
    return "postgres://preview:preview@localhost.invalid:5432/preview";
  }
  if (/(URL|URI|ENDPOINT|HOST|ORIGIN|DOMAIN)$/.test(k)) return "http://localhost.invalid";
  if (/PORT$/.test(k)) return "3000";
  if (/(SECRET|KEY|TOKEN|PASSWORD|PASS|SALT|PRIVATE|SIGNATURE)/.test(k)) return "graphreview-preview-placeholder-0123456789abcdef0123456789";
  if (/EMAIL$/.test(k)) return "preview@example.com";
  if (/(TIMEOUT|TTL|LIMIT|MAX|MIN|COUNT|SIZE|EXPIRES|EXPIRY)/.test(k)) return "60";
  return "preview-placeholder";
}

let envFileValues = {};

function loadEnvFiles() {
  for (const name of ENV_FILES) {
    const file = path.join(PROJECT, name);
    if (!existsSync(file)) continue;
    const values = parseEnvFile(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (value === "" || key in envFileValues) continue;
      envFileValues[key] = value;
    }
  }
  for (const [key, value] of Object.entries(envFileValues)) {
    if (!process.env[key] && !ENV_LEAVE_ALONE.test(key)) process.env[key] = value;
  }
}

/** Every process.env key the bundled repo code reads statically, filled with a placeholder when still unset. */
function fillEnvFromBundle() {
  const keys = new Set();
  for (const file of readdirSync(OUT)) {
    if (!file.endsWith(".js")) continue;
    const text = readFileSync(path.join(OUT, file), "utf8");
    for (const m of text.matchAll(/process\.env\.([A-Za-z_][\w]*)/g)) keys.add(m[1]);
    for (const m of text.matchAll(/process\.env\[\s*["']([A-Za-z_][\w]*)["']\s*\]/g)) keys.add(m[1]);
  }
  const filled = [];
  for (const key of keys) {
    if (process.env[key] || ENV_LEAVE_ALONE.test(key) || ENV_FLAG.test(key.toUpperCase())) continue;
    process.env[key] = placeholderFor(key);
    filled.push(key);
  }
  if (filled.length > 0) notes.add(`placeholder values for ${filled.slice(0, 8).join(", ")}${filled.length > 8 ? ` and ${filled.length - 8} more` : ""}`);
}

/** Vite-style import.meta.env, as a build-time constant like Vite makes it. */
function importMetaEnv() {
  const env = { MODE: "development", DEV: true, PROD: false, SSR: false, BASE_URL: "/" };
  for (const [key, value] of Object.entries(envFileValues)) {
    if (/^(VITE_|PUBLIC_|REACT_APP_)/.test(key)) env[key] = value;
  }
  return env;
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

/** What a client bundle gets for a "use server" module in Next.js: callable references, not the server code. */
const SERVER_ACTION_SOURCE = (names, moduleId) => `
const action = (name) => Object.defineProperty(
  async function (...args) { return globalThis.__graphreviewServerCall(${JSON.stringify(moduleId)}, name, args); },
  "name",
  { value: name }
);
${names.map((n) => (n === "default" ? `export default action("default");` : `export const ${n} = action(${JSON.stringify(n)});`)).join("\n")}
`;

// ---------------------------------------------------------------------------
// Server calls: recorded, and answered from mocks when the job has them
// ---------------------------------------------------------------------------

/** Mocked responses from the job (record → mock → replay): "action <file>#<name>" or "fetch <METHOD> <path>" → value. */
const MOCKS = SPEC.mocks ?? {};
/** Every server call the code made, for the job to mock on the next run. */
const serverCalls = new Map();
const MAX_SERVER_CALLS = 40;

function recordCall(key, detail) {
  const existing = serverCalls.get(key);
  if (existing) existing.count += 1;
  else if (serverCalls.size < MAX_SERVER_CALLS) serverCalls.set(key, { key, count: 1, mocked: key in MOCKS, ...detail });
}

function mockedValue(key) {
  // A fresh copy per call, so one caller mutating the result can't leak into the next.
  return revive(JSON.parse(JSON.stringify(MOCKS[key])));
}

globalThis.__graphreviewServerCall = async (moduleId, name, args) => {
  const key = `action ${moduleId}#${name}`;
  recordCall(key, { kind: "action", module: moduleId, name, args: repr(args).slice(0, 300) });
  return key in MOCKS ? mockedValue(key) : undefined;
};

/** Wraps fetch: a request with a mock gets it as a JSON response; anything else goes to the (offline) real fetch. */
function interceptFetch() {
  const realFetch = globalThis.fetch;
  if (typeof realFetch !== "function") return;
  globalThis.fetch = async function graphreviewFetch(input, init) {
    const rawUrl = typeof input === "string" ? input : input?.url ?? String(input);
    let url;
    try {
      url = new URL(rawUrl, "http://localhost:3000");
    } catch {
      return realFetch(input, init);
    }
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    const local = url.hostname === "localhost" || url.hostname === "localhost.invalid";
    const key = `fetch ${method} ${local ? url.pathname : url.origin + url.pathname}`;
    recordCall(key, { kind: "fetch", method, url: url.href.slice(0, 300), body: typeof init?.body === "string" ? init.body.slice(0, 300) : undefined });
    if (key in MOCKS) {
      return new Response(JSON.stringify(MOCKS[key]), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  };
}

const moduleTypeCache = new Map();

/** Whether Node loads this package file as CommonJS: .cjs, or .js under a package.json without "type": "module". */
function isCommonJs(file) {
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
const RUNTIME_LOADED = /\.(c|m)?js$|\.json$|\.node$/i;

/** Packages that only throw on import outside their intended bundler condition. */
const EMPTY_MODULES = new Set(["server-only", "client-only"]);

/** Repo modules reached from a "use client" boundary — where "use server" imports become action stubs. */
const clientModules = new Set();
let serverActionModules = 0;

function frameworkPlugin() {
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
          serverActionModules += 1;
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

const ASSET_LOADERS = Object.fromEntries(
  [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm", ".mp3", ".wav"].map(
    (ext) => [ext, "dataurl"]
  )
);

// ---------------------------------------------------------------------------
// Providers: what the app's layouts put around pages, and every repo provider
// ---------------------------------------------------------------------------

const SOURCE_DIRS = ["app", "src", "components", "lib", "contexts", "context", "providers", "hooks", "store", "stores", "features", "modules"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "out", ".git", "public", "coverage", ".graphreview-entries"]);
const MAX_SOURCE_FILES = 4000;
const MAX_REPO_PROVIDERS = 30;

function walkSources() {
  const files = [];
  const visit = (dir, depth) => {
    if (files.length >= MAX_SOURCE_FILES || depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SOURCE_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) visit(full, depth + 1);
      } else if (/\.(t|j)sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !/\.(test|spec|stories)\./.test(entry.name)) {
        files.push(full);
      }
    }
  };
  for (const dir of SOURCE_DIRS) {
    const full = path.join(PROJECT, dir);
    if (existsSync(full)) visit(full, 0);
  }
  return [...new Set(files)];
}

/** `import { A, B as C } from "x"` and `import D from "y"` → local name → specifier. */
function parseImports(source) {
  const map = new Map();
  for (const m of source.matchAll(/import\s+(?:type\s+)?([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g)) {
    const [, def, named, spec] = m;
    if (def && def !== "type") map.set(def, spec);
    for (const part of (named ?? "").split(",")) {
      const bits = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      const local = (bits[1] ?? bits[0])?.trim();
      if (local && IDENTIFIER.test(local)) map.set(local, spec);
    }
  }
  return map;
}

function relativeToProject(file) {
  return path.relative(PROJECT, file).split(path.sep).join("/");
}

/** The layout files that wrap the changed file in Next.js: the root layout, then each on its route path. */
function layoutChain() {
  const appRoot = ["app", "src/app"].find((dir) => existsSync(path.join(PROJECT, dir)));
  if (!appRoot) return [];
  const target = relativeToProject(path.join(SRC, SPEC.file));
  const dirs = [appRoot];
  if (target.startsWith(`${appRoot}/`)) {
    const segments = path.posix.dirname(target).split("/").slice(appRoot.split("/").length);
    let current = appRoot;
    for (const segment of segments) {
      current = `${current}/${segment}`;
      dirs.push(current);
    }
  }
  const layouts = [];
  for (const dir of dirs) {
    for (const ext of ["tsx", "jsx", "ts", "js"]) {
      const file = path.join(PROJECT, dir, `layout.${ext}`);
      if (existsSync(file) && relativeToProject(file) !== target) {
        layouts.push(file);
        break;
      }
    }
  }
  return layouts;
}

const PROVIDER_NAME = /^[A-Z]\w*Providers?$/;

/**
 * Provider candidates, each bundled as its own entry so one that fails to
 * load can't take the others (or the component) down:
 *   layout — rendered by a layout around the changed file, in order (outer first)
 *   repo   — any other provider component the repo exports, added on demand
 *            when a render says "must be used within XProvider"
 *   query  — @tanstack/react-query's provider, for "No QueryClient set"
 */
function discoverProviders() {
  const candidates = [];
  const seen = new Set();
  for (const layout of layoutChain()) {
    const source = readFileSync(layout, "utf8");
    const imports = parseImports(source);
    for (const m of source.matchAll(/<([A-Z][\w]*)\b/g)) {
      const name = m[1];
      if (!PROVIDER_NAME.test(name) || seen.has(name) || !imports.has(name)) continue;
      const spec = imports.get(name);
      seen.add(name);
      candidates.push({ name, spec: spec.startsWith(".") ? path.resolve(path.dirname(layout), spec) : spec, layout: true });
    }
  }
  let repoProviders = 0;
  for (const file of walkSources()) {
    if (repoProviders >= MAX_REPO_PROVIDERS) break;
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const name of exportedProviderNames(source)) {
      if (seen.has(name)) continue;
      seen.add(name);
      candidates.push({ name, spec: file, layout: false });
      repoProviders += 1;
    }
    if (!seen.has("__reduxStore")) {
      const store = /export\s+(?:const|let|function)\s+(\w*[sS]tore)\b(?:\s*=\s*(?:configureStore|createStore|legacy_createStore)\s*\(|\s*\()/.exec(source);
      if (store) {
        seen.add("__reduxStore");
        candidates.push({ name: "__reduxStore", spec: file, layout: false, storeExport: store[1] });
      }
    }
  }
  if (isInstalled("@tanstack/react-query")) {
    candidates.push({ name: "__query", spec: "@tanstack/react-query", layout: false, query: true });
  }
  for (const adapter of LIBRARY_ADAPTERS) {
    if (isInstalled(adapter.pkg)) candidates.push({ name: adapter.name, spec: adapter.pkg, layout: false, adapter });
  }
  return candidates;
}

function isInstalled(pkg) {
  return [PROJECT, SRC].some((dir) => existsSync(path.join(dir, "node_modules", ...pkg.split("/"), "package.json")));
}

/** Provider components a file exports: declared exported, `export default X`, or listed in `export { X }`. */
function exportedProviderNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let)\s+([A-Z]\w*Providers?)\b/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s+default\s+([A-Z]\w*Providers?)\s*;?\s*$/gm)) names.add(m[1]);
  for (const m of source.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && PROVIDER_NAME.test(name)) names.add(name);
    }
  }
  return names;
}

/**
 * Library providers a component may need and the app would have set up
 * above it, each added when a render's error points at it. `wrap` gets the
 * library's module namespace (bundled like the repo's own import of it, so
 * it is the same instance) and returns a function that wraps an element.
 */
const LIBRARY_ADAPTERS = [
  {
    name: "__redux",
    label: "a Redux store",
    pkg: "react-redux",
    match: /could not find react-redux context value|could not find "store"/i,
    wrap: (ns, React) => {
      if (!isComponentLike(ns.Provider)) return null;
      return (element) => React.createElement(ns.Provider, { store: reduxStore() }, element);
    },
  },
  {
    name: "__apollo",
    label: "an Apollo client with no server",
    pkg: "@apollo/client",
    match: /Could not find "client"|wrap the root component in an <ApolloProvider>/i,
    wrap: (ns, React) => {
      if (!isComponentLike(ns.ApolloProvider) || typeof ns.ApolloClient !== "function") return null;
      const link = typeof ns.ApolloLink?.empty === "function" ? ns.ApolloLink.empty() : undefined;
      const client = new ns.ApolloClient({ cache: new ns.InMemoryCache(), ...(link ? { link } : { uri: "http://localhost.invalid/graphql" }) });
      return (element) => React.createElement(ns.ApolloProvider, { client }, element);
    },
  },
  {
    name: "__nextIntl",
    label: "next-intl with no messages (keys shown as text)",
    pkg: "next-intl",
    match: /No intl context found|NextIntlClientProvider|IntlProvider was not found/i,
    wrap: (ns, React) => {
      const Provider = ns.NextIntlClientProvider ?? ns.IntlProvider;
      if (!isComponentLike(Provider)) return null;
      const props = { locale: "en", messages: {}, timeZone: "UTC", onError: noop, getMessageFallback: ({ key, namespace }) => (namespace ? `${namespace}.${key}` : key) };
      return (element) => React.createElement(Provider, props, element);
    },
  },
  {
    name: "__reactIntl",
    label: "react-intl with no messages",
    pkg: "react-intl",
    match: /Could not find required `intl` object|\[React Intl\].*IntlProvider/i,
    wrap: (ns, React) => {
      if (!isComponentLike(ns.IntlProvider)) return null;
      return (element) => React.createElement(ns.IntlProvider, { locale: "en", messages: {}, onError: noop }, element);
    },
  },
  {
    name: "__form",
    label: "an empty react-hook-form",
    pkg: "react-hook-form",
    match: /useFormContext|Cannot (?:destructure|read) propert(?:y|ies) (?:of )?'?(?:register|control|formState|watch|setValue|getValues|handleSubmit|getFieldState|trigger)'?/i,
    wrap: (ns, React) => {
      if (typeof ns.useForm !== "function" || !isComponentLike(ns.FormProvider)) return null;
      function PreviewForm({ children }) {
        return React.createElement(ns.FormProvider, ns.useForm(), children);
      }
      return (element) => React.createElement(PreviewForm, null, element);
    },
  },
  ...["styled-components", "@emotion/react"].map((pkg) => ({
    name: `__theme:${pkg}`,
    label: `a stand-in ${pkg} theme`,
    pkg,
    // `theme.colors.primary` with no theme fails on `primary`, inside the library's style interpolation.
    match: (error) =>
      /Cannot read properties of (?:undefined|null)/.test(String(error?.message)) &&
      String(error?.stack ?? "").includes(`node_modules/${pkg}/`),
    wrap: (ns, React) => {
      if (!isComponentLike(ns.ThemeProvider)) return null;
      const theme = fakes.fakeValue("theme", { primitive: "inherit", callableNested: false });
      return (element) => React.createElement(ns.ThemeProvider, { theme }, element);
    },
  })),
];

/** The repo's own Redux store when one was found and loads, else a fake one whose state answers like a stand-in context. */
let reduxStoreValue = null;
function reduxStore() {
  if (reduxStoreValue) return reduxStoreValue;
  if (providers.reduxStore) {
    reduxStoreValue = providers.reduxStore;
    notes.add("rendered with the repo's own Redux store");
    return reduxStoreValue;
  }
  const state = fakes.fakeValue("state");
  fakes.used.add("a stand-in Redux store state");
  reduxStoreValue = { getState: () => state, subscribe: () => noop, dispatch: (action) => action, replaceReducer: noop };
  return reduxStoreValue;
}

function hasNext() {
  return [PROJECT, SRC].some((dir) => existsSync(path.join(dir, "node_modules", "next", "package.json")));
}

/**
 * Bundles the changed file (entry "entry") and the provider candidates
 * (entries "p0", "p1", …) in one build with code splitting, so modules they
 * share — a context object, a store — are one instance, like in the app.
 */
async function bundle(needsReact, providerCandidates) {
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
// A browser to render in (happy-dom)
// ---------------------------------------------------------------------------

let domReady = false;

/** Registers happy-dom's window/document as globals, plus the browser APIs it lacks that UI libraries touch on mount. */
function setUpDom() {
  try {
    const { GlobalRegistrator } = harnessRequire("@happy-dom/global-registrator");
    GlobalRegistrator.register({ url: "http://localhost:3000/", width: 1280, height: 800 });
  } catch (error) {
    warnings.push(`browser environment unavailable: ${errorText(error)}`);
    return;
  }
  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  globalThis.ResizeObserver ??= NoopObserver;
  globalThis.IntersectionObserver ??= NoopObserver;
  globalThis.MutationObserver ??= NoopObserver;
  if (globalThis.Element && !Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = noop;
  globalThis.requestIdleCallback ??= (fn) => setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 1);
  globalThis.cancelIdleCallback ??= (id) => clearTimeout(id);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  domReady = true;
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

/** The stand-in Next router, outermost around every render (set up by `setUpNextRouter`). */
let routerWrap = null;

/** Providers that loaded: the layouts' (in order), all by name, and react-query's. */
const providers = { layout: [], byName: new Map(), query: null, adapters: new Map(), reduxStore: null };

/**
 * A stand-in Next.js app router: pathname "/", no search params, and
 * navigation that does nothing — enough for Link, useRouter, usePathname and
 * useSearchParams to render instead of throwing.
 */
function setUpNextRouter(loaded) {
  const routerContext = loaded.__nextRouter?.AppRouterContext;
  if (!routerContext || typeof routerContext !== "object") return;
  const hooks = loaded.__nextHooks ?? {};
  const router = { push: noop, replace: noop, refresh: noop, prefetch: noop, back: noop, forward: noop, hmrRefresh: noop };
  routerWrap = (React, element) => {
    let tree = element;
    if (hooks.SearchParamsContext) tree = React.createElement(hooks.SearchParamsContext.Provider, { value: new URLSearchParams() }, tree);
    if (hooks.PathnameContext) tree = React.createElement(hooks.PathnameContext.Provider, { value: routePathname() }, tree);
    if (hooks.PathParamsContext) tree = React.createElement(hooks.PathParamsContext.Provider, { value: paramsFromRoute(SPEC.file) }, tree);
    return React.createElement(routerContext.Provider, { value: router }, tree);
  };
}

function isComponentLike(value) {
  return typeof value === "function" || Boolean(value && typeof value === "object" && value.$$typeof);
}

/** Loads each provider candidate on its own; one that fails to load is just left out. */
async function setUpProviders(candidates) {
  for (const candidate of candidates) {
    try {
      const { ns } = await withTimeout(import(pathToFileURL(candidate.out).href), SPEC.caseTimeoutMs, `Importing ${candidate.name}`);
      if (candidate.adapter) {
        const wrap = bundleReact && candidate.adapter.wrap(ns, bundleReact);
        if (wrap) providers.adapters.set(candidate.name, { ...candidate.adapter, wrapElement: wrap });
        continue;
      }
      if (candidate.storeExport) {
        const value = ns[candidate.storeExport];
        const store = typeof value === "function" && !value.getState ? value() : value;
        if (store && typeof store.getState === "function") providers.reduxStore = store;
        continue;
      }
      if (candidate.query) {
        if (typeof ns.QueryClient === "function" && isComponentLike(ns.QueryClientProvider)) {
          providers.query = (React, element) =>
            React.createElement(
              ns.QueryClientProvider,
              { client: new ns.QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }) },
              element
            );
        }
        continue;
      }
      const Comp = isComponentLike(ns[candidate.name]) ? ns[candidate.name] : isComponentLike(ns.default) ? ns.default : null;
      if (!Comp) continue;
      providers.byName.set(candidate.name, Comp);
      if (candidate.layout) providers.layout.push({ name: candidate.name, Comp });
    } catch {
      /* not available: renders go ahead without it */
    }
  }
  if (providers.layout.length > 0) notes.add(`rendered inside the app's layout providers (${providers.layout.map((p) => p.name).join(", ")})`);
}

/** The React the bundle uses, for building adapter elements (set once the entry is loaded). */
let bundleReact = null;

/**
 * Router (outermost) › layout providers › providers added on demand › compound
 * parent › the component. With stand-ins on, the repo's providers also get
 * fake values for the props the app would have passed them.
 */
function wrapElement(React, element, plan) {
  let tree = element;
  const provider = (Comp, name) => React.createElement(plan.stubs ? withFakeProps(Comp, name) : Comp, null, tree);
  if (plan.compound) tree = React.createElement(plan.compound, { open: true, defaultOpen: true }, tree);
  for (const name of [...plan.extra].reverse()) {
    if (name === "__query") tree = providers.query(React, tree);
    else if (providers.adapters.has(name)) tree = providers.adapters.get(name).wrapElement(tree);
    else tree = provider(providers.byName.get(name), name);
  }
  if (plan.layout) for (const p of [...providers.layout].reverse()) tree = provider(p.Comp, p.name);
  return routerWrap ? routerWrap(React, tree) : tree;
}

const fakePropsWrappers = new WeakMap();

/** A function component called with its props plus fakes for whatever else it reads; anything else as it is. */
function withFakeProps(Comp, name) {
  if (typeof Comp !== "function" || Comp.prototype?.isReactComponent || isAsyncFunction(Comp)) return Comp;
  let wrapper = fakePropsWrappers.get(Comp);
  if (!wrapper) {
    wrapper = function PreviewProps(props) {
      return Comp(fakes.fakeProps(props, name));
    };
    Object.defineProperty(wrapper, "name", { value: `${name} (stand-in props)` });
    fakePropsWrappers.set(Comp, wrapper);
  }
  return wrapper;
}

// ---------------------------------------------------------------------------
// Contexts nobody provided: stand-in values on a retry
// ---------------------------------------------------------------------------

/** Contexts the repo's own code created with an empty default (null/undefined), with a name for the notes. */
const repoContexts = new Map();
/** Repo contexts read with no provider above them during the current render attempt. */
const contextMisses = new Set();
/** Repo contexts that got a stand-in during the current render attempt. */
const contextStandIns = new Set();
let contextStandInsOn = false;

/** `const AuthContext = createContext(…)` on the bundle line that created a context, or its displayName later. */
function contextNameFromStack(frame) {
  const m = /\((?:file:\/\/)?(\/[^:)]+):(\d+):\d+\)|at (?:file:\/\/)?(\/[^:\s]+):(\d+):\d+/.exec(frame ?? "");
  const file = m?.[1] ?? m?.[3];
  const line = Number(m?.[2] ?? m?.[4]);
  if (!file || !line) return null;
  try {
    const text = readFileSync(file, "utf8").split("\n")[line - 1] ?? "";
    return /(?:const|let|var)\s+([A-Za-z_$][\w$]*?)\d*\s*=/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

function contextName(ctx) {
  const info = repoContexts.get(ctx);
  return ctx.displayName || info?.name || "a context";
}

/**
 * Wraps React's createContext/useContext/use (before the repo's code loads,
 * so its imports see the wrapped ones): contexts the repo creates with an
 * empty default are remembered, and while stand-ins are on, reading one with
 * no provider above it gives a fake value instead of null. Library contexts
 * are left alone — their adapters handle them.
 */
function installContextStandIns() {
  const instances = [];
  for (const load of [() => projectRequire()("react"), () => harnessRequire("react")]) {
    try {
      const React = load();
      if (React && !instances.includes(React)) instances.push(React);
    } catch {
      /* not installed there */
    }
  }
  for (const React of instances) {
    if (React.__graphreviewContexts || typeof React.createContext !== "function") continue;
    const realCreate = React.createContext;
    const realUseContext = React.useContext;
    const realUse = React.use;
    const standIn = (ctx, value) => {
      if (value !== null && value !== undefined) return value;
      const info = repoContexts.get(ctx);
      if (!info) return value;
      contextMisses.add(ctx);
      if (!contextStandInsOn) return value;
      contextStandIns.add(contextName(ctx));
      info.fake ??= fakes.fakeValue(contextName(ctx));
      return info.fake;
    };
    try {
      React.createContext = function createContext(defaultValue, ...rest) {
        const ctx = realCreate.call(this, defaultValue, ...rest);
        if (defaultValue === null || defaultValue === undefined) {
          const frame = new Error().stack?.split("\n")[2] ?? "";
          if (frame.includes(OUT)) repoContexts.set(ctx, { name: contextNameFromStack(frame) });
        }
        return ctx;
      };
      React.useContext = function useContext(ctx, ...rest) {
        return standIn(ctx, realUseContext.call(this, ctx, ...rest));
      };
      if (typeof realUse === "function") {
        React.use = function use(usable, ...rest) {
          const value = realUse.call(this, usable, ...rest);
          return repoContexts.has(usable) ? standIn(usable, value) : value;
        };
      }
      React.__graphreviewContexts = true;
    } catch (error) {
      warnings.push(`context stand-ins unavailable: ${errorText(error)}`);
    }
  }
}

/** `components/ui/dropdown-menu.tsx` → `DropdownMenu`: the root of a shadcn/Radix-style compound component file. */
function compoundRootName(file) {
  const base = path.posix.basename(file).replace(/\.(t|j)sx?$/, "");
  return base
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

/**
 * What a failed render is missing, read from its error: a repo provider
 * ("useAuth must be used within AuthProvider"), react-query's client, or —
 * for a compound part like SheetContent ("must be used within `Dialog`") —
 * its parent from the same file.
 */
function missingContext(error, mod) {
  const message = String(error?.message ?? error);
  if (/No QueryClient set/i.test(message) && providers.query) return { provider: "__query" };
  for (const [name, adapter] of providers.adapters) {
    if (adapter.match instanceof RegExp ? adapter.match.test(message) : adapter.match(error)) return { provider: name };
  }
  const m =
    /(?:must be (?:used|rendered|called) (?:with)?in(?:side)?|used outside(?: of)?|outside (?:of )?(?:an? |the )?|wrap(?:ped)?(?: \w+)? (?:in|with)|requires? (?:an? )?|within (?:an? |the )?|inside (?:an? |the )?)(?:\s*(?:an?|the)\s)?[\s`'"<]*([A-Z][\w.]*)/.exec(
      message
    );
  if (!m) return null;
  const name = m[1].split(".").pop();
  for (const candidate of [name, `${name}Provider`, name.replace(/Context$/, "Provider"), name.replace(/Context$/, "")]) {
    if (providers.byName.has(candidate)) return { provider: candidate };
  }
  if (isComponentLike(mod[name])) return { compound: mod[name] };
  const root = compoundRootName(SPEC.file);
  if (isComponentLike(mod[root])) return { compound: mod[root] };
  return null;
}

function renderOnServer(React, server, element) {
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
 * Renders like a browser does: react-dom/client into happy-dom, effects and
 * timers allowed to settle, then the whole <body> captured — including
 * portals (dialogs, popovers, toasts mount there, not in the component's
 * container) and any <style> a CSS-in-JS library injected into <head>.
 */
async function renderInBrowser(React, client, element) {
  const container = document.createElement("div");
  container.setAttribute("data-graphreview-root", "");
  document.body.appendChild(container);
  let uncaught = null;
  const root = client.createRoot(container, {
    onUncaughtError(error) {
      uncaught ??= error;
    },
    onRecoverableError() {},
  });
  const act = typeof React.act === "function" ? React.act : null;
  try {
    if (act) await act(async () => root.render(element));
    else root.render(element);
    await sleep(SETTLE_MS);
    if (act) await act(async () => {});
    if (uncaught) throw uncaught;
    const injected = [...document.head.querySelectorAll("style")].map((s) => s.outerHTML).join("");
    const body = [...document.body.childNodes]
      .map((node) => (node === container ? container.innerHTML : node.outerHTML ?? node.textContent ?? ""))
      .join("");
    return injected + body;
  } finally {
    try {
      if (act) await act(async () => root.unmount());
      else root.unmount();
    } catch {
      /* already torn down by an error */
    }
    document.body.innerHTML = "";
    for (const style of [...document.head.querySelectorAll("style")]) style.remove();
  }
}

const NEXT_ROUTE_FILE = /(^|\/)app\/(.*\/)?(page|layout|template|default|not-found|error|loading)\.(t|j)sx?$/;

/** The URL a Next.js route file serves: `app/(shop)/comparator/[id]/page.tsx` → `/comparator/example-id`. "/" for anything else. */
function routePathname() {
  const rel = relativeToProject(path.join(SRC, SPEC.file));
  const m = /^(?:src\/)?app\/(.*)$/.exec(rel);
  if (!m || !NEXT_ROUTE_FILE.test(SPEC.file)) return "/";
  const params = paramsFromRoute(SPEC.file);
  const segments = m[1]
    .split("/")
    .slice(0, -1)
    .filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith("@"))
    .map((segment) => {
      const name = /^\[\[?(?:\.\.\.)?(\w+)\]?\]$/.exec(segment)?.[1];
      if (!name) return segment;
      const value = params[name];
      return Array.isArray(value) ? value.join("/") : value;
    });
  return `/${segments.join("/")}`;
}

/** Visible text of rendered markup, ignoring styles and scripts — empty means nothing to look at. */
function visibleText(html) {
  return (html ?? "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

const CALLBACK_PROP = /^(on[A-Z]|handle[A-Z]|render[A-Z]?|set[A-Z]|get[A-Z]|fetch[A-Z]|load[A-Z]|format[A-Z]|validate[A-Z]|toggle[A-Z])|(Callback|Handler|Fn|Func|Function|Action|Listener)$/;

/**
 * Props as a real caller would pass them: callback-looking props the model
 * gave as {} or a string become no-op functions; Next.js route files get
 * awaitable params/searchParams (from the route folder when missing) and
 * layouts a stand-in children.
 */
function realisticProps(React, props) {
  const out = { ...props };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "function" || !CALLBACK_PROP.test(key)) continue;
    const placeholder =
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
    if (placeholder && !(key === "render" && typeof value === "boolean")) out[key] = noop;
  }
  for (const [key, value] of Object.entries(out)) {
    if (!COMPONENT_PROP.test(key) || isComponentLike(value) || React.isValidElement?.(value)) continue;
    out[key] = componentFor(React, value);
  }
  if (!NEXT_ROUTE_FILE.test(SPEC.file)) {
    for (const key of ["params", "searchParams"]) if (key in out) out[key] = awaitable(out[key]);
    return out;
  }
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

/** Props that take a component (an icon, a polymorphic `as`), which JSON inputs can only name. */
const COMPONENT_PROP = /^(icon|Icon|as|component|Component|iconComponent|IconComponent)$|[a-z]Icon$|Component$/;

let iconLibrary;

/** The repo's lucide-react, if it has one, for icon names given as strings. */
function lucideIcons() {
  if (iconLibrary !== undefined) return iconLibrary;
  try {
    iconLibrary = projectRequire()("lucide-react");
  } catch {
    iconLibrary = null;
  }
  return iconLibrary;
}

/** A component for a component-valued prop: the named lucide icon when there is one, else a small placeholder glyph. */
function componentFor(React, value) {
  if (typeof value === "string") {
    const name = value.replace(/Icon$/, "");
    const icon = lucideIcons()?.[value] ?? lucideIcons()?.[name] ?? lucideIcons()?.[`${name}Icon`];
    if (isComponentLike(icon)) return icon;
  }
  return function PlaceholderIcon(props) {
    return React.createElement("span", { "aria-hidden": true, className: props?.className, style: { display: "inline-block", width: "1em", height: "1em", border: "1px solid currentColor", borderRadius: "3px", opacity: 0.6 } });
  };
}

function isAsyncFunction(fn) {
  return typeof fn === "function" && fn.constructor?.name === "AsyncFunction";
}

/**
 * Which renderer first: async components (server components) need the server
 * renderer; everything else renders like it would in the browser. The other
 * renderer is the fallback when the first one fails.
 */
function renderOrder(Component, entryDirective) {
  if (!domReady) return ["server"];
  if (isAsyncFunction(Component)) return ["server", "browser"];
  if (hasNext() && entryDirective !== "client" && NEXT_ROUTE_FILE.test(SPEC.file)) return ["server", "browser"];
  return ["browser", "server"];
}

const MAX_CONTEXT_RETRIES = 6;

/**
 * Renders one case, learning what it needs as it goes: start inside the
 * layouts' providers; when an error names a missing provider or compound
 * parent, add it and render again; if the layout providers themselves seem to
 * be the problem, try once without them. Then the other renderer.
 */
async function renderCase(React, renderers, Component, props, order, mod) {
  const attempts = [];
  for (const how of order) {
    const plan = { layout: providers.layout.length > 0, extra: [], compound: null, stubs: false };
    // A provider added for a context may itself fail before its children read it, so remember any miss.
    let missedContext = false;
    for (let attempt = 0; attempt <= MAX_CONTEXT_RETRIES; attempt++) {
      const element = wrapElement(React, React.createElement(Component, props), plan);
      contextMisses.clear();
      contextStandIns.clear();
      contextStandInsOn = plan.stubs;
      try {
        const html =
          how === "browser"
            ? await withTimeout(renderInBrowser(React, renderers.client, element), SPEC.caseTimeoutMs, "Rendering")
            : await renderOnServer(React, renderers.server, element);
        // A fallback render that shows nothing isn't a success: the earlier error is the real answer.
        if (attempts.some((a) => a.how !== how) && !visibleText(html)) throw attempts.find((a) => a.how !== how).error;
        return { html, how, plan, attempts, standIns: [...contextStandIns] };
      } catch (error) {
        // Next's notFound()/redirect() are the component's answer, not a renderer problem.
        if (/NEXT_HTTP_ERROR_FALLBACK|NEXT_REDIRECT/.test(String(error?.digest ?? error?.message ?? ""))) throw error;
        attempts.push({ how, error });
        missedContext ||= contextMisses.size > 0;
        const missing = missingContext(error, mod);
        if (missing?.provider && !plan.extra.includes(missing.provider)) {
          plan.extra.push(missing.provider);
          continue;
        }
        if (missing?.compound && !plan.compound) {
          plan.compound = missing.compound;
          continue;
        }
        // A repo context was read with nothing above it: try again with stand-ins.
        if (!plan.stubs && missedContext) {
          plan.stubs = true;
          continue;
        }
        if (plan.layout && !missing) {
          plan.layout = false;
          continue;
        }
        break;
      }
    }
  }
  // The most informative failure: the browser attempt with the most context, else the first.
  throw (attempts.findLast((a) => a.how === order[0]) ?? attempts[0])?.error ?? new Error("Nothing rendered.");
}

async function runComponent(Component, symbol, React, renderers, entryDirective, mod) {
  const cases = [];
  const order = renderOrder(Component, entryDirective);
  for (const c of symbol.cases) {
    const props = realisticProps(React, revive(c.input?.props ?? {}));
    const logs = [];
    currentLogs = logs;
    const started = Date.now();
    const outcome = { label: c.label };
    try {
      const { html, how, plan, attempts, standIns } = await renderCase(React, renderers, Component, props, order, mod);
      outcome.html = html.length > MAX_HTML ? `${html.slice(0, MAX_HTML)}<!-- truncated -->` : html;
      const added = [
        ...plan.extra.map((n) => (n === "__query" ? "QueryClientProvider" : providers.adapters.get(n)?.label ?? n)),
        ...(plan.compound ? ["its parent component"] : []),
      ];
      if (added.length > 0) logs.push(`info: rendered inside ${added.join(", ")}`);
      if (standIns.length > 0) {
        logs.push(`info: stand-in values (fake, e.g. "Preview User") for ${standIns.join(", ")} — no provider above it in the preview`);
      }
      if (plan.stubs && (plan.layout || plan.extra.length > 0)) logs.push("info: the providers got stand-in values for props the app would pass them");
      if (attempts.length > 0 && added.length === 0 && standIns.length === 0) {
        logs.push(`info: rendered ${how === "browser" ? "in the browser" : "on the server"} after: ${errorText(attempts[0].error).slice(0, 300)}`);
      }
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
  const entryDirective = directiveOf(readFileSync(path.join(SRC, SPEC.file), "utf8"));

  writeShims();
  installModuleHooks();
  loadEnvFiles();

  // A Next.js route file without "use client" is a server component: it runs
  // where there is no window, and its server-only guards expect exactly that.
  const serverEntry = hasNext() && entryDirective !== "client" && NEXT_ROUTE_FILE.test(SPEC.file);
  const providerCandidates = needsReact ? discoverProviders() : [];

  let loaded;
  try {
    const bundled = await bundle(needsReact, providerCandidates);
    result.css = bundled.css;
    fillEnvFromBundle();
    if (serverActionModules > 0) notes.add(`${serverActionModules} server action module(s) replaced by stubs, as Next.js does in client code`);
    // The DOM must exist before React DOM loads: it decides at import time whether it runs in a browser.
    if (needsReact && !serverEntry) setUpDom();
    // After the DOM: happy-dom installs its own fetch, which is the one to wrap.
    interceptFetch();
    if (needsReact) installContextStandIns();
    currentLogs = [];
    const importLogs = currentLogs;
    loaded = await withTimeout(import(pathToFileURL(path.join(OUT, "entry.js")).href), SPEC.caseTimeoutMs * 2, "Importing the module");
    currentLogs = null;
    if (importLogs.length) warnings.push(...importLogs.map((l) => `on import: ${l}`));
  } catch (error) {
    currentLogs = null;
    // esbuild's way of saying its process died — in practice, the memory cap.
    result.fatal = /service (was|is no longer running|stopped)/i.test(String(error?.message ?? error))
      ? `The bundler was killed while bundling ${SPEC.file}, almost certainly for running out of memory ` +
        `(this sandbox allows ${process.env.GRAPHREVIEW_MEMORY ?? "a fixed amount"}). Raise PREVIEW_MEMORY in config.env (in the GraphReview data folder) and restart GraphReview.`
      : `Could not load ${SPEC.file}: ${errorText(error)}`;
    result.stubbedModules = [...stubbed];
  result.serverCalls = [...serverCalls.values()];
    result.warnings.push(...[...notes].map((n) => `note: ${n}`));
    await emit(result);
    return;
  }

  const mod = loaded.__mod;
  if (needsReact) {
    bundleReact = loaded.__react;
    setUpNextRouter(loaded);
    await setUpProviders(providerCandidates);
  }
  for (const symbol of SPEC.symbols) {
    const entry = { name: symbol.name, kind: symbol.kind };
    const value = pickExport(mod, symbol.name);
    if (value === undefined) {
      entry.error = `"${symbol.name}" is not exported from ${SPEC.file}, so it can't be called from outside.`;
    } else if (symbol.kind === "component") {
      const Component = unwrapComponent(value);
      entry.cases = Component
        ? await runComponent(Component, symbol, loaded.__react, { server: loaded.__server, client: loaded.__client }, entryDirective, mod)
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
  result.serverCalls = [...serverCalls.values()];
  for (const use of fakes.used) notes.add(`stand-in: ${use}`);
  result.warnings.push(...[...notes].map((n) => `note: ${n}`));
  await emit(result);
}

main()
  .catch((error) => emit({ side: SPEC.side, symbols: [], fatal: errorText(error), warnings }))
  .finally(() => {
    // Exit once the result is flushed: lingering timers/sockets in user code must not keep the container alive.
    process.exit(0);
  });
