// Rendering a component case: in happy-dom with react-dom/client (effects run,
// portals captured) or on the server for async components, with stand-in values
// for repo contexts that have no provider above them.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import * as fakes from "./preview-fakes.mjs";
import { MAX_HTML, NEXT_ROUTE_FILE, OUT, SETTLE_MS, SPEC, errorText, harnessRequire, hasNext, isAsyncFunction, isComponentLike, noop, projectRequire, revive, sleep, state, warnings, withTimeout } from "./harness-context.mjs";
import { providers, wrapElement } from "./harness-providers.mjs";
import { realisticProps } from "./harness-props.mjs";

// ---------------------------------------------------------------------------
// A browser to render in (happy-dom)
// ---------------------------------------------------------------------------

/** Registers happy-dom's window/document as globals, plus the browser APIs it lacks that UI libraries touch on mount. */
export function setUpDom() {
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
  state.domReady = true;
}

// ---------------------------------------------------------------------------
// Contexts nobody provided: stand-in values on a retry
// ---------------------------------------------------------------------------

/** Contexts the repo's own code created with an empty default (null/undefined), with a name for the notes. */
export const repoContexts = new Map();

/** Repo contexts read with no provider above them during the current render attempt. */
export const contextMisses = new Set();

/** Repo contexts that got a stand-in during the current render attempt. */
export const contextStandIns = new Set();

/** `const AuthContext = createContext(…)` on the bundle line that created a context, or its displayName later. */
export function contextNameFromStack(frame) {
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

export function contextName(ctx) {
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
export function installContextStandIns() {
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
      if (!state.contextStandInsOn) return value;
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
export function compoundRootName(file) {
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
export function missingContext(error, mod) {
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

export function renderOnServer(React, server, element) {
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
export async function renderInBrowser(React, client, element) {
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

/** Visible text of rendered markup, ignoring styles and scripts — empty means nothing to look at. */
export function visibleText(html) {
  return (html ?? "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which renderer first: async components (server components) need the server
 * renderer; everything else renders like it would in the browser. The other
 * renderer is the fallback when the first one fails.
 */
export function renderOrder(Component, entryDirective) {
  if (!state.domReady) return ["server"];
  if (isAsyncFunction(Component)) return ["server", "browser"];
  if (hasNext() && entryDirective !== "client" && NEXT_ROUTE_FILE.test(SPEC.file)) return ["server", "browser"];
  return ["browser", "server"];
}

export const MAX_CONTEXT_RETRIES = 6;

/**
 * Renders one case, learning what it needs as it goes: start inside the
 * layouts' providers; when an error names a missing provider or compound
 * parent, add it and render again; if the layout providers themselves seem to
 * be the problem, try once without them. Then the other renderer.
 */
export async function renderCase(React, renderers, Component, props, order, mod) {
  const attempts = [];
  for (const how of order) {
    const plan = { layout: providers.layout.length > 0, extra: [], compound: null, stubs: false };
    // A provider added for a context may itself fail before its children read it, so remember any miss.
    let missedContext = false;
    for (let attempt = 0; attempt <= MAX_CONTEXT_RETRIES; attempt++) {
      const element = wrapElement(React, React.createElement(Component, props), plan);
      contextMisses.clear();
      contextStandIns.clear();
      state.contextStandInsOn = plan.stubs;
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

export async function runComponent(Component, symbol, React, renderers, entryDirective, mod) {
  const cases = [];
  const order = renderOrder(Component, entryDirective);
  for (const c of symbol.cases) {
    const props = realisticProps(React, revive(c.input?.props ?? {}));
    const logs = [];
    state.currentLogs = logs;
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
    state.currentLogs = null;
    cases.push(outcome);
  }
  return cases;
}
