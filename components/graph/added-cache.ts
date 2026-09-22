// Client-side cache for a PR's AI-labeled "added" components (see
// AddedComponentDTO / lib/jobs/added-components.ts) — labeling costs an AI
// call, and re-running it every time "Check impact" is clicked for a PR
// that hasn't changed is wasted cost. Cached in localStorage, keyed by repo
// and PR number, and versioned by the PR's own `updatedAt` so an entry is
// naturally stale the moment the PR gets a new commit (GitHub/GitLab bump
// `updatedAt` on push) — a version mismatch is treated as a miss.
//
// Entries are evicted from DiffPanel.tsx once the open-PR-list fetch
// *succeeds* and a cached PR number is no longer in it (merged/closed) —
// never on a failed fetch, so a network hiccup can't wipe a valid cache.
// Never used for refs/paths-mode checks — those have no stable PR identity
// to key an entry on.

import type { AddedComponentDTO } from "./types";

const PREFIX = "graphreview:pr-added:";

interface CacheEntry {
  updatedAt: string;
  components: AddedComponentDTO[];
}

function cacheKey(repoId: string, prNumber: number): string {
  return `${PREFIX}${repoId}:${prNumber}`;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<CacheEntry>;
  return typeof entry.updatedAt === "string" && Array.isArray(entry.components);
}

/**
 * `undefined` on a miss, a stale/unparseable entry, or when localStorage
 * itself is unavailable (private browsing, blocked storage, SSR) — every
 * case a caller should just treat as "go fetch it".
 */
export function readAddedCache(
  repoId: string,
  prNumber: number,
  updatedAt: string
): AddedComponentDTO[] | undefined {
  try {
    const raw = window.localStorage.getItem(cacheKey(repoId, prNumber));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isCacheEntry(parsed) || parsed.updatedAt !== updatedAt) return undefined;
    return parsed.components;
  } catch {
    return undefined;
  }
}

export function writeAddedCache(
  repoId: string,
  prNumber: number,
  updatedAt: string,
  components: AddedComponentDTO[]
): void {
  try {
    const entry: CacheEntry = { updatedAt, components };
    window.localStorage.setItem(cacheKey(repoId, prNumber), JSON.stringify(entry));
  } catch {
    /* Storage full/unavailable — degrades to "labels every time", not broken. */
  }
}

/**
 * Removes cached entries for `repoId` whose PR number isn't in
 * `openPrNumbers`. Call only after a *successful* open-PR-list fetch (see
 * the module comment) — an empty-but-successful list is a legitimate signal
 * to evict everything cached for this repo, so callers should not special-case it.
 */
export function evictClosedAddedCache(
  repoId: string,
  openPrNumbers: ReadonlySet<number>
): void {
  try {
    const repoPrefix = `${PREFIX}${repoId}:`;
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const storageKey = window.localStorage.key(i);
      if (!storageKey || !storageKey.startsWith(repoPrefix)) continue;
      const prNumber = Number(storageKey.slice(repoPrefix.length));
      if (Number.isFinite(prNumber) && !openPrNumbers.has(prNumber)) {
        toRemove.push(storageKey);
      }
    }
    for (const storageKey of toRemove) window.localStorage.removeItem(storageKey);
  } catch {
    /* Storage unavailable — nothing to evict. */
  }
}
