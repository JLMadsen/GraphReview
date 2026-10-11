// GraphReview before/after preview — the Node side of the sandbox (DESIGN.md §6.9).
//
// Runs INSIDE a throwaway container, once per side (base or head), never in
// the app or worker process. lib/jobs/preview.ts copies this file, the
// modules beside it and a `spec.json` into /job, the repo at that commit into /src, and mounts:
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
// This file is the entry: process setup, console capture and `main`. The rest
// is split by concern, every module importing harness-context.mjs (spec, paths,
// the run's mutable `state`, helpers): harness-env, harness-mocks,
// harness-bundle, harness-providers, harness-css, harness-props and
// harness-render (which imports providers and props). Every .mjs file in this
// folder is copied into the container.
//
// The result is one JSON line on stdout after RESULT_MARKER — anything the code
// under test prints is captured per case, not mixed into the result.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import * as fakes from "./preview-fakes.mjs";
import { MAX_CSS, MAX_LOG_LINES, NEXT_ROUTE_FILE, OUT, SPEC, SRC, directiveOf, errorText, hasNext, notes, repr, revive, state, stubbed, warnings, withTimeout } from "./harness-context.mjs";
import { fillEnvFromBundle, loadEnvFiles } from "./harness-env.mjs";
import { interceptFetch, serverCalls } from "./harness-mocks.mjs";
import { bundle, installModuleHooks, writeShims } from "./harness-bundle.mjs";
import { discoverProviders, setUpNextRouter, setUpProviders } from "./harness-providers.mjs";
import { buildGlobalCss } from "./harness-css.mjs";
import { installContextStandIns, runComponent, setUpDom } from "./harness-render.mjs";

const RESULT_MARKER = "@@GRAPHREVIEW_PREVIEW_RESULT@@";

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

const realStdoutWrite = process.stdout.write.bind(process.stdout);

/** Writes the result line and resolves once it is flushed: a pipe write of a big result is async, and exiting early cuts it off. */
function emit(result) {
  return new Promise((resolve) => realStdoutWrite(`${RESULT_MARKER}${JSON.stringify(result)}\n`, () => resolve()));
}

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
    if (state.serverActionModules > 0) notes.add(`${state.serverActionModules} server action module(s) replaced by stubs, as Next.js does in client code`);
    // The DOM must exist before React DOM loads: it decides at import time whether it runs in a browser.
    if (needsReact && !serverEntry) setUpDom();
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
    await emit(result);
    return;
  }

  const mod = loaded.__mod;
  if (needsReact) {
    state.bundleReact = loaded.__react;
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
