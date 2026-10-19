// GraphReview before/after preview — the Node side of the sandbox (DESIGN.md §6.9).
//
// Runs INSIDE a throwaway container, once per side (base or head), never in
// the app or worker process — the fallback when a warm session
// (harness-server.mjs) can't be used. lib/jobs/preview.ts copies this file, the
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
// This file is the one-shot entry; harness-run.mjs holds the run itself (process
// setup, console capture, `runFile`), shared with the session worker
// (harness-worker.mjs, under harness-server.mjs). The rest is split by
// concern, every module importing harness-context.mjs (spec, paths, the run's
// mutable `state`, helpers): harness-env, harness-mocks,
// harness-bundle, harness-providers, harness-css, harness-props and
// harness-render (which imports providers and props). Every .mjs file in this
// folder is copied into the container.
//
// The result is one JSON line on stdout after RESULT_MARKER — anything the code
// under test prints is captured per case, not mixed into the result.

import { RESULT_MARKER, realStdoutWrite, runFile } from "./harness-run.mjs";
import { SPEC, errorText, warnings } from "./harness-context.mjs";

/** Writes the result line and resolves once it is flushed: a pipe write of a big result is async, and exiting early cuts it off. */
function emit(result) {
  return new Promise((resolve) => realStdoutWrite(`${RESULT_MARKER}${JSON.stringify(result)}\n`, () => resolve()));
}

runFile()
  .then(emit)
  .catch((error) => emit({ side: SPEC.side, symbols: [], fatal: errorText(error), warnings }))
  .finally(() => {
    // Exit once the result is flushed: lingering timers/sockets in user code must not keep the container alive.
    process.exit(0);
  });
