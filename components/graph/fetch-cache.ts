"use client";

// The file viewer's answers, kept for a minute in the page: reopening a file,
// or going back to one through a code link, draws at once instead of asking
// the server again. Keyed by the request URL, so a different diff, side or
// whitespace setting is its own entry. Short-lived because a PR's head can
// move; the server keeps what is keyed by commit far longer
// (lib/jobs/memo-cache.ts). Only answers that came back OK are kept.

const TTL_MS = 60_000;
const MAX_ENTRIES = 60;

const entries = new Map<string, { at: number; value: Promise<{ ok: boolean; status: number; json: unknown }> }>();

/** `fetch(url)` read as JSON — `{ ok, status, json }` — shared with any request for the same URL in the last minute. */
export function fetchJsonCached(url: string): Promise<{ ok: boolean; status: number; json: unknown }> {
  const now = Date.now();
  const hit = entries.get(url);
  if (hit && now - hit.at < TTL_MS) {
    entries.delete(url);
    entries.set(url, hit);
    return hit.value;
  }
  const value = fetch(url, { cache: "no-store" }).then(async (res) => ({ ok: res.ok, status: res.status, json: await res.json().catch(() => null) }));
  entries.set(url, { at: now, value });
  value.then(
    (answer) => {
      if (!answer.ok && entries.get(url)?.value === value) entries.delete(url);
    },
    () => {
      if (entries.get(url)?.value === value) entries.delete(url);
    }
  );
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  return value;
}
