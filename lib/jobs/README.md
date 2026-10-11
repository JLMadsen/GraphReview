# lib/jobs

> `lib/jobs/` queue/job-type definitions and job bodies

Static analysis (parsing potentially thousands of files) and AI calls are
too slow to run inline in a route handler, so they run as background jobs:
route handlers enqueue, and the workers in `worker/` (started inside the
same process by `instrumentation.ts`) consume. Jobs are stored in the app's
SQLite database by `runner.ts`, so a queued job survives a restart.

## Scope

- `runner.ts` — the job queue itself: `Queue`, `Worker`, `Job`,
  `UnrecoverableError` (a small BullMQ-shaped API over the `jobs` table),
  interrupted-job recovery, and short-lived flags for cooperative cancel.
- Queue definitions shared by route handlers (producers) and `worker/`
  (consumer).
- Job-type payload/result types: repo analysis (clone/pull → static
  analysis → clustering), per-component AI review (plus its impact and PR-intent passes), the app
  map's AI runs, previews.
- Nothing here executes a job — `worker/` owns the consumer/processor
  wiring; this directory is the shared contract both sides import.

## Modules

| file | what it owns |
|---|---|
| `queue.ts` | The `analysis` queue, the typed `{ repoId }` payload, and `enqueueAnalysis()` — idempotent via a deterministic job id (`analysis-<repoId>`). |
| `source.ts` | Resolving a `Repo` to a directory: local paths (absolute, or confined to `LOCAL_REPOS_ROOT` when that is set) and the app-managed clone/fetch into the clone cache (`<data folder>/repos`, or `REPO_CACHE_DIR`). Also the cheap HEAD probes (`git ls-remote` / `rev-parse`). |
| `github-access.ts` | Joins a stored `Repo` to `lib/github`: parses owner/repo out of the URL, decrypts the PAT from `Settings`, and resolves `{owner, repo, token}` access for a repo. |
| `gitlab-access.ts` | The GitLab counterpart to `github-access.ts` — parses a project's full namespace path out of the URL, decrypts the GitLab PAT, and resolves `{path, token}` access for a repo. |
| `repo-access.ts` | `getRepoBranches`/`getRepoPullRequests` — the per-tab dispatch across local git, `github-access.ts`, and `gitlab-access.ts`, returning one envelope shape regardless of which source produced it. Shared by the API routes and the server components that render the Branches/Pull-Requests tabs. |
| `staleness.ts` | `checkAndEnqueueIfStale()` — compare `lastAnalyzedSha` to the current HEAD, enqueue a refresh when they differ. Callable from any route. |
| `repo-status.ts` | Derives the status indicator (`analyzing`/`up_to_date`/`stale`/`error`) and the `RepoDto` wire shape used by `GET /api/repos[/:id]`. |
| `analyze.ts` | The job body: `analyzeRepo()` → the database (files, components, `BELONGS_TO`, `IMPORTS`, aggregated `DEPENDS_ON`) → `markRepoAnalyzed`. Not re-exported from `index.ts` — it pulls in tree-sitter, which only the worker should load. The module tier itself is written by `module-tier.ts`, whose prune step is scoped to the **module** tier, so a refresh can never delete the domain tier or a module's `CHILD_OF` edge — only a domain left with no children at all. |
| `module-tier.ts` | `writeModuleTier()` — the one writer of the module tier (DESIGN.md §6.3), called by `analyze.ts`: ownership → folder/merged module nodes → `BELONGS_TO` (only changed files) → `DEPENDS_ON` → prune empty folder modules → domain inheritance → findings follow their files. Merged modules are the merges users accepted before the merge suggestions were removed with the Repo view (docs/ideas.md); they stay in effect. |
| `ownership.ts` | Pure: which component owns each file once merged modules claim files out of folder modules (exact file > longest folder pattern > folder module). |
| `folder-names.ts` | Pure: which path segments name a layer (`app`, `lib`, …) or nothing in particular (`utils`, …), and `normaliseSegment` — the App map's feature-folder heuristics. |
| `ai-config.ts` | `loadAiConfigOrNull()` — the active AI provider's config, or `null` when none is fully configured. |
| `pr-map.ts` | The PR map builder (DESIGN.md §6.4): `loadPrMapInput` (owners + one-hop `IMPORTS` of the changed files), then pure `classifyPath`, `collectPrMapLinks`, `heuristicPrMapGroups`, `assemblePrMap` and `applyPrMapGrouping` (an AI grouping over the same links). |
| `repo-access.ts` (commits) | `getRepoCommits()` — a branch's newest commits for the commit picker, dispatched to GitHub / GitLab / `listLocalCommits` (`git log`) with the same `linked`/`error` envelope as branches and PRs. `getRepoPullRequests()` takes an optional `limit`. |
| `changed-files.ts` | `listTargetChangedFiles()` — a review target's changed files (status, counts, patches) from local git / GitHub / GitLab, cached 30 s. Used by the PR map endpoint. |
| `smoke-test-pr-map.ts` | `npx tsx lib/jobs/smoke-test-pr-map.ts` — the PR map builder, AI-grouping normalisation, and the mock-server round trip. |
| `smoke-test-ownership.ts` | `npx tsx lib/jobs/smoke-test-ownership.ts` — checks for `ownership.ts`: folder ownership, merged modules claiming folders and files, dead patterns, flat-folder parts. |
| `preview-queue.ts` | The `preview` queue (DESIGN.md §6.9): payload `{ repoId, target, filePath, inputs? }`, `attempts: 1`, one job per (repo, target, file) — job id `preview-<hash>` — so running again replaces the last run. The result is the job's return value; nothing is written to the database. |
| `preview.ts` | The before/after preview job: pin base (merge-base) and head, detect changed symbols, get inputs (edited → AI → empty), write both trees, run each in a sandbox container (`lib/preview`), and compare case by case. Not re-exported (pulls in `lib/ai`, `lib/analysis`). |
| `head-source.ts` | `openHeadSource()` — read files and `git grep -w` at a review target's head commit (the local checkout, or the app-managed clone with the head fetched in). Used by the review's related-code context and its impact pass; `null` when the head can't be opened. |
| `impact-contracts.ts` | Pure: `detectChangedContracts()` — function/method signatures, type shapes and exported constants a diff changed or removed (hunk old/new side + the file at the head; body-only edits don't count), and `addedLineNumbers()`. |
| `impact.ts` | The review's impact pass: grep each changed contract at the head, keep usages the PR didn't write that can reach the declaration (`untouchedReachableUsages`, pure), ask `checkImpact` (lib/ai) which no longer fit, and return `category: "impact"` findings on the callers' components (plus a note when caps cut usages off). Never throws. |
| `smoke-test-impact.ts` | `npx tsx lib/jobs/smoke-test-impact.ts` — contract detection, the usage filter, and the impact / PR-intent model calls (fake chat + mock server). |
| `preview-scan.ts` | The scan behind the Graph tab's "Looks different" list: parses both versions of each changed JSX-capable file and keeps the changed **components** (not plain functions). No Docker, no model. Its queue (`preview-scan`, in `preview-queue.ts`) is started by reading `GET …/preview/scan` and re-scans after 5 minutes (`ensurePreviewScan`). Not re-exported (pulls in `lib/analysis`). |

| `commit-analysis.ts` | `analyzeRepoCommit(dir, sha)`: one commit analysed with the SQLite parse cache (`dbParseCache`) and the last three results memoised in memory. Not re-exported (pulls in lib/analysis). |
| `target-graph-queue.ts` / `target-graph.ts` | The `target-graph` queue and job (DESIGN.md §6.10): a target's merge-base vs head — structure change (new import cycles become `structure` findings), call graph — stored in `target_graphs`. Started by reading `GET …/target-graph`; redone after 5 minutes. The job body is not re-exported. |
| `symbol-context.ts` | The review's view from names: `loadTargetAnalyses`, `symbolContracts`/`symbolUsages` and `newDeadImports` for the impact pass, `symbolRelatedFiles` for the per-component context. Not re-exported. |
| `smoke-test-symbol-impact.ts` | `npx tsx lib/jobs/smoke-test-symbol-impact.ts` — the name-based impact pass, replaying the first real review's false positives. |

`worker/` owns the consumer wiring; nothing in this directory starts a
`Worker`. The actual parsing (`lib/analysis/`) and AI (`lib/ai/`) logic stays
in those packages.
