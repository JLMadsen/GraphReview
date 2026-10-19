/**
 * Checks the preview's Redux adapter (lib/preview/harness/harness-providers.mjs
 * `LIBRARY_ADAPTERS` / `reduxStore`): a component calling useSelector with no
 * <Provider> renders with the repo's own store, or else a stand-in one.
 *
 *   npx tsx lib/preview/smoke-test-preview-redux.ts
 *
 * react-redux isn't a dependency here, so `reactRedux` below is a minimal
 * stand-in with its Provider/useSelector shape and its missing-store error.
 */
import { createContext, createElement, useContext, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resetRunState, state } from "./harness/harness-context.mjs";
import { LIBRARY_ADAPTERS, providers, reduxStore, resetProviders } from "./harness/harness-providers.mjs";
import { missingContext } from "./harness/harness-render.mjs";

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const ReduxContext = createContext<Any>(null);
const reactRedux = {
  Provider: ({ store, children }: { store: Any; children?: ReactNode }) => createElement(ReduxContext.Provider, { value: { store } }, children),
  useSelector: (selector: (s: Any) => unknown) => {
    const ctx = useContext(ReduxContext);
    // react-redux 8/9's wording.
    if (!ctx) throw new Error("could not find react-redux context value; please ensure the component is wrapped in a <Provider>");
    return selector(ctx.store.getState());
  },
};

function Counter() {
  const count = reactRedux.useSelector((s) => s.counter.value);
  return createElement("span", null, `count: ${String(count)}`);
}

function renderWithAdapter(): { html?: string; error?: unknown } {
  const adapter = LIBRARY_ADAPTERS.find((a) => a.name === "__redux")!;
  const wrap = adapter.wrap(reactRedux, { createElement } as Any)!;
  providers.adapters.set(adapter.name, { ...adapter, wrapElement: wrap });
  try {
    return { html: renderToStaticMarkup(wrap(createElement(Counter))) };
  } catch (error) {
    return { error };
  }
}

console.log("missing store");
let bare: unknown;
try {
  renderToStaticMarkup(createElement(Counter));
} catch (error) {
  bare = error;
}
resetProviders();
providers.adapters.set("__redux", LIBRARY_ADAPTERS[0]);
check("the bare render fails", bare instanceof Error);
check("its error picks the Redux adapter", missingContext(bare, {})?.provider === "__redux", missingContext(bare, {}));

console.log("stand-in store (repo has none)");
resetRunState();
resetProviders();
let fallback: ReturnType<typeof renderWithAdapter> = {};
try {
  fallback = renderWithAdapter();
} catch (error) {
  fallback = { error };
}
check("renders without throwing", fallback.error === undefined, String((fallback.error as Error)?.message ?? ""));
check("useSelector reads the stand-in state", typeof fallback.html === "string" && fallback.html.startsWith("<span>count: "), fallback.html);
check("the store is kept in the shared harness state", state.reduxStoreValue !== null && reduxStore() === state.reduxStoreValue);
const store: Any = state.reduxStoreValue;
check("it behaves like a store", typeof store?.getState === "function" && typeof store.subscribe() === "function" && store.dispatch({ type: "x" }).type === "x");

console.log("the repo's own store");
resetRunState();
resetProviders();
const repoStore = { getState: () => ({ counter: { value: 7 } }), subscribe: () => () => {}, dispatch: (a: unknown) => a };
(providers as Any).reduxStore = repoStore;
const own = renderWithAdapter();
check("renders with the repo's state", own.html === "<span>count: 7</span>", own.html ?? String((own.error as Error)?.message));
check("the repo store is the one used", reduxStore() === repoStore);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
