# lib/jobs

> `lib/jobs/` BullMQ queue/job-type definitions shared by app and worker

From DESIGN.md §3:

> **Background jobs — BullMQ + Redis.** Static analysis (parsing
> potentially thousands of files) and AI calls are too slow and CPU-bound
> to run inline in a route handler... A separate `worker` process (same
> image, different entrypoint) consumes jobs from Redis-backed queues,
> giving job status, retries, and a natural point to parallelize
> per-component AI calls.

## Scope

- Queue definitions (names, connection config from `REDIS_URL`) shared by
  both `app` (producer, via route handlers) and `worker` (consumer).
- Job-type payload/result types: repo analysis (clone/pull → static
  analysis → clustering), per-component AI intent-check, AI-assisted
  labeling of the domain tier.
- Nothing here executes a job — `worker/` owns the consumer/processor
  wiring; this directory is the shared contract both sides import.

## Modules

| file | what it owns |
|---|---|
| `queue.ts` | Redis connection (`REDIS_URL`), the `analysis` queue, the typed `{ repoId }` payload, and `enqueueAnalysis()` — idempotent via a deterministic job id (`analysis-<repoId>`; `-` not `:`, since BullMQ rejects `:` in custom job ids). |
| `source.ts` | Resolving a `Repo` to a directory: the `LOCAL_REPOS_PATH` containment check (§14, a security boundary) and the app-managed clone/fetch into `REPO_CACHE_DIR` (§12). Also the cheap HEAD probes (`git ls-remote` / `rev-parse`). |
| `github-access.ts` | Joins a stored `Repo` to `lib/github`: parses owner/repo out of the URL, decrypts the PAT from `Settings` (§11), and returns branch/PR lists — shared by the API routes and the server components that render those tabs. |
| `staleness.ts` | §10's `checkAndEnqueueIfStale()` — compare `lastAnalyzedSha` to the current HEAD, enqueue a refresh when they differ. Callable from any route. |
| `repo-status.ts` | Derives the §4 status indicator (`analyzing`/`up_to_date`/`stale`/`error`) and the `RepoDto` wire shape used by `GET /api/repos[/:id]`. |
| `analyze.ts` | The job body: `analyzeRepo()` → Neo4j (`File`, `Component`, `BELONGS_TO`, `IMPORTS`, aggregated `DEPENDS_ON`) → `markRepoAnalyzed`. Not re-exported from `index.ts` — it pulls in tree-sitter, which only the worker should load. Its prune step is scoped to the **module** tier, so a refresh can never delete the AI-written domain tier or a module's `CHILD_OF` edge — only a domain left with no children at all. |
| `label-queue.ts` | The `label` queue (§6.1): payload `{ repoId, force? }`, `attempts: 1` (never auto-retry something that spends model calls), job id `label-<repoId>`, and `enqueueLabel()` with the same idempotent enqueue dance as analysis/review. Unlike a review, nothing enqueues this automatically — it is on demand only (§10: re-analysis is frequent and silent token spend is not acceptable). |
| `label.ts` | The job body: module-tier components (+ file paths, dependency names, optional README excerpt) → `labelComponents` from `lib/ai` → replace this repo's auto domain components and their `CHILD_OF` edges (serially — Neo4j Community deadlocks on parallel relationship writes, §17) → write one description per module, **never over a non-empty one** unless `force`. Not re-exported from `index.ts` — it pulls in `lib/ai`. |

`worker/` owns the consumer wiring; nothing in this directory starts a
`Worker`. The actual parsing (`lib/analysis/`) and AI (`lib/ai/`) logic stays
in those packages.
