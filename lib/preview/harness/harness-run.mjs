// One file's run, shared by the one-shot entry (node-harness.mjs) and the
// session worker (harness-worker.mjs) — DESIGN.md §6.9. Importing this module
// sets the process up (console capture, error handlers, the fakes global);
// runFile() then bundles, loads and runs one file's changed symbols, starting
// from clean per-file state, so a session worker can call it again and again.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import * as fakes from "./preview-fakes.mjs";
import { MAX_CSS, MAX_LOG_LINES, NEXT_ROUTE_FILE, OUT, PROJECT, SPEC, SRC, directiveOf, errorText, hasNext, notes, repr, resetRunState, revive, state, stubbed, warnings, withTimeout } from "./harness-context.mjs";
import { fillEnvFromBundle, loadEnvFiles } from "./harness-env.mjs";
import { interceptFetch, resetMocks, serverCalls } from "./harness-mocks.mjs";
import { bundle, installModuleHooks, resetBundleState, writeShims } from "./harness-bundle.mjs";
import { discoverProviders, resetProviders, setUpNextRouter, setUpProviders } from "./harness-providers.mjs";
import { buildGlobalCss } from "./harness-css.mjs";
import { installContextStandIns, resetRenderState, runComponent, setUpDom, tearDownDom } from "./harness-render.mjs";

export const RESULT_MARKER = "@@GRAPHREVIEW_PREVIEW_RESULT@@";

// Packages are loaded by Node at runtime (not bundled), so they read this
// themselves; React and Next pick their development builds, as in `next dev`.
process.env.NODE_ENV ??= "development";

// The bundled repo code reaches the fakes (replaced auth modules) through here.
globalThis.__graphreviewFakes = fakes;

// Errors thrown after a render returned — in an effect, a timer, a rejected
// fetch — must not kill the run (and every other case with it). They're kept
// in the current case's log instead.
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (state.currentLogs && state.currentLogs.length < MAX_LOG_LINES) state.currentLogs.push(`error (after render): ${text}`.slice(0, 500));
  });
}

// ---------------------------------------------------------------------------
// Console capture: user code may log; keep it per case, out of stdout.
// ---------------------------------------------------------------------------

export const realStdoutWrite = process.stdout.write.bind(process.stdout);

for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...args) => {
    const line = args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 3 }))).join(" ");
    if (state.currentLogs && state.currentLogs.length < MAX_LOG_LINES) state.currentLogs.push(`${level}: ${line}`.slice(0, 500));
  };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

async function runFunction(fn, symbol) {
  const cases = [];
  for (const c of symbol.cases) {
    const args = revive(Array.isArray(c.input?.args) ? c.input.args : []);
    const logs = [];
    state.currentLogs = logs;
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
    state.currentLogs = null;
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


let processReady = false;

/** Once per process: the next/headers shim and the module hooks that redirect packages to it. */
function setUpProcess() {
  if (processReady) return;
  processReady = true;
  writeShims();
  installModuleHooks();
}

/** The global stylesheet is the project's, not the file's: built once per project and reused by every later file. */
let globalCss = { project: null, promise: null };

function globalCssFor() {
  if (globalCss.project !== PROJECT) globalCss = { project: PROJECT, promise: buildGlobalCss() };
  return globalCss.promise;
}

/** Everything the previous file left behind in this process. */
function resetForNextFile() {
  resetRunState();
  resetMocks();
  resetBundleState();
  resetRenderState();
  resetProviders();
  fakes.used.clear();
}

/** Starts the work every run of this project needs (session worker, before its first file): env files, the global stylesheet. */
export function warmUp() {
  setUpProcess();
  loadEnvFiles();
  return globalCssFor();
}

/**
 * Runs the file SPEC names. `onHead` gets the stylesheet once the file has
 * loaded, `onSymbol` each symbol as soon as its cases are done — a session
 * streams both to the job — and the whole result is returned at the end.
 */
export async function runFile({ onHead, onSymbol } = {}) {
  resetForNextFile();
  const result = { side: SPEC.side, symbols: [], stubbedModules: [], warnings, css: "", cssNote: undefined };
  const needsReact = SPEC.symbols.some((s) => s.kind === "component");
  const entryDirective = directiveOf(readFileSync(path.join(SRC, SPEC.file), "utf8"));

  setUpProcess();
  loadEnvFiles();

  // A Next.js route file without "use client" is a server component: it runs
  // where there is no window, and its server-only guards expect exactly that.
  const serverEntry = hasNext() && entryDirective !== "client" && NEXT_ROUTE_FILE.test(SPEC.file);
  const providerCandidates = needsReact ? discoverProviders() : [];
  // Built while the file bundles; the same for every file of the project.
  const globalStyles = needsReact ? globalCssFor() : null;

  let loaded;
  try {
    const bundled = await bundle(needsReact, providerCandidates);
    result.css = bundled.css;
    fillEnvFromBundle();
    if (state.serverActionModules > 0) notes.add(`${state.serverActionModules} server action module(s) replaced by stubs, as Next.js does in client code`);
    // The DOM must exist before React DOM loads: it decides at import time whether it runs in a browser.
    if (needsReact && !serverEntry) await setUpDom();
    else await tearDownDom();
    // After the DOM: happy-dom installs its own fetch, which is the one to wrap.
    interceptFetch();
    if (needsReact) installContextStandIns();
    state.currentLogs = [];
    const importLogs = state.currentLogs;
    loaded = await withTimeout(import(pathToFileURL(path.join(OUT, "entry.js")).href), SPEC.caseTimeoutMs * 2, "Importing the module");
    state.currentLogs = null;
    if (importLogs.length) warnings.push(...importLogs.map((l) => `on import: ${l}`));
  } catch (error) {
    state.currentLogs = null;
    // esbuild's way of saying its process died — in practice, the memory cap.
    result.fatal = /service (was|is no longer running|stopped)/i.test(String(error?.message ?? error))
      ? `The bundler was killed while bundling ${SPEC.file}, almost certainly for running out of memory ` +
        `(this sandbox allows ${process.env.GRAPHREVIEW_MEMORY ?? "a fixed amount"}). Raise PREVIEW_MEMORY in config.env (in the GraphReview data folder) and restart GraphReview.`
      : `Could not load ${SPEC.file}: ${errorText(error)}`;
    result.stubbedModules = [...stubbed];
    result.serverCalls = [...serverCalls.values()];
    result.warnings.push(...[...notes].map((n) => `note: ${n}`));
    return result;
  }

  const mod = loaded.__mod;
  if (needsReact) {
    state.bundleReact = loaded.__react;
    setUpNextRouter(loaded);
    await setUpProviders(providerCandidates);
    const global = await globalStyles;
    result.css = `${global.css}\n${result.css}`.slice(0, MAX_CSS);
    result.cssNote = global.note;
  }
  onHead?.({ css: result.css, cssNote: result.cssNote });
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
    onSymbol?.(entry);
  }

  result.stubbedModules = [...stubbed];
  result.serverCalls = [...serverCalls.values()];
  for (const use of fakes.used) notes.add(`stand-in: ${use}`);
  result.warnings.push(...[...notes].map((n) => `note: ${n}`));
  return result;
}
