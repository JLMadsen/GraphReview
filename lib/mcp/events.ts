// "A review's findings changed outside the review job" — today, a coding
// agent replied to one over MCP. The review dock listens through
// `GET /api/repos/[repoId]/review/events` and refetches, so a reply shows up
// without polling.
//
// In-process only: the MCP route and the events route run in the same Node
// process, but in separate Next.js bundles, so the emitter is pinned to
// `globalThis` (same as lib/jobs/runner.ts).

import { EventEmitter } from "node:events";

const EMITTER_KEY = Symbol.for("graphreview.findings.emitter");

function bus(): EventEmitter {
  const g = globalThis as typeof globalThis & { [EMITTER_KEY]?: EventEmitter };
  // Every open review dock holds one listener; the cap is only a leak warning.
  g[EMITTER_KEY] ??= new EventEmitter().setMaxListeners(200);
  return g[EMITTER_KEY];
}

const channel = (repoId: string, targetKey: string) => `${repoId}\u0000${targetKey}`;

export function emitFindingsChanged(repoId: string, targetKey: string, findingId: string): void {
  bus().emit(channel(repoId, targetKey), findingId);
}

/** Calls `listener` with the finding id whenever a finding of that target changes. Returns the unsubscribe. */
export function onFindingsChanged(
  repoId: string,
  targetKey: string,
  listener: (findingId: string) => void
): () => void {
  const name = channel(repoId, targetKey);
  bus().on(name, listener);
  return () => {
    bus().off(name, listener);
  };
}
