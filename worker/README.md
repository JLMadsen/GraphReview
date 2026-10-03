# worker

> `worker/` the background job workers

## Scope

- `index.ts` — `startWorker()`, called once per process from the root
  `instrumentation.ts` when the Next.js server starts (dev or production).
  It registers a `Worker` (lib/jobs/runner.ts) for each queue defined in
  `lib/jobs/` — `analysis`, `review`, `label`, `app-map`, `preview`,
  `preview-scan` — and dispatches to the job bodies there.
- Runs inside the web server's process; there is no separate worker to
  start. `GRAPHREVIEW_NO_WORKER=1` turns it off.
- No HTTP surface of its own; it only consumes jobs and writes results via
  `lib/db/`.

## Current state

On start it opens the database (applying migrations) and settles jobs a
previous run left `active` (`recoverInterruptedJobs`): analysis is
re-queued, AI jobs are marked failed as interrupted. Then each queue's
worker polls for due jobs and is also woken immediately on `add()`.

Job start/completion/failure are logged to stdout with timings and counts,
and each job's own lines are mirrored into its job log for the UI's
hover-to-see-progress. Errors are rethrown so the runner applies the
queue's retry/backoff policy; failures that retrying can't fix (repo
deleted, path outside `LOCAL_REPOS_ROOT`) are raised as `UnrecoverableError`.

Labeling and app-map runs are cancellable cooperatively: the worker polls a
cancel flag (lib/jobs/runner.ts `setFlag`/`hasFlag`) and aborts the run's
model calls.

Optional env vars: `ANALYSIS_CONCURRENCY`, `REVIEW_CONCURRENCY`,
`LABEL_CONCURRENCY`, `APP_MAP_CONCURRENCY`, `PREVIEW_CONCURRENCY` (all
default 1) and `STALENESS_SWEEP_INTERVAL_MS` (default 0 = off, since the
normal refresh trigger is "on view").
