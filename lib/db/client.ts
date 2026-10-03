// Server-only SQLite connection + small query helpers.
//
// One database file per install (lib/runtime/paths.ts), opened once per
// process with Node's built-in `node:sqlite` — no native module to compile,
// no server to run. Every call is synchronous; the repository functions in
// this directory stay `async` only so their callers didn't have to change
// when the store moved off Neo4j.
//
// Because calls are synchronous and the app is one process, a read followed
// by a write inside the same synchronous stretch of code can't interleave
// with another request. `transaction()` adds atomicity on top for multi-
// statement writes.

import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { getDatabasePath } from "@/lib/runtime/paths";
import { migrate } from "./schema";

if (typeof window !== "undefined") {
  throw new Error("lib/db/client is server-only and must never be imported into client components.");
}

export type SqlValue = SQLInputValue;

// Next.js bundles route handlers, server components and instrumentation
// separately, so a plain module-level singleton would open the database
// once per bundle. Pinning it to `globalThis` keeps it to one connection
// (and one migration run) per process.
const GLOBAL_KEY = Symbol.for("graphreview.db");
type GlobalWithDb = typeof globalThis & { [GLOBAL_KEY]?: DatabaseSync };

/** The process-wide connection, opened (and migrated) on first use. */
export function getDb(): DatabaseSync {
  const g = globalThis as GlobalWithDb;
  if (!g[GLOBAL_KEY]) {
    const db = new DatabaseSync(getDatabasePath());
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    migrate(db);
    g[GLOBAL_KEY] = db;
  }
  return g[GLOBAL_KEY];
}

/** Closes the connection, if open. For graceful shutdown and scripts. */
export function closeDb(): void {
  const g = globalThis as GlobalWithDb;
  const db = g[GLOBAL_KEY];
  if (db) {
    g[GLOBAL_KEY] = undefined;
    db.close();
  }
}

const statementCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function prepare(sql: string): StatementSync {
  const db = getDb();
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

/** Every row of a query. */
export function all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
  return prepare(sql).all(...params) as T[];
}

/** The first row of a query, or `undefined`. */
export function get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
  return prepare(sql).get(...params) as T | undefined;
}

/** Runs a write; returns how many rows it changed. */
export function run(sql: string, ...params: SqlValue[]): number {
  return Number(prepare(sql).run(...params).changes);
}

let depth = 0;

/**
 * Runs `work` atomically. `work` must be synchronous — an `await` inside it
 * would let other requests' statements land in the middle of the
 * transaction. Nested calls join the outer transaction.
 */
export function transaction<T>(work: () => T): T {
  if (depth > 0) return work();
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  depth++;
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    depth--;
  }
}

/**
 * `?, ?, ?` for an `IN (…)` list of `count` values. SQLite caps bound
 * parameters (32766 by default), so callers chunk long lists with {@link chunked}.
 */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** Splits a list for `IN (…)` queries that would exceed the parameter cap. */
export function chunked<T>(items: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// JSON documents
// ---------------------------------------------------------------------------
//
// Each entity keeps its full record as JSON in a `data` column, next to the
// handful of real columns it is looked up or joined by. Absent fields are
// simply left out of the JSON (as a removed Neo4j property was), so
// `undefined` and `null` are both dropped on write.

/** Serialises a record, dropping `undefined`/`null` fields. */
export function pack(record: object): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return JSON.stringify(out);
}

/** Parses a `data` column. */
export function unpack<T = Record<string, unknown>>(data: unknown): T {
  return JSON.parse(String(data)) as T;
}

/**
 * Applies `patch` onto `existing` the way a Cypher `SET` did: a field set
 * to `null`/`undefined` is removed, anything else overwrites, and fields the
 * patch doesn't mention are kept.
 */
export function applyPatch<T extends object>(existing: T | undefined, patch: object): T {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) delete out[key];
    else out[key] = value;
  }
  return out as T;
}
