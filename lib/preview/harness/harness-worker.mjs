// A warm preview worker (DESIGN.md §6.9): one long-lived Node process in a
// session container that runs file after file, so the packages every file
// loads (React, React DOM, Next, happy-dom, esbuild's service) are loaded once
// instead of once per file. Started and supervised by harness-server.mjs,
// talking over IPC:
//
//   ← { type: "run", id, spec }       run one file (spec as in spec.json)
//   → { type: "start", id }           the run began (the supervisor's timer starts)
//   → { type: "head", id, css, … }    the file loaded: its stylesheet
//   → { type: "symbol", id, entry }   one symbol's cases, as soon as they're done
//   → { type: "done", id, result, rss }
//
// Each file starts from clean per-file state (harness-run.mjs) with its own
// bundle, so only packages are shared between files, as they are between the
// pages of a real app. Whether a worker has a DOM is fixed for its lifetime
// (GRAPHREVIEW_WORKER_DOM): packages decide at import time whether they run
// in a browser, so files that run without one get a worker that never had one.

import { flushCompileCache } from "node:module";
import { errorText, harnessRequire, hasNext, projectRequire, setSpec, warnings } from "./harness-context.mjs";
import { runFile, warmUp } from "./harness-run.mjs";
import { setUpDom } from "./harness-render.mjs";

const DOM = process.env.GRAPHREVIEW_WORKER_DOM === "1";
const PROJECT_ROOT = process.env.GRAPHREVIEW_PROJECT_ROOT || ".";

function send(message) {
  process.send?.(message);
}

/** The repo's own copy of a package, else the harness's; null when neither loads. */
function load(name) {
  for (const req of [() => projectRequire(), () => harnessRequire]) {
    try {
      return req()(name);
    } catch {
      /* try the next */
    }
  }
  return null;
}

/**
 * Loads what nearly every file needs, before the first one arrives — the
 * session starts while the job is still waiting for the model's inputs.
 * Best effort: anything that fails here is simply loaded by the run itself.
 */
async function warm() {
  setSpec({ file: "", projectRoot: PROJECT_ROOT, symbols: [], mocks: {} });
  const css = warmUp();
  // The DOM goes first: React DOM decides at import time whether it has one.
  if (DOM) await setUpDom();
  load("react");
  load("react-dom/server");
  if (DOM) load("react-dom/client");
  if (hasNext()) {
    for (const name of [
      "next/dist/shared/lib/app-router-context.shared-runtime",
      "next/dist/shared/lib/hooks-client-context.shared-runtime",
      "next/link",
      "next/navigation",
      "next/image",
    ]) {
      load(name);
    }
  }
  try {
    await harnessRequire("esbuild").transform("", {});
  } catch {
    /* the first bundle starts it instead */
  }
  await css;
  saveCompiledCode();
}

/**
 * Node writes its compile cache (NODE_COMPILE_CACHE, lib/preview/sandbox.ts)
 * only when a process exits on its own, and workers are killed instead — so
 * what this one compiled is saved after warming up and after each file.
 */
function saveCompiledCode() {
  try {
    flushCompileCache?.();
  } catch {
    /* an older Node, or no cache configured */
  }
}

async function run({ id, spec }) {
  setSpec(spec);
  send({ type: "start", id });
  let result;
  try {
    result = await runFile({
      onHead: (head) => send({ type: "head", id, ...head }),
      onSymbol: (entry) => send({ type: "symbol", id, entry }),
    });
  } catch (error) {
    result = { side: spec.side, symbols: [], fatal: errorText(error), warnings: [...warnings] };
  }
  send({ type: "done", id, result, rss: process.memoryUsage().rss });
  saveCompiledCode();
}

let queue = warm().catch(() => undefined);
process.on("message", (message) => {
  if (message?.type === "run") queue = queue.then(() => run(message));
});
process.on("disconnect", () => process.exit(0));
