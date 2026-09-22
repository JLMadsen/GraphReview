# lib/neo4j

> `lib/neo4j/` driver singleton + typed repository functions per entity

From DESIGN.md §3:

> **Neo4j driver**: the official `neo4j-driver` package, wrapped in a
> server-only singleton (`lib/neo4j/client.ts`) with a connection pool. It is
> never imported into client components — all reads/writes go through typed
> repository functions in `lib/neo4j/`.

## Scope

- `client.ts` — the server-only driver singleton / connection pool, plus
  `runQuery`/`runRead`/`runWrite`/`withSession` helpers that always close
  their session, even on error. Reads `NEO4J_URI`/`NEO4J_USER`/
  `NEO4J_PASSWORD` from env (see `docker/.env.example`).
- `types.ts` — typed shapes for every node label and relationship property
  bag in §7 (`RepoRecord`, `ComponentRecord`, `FileRecord`,
  `PullRequestRecord`, `RefSnapshotRecord`, `FindingRecord`, plus
  `ImportsProps`/`DependsOnProps`/`ChangesProps` for relationship
  properties). `SettingsRecord` is the one exception — it's defined in
  `settings.ts` itself per that module's integration contract.
- `schema.ts` — `runMigrations()`, which creates (`IF NOT EXISTS`, so it's
  safe to re-run) a uniqueness constraint on every label's `id` property
  (and `Settings.id`). `RefSnapshot` is a documented exception: see the
  Community Edition note in the file for why its constraint is on `sha`
  rather than a composite `(repoId, sha)` key.
- One repository module per node label in the schema (§7): `repo.ts`,
  `component.ts`, `file.ts`, `pullRequest.ts`, `refSnapshot.ts`,
  `finding.ts`, `settings.ts`. Each owns the Cypher for its entity —
  parameterized only, never string-concatenated — and returns typed
  results. Each also owns the relationship functions where it's the
  "from" side of that edge (e.g. `file.ts` exports `linkFileToComponent`
  for `BELONGS_TO` and `linkFileImport` for `IMPORTS`; `component.ts`
  exports `linkComponentDependency` for `DEPENDS_ON`, `linkComponentChildOf`
  for `CHILD_OF`, and `linkComponentToRepo` for `PART_OF`; `pullRequest.ts`
  exports `linkPullRequestToRepo` for `BELONGS_TO` and
  `linkPullRequestChangesFile` for `CHANGES`; `finding.ts` exports
  `linkFindingAboutComponent` for `ABOUT` and `linkFindingForPullRequest`
  for `FOR`).
- `index.ts` — barrel re-exporting all of the above.
- No Neo4j import belongs in a client component. Route handlers and
  `worker/` are the only callers.

Out of scope here: encryption of credential fields on `Settings` (that's
`lib/crypto/`), and the GitHub/AI API calls that produce the data being
persisted.
