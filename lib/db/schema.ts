// SQLite schema, applied on first connection (lib/db/client.ts).
//
// Versioned with `PRAGMA user_version`: each entry in MIGRATIONS runs once,
// in order, inside a transaction. Append new entries; never edit one that
// has shipped.
//
// Layout: every entity table has its natural key, the columns it is looked
// up or joined by, and a `data` column holding the full record as JSON
// (see `pack`/`unpack` in client.ts). The graph's relationships are plain
// edge tables. Edges are dropped with their endpoints (`ON DELETE CASCADE`),
// the way Neo4j's `DETACH DELETE` dropped them; cross-references that were
// only properties in Neo4j (a finding's `componentId`, a PR map's `prId`)
// stay plain columns, so deleting a component never deletes its findings.

import type { DatabaseSync } from "node:sqlite";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE repos (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE components (
    id      TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    tier    TEXT NOT NULL,
    name    TEXT NOT NULL,
    data    TEXT NOT NULL
  );
  CREATE INDEX components_repo ON components (repo_id, tier);

  -- (Component)-[:CHILD_OF]->(Component)
  CREATE TABLE component_parents (
    child_id  TEXT NOT NULL REFERENCES components (id) ON DELETE CASCADE,
    parent_id TEXT NOT NULL REFERENCES components (id) ON DELETE CASCADE,
    PRIMARY KEY (child_id, parent_id)
  );
  CREATE INDEX component_parents_parent ON component_parents (parent_id);

  -- (Component)-[:DEPENDS_ON {weight}]->(Component)
  CREATE TABLE component_deps (
    from_id TEXT NOT NULL REFERENCES components (id) ON DELETE CASCADE,
    to_id   TEXT NOT NULL REFERENCES components (id) ON DELETE CASCADE,
    weight  REAL NOT NULL,
    PRIMARY KEY (from_id, to_id)
  );
  CREATE INDEX component_deps_to ON component_deps (to_id);

  CREATE TABLE files (
    id      TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    path    TEXT NOT NULL,
    data    TEXT NOT NULL
  );
  CREATE INDEX files_repo_path ON files (repo_id, path);

  -- (File)-[:BELONGS_TO]->(Component): at most one owner per file.
  CREATE TABLE file_owners (
    file_id      TEXT PRIMARY KEY REFERENCES files (id) ON DELETE CASCADE,
    component_id TEXT NOT NULL REFERENCES components (id) ON DELETE CASCADE
  );
  CREATE INDEX file_owners_component ON file_owners (component_id);

  -- (File)-[:IMPORTS {kind}]->(File)
  CREATE TABLE file_imports (
    from_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    to_id   TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    kind    TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id)
  );
  CREATE INDEX file_imports_to ON file_imports (to_id);

  CREATE TABLE pull_requests (
    id      TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    number  INTEGER NOT NULL,
    state   TEXT NOT NULL,
    data    TEXT NOT NULL
  );
  CREATE INDEX pull_requests_repo ON pull_requests (repo_id, number);

  -- (PullRequest)-[:CHANGES {additions, deletions}]->(File)
  CREATE TABLE pr_changes (
    pr_id     TEXT NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
    file_id   TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    additions INTEGER NOT NULL,
    deletions INTEGER NOT NULL,
    PRIMARY KEY (pr_id, file_id)
  );

  CREATE TABLE ref_snapshots (
    repo_id   TEXT NOT NULL,
    sha       TEXT NOT NULL,
    ref       TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    data      TEXT NOT NULL,
    PRIMARY KEY (repo_id, sha)
  );
  CREATE INDEX ref_snapshots_ref ON ref_snapshots (repo_id, ref);

  CREATE TABLE findings (
    id           TEXT PRIMARY KEY,
    repo_id      TEXT NOT NULL,
    target_key   TEXT NOT NULL,
    pr_id        TEXT,
    component_id TEXT NOT NULL,
    category     TEXT NOT NULL,
    file_path    TEXT,
    created_at   TEXT NOT NULL,
    data         TEXT NOT NULL
  );
  CREATE INDEX findings_target ON findings (repo_id, target_key, component_id);
  CREATE INDEX findings_pr ON findings (pr_id);
  CREATE INDEX findings_component ON findings (component_id);

  CREATE TABLE merge_suggestions (
    id      TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    data    TEXT NOT NULL
  );
  CREATE INDEX merge_suggestions_repo ON merge_suggestions (repo_id);

  CREATE TABLE checklist_items (
    id    TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    data  TEXT NOT NULL
  );

  CREATE TABLE checklist_answers (
    id         TEXT PRIMARY KEY,
    repo_id    TEXT NOT NULL,
    target_key TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    data       TEXT NOT NULL
  );
  CREATE INDEX checklist_answers_target ON checklist_answers (repo_id, target_key);

  CREATE TABLE chat_messages (
    id         TEXT PRIMARY KEY,
    repo_id    TEXT NOT NULL,
    target_key TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    data       TEXT NOT NULL
  );
  CREATE INDEX chat_messages_target ON chat_messages (repo_id, target_key, seq);

  CREATE TABLE pr_maps (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );

  CREATE TABLE app_maps (
    id      TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    data    TEXT NOT NULL
  );
  CREATE INDEX app_maps_repo ON app_maps (repo_id);

  CREATE TABLE ai_providers (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    data       TEXT NOT NULL
  );

  -- Small singletons: the Settings record, the checklist's seeded flag.
  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Background jobs (lib/jobs/runner.ts).
  CREATE TABLE jobs (
    queue         TEXT NOT NULL,
    id            TEXT NOT NULL,
    name          TEXT NOT NULL,
    data          TEXT NOT NULL,
    opts          TEXT NOT NULL,
    state         TEXT NOT NULL,
    progress      TEXT,
    returnvalue   TEXT,
    failed_reason TEXT,
    attempts_made INTEGER NOT NULL DEFAULT 0,
    seq           INTEGER NOT NULL,
    run_at        INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    processed_on  INTEGER,
    finished_on   INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (queue, id)
  );
  CREATE INDEX jobs_waiting ON jobs (queue, state, run_at, seq);

  CREATE TABLE job_logs (
    queue  TEXT NOT NULL,
    job_id TEXT NOT NULL,
    seq    INTEGER NOT NULL,
    line   TEXT NOT NULL,
    PRIMARY KEY (queue, job_id, seq),
    FOREIGN KEY (queue, job_id) REFERENCES jobs (queue, id) ON DELETE CASCADE
  );
  `,
  // 2 — names (lib/analysis/symbols.ts): how much a file uses what it
  // imports, type-only imports, the parse cache keyed by git blob, and the
  // per-target graph results (structure diff + call graph).
  `
  ALTER TABLE file_imports ADD COLUMN weight INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE file_imports ADD COLUMN type_only INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE parse_cache (
    key     TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    used_at INTEGER NOT NULL
  );
  CREATE INDEX parse_cache_used ON parse_cache (used_at);

  CREATE TABLE target_graphs (
    repo_id     TEXT NOT NULL,
    target_key  TEXT NOT NULL,
    base_sha    TEXT NOT NULL,
    head_sha    TEXT NOT NULL,
    computed_at TEXT NOT NULL,
    data        TEXT NOT NULL,
    PRIMARY KEY (repo_id, target_key)
  );
  `,
  // 3 — the endpoint catalog of each repo's analysed commit (lib/analysis/api/).
  `
  CREATE TABLE api_catalogs (
    repo_id     TEXT PRIMARY KEY,
    sha         TEXT NOT NULL,
    computed_at TEXT NOT NULL,
    data        TEXT NOT NULL
  );
  `,
];

/** Brings the database up to the latest schema version. */
export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = Number(row.user_version);
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[version]);
      version++;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
