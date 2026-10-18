// In-process caches for what the code views read on every open (DESIGN.md
// §6.24, §6.28): a diff between two commits, a file at a commit, a PR's two
// ends. Most of it is keyed by commit ids, so it can't go stale: only the
// size caps and a long TTL let it go. What can move (a PR's head, which
// commits the clone has) gets a short TTL.
//
// A bucket holds promises, so two requests for the same key share one load;
// a load that fails is dropped at once, never cached. Buckets live on
// globalThis so Next's per-route module copies share them.

const KEY = Symbol.for("graphreview.jobs.memo-cache");

interface Entry {
  value: Promise<unknown>;
  expires: number;
  weight: number;
}

interface Bucket {
  entries: Map<string, Entry>;
  weight: number;
}

export interface MemoOptions<T> {
  ttlMs: number;
  /** Most entries kept; the least recently used go first. */
  maxEntries: number;
  /** With `weigh`: most total weight (e.g. characters) kept. */
  maxWeight?: number;
  weigh?: (value: T) => number;
}

function buckets(): Map<string, Bucket> {
  const g = globalThis as typeof globalThis & { [KEY]?: Map<string, Bucket> };
  g[KEY] ??= new Map();
  return g[KEY];
}

function bucketOf(name: string): Bucket {
  const all = buckets();
  let bucket = all.get(name);
  if (!bucket) all.set(name, (bucket = { entries: new Map(), weight: 0 }));
  return bucket;
}

function drop(bucket: Bucket, key: string): void {
  const entry = bucket.entries.get(key);
  if (!entry) return;
  bucket.weight -= entry.weight;
  bucket.entries.delete(key);
}

function trim(bucket: Bucket, options: MemoOptions<never>): void {
  for (const key of bucket.entries.keys()) {
    const over = bucket.entries.size > options.maxEntries || (options.maxWeight !== undefined && bucket.weight > options.maxWeight);
    if (!over) break;
    drop(bucket, key);
  }
}

/** `load()`'s value under `key` in bucket `name`, loaded once and kept per `options`. */
export function memo<T>(name: string, key: string, options: MemoOptions<T>, load: () => Promise<T>): Promise<T> {
  const bucket = bucketOf(name);
  const now = Date.now();
  const hit = bucket.entries.get(key);
  if (hit && hit.expires > now) {
    // Most recently used goes last.
    bucket.entries.delete(key);
    bucket.entries.set(key, hit);
    return hit.value as Promise<T>;
  }
  if (hit) drop(bucket, key);
  const value = load();
  const entry: Entry = { value, expires: now + options.ttlMs, weight: 0 };
  bucket.entries.set(key, entry);
  value.then(
    (resolved) => {
      if (bucket.entries.get(key) !== entry) return;
      entry.weight = options.weigh ? options.weigh(resolved) : 0;
      bucket.weight += entry.weight;
      trim(bucket, options as MemoOptions<never>);
    },
    () => {
      if (bucket.entries.get(key) === entry) drop(bucket, key);
    }
  );
  trim(bucket, options as MemoOptions<never>);
  return value;
}

/** A full commit id: what makes a key immutable. */
export const isFullSha = (ref: string | undefined | null): ref is string => Boolean(ref && /^[0-9a-f]{40}$/.test(ref));

/** Empties every bucket (tests). */
export function clearMemoCaches(): void {
  buckets().clear();
}
