// Schema initialization: uniqueness constraints for every node label in
// DESIGN.md §7. Safe to run repeatedly — each statement uses
// `CREATE CONSTRAINT IF NOT EXISTS`, so re-running on an already-migrated
// database is a no-op.
//
// Note on `RefSnapshot`: §7 gives every other label an `id` property, but
// lists `sha` as `RefSnapshot`'s first (natural-key) property with no
// separate `id`, so the constraint below is on `sha` rather than `id`.
// Ideally this would be a composite `(repoId, sha)` uniqueness constraint
// (a git sha is scoped per repo in principle), but composite/multi-property
// uniqueness constraints require Neo4j Enterprise Edition, and DESIGN.md
// §12 targets the plain `neo4j:5` (Community Edition) Compose image with
// no mention of an Enterprise license. A single-property constraint on
// `sha` is the Community-compatible approximation — safe in practice given
// how astronomically unlikely a cross-repo sha collision is — and
// refSnapshot.ts still keys all lookups/upserts on `(repoId, sha)` at the
// application level regardless of what the DB enforces.

import { runWrite } from "./client";

const CONSTRAINT_STATEMENTS: string[] = [
  `CREATE CONSTRAINT repo_id_unique IF NOT EXISTS
   FOR (r:Repo) REQUIRE r.id IS UNIQUE`,
  `CREATE CONSTRAINT component_id_unique IF NOT EXISTS
   FOR (c:Component) REQUIRE c.id IS UNIQUE`,
  `CREATE CONSTRAINT file_id_unique IF NOT EXISTS
   FOR (f:File) REQUIRE f.id IS UNIQUE`,
  `CREATE CONSTRAINT pull_request_id_unique IF NOT EXISTS
   FOR (p:PullRequest) REQUIRE p.id IS UNIQUE`,
  `CREATE CONSTRAINT finding_id_unique IF NOT EXISTS
   FOR (f:Finding) REQUIRE f.id IS UNIQUE`,
  `CREATE CONSTRAINT settings_id_unique IF NOT EXISTS
   FOR (s:Settings) REQUIRE s.id IS UNIQUE`,
  `CREATE CONSTRAINT ai_provider_id_unique IF NOT EXISTS
   FOR (p:AiProvider) REQUIRE p.id IS UNIQUE`,
  `CREATE CONSTRAINT ref_snapshot_sha_unique IF NOT EXISTS
   FOR (s:RefSnapshot) REQUIRE s.sha IS UNIQUE`,
];

/**
 * Creates (or confirms) uniqueness constraints for every node label in the
 * schema. Intended to be called once at app/worker startup (or from a
 * one-off init script elsewhere in the repo that imports it) — this
 * module only exports the migration logic itself, per this directory's
 * scope (lib/neo4j/ only).
 */
export async function runMigrations(): Promise<void> {
  for (const statement of CONSTRAINT_STATEMENTS) {
    await runWrite(statement);
  }
}
