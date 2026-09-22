// Server-only Neo4j driver singleton + query helpers.
//
// This module must never be imported from a client component — it reads
// server-side env vars (`NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD`, per
// docker/.env.example) and holds a live connection pool.
// Route handlers, `worker/`, and the repository modules in this directory
// are the only intended callers (see README.md).

import neo4j from "neo4j-driver";
import type {
  Driver,
  QueryResult,
  Record as Neo4jRecord,
  Session,
  SessionMode,
} from "neo4j-driver";

if (typeof window !== "undefined") {
  throw new Error(
    "lib/neo4j/client is server-only and must never be imported into client components."
  );
}

/** Parameters passed to a parameterized Cypher query. Never string-concatenate values into the query text — always pass them here. */
export type QueryParams = Record<string, unknown>;

let driverSingleton: Driver | undefined;

function requiredEnv(name: "NEO4J_URI" | "NEO4J_USER" | "NEO4J_PASSWORD"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See docker/.env.example.`
    );
  }
  return value;
}

/**
 * Returns the process-wide pooled Neo4j driver, creating it on first use.
 * Safe to call repeatedly — the driver (and its connection pool) is created
 * once and reused for the lifetime of the process.
 */
export function getDriver(): Driver {
  if (!driverSingleton) {
    const uri = requiredEnv("NEO4J_URI");
    const user = requiredEnv("NEO4J_USER");
    const password = requiredEnv("NEO4J_PASSWORD");

    driverSingleton = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      maxConnectionPoolSize: 50,
      maxConnectionLifetime: 60 * 60 * 1000, // 1 hour
      connectionAcquisitionTimeout: 60 * 1000, // 1 minute
    });
  }
  return driverSingleton;
}

/** Closes the pooled driver, if one has been created. Intended for graceful shutdown (e.g. in the worker entrypoint) and test teardown. */
export async function closeDriver(): Promise<void> {
  if (driverSingleton) {
    const toClose = driverSingleton;
    driverSingleton = undefined;
    await toClose.close();
  }
}

/**
 * Runs a single parameterized Cypher statement in its own session, always
 * closing the session afterward (even on error). This is the workhorse used
 * by every repository function in `lib/neo4j/` — callers should never open
 * a `Session` directly.
 */
export async function runQuery(
  cypher: string,
  params: QueryParams = {},
  mode: SessionMode = neo4j.session.WRITE
): Promise<QueryResult> {
  const session: Session = getDriver().session({ defaultAccessMode: mode });
  try {
    return await session.run(cypher, params);
  } finally {
    await session.close();
  }
}

/** Convenience wrapper for a read-only query (routes to a read-mode session). */
export async function runRead(
  cypher: string,
  params: QueryParams = {}
): Promise<QueryResult> {
  return runQuery(cypher, params, neo4j.session.READ);
}

/** Convenience wrapper for a write query (routes to a write-mode session). */
export async function runWrite(
  cypher: string,
  params: QueryParams = {}
): Promise<QueryResult> {
  return runQuery(cypher, params, neo4j.session.WRITE);
}

/**
 * Runs `work` against a single session for callers that need more than one
 * statement in the same session (e.g. an explicit transaction spanning a
 * node upsert and multiple relationship writes). The session is always
 * closed afterward, even if `work` throws.
 */
export async function withSession<T>(
  work: (session: Session) => Promise<T>,
  mode: SessionMode = neo4j.session.WRITE
): Promise<T> {
  const session = getDriver().session({ defaultAccessMode: mode });
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

/** Convenience helper: the first record of a result, or `undefined` if the result was empty. */
export function firstRecord(result: QueryResult): Neo4jRecord | undefined {
  return result.records[0];
}
