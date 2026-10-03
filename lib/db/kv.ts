// Small JSON values by key — caches and bookkeeping that don't deserve a
// table of their own.

import { get, run } from "./client";

/** The stored value, or `undefined` when absent, expired or unreadable. */
export function readKv<T>(key: string): T | undefined {
  const row = get<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, `kv:${key}`);
  if (!row) return undefined;
  try {
    const stored = JSON.parse(row.value) as { value: T; expiresAt?: number };
    if (stored.expiresAt !== undefined && stored.expiresAt <= Date.now()) return undefined;
    return stored.value;
  } catch {
    return undefined;
  }
}

/** Stores `value` under `key`, optionally expiring `ttlSeconds` from now. */
export function writeKv(key: string, value: unknown, ttlSeconds?: number): void {
  run(
    `INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    `kv:${key}`,
    JSON.stringify({ value, ...(ttlSeconds !== undefined ? { expiresAt: Date.now() + ttlSeconds * 1000 } : {}) })
  );
}
