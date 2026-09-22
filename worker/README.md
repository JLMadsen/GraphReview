# worker

> `worker/` worker process entrypoint(s)

> A separate `worker` process (same image, different entrypoint) consumes
> jobs from Redis-backed queues, giving job status, retries, and a natural
> point to parallelize per-component AI calls.
>
> **Services**: `app` (Next.js web server), `worker` (same image, BullMQ
> worker entrypoint)...

## Scope

- `index.ts` — process entrypoint. Registers BullMQ `Worker` consumers for
  the queues defined in `lib/jobs/`, dispatching to `lib/analysis/` (static
  analysis jobs) and `lib/ai/` (per-component intent-check jobs).
- Runs as the same Docker image as `app`, just with a different container
  command (`npm run worker` vs `npm run dev`/`next start`) — see
  `docker-compose.yml`.
- No HTTP surface; this process only consumes jobs and writes results via
  `lib/neo4j/`.

## Current state

`index.ts` consumes the `analysis` queue (`lib/jobs/queue.ts`). For each
`{ repoId }` job it resolves the repo's source on disk (bind-mounted local
path, or an app-managed clone in `/data/repos/<repoId>`), runs
`analyzeRepo()` from `lib/analysis`, persists the resulting graph through
`lib/neo4j`, and records `Repo.lastAnalyzedAt`/`lastAnalyzedSha`. The
job body itself lives in `lib/jobs/analyze.ts`; this file is only BullMQ
plumbing plus lifecycle logging.

Job start/completion/failure are logged to stdout with timings and counts,
since `docker logs` on the `worker` service is how this process is observed.
Errors are rethrown so BullMQ applies its retry/backoff policy; failures that
retrying can't fix (repo deleted, path outside the bind mount) are raised as
`UnrecoverableError`.

Optional env vars: `ANALYSIS_CONCURRENCY` (default 1) and
`STALENESS_SWEEP_INTERVAL_MS` (default 0 = off, since the normal refresh
trigger is "on view").

AI intent-check jobs are v2 — no consumer for them exists yet.
