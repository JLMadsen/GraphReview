// Server calls the previewed code makes (server actions, fetch): recorded, and
// answered from the job's mocks when it has them.

import { SPEC, repr, revive } from "./harness-context.mjs";

// ---------------------------------------------------------------------------
// Server calls: recorded, and answered from mocks when the job has them
// ---------------------------------------------------------------------------

/** Mocked responses from the job (record → mock → replay): "action <file>#<name>" or "fetch <METHOD> <path>" → value. */
export let MOCKS = SPEC.mocks ?? {};

/** Every server call the code made, for the job to mock on the next run. */
export const serverCalls = new Map();

/** The next file's mocks, and no calls recorded yet (session worker). */
export function resetMocks() {
  MOCKS = SPEC.mocks ?? {};
  serverCalls.clear();
}

export const MAX_SERVER_CALLS = 40;

export function recordCall(key, detail) {
  const existing = serverCalls.get(key);
  if (existing) existing.count += 1;
  else if (serverCalls.size < MAX_SERVER_CALLS) serverCalls.set(key, { key, count: 1, mocked: key in MOCKS, ...detail });
}

export function mockedValue(key) {
  // A fresh copy per call, so one caller mutating the result can't leak into the next.
  return revive(JSON.parse(JSON.stringify(MOCKS[key])));
}

globalThis.__graphreviewServerCall = async (moduleId, name, args) => {
  const key = `action ${moduleId}#${name}`;
  recordCall(key, { kind: "action", module: moduleId, name, args: repr(args).slice(0, 300) });
  return key in MOCKS ? mockedValue(key) : undefined;
};

/** Wraps fetch: a request with a mock gets it as a JSON response; anything else goes to the (offline) real fetch. */
export function interceptFetch() {
  const realFetch = globalThis.fetch;
  // A session worker's next file may find the wrapper still in place (no DOM swap in between).
  if (typeof realFetch !== "function" || realFetch.__graphreview) return;
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
  globalThis.fetch.__graphreview = true;
}
