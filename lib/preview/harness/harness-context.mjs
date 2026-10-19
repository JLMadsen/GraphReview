// Shared by every part of the Node preview harness (node-harness.mjs, and the
// session worker harness-worker.mjs): the job's spec and paths, limits, the
// run's mutable state, and small helpers for values, errors, source text and
// Next.js routes.
//
// SPEC, PROJECT, OUT and ENTRIES are live bindings: a one-shot run reads its
// spec from /job/spec.json once, a session worker points them at each file in
// turn with setSpec().

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

export const SRC = "/src";

const OUT_ROOT = "/tmp/graphreview-preview";

/** The harness's entry folder inside the project; a session gives it its own tmpfs (lib/preview/sandbox.ts). */
const ENTRIES_DIR = ".graphreview-entries";

export let SPEC = existsSync("/job/spec.json") ? JSON.parse(readFileSync("/job/spec.json", "utf8")) : { file: "", projectRoot: ".", symbols: [], mocks: {} };

export let PROJECT = path.join(SRC, SPEC.projectRoot || ".");

export let OUT = OUT_ROOT;

// Inside the project, so the repo's tsconfig paths (`@/…`) resolve for the entries' imports.
export let ENTRIES = path.join(PROJECT, ENTRIES_DIR);

let runCount = 0;

/**
 * Points the harness at the next file (session worker). Each run gets its own
 * output and entry folders: Node caches ES modules by URL, so a bundle written
 * where the previous file's was would be served from that cache.
 */
export function setSpec(spec) {
  SPEC = spec;
  PROJECT = path.join(SRC, SPEC.projectRoot || ".");
  runCount += 1;
  OUT = path.join(OUT_ROOT, `r${runCount}`);
  ENTRIES = path.join(PROJECT, ENTRIES_DIR, `w${process.pid}-r${runCount}`);
}

/** Clears what one file's run left in the shared state (session worker, between files). */
export function resetRunState() {
  stubbed.clear();
  warnings.length = 0;
  notes.clear();
  Object.assign(state, {
    currentLogs: null,
    serverActionModules: 0,
    reduxStoreValue: null,
    routerWrap: null,
    bundleReact: null,
    contextStandInsOn: false,
  });
}

/**
 * Whether a run renders in a browser (happy-dom): components, except a
 * Next.js route file without "use client", which is a server component and
 * runs where there is no window. A session keeps one worker for each answer,
 * since packages decide at import time whether they run in a browser.
 */
export function needsDom(spec) {
  if (!spec.symbols?.some((s) => s.kind === "component")) return false;
  let directive = null;
  try {
    directive = directiveOf(readFileSync(path.join(SRC, spec.file), "utf8"));
  } catch {
    /* unreadable: the run reports it */
  }
  const project = path.join(SRC, spec.projectRoot || ".");
  const next = [project, SRC].some((dir) => existsSync(path.join(dir, "node_modules", "next", "package.json")));
  return !(next && directive !== "client" && NEXT_ROUTE_FILE.test(spec.file));
}

export const SHIMS = "/tmp/graphreview-shims";

export const MAX_REPR = 4000;

export const MAX_HTML = 200_000;

export const MAX_CSS = 400_000;

export const MAX_LOG_LINES = 40;

/** How long a client render may keep settling (effects, timers, lazy imports) before its DOM is captured. */
export const SETTLE_MS = 400;

export const harnessRequire = createRequire("/harness/node_modules/");

export const stubbed = new Set();

export const warnings = [];

export const notes = new Set();

/**
 * The harness's mutable state, in one object so every module reads and
 * writes the same values (an imported binding is read-only).
 */
export const state = {
  /** The running case's captured log lines (console output, errors after a render); null between cases. */
  currentLogs: null,
  /** Values from the committed env files (loadEnvFiles), also given to the bundle as import.meta.env. */
  envFileValues: {},
  /** "use server" modules the bundle replaced with action stubs. */
  serverActionModules: 0,
  /** The repo's own Redux store when one was found and loads, else a fake one whose state answers like a stand-in context. */
  reduxStoreValue: null,
  /** Whether happy-dom's globals are installed (setUpDom), so client renders can run in it. */
  domReady: false,
  /** The stand-in Next router, outermost around every render (set up by `setUpNextRouter`). */
  routerWrap: null,
  /** The React the bundle uses, for building adapter elements (set once the entry is loaded). */
  bundleReact: null,
  /** Whether repo contexts read with no provider get stand-in values — on for a retry after a render failed on one. */
  contextStandInsOn: false,
  /** lucide-react from the repo, once looked up; null when it isn't installed. */
  iconLibrary: undefined,
};

export function repr(value) {
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

export function errorText(error) {
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

export const noop = () => {};

// Inputs are JSON; a few tagged objects stand in for values JSON can't hold.
export function revive(value) {
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

export function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A value that works both awaited and read directly: Next 15 passes `params`
 * and `searchParams` as Promises (`const { id } = await params`), Next 14 and
 * older as plain objects (`params.id`). A resolved Promise carrying the
 * object's own properties satisfies both.
 */
export function awaitable(value) {
  if (value && typeof value.then === "function") return value;
  const promise = Promise.resolve(value);
  return value && typeof value === "object" ? Object.assign(promise, value) : promise;
}

// ---------------------------------------------------------------------------
// Directives and source helpers
// ---------------------------------------------------------------------------

export const DIRECTIVE = /^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*(?:#![^\n]*\n\s*)?["']use (client|server)["']/;

export function directiveOf(source) {
  return DIRECTIVE.exec(source)?.[1] ?? null;
}

export function isRepoSource(file) {
  return /\.(c|m)?(j|t)sx?$/.test(file) && !/[\\/]node_modules[\\/]/.test(file) && file.startsWith(SRC);
}

export const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Names a module exports, from its source (good enough for action modules: functions and consts). */
export function exportedNames(source) {
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

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Names an importer pulls from `specifier` via `import { a, b as c }` / `export { a } from` — a stub must export each one as ESM. */
export function importedNames(importer, specifier) {
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

export function relativeToProject(file) {
  return path.relative(PROJECT, file).split(path.sep).join("/");
}

export function hasNext() {
  return [PROJECT, SRC].some((dir) => existsSync(path.join(dir, "node_modules", "next", "package.json")));
}

export function projectRequire() {
  return createRequire(path.join(PROJECT, "package.json"));
}

export function isComponentLike(value) {
  return typeof value === "function" || Boolean(value && typeof value === "object" && value.$$typeof);
}

export const NEXT_ROUTE_FILE = /(^|\/)app\/(.*\/)?(page|layout|template|default|not-found|error|loading)\.(t|j)sx?$/;

/** The URL a Next.js route file serves: `app/(shop)/comparator/[id]/page.tsx` → `/comparator/example-id`. "/" for anything else. */
export function routePathname() {
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

/** `app/repo/[repoId]/[...slug]/layout.tsx` → `{ repoId: "example-repoId", slug: ["example"] }`. */
export function paramsFromRoute(file) {
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

export function isAsyncFunction(fn) {
  return typeof fn === "function" && fn.constructor?.name === "AsyncFunction";
}
