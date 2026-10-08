// The analysis parse cache (lib/analysis: `ParseCache`): what one file's
// syntax says, keyed by analyzer version + language + git blob id. A file
// that hasn't changed is never parsed twice — not across re-analyses, and
// not between a PR's base and head.

import { all, chunked, placeholders, run, transaction } from "./client";

/** Entries not read for this long are dropped at startup. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Cached parses for `keys` (absent keys are simply missing), marking them used. */
export function readParseCache<T>(keys: readonly string[]): Map<string, T> {
  const out = new Map<string, T>();
  if (keys.length === 0) return out;
  const now = Date.now();
  for (const part of chunked(keys)) {
    for (const row of all<{ key: string; data: string }>(
      `SELECT key, data FROM parse_cache WHERE key IN (${placeholders(part.length)})`,
      ...part
    )) {
      try {
        out.set(row.key, JSON.parse(row.data) as T);
      } catch {
        /* unreadable entry: parsed again and overwritten */
      }
    }
    run(`UPDATE parse_cache SET used_at = ? WHERE key IN (${placeholders(part.length)})`, now, ...part);
  }
  return out;
}

export function writeParseCache(entries: ReadonlyArray<[string, unknown]>): void {
  if (entries.length === 0) return;
  const now = Date.now();
  transaction(() => {
    for (const [key, value] of entries) {
      run(
        `INSERT INTO parse_cache (key, data, used_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET data = excluded.data, used_at = excluded.used_at`,
        key,
        JSON.stringify(value),
        now
      );
    }
  });
}

/** Drops entries nobody read for a month. Called once at startup. */
export function purgeParseCache(): number {
  return run(`DELETE FROM parse_cache WHERE used_at < ?`, Date.now() - MAX_AGE_MS);
}
