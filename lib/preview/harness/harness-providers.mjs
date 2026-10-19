// What wraps each render: the repo's own Providers component, library providers
// an error points at (Redux, Apollo, next-intl, …), a stand-in app router, and
// fake props for wrappers that need them.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as fakes from "./preview-fakes.mjs";
import { IDENTIFIER, PROJECT, SPEC, SRC, isAsyncFunction, isComponentLike, noop, notes, paramsFromRoute, relativeToProject, routePathname, state, withTimeout } from "./harness-context.mjs";

// ---------------------------------------------------------------------------
// Providers: what the app's layouts put around pages, and every repo provider
// ---------------------------------------------------------------------------

export const SOURCE_DIRS = ["app", "src", "components", "lib", "contexts", "context", "providers", "hooks", "store", "stores", "features", "modules"];

export const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "out", ".git", "public", "coverage", ".graphreview-entries"]);

export const MAX_SOURCE_FILES = 4000;

export const MAX_REPO_PROVIDERS = 30;

export function walkSources() {
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
export function parseImports(source) {
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

/** The layout files that wrap the changed file in Next.js: the root layout, then each on its route path. */
export function layoutChain() {
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

export const PROVIDER_NAME = /^[A-Z]\w*Providers?$/;

/**
 * Provider candidates, each bundled as its own entry so one that fails to
 * load can't take the others (or the component) down:
 *   layout — rendered by a layout around the changed file, in order (outer first)
 *   repo   — any other provider component the repo exports, added on demand
 *            when a render says "must be used within XProvider"
 *   query  — @tanstack/react-query's provider, for "No QueryClient set"
 */
export function discoverProviders() {
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

export function isInstalled(pkg) {
  return [PROJECT, SRC].some((dir) => existsSync(path.join(dir, "node_modules", ...pkg.split("/"), "package.json")));
}

/** Provider components a file exports: declared exported, `export default X`, or listed in `export { X }`. */
export function exportedProviderNames(source) {
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
export const LIBRARY_ADAPTERS = [
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

export function reduxStore() {
  if (state.reduxStoreValue) return state.reduxStoreValue;
  if (providers.reduxStore) {
    state.reduxStoreValue = providers.reduxStore;
    notes.add("rendered with the repo's own Redux store");
    return state.reduxStoreValue;
  }
  const fakeState = fakes.fakeValue("state");
  fakes.used.add("a stand-in Redux store state");
  state.reduxStoreValue = { getState: () => fakeState, subscribe: () => noop, dispatch: (action) => action, replaceReducer: noop };
  return state.reduxStoreValue;
}

/** Providers that loaded: the layouts' (in order), all by name, and react-query's. */
export const providers = { layout: [], byName: new Map(), query: null, adapters: new Map(), reduxStore: null };

/** Providers are loaded from one file's bundle (session worker, between files). */
export function resetProviders() {
  Object.assign(providers, { layout: [], byName: new Map(), query: null, adapters: new Map(), reduxStore: null });
}

/**
 * A stand-in Next.js app router: pathname "/", no search params, and
 * navigation that does nothing — enough for Link, useRouter, usePathname and
 * useSearchParams to render instead of throwing.
 */
export function setUpNextRouter(loaded) {
  const routerContext = loaded.__nextRouter?.AppRouterContext;
  if (!routerContext || typeof routerContext !== "object") return;
  const hooks = loaded.__nextHooks ?? {};
  const router = { push: noop, replace: noop, refresh: noop, prefetch: noop, back: noop, forward: noop, hmrRefresh: noop };
  state.routerWrap = (React, element) => {
    let tree = element;
    if (hooks.SearchParamsContext) tree = React.createElement(hooks.SearchParamsContext.Provider, { value: new URLSearchParams() }, tree);
    if (hooks.PathnameContext) tree = React.createElement(hooks.PathnameContext.Provider, { value: routePathname() }, tree);
    if (hooks.PathParamsContext) tree = React.createElement(hooks.PathParamsContext.Provider, { value: paramsFromRoute(SPEC.file) }, tree);
    return React.createElement(routerContext.Provider, { value: router }, tree);
  };
}

/** Loads each provider candidate on its own; one that fails to load is just left out. */
export async function setUpProviders(candidates) {
  for (const candidate of candidates) {
    try {
      const { ns } = await withTimeout(import(pathToFileURL(candidate.out).href), SPEC.caseTimeoutMs, `Importing ${candidate.name}`);
      if (candidate.adapter) {
        const wrap = state.bundleReact && candidate.adapter.wrap(ns, state.bundleReact);
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

/**
 * Router (outermost) › layout providers › providers added on demand › compound
 * parent › the component. With stand-ins on, the repo's providers also get
 * fake values for the props the app would have passed them.
 */
export function wrapElement(React, element, plan) {
  let tree = element;
  const provider = (Comp, name) => React.createElement(plan.stubs ? withFakeProps(Comp, name) : Comp, null, tree);
  if (plan.compound) tree = React.createElement(plan.compound, { open: true, defaultOpen: true }, tree);
  for (const name of [...plan.extra].reverse()) {
    if (name === "__query") tree = providers.query(React, tree);
    else if (providers.adapters.has(name)) tree = providers.adapters.get(name).wrapElement(tree);
    else tree = provider(providers.byName.get(name), name);
  }
  if (plan.layout) for (const p of [...providers.layout].reverse()) tree = provider(p.Comp, p.name);
  return state.routerWrap ? state.routerWrap(React, tree) : tree;
}

export const fakePropsWrappers = new WeakMap();

/** A function component called with its props plus fakes for whatever else it reads; anything else as it is. */
export function withFakeProps(Comp, name) {
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
