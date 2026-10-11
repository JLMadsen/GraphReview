<!-- Part of the design doc: see ../DESIGN.md for the index. -->

## 11. Secrets & credential storage

Decision #6 waives real user authentication (single local admin), but the GitHub PAT and each saved AI provider's API key are still meaningful secrets and deserve better than plaintext-in-a-queryable-database defaults. Two proportionate, cheap steps — not a full secrets-manager:

1. **The server listens on 127.0.0.1 only** (`bin/graphreview.mjs`), and there are no other services or ports — the database is a file in the data folder. Because there is no login, `middleware.ts` also guards against the user's own browser being used against it: requests must be addressed to a loopback host name (defeats DNS rebinding) and anything but GET/HEAD must come from the app's own origin (defeats cross-site POSTs, which with path containment gone could otherwise add any folder as a repo). `GRAPHREVIEW_ALLOWED_HOSTS` adds host names.
2. **Credential fields are encrypted at rest.** The PATs (on `Settings`, §7) and every saved provider's API key are encrypted with AES-256-GCM before being written to the database, and decrypted only in-process when making an API call. The key is `SESSION_SECRET` when set, otherwise a random `secret.key` generated in the data folder on first use. This keeps a copy of the database file on its own (a backup, a file attached to a bug report) from being an instant credential leak; it doesn't protect against someone who can read the whole data folder, which per-user key management (moot under decision #6) wouldn't either.

Out of scope: a full secrets manager/vault integration, or per-user credential isolation.

## 12. Distribution and runtime layout

**As built (2026-10-03)** — replaced the original Docker Compose layout (app + worker + Neo4j + Redis containers, a bind-mounted local-repos folder, `SESSION_SECRET`/`NEO4J_*`/`REDIS_URL` env vars).

- **One process.** `npx graphreview` runs `bin/graphreview.mjs`, which checks prerequisites (Node 22.13+ for `node:sqlite`, `git`), picks a port from 3470 up, and starts the prebuilt app with `next start` on 127.0.0.1. `instrumentation.ts` starts the job workers inside that server process. `npm run dev` does the same with hot reload.
- **One data folder** — `~/.graphreview` (`--data` / `GRAPHREVIEW_HOME`; `.data/` in a checkout under `npm run dev`): `graphreview.db`, `repos/` (app-managed clones), `secret.key`, `config.env` (the user's settings as `NAME=value` lines — `lib/runtime/config-env.mjs`; created on first start with the likely settings commented out, applied by the launcher before the app starts so even `NODE_EXTRA_CA_CERTS` works, and by instrumentation.ts under `npm run dev`; the environment wins over the file), `instance.json` (the running instance's pid and URL — a second launch on the same folder points at it instead of starting a second set of workers on one database).
- **Lifecycle.** Queued jobs survive restarts; a job left `active` is re-queued if it has attempts left (analysis) and otherwise failed as interrupted (AI jobs, §10 — never auto-repeat model spend). The server exits when its launcher process disappears, since on Windows killing a parent doesn't kill its children.
- **Packaging.** `npm pack` runs `next build` (`prepack`) and ships `.next/`, `bin/`, `public/`, the analysis `queries.scm` files and the preview harness; dependencies install normally. `web-tree-sitter`, `@vscode/tree-sitter-wasm` and `simple-git` are `serverExternalPackages` so their files are read from `node_modules` at runtime, and the launcher points `GRAPHREVIEW_GRAMMAR_DIR`/`GRAPHREVIEW_ANALYSIS_LANGUAGES_DIR` at them.
- **Docker is optional** — used only by the before/after preview (§6.9).
- **Closed networks:** `GITHUB_API_URL`/`GITHUB_WEB_URL`, `GITLAB_API_URL`/`GITLAB_WEB_URL`, `NODE_EXTRA_CA_CERTS`, `NPM_CONFIG_REGISTRY`, `PIP_INDEX_URL`, `PREVIEW_IMAGE_REGISTRY` and the proxy variables (install.md has the full list). The Docker build args of the old layout (`NODE_BASE_IMAGE`, `ALPINE_MIRROR`, `CA_CERT_DIR`, `NEO4J_IMAGE`, `REDIS_IMAGE`) are gone with it.
- Pages that read the database must still be `dynamic = "force-dynamic"`: `next build` has no user database, so a statically prerendered DB-backed page bakes in "empty" (this once hid saved credentials on `/settings`).

## 13. Module/folder structure

*Design-time sketch below; **as built** the notable additions are:*
- `lib/ai/` = `client, parse, budget, prompts, review, errors, types, mock-server` (+ several smoke tests)
- `lib/preview/` = the before/after preview's sandbox (`sandbox`, `checkout`, `symbols`, `runtime`, `types`, `harness/`) — §6.9
- `lib/jobs/` = the job runner, its queues and job bodies, the module-tier writer, the two maps, the checklist, the chat and the preview — lib/jobs/README.md has the full table
- `lib/db/` (formerly `lib/neo4j/`) also has `label.ts` and `merge.ts` (repo-scoped bulk queries, kept out of `component.ts`/`file.ts`) and `kv.ts`
- `lib/analysis/` also has `languages/{go,rust,java,kotlin,jvm}/` (`jvm/` is shared Java+Kotlin resolution infrastructure, not a language of its own — see §5), `api/` (the endpoint catalog, §6.11) and `infra/` (the infra catalog, §6.12: `read`, `code-facts`, `terraform`, `nomad`, `kubernetes`, `docker`, `link`, `catalog`, `compare`, `describe`, `types`), with `syntax/hcl.mjs` the HCL reader, and `db/` (the schema catalog, §6.13: `read`, `sql`, `replay`, `common`, `sources/{prisma,drizzle,typeorm,django,sqlalchemy,sql-files}`, `catalog`, `link`, `compare`, `describe`, `types`), with `syntax/db.mjs` the table facts of the parse
- `components/graph/` = the Graph tab: `GraphView` (columns and views), `AppMapView`/`AppMapPanel`, `ApiView`/`ApiEndpointDetail`, `InfraView`/`InfraResourceDetail`, `DataView`/`DbTableDetail`, `PrMapCanvas`/`PrAreaPanel`, `CardFlow`, `DiffPanel`, `ReviewPanel`, `ChecklistPanel`, `ChatPanel`, `PreviewPanel`, `FileDiffModal`, their hooks and wire types — components/graph/README.md has the rest
- `lib/mcp/` = the MCP server coding agents use to read a review and reply to findings (`app/api/mcp`)
- API routes under `app/api/repos/[repoId]/` = `graph, file, diff-impact (+ /file), app-map (+ /job), pr-map, review (+ /events, /findings/[findingId]), checklist (+ /overrides), chat, preview (+ /scan), target-graph, api-catalog (+ /infer), infra-catalog, db-schema, branches, commits, pull-requests, refresh`, plus `app/api/local-repos`, `app/api/checklist/items` and `app/api/mcp`
- Smoke tests run with `npx tsx lib/<module>/smoke-test*.ts`; `npm test` runs them all.

```
app/                     App Router routes (repo/[repoId]/graph, repo/[repoId]/pr/[prNumber], settings)
                          + thin app/api/* route handlers
components/               shadcn/ui components
components/graph/         the Graph tab: card maps (React Flow + ELK), diff panel, review dock, chat
lib/db/                   SQLite connection + typed repository functions per entity
lib/analysis/             languages/<lang>/ (grammar/queries/resolver), graph-builder.ts, ir.ts
lib/github/                Octokit wrapper, PAT handling, PR/diff/linked-issue fetching
lib/gitlab/                 fetch-based GitLab REST v4 wrapper, PAT handling, MR/diff/linked-issue fetching
lib/ai/                    OpenAI-compatible client wrapper, prompt templates,
                          per-component orchestration, truncation helpers
lib/jobs/                  job queue (runner.ts), queue/job-type definitions and job bodies
lib/crypto/                credential encrypt/decrypt helpers (§11)
worker/                    job workers, started in-process by instrumentation.ts
bin/                       the `npx graphreview` launcher
types/                     (never created — wire types live beside their UI, components/graph/*-types.ts)
docs/                      DESIGN.md and future ADRs
```

## 14. Local repo access

**As built (2026-10-03):** GraphReview runs on the host as the user, so a local source is simply an absolute path to a checkout — it is read in place and never written to (previews copy trees out with a throwaway index, §6.9). `LOCAL_REPOS_ROOT`, when set, confines local sources to one folder again: relative paths resolve from it and anything outside is refused. The add-repo dialog lists git repos found one level inside common checkout folders (`~/code`, `~/Documents/GitHub`, `~/source/repos`, …), or inside `LOCAL_REPOS_ROOT` when set.

*History:* under Docker Compose a container could only see host paths bind-mounted at startup, so local repos had to live under one bind-mounted folder (`LOCAL_REPOS_PATH`), and escaping it was treated as a security boundary.
