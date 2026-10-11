// The repo's global stylesheet, built with its own PostCSS plugins (Tailwind),
// so the previews look like the app.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROJECT, SRC, errorText, harnessRequire, projectRequire, withTimeout } from "./harness-context.mjs";

// ---------------------------------------------------------------------------
// Global CSS (Tailwind & co.) — best effort, components only
// ---------------------------------------------------------------------------

export const GLOBAL_CSS_NAMES = ["globals.css", "global.css", "index.css", "app.css", "main.css", "styles.css", "tailwind.css"];

export const GLOBAL_CSS_DIRS = ["app", "src/app", "src", "styles", "src/styles", "app/styles", "."];

export function findGlobalCss() {
  for (const dir of GLOBAL_CSS_DIRS) {
    for (const name of GLOBAL_CSS_NAMES) {
      const candidate = path.join(PROJECT, dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export async function loadPostcssPlugins() {
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

export async function buildGlobalCss() {
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
