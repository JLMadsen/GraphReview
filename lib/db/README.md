# lib/db

> `lib/db/` SQLite connection + typed repository functions per entity

All persistent state lives in one SQLite file in the data folder
(`lib/runtime/paths.ts`: `~/.graphreview/graphreview.db`, or `.data/` under
`npm run dev`), opened with Node's built-in `node:sqlite`. Nothing outside
this directory writes SQL for app data — route handlers, `lib/jobs/` and
`worker/` call the typed functions exported from `index.ts`. (The job
queue's own tables are the exception: `lib/jobs/runner.ts` owns those.)

## Scope

- `client.ts` — the process-wide connection (pinned to `globalThis`, since
  Next.js bundles route handlers and instrumentation separately), the
  `all`/`get`/`run` helpers with a statement cache, `transaction()`, and the
  `pack`/`unpack`/`applyPatch` helpers for JSON documents. Calls are
  synchronous; repository functions stay `async` so callers don't care.
- `schema.ts` — versioned migrations (`PRAGMA user_version`), applied on
  first connection. Append, never edit a shipped entry.
- `types.ts` — record shapes (`RepoRecord`, `ComponentRecord`,
  `FileRecord`, `PullRequestRecord`, `RefSnapshotRecord`, `FindingRecord`,
  …). `SettingsRecord` lives in `settings.ts`.
- One module per entity: `repo.ts`, `component.ts`, `file.ts`,
  `pullRequest.ts`, `refSnapshot.ts`, `finding.ts`, `settings.ts`,
  `ai-provider.ts`, `checklist.ts`, `chat.ts`, `pr-map.ts`, `app-map.ts`,
  plus `label.ts` and `merge.ts` for the set-based reads/writes labeling and
  feature merges need, and `kv.ts` for small cached JSON values.
- No import from a client component — this is server-only.

## Layout

Each entity table has its key, the columns it is looked up or joined by,
and a `data` column with the full record as JSON. The graph's relationships
are edge tables: `component_parents` (`CHILD_OF`), `component_deps`
(`DEPENDS_ON`), `file_owners` (`BELONGS_TO`, one owner per file),
`file_imports` (`IMPORTS`) and `pr_changes` (`CHANGES`). Edges cascade with
their endpoints; references that are only ids (a finding's `componentId`,
a PR map's `prId`) don't, so pruning a component never deletes findings —
`relinkFindings` in `merge.ts` moves them instead.

Out of scope here: encryption of credential fields (`lib/crypto/`), and the
GitHub/AI calls that produce the data being persisted.
