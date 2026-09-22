# GraphReview — Design Document

Status: **v1 implemented; v2 (AI review) implemented** — synced with the code on 2026-09-21. Per-phase status is in §15; things that are built but not yet verified live are listed in §16; hard-won implementation gotchas are in §17. Sections below describe the design; where the build deliberately differs, a **"As built"** note says so.

## 1. Product concept

GraphReview is a locally-run tool for reviewing GitHub pull requests in a different way than a flat diff. It statically analyzes a target codebase into an **ontological graph** of components (e.g. "Auth", "DB layer", "UI primitives") connected by their code dependencies. When you select a PR — or diff any two refs — it highlights which components are touched by the changed files. An AI model then explains, per touched component, what the change does in plain English, and checks whether the change's actual content is consistent with the PR's stated intent (its title/description and any linked issue), surfacing mismatches as advisory annotations directly on the graph.

The app is designed to run entirely on a developer's own machine, against repos they choose, with a fully swappable AI backend and no dependency on a specific GitHub App registration.

## 2. Locked decisions

These were decided deliberately and should not be relitigated without a documented reason — they shape every section below.

| # | Decision |
|---|---|
| 1 | **Graph construction** is static analysis, fully automatic. No manual curation is required to get an initial graph; nodes remain editable afterward. |
| 2 | **Edges** represent code dependencies (imports/calls) — objective, derived from static analysis, not asserted relationships. |
| 3 | **Intent validation** compares the diff against the PR's title/description (and linked issue, when resolvable) fetched from GitHub. |
| 4 | **Repo access** supports a local clone already on disk, or an app-managed clone by URL, through one interface. Under Docker, local sources must live under one bind-mounted parent folder (`LOCAL_REPOS_PATH`) — see §14's caveat. |
| 5 | **Distribution** is Docker Compose as the primary, recommended way to run the app: one `docker compose up` starts the app and Neo4j together. |
| 6 | **Auth** is a single local admin user, no real authentication — at most a lightweight local session gate. |
| 7 | **GitHub auth** is a user-supplied Personal Access Token (PAT) entered in settings — no OAuth App or GitHub App registration. |
| 8 | **AI provider** is a generic OpenAI-compatible chat-completions endpoint (base URL + API key + model name), fully user-configurable. No hardcoded provider, and no reliance on provider-specific structured-output/tool-calling features. |
| 9 | **Node purpose/description** lives only in Neo4j as a component property, edited in-app — never committed to the target repo. |
| 10 | **Intent-check UX** is advisory annotations only in the graph UI. It never blocks a review and never auto-posts to GitHub. |
| 11 | **Language scope** is polyglot as an *extension point* from day one (common IR + per-language plugin interface). Actual v1 language coverage is still phased — see §15. |
| 12 | **Multi-repo**: one running instance tracks multiple repos simultaneously, each in its own namespace, switchable in the UI. |
| 13 | **Frontend** is Next.js (App Router, TypeScript) with shadcn/ui as the base component library. |

## 3. Tech stack

- **Next.js App Router, TypeScript throughout** (app, worker, and shared libs share one codebase and type layer). App Router over Pages Router: server components suit the graph-heavy dashboard, and route handlers give a natural, colocated API surface.
- **Neo4j driver**: the official `neo4j-driver` package, wrapped in a server-only singleton (`lib/neo4j/client.ts`) with a connection pool. It is never imported into client components — all reads/writes go through typed repository functions in `lib/neo4j/`.
- **Background jobs — BullMQ + Redis.** Static analysis (parsing potentially thousands of files) and AI calls are too slow and CPU-bound to run inline in a route handler: they'd block the server's event loop and give no progress or cancel UX. A separate `worker` process (same image, different entrypoint) consumes jobs from Redis-backed queues, giving job status, retries, and a natural point to parallelize per-component AI calls. Redis is one more small container in Compose.
- **Graph rendering — Cytoscape.js.** Chosen over the alternatives considered:
  - *react-force-graph* — nicer for a "cool" WebGL visual, but weaker at discrete layout-mode switching and has no built-in minimap; more custom work to hit the Force/Circle/Grid + minimap spec from the prototype.
  - *Sigma.js* — WebGL, excels at very large graphs (10k+ nodes), but is overkill at component-graph scale and requires hand-rolling layout switching via `graphology-layout*`. Worth revisiting later specifically for a file-level drill-down view if that ever needs to render thousands of file nodes at once.
  - *Cytoscape.js* — canvas-based, with a layout registry that maps directly onto the required layout modes (`fcose`/`cose-bilkent` → Force, `circle` → Circle, `grid` → Grid), and a plugin ecosystem that covers the rest of the UI spec off the shelf: `cytoscape-expand-collapse` (compound/tier nesting), `cytoscape-elk` (the Hierarchical layout). Performance is more than sufficient for realistic component-graph sizes (tens to low hundreds of nodes; verified at 109 components / 382 dependency edges).
  - **As built:** layouts are Force (`fcose`), Circle, Grid and **Hierarchical (ELK, top-to-bottom layered)**. `elkjs` is large, so `cytoscape-elk` is dynamically imported only the first time Hierarchical is selected. The **minimap was removed** on user feedback (`cytoscape-navigator` uninstalled), and tooltips are a small custom overlay rather than `cytoscape-popper` (which needs a positioning engine that isn't a dependency). Wheel zoom uses Cytoscape's default sensitivity — a custom `wheelSensitivity` made zoom feel slow.

## 4. Screens & navigation

- **Repo list (landing page)** — every added repo, with name, source (`local` | `github`), and a status indicator (`analyzing…` / `up to date as of <sha>` / `stale, refreshing…`, per §10). Adding a repo (local path under `LOCAL_REPOS_PATH`, or a GitHub URL) kicks off the first analysis automatically (§10).
- **Repo detail**, reached by clicking a repo, with three tabs:
  - **Branches** — branch list, plus the ad-hoc "compare two refs" tool from the original prototype's sidebar.
  - **Pull Requests** — PR list fetched from GitHub (state filter: open/closed/merged), so a reviewer can browse without loading the graph first.
  - **Graph** — the main visualization (§6). Opened directly with no filter, or pre-filtered when arrived at from a PR row or a ref comparison. The diff-selection control itself (pick a PR, or two refs) lives as a panel inside this tab, not a separate screen — matching the prototype's always-present sidebar, just scoped to this one tab instead of being global.
- **Settings** — a single global (not per-repo) page for the GitHub PAT and AI provider config (base URL/key/model), since both are instance-wide under decision #6's single-local-admin model.

This differs from the prototype screenshot's single always-on graph+sidebar view: browsing branches/PRs is a first-class step before committing to loading a graph, which matters more once repos are polyglot and potentially large (§5).

**As built (deltas from the list above):**
- **Repo list** — the whole card is the click target and opens the **Graph** tab directly (a stretched link; the earlier Branches / Pull Requests / Graph quick-link buttons were removed — those tabs remain reachable from inside the repo). A repo whose analysis failed shows the **actual failure reason** (BullMQ `failedReason`) and a **Retry** button that force re-enqueues analysis. The Add-repo dialog lists the git repos found one level under `LOCAL_REPOS_PATH` as a dropdown (manual path entry still works).
- **Branches** — for `provider: "local"` repos the list comes from the local `.git` (`git for-each-ref`), so **no GitHub PAT is needed**; GitHub-linked repos still use the API. **Pull Requests** stays GitHub-only ("not linked to GitHub" for local repos).
- **Graph tab** — uses the full page width (only this tab opts out of the repo shell's width cap). Clicking a node shows that component's **file list** and highlights its direct dependency neighbours (both directions), dimming the rest; clicking the background or the node again clears it. The diff panel's PR / base / head pickers are **dropdowns fed by real data** (open PRs, local or GitHub branches) with a free-text fallback when the data isn't available. Ref comparison works for local repos via local `git diff base...head`.
- **Review dock** — the AI review's progress, cost counter, verdict filters and findings live in a full-width dock under the canvas (see §9/§10 "As built").
- **Settings** — a **Test connection** button for the AI provider (a tiny chat call, run server-side, using the typed values or the saved key), and **Clear** actions for the saved PAT and AI key. The page is dynamically rendered (never prerendered at build time).

## 5. Polyglot static analysis strategy

The goal is an import/dependency graph across multiple languages without turning "add a language" into "install and shell out to a whole new toolchain" (e.g. a JVM for `jdeps`, a Go toolchain for `go list`, etc., all bloating the Docker image).

- Use **`web-tree-sitter`** with **WASM grammars**, not native bindings — this avoids native module rebuilds across platforms/architectures and keeps the Docker image portable.
- v1 language coverage: **JavaScript/TypeScript and Python** (see phasing in §15); the grammar set is designed to grow without touching the core pipeline.
- Each language implements a small `LanguageAnalyzer`: a tree-sitter query file (`.scm`) that extracts import/require statements, plus a `resolveImportPath` function that turns a raw import specifier into a repo-relative file path where possible (straightforward for JS/TS/Python relative imports; best-effort elsewhere, falling back to an "external dependency" placeholder when unresolvable).
- **Common IR** every analyzer emits, decoupling the graph builder from language specifics:
  ```ts
  interface FileAnalysis {
    file: string;
    language: string;
    imports: Array<{
      raw: string;
      resolvedPath?: string;
      kind: "import" | "require" | "call";
    }>;
    loc: number;
  }
  ```
- **Extension point**: `lib/analysis/languages/<lang>/{grammar.wasm, queries.scm, resolve.ts}`, implementing a shared `LanguageAnalyzer` interface and registered by file extension in a central registry. Adding language *N+1* means implementing the interface and shipping its grammar — no change to the graph builder.
- **Call-graph edges** (as opposed to file-level import edges) are deferred past v1 — reliable call/scope resolution is much harder and highly language-specific. v1 ships file-level import edges only, which already satisfies decision #2 ("edges = code dependencies").
- Unresolvable external packages (npm/PyPI/etc.) become optional grouped "external" nodes for context, rather than being expanded individually.

## 6. Component/node inference

Turning a raw file-level import graph into meaningful, named components:

- **v1 default: folder-based clustering.** A component is the set of files under a configurable top-N folder depth (e.g. everything under `src/auth/**` becomes "Auth"). This is deterministic, explainable, and matches the near-universal folder-per-module convention across languages and ecosystems. Results are stored as editable `Component` properties so users can merge, split, or rename after generation, per decision #9.
- **Community detection (Louvain, via `graphology` + `graphology-communities-louvain`)** is offered later as an opt-in "suggest a different clustering" action, computed on the file-level import graph — useful for flatter `src/` layouts where folders don't reflect logical boundaries. It is not the default path, since Louvain output can be non-deterministic and non-intuitive to a human; users explicitly accept or reject the suggestion.
- **LLM-assisted labeling** is an optional step at generation time: send the model the file paths in a cluster (plus perhaps a README/package.json snippet — never full file contents) and ask for a short name and one-line purpose, populating `Component.description` directly. This must degrade gracefully — at graph-generation time the user may not yet have configured an AI provider (decision #8) — falling back to the raw folder name when none is configured.
- v1 pipeline: build the file-level import graph (§5) → cluster by folder depth → LLM-label if an AI provider is configured, else use the folder name → persist as editable `Component` nodes → offer manual re-clustering via community detection as a secondary action.

### 6.1 Hierarchical (multi-tier) clustering

Clustering is not flat — it is recursive, with each `Component` optionally having a parent `Component`. The default view exposes three tiers, matching the drill-down a reviewer actually wants (see the worked example in §6.2):

1. **Domain tier** (e.g. Frontend / Backend / Infrastructure) — the widest grouping.
2. **Module tier** (e.g. Auth, DB connection, a given page/route) — the level the graph highlights by default when a PR is opened; this is what the existing `Component` model in §6–§7 already describes.
3. **File tier** — individual files, reached by drilling into a module node.

Mechanically, tiers 2→3 and 1→2 both come from the same folder-depth clustering pass in §6, just applied at two different depth cutoffs — no separate algorithm is needed to produce the nesting structurally. What differs is how reliably each tier can be *labeled* automatically:

- The module tier (2) labels well from folder names directly, same as the current v1 approach.
- The domain tier (1) does **not** label reliably from folder structure alone in a lot of real repos — a Next.js app in particular mixes server and UI code under `app/`, so "frontend vs. backend vs. infra" often isn't a top-level folder split. Getting a good domain tier needs either LLM-assisted labeling (send the module list, ask the model to bucket them into domains) or a short one-time manual tagging step per repo, not pure mechanical inference. See the phasing note in §15 and the caveat in §16.

Rendering-wise, this maps directly onto Cytoscape's compound-node model (`cytoscape-expand-collapse`, already chosen in §3): tiers are nested/collapsible compound nodes rather than three separate graphs, so a reviewer can start at the domain view and expand down to modules and files in place.

### 6.2 Worked example: diff granularity

Take a hypothetical bug where `square.ts`'s function doubles its input instead of squaring it, inside a "Math" module component. The graph highlights the touched node at the tier currently in view — most often "Math" at the module tier, shown as touched with one file changed underneath it. The graph itself does not, by default, spell out *what* is wrong at that zoomed-out level.

That detail comes from the AI finding, not the graph structure: the per-component LLM call (§9) already receives the actual diff hunk for `square.ts`, so a resulting mismatch ("this doubles instead of squares, but the PR says it implements a square function") lands in the `Finding`'s rationale text, naming the file and function explicitly — even though the `Finding` node is attached `ABOUT` the Math component, not a specific file. To make that precision navigable rather than just readable prose, `Finding` gets two additional properties (§7): `filePath` and `lineRange`, populated from the diff hunk the finding was generated from. This costs nothing extra to compute (the LLM call is already scoped to that file's hunk) and lets the UI jump straight to the offending file/lines from a finding, without requiring the graph visualization itself to render at file granularity by default.

## 7. Neo4j schema

Single Neo4j database; every node except `Settings` is `repoId`-scoped so multiple repos coexist without needing per-repo databases (revisit only if strict isolation becomes necessary).

**Node labels and key properties:**

- `(:Repo)` — `id`, `name`, `url`/`localPath`, `defaultBranch`, `provider` (`local` | `github`), `createdAt`, `lastAnalyzedAt`, `lastAnalyzedSha`
- `(:Component)` — `id`, `repoId`, `name`, `description`, `createdBy` (`auto` | `user`), `pathPatterns`, `tier` (`domain` | `module` | ... — see §6.1)
- `(:File)` — `id`, `repoId`, `path`, `language`, `loc`, `lastSeenCommit`
- `(:PullRequest)` — `id`, `repoId`, `number`, `title`, `description`, `author`, `state`, `baseRef`, `headRef`, `headSha`, `url`, `createdAt`, `updatedAt`
- `(:RefSnapshot)` — `sha`, `repoId`, `ref`, `message`, `author`, `timestamp` — covers both a PR's base/head and ad-hoc ref-to-ref comparisons
- `(:Finding)` — `id`, `repoId`, `prId` (nullable), **`targetKey`** (what was reviewed: `pr:<number>` or `refs:<baseRef>...<headRef>` — added so ref-comparison reviews, which have no `PullRequest` node, can be stored and replaced), `componentId`, `filePath`, `lineRange`, `summary`, `intentMatch` (`match` | `partial` | `mismatch` | `unknown`), `confidence`, `rationale`, `model`, `createdAt` — `filePath`/`lineRange` are populated from the diff hunk the finding was generated from (§6.2, §9), so a finding attached to a component can still be navigated to the exact file/lines it's about. Findings are **overwritten**, not versioned, when a PR's head SHA changes — see §10.
- `(:Settings {id: "global"})` — a singleton, not `repoId`-scoped, since GitHub PAT and AI provider config are shared instance-wide under decision #6. Credential fields are stored encrypted — see §11.

**Relationships:**

- `(File)-[:BELONGS_TO]->(Component)`
- `(File)-[:IMPORTS {kind}]->(File)`
- `(Component)-[:DEPENDS_ON {weight}]->(Component)` — aggregated from file-level edges
- `(Component)-[:CHILD_OF]->(Component)` — nests a module-tier component under its domain-tier parent (§6.1); the same relationship type generalizes to further tiers if ever needed
- `(PullRequest)-[:BELONGS_TO]->(Repo)`
- `(PullRequest)-[:CHANGES {additions, deletions}]->(File)`
- `(Component)-[:PART_OF]->(Repo)`
- `(Finding)-[:ABOUT]->(Component)`
- `(Finding)-[:FOR]->(PullRequest)`

## 8. GitHub integration surface

- **Data needed**: repo and branch lists, PR list and detail (title, body, base/head SHA, author, state), per-file diffs, linked issues, and ad-hoc ref-to-ref comparisons.
- **REST v3** (`@octokit/rest`) covers most of this — notably `GET /repos/{owner}/{repo}/pulls/{pull_number}/files`, which returns per-file unified-diff `patch` text directly (no separate diff-parsing step needed), and `GET /repos/{owner}/{repo}/compare/{base}...{head}` for non-PR ref comparisons (decision #4).
- **GraphQL v4** (`@octokit/graphql`) is used specifically for linked-issue resolution — `closingIssuesReferences` on a PR is reliably available only via GraphQL — and optionally to batch PR + files + linked-issues into fewer round-trips.
- The PAT (decision #7) is stored via in-app settings, persisted in Neo4j, and used as a Bearer token. REST rate-limit headers are surfaced in the UI (PAT auth gets 5000 req/hr, generous for single-user local use).
- **As built — local repos need no GitHub at all.** Branch listing, ref comparison and the per-file diff text used by the AI review all come from the checkout's own git (`lib/jobs/local-git.ts`: `git for-each-ref`, `git diff --name-only|--name-status|--numstat base...head`, per-file `-U3` patches capped at ~60 KB). Local git runs with `safe.directory=*` because the repo arrives through a read-only bind mount owned by a different uid. Only PRs, linked issues and private-repo cloning require a PAT. A failed clone now reports *why* ("likely private / invalid PAT — needs `repo` scope") instead of git's raw "could not read Username".

## 9. AI integration flow

- **One LLM call per touched component**, not one call for the whole PR. This naturally caps prompt size, lets calls run in parallel via the job queue, and lets findings stream into the UI per node as they complete.
- Each call sends:
  1. Shared "intent" context, once: the PR's title, description, and linked-issue text.
  2. **Diff hunks only** for that component's changed files — the `patch` text already returned by GitHub's files API, with no extra diffing step.
  3. Lightweight structural context: the component's stored name/description and its `DEPENDS_ON` neighbors.
  4. Full file contents are never sent.
- Because the call is already scoped to a specific file's diff hunk, the parser extracts a `filePath`/`lineRange` from that hunk alongside the model's summary/rationale, populating the corresponding `Finding` properties (§7) — so a finding attached to a component in the graph still carries exact file/line precision (§6.2), rather than only ever saying "something in this component looks off."
- Oversized single-file diffs are truncated to hunks touching top-level declarations in v1, with a "diff truncated" flag shown in the UI; a smarter pre-summarization pass is deferred to v2.
- For PRs touching many components (roughly 8–10+), a lazy two-tier flow — a cheap one-line summary per component eagerly, full intent-match analysis only on-demand when a node is expanded — is a natural v2/v3 refinement rather than eagerly running full analysis on every touched component synchronously.
- Because decision #8 requires a fully generic OpenAI-compatible endpoint, the integration **does not rely on `response_format` or tool-calling** for structured output, since these aren't universally supported (e.g. by some Ollama/LM Studio setups). Output uses plain prompted instructions with a robust parser (fenced-JSON extraction plus a fallback). The per-call token budget is configurable, with a conservative default (e.g. 6–8k input tokens), since local models often have much smaller context windows than hosted ones.

### 9.1 As built — the review pipeline

- **`lib/ai/`**: `client.ts` (generic OpenAI-compatible `chatCompletion`, no `response_format`/tools), `parse.ts` (`extractJson`: fenced block → any fence → first brace-balanced span → `null`, never throws), `budget.ts` (≈4 chars/token estimate; default 7000-token budget; system message always kept, most call-specific message preserved, oldest context dropped first), `prompts.ts`, and `review.ts` — `reviewComponentChange(config, {intent, component, files})`. It truncates oversized diffs hunk-by-hunk (`[diff truncated]`, `truncated: true`), makes **no model call at all** if no file has patch text (binary/oversized), normalises model output (confidence clamped to 0..1, unknown `intentMatch` → `unknown`, a `filePath` not among the inputs is dropped), and falls back to a single `unknown` finding with `parseFailed: true` when the output can't be parsed. API/network errors propagate to the caller. `pingProvider` is a one-token "does this config work" probe.
- **Intent semantics.** `match` = plausibly implements the stated intent; `partial` = only part of it or includes unrelated extras; `mismatch` = contradicts the intent **or contains an apparent defect** (§6.2's doubles-instead-of-squares); `unknown` = not enough information. For a **ref comparison there is no PR, hence no stated intent** — the model is told to judge against the code's own evident purpose (names, comments, the component description) and to use `mismatch` for apparent defects. So the feature also works, in a weaker form, on local repos.
- **Job**: a second BullMQ queue, `review`, with a worker in the same process as the analysis worker (concurrency 1). Payload `{ repoId, target: {kind:"pr", prNumber} | {kind:"refs", baseRef, headRef} }`. **`attempts: 1`** — a job that spends money on model calls is never retried automatically; re-running is a deliberate action. Job id = `review-<repoId>-<sha1(targetKey)[0..12]>` (hashed because ref names contain `/`, and BullMQ forbids `:` in custom ids). The job fetches the diff and intent, maps changed files → components (`lib/jobs/diff-components.ts`, shared with the diff-impact route), then calls the model once per touched component with concurrency 3, persisting each component's findings **as it completes** (so they stream into the UI) and updating `job.progress`. One failed model call never aborts the job: that component gets a persisted `unknown` finding whose rationale states the error, and the cost counter still counts the call (a rejected request may be billed). After the run, findings for components no longer touched are pruned.
- **API** (`/api/repos/[repoId]/review`): `POST {prNumber}|{baseRef,headRef}` → `{jobId, targetKey, enqueued}` (400 `ai_not_configured` / `not_linked`, 404, 503 `queue_unavailable`; a POST while a run is pending is a no-op). `GET ?prNumber=N|?baseRef=X&headRef=Y` → `{targetKey, state: none|queued|running|completed|failed, progress?: {total, completed, failed, calls, promptTokens, completionTokens, running[], unmatchedFiles}, error?, findings[], aiConfigured}`. `findings` is whatever is persisted so far. `completed` is also returned when findings exist but the job record has aged out, so an old review isn't mistaken for "never run".
- **UI** (`components/graph/`): after a successful PR / compare-refs impact check the UI GETs the review. **AI not configured** → a non-alarming note linking to Settings, never a POST. **No findings yet** → POSTs automatically (§10: automatic, no confirmation) and polls every ~1.2 s. **Findings already exist** → shows them and offers **Re-run review**; it deliberately does *not* silently re-spend tokens. Findings appear as (1) a marker halo on each component's node for its *worst* verdict — a third, independent highlight layer using Cytoscape `underlay-*` (mismatch rose, partial orchid, unknown slate, match emerald), which composes with the impact layer (node fill) and the selection layer (border/opacity) rather than overwriting either; (2) count chips in the legend; (3) the full-width dock — progress bar, live names of in-flight components, the **cost counter** (`N calls · P prompt + C completion tokens`), verdict filters, findings sorted worst-first with collapsible rationale, and click-to-select-the-node; (4) the selected component's own findings above its file list. Every verdict also carries a distinct icon and word (colour-blind safe), and the dock states that AI can be wrong.
- **Testing without a provider**: `npx tsx lib/ai/mock-server.ts --port 4010` starts a deterministic OpenAI-compatible mock (≈50% match / 25% partial / 25% mismatch by hash of component name; `MOCK_FAIL` in a prompt → HTTP 500, `MOCK_GARBAGE` → non-JSON; `MOCK_DELAY_MS` simulates latency). From the Docker containers use base URL `http://host.docker.internal:4010/v1`. On Windows `tsx` leaves a child process behind — stop the mock by killing the PID listening on the port.

## 10. Analysis lifecycle, staleness & AI cost

**When static analysis (re-)runs:**

- Adding a repo triggers a full analysis immediately (clone/pull if needed → static analysis §5 → clustering §6), recording `Repo.lastAnalyzedAt`/`lastAnalyzedSha`.
- Opening a repo's **Graph** tab, or selecting a PR/ref comparison, compares `lastAnalyzedSha` against the current HEAD (or the PR's head SHA) via a cheap check (`git ls-remote` for local/URL repos, or the GitHub API for the PR's head). If they differ, a background re-analysis job is enqueued automatically — no manual "refresh" button to remember.
- While that job runs, the UI keeps showing the last-known graph with a non-blocking "refreshing as of a newer commit…" indicator (stale-while-revalidate), rather than blocking navigation — a reviewer should never be stuck on a spinner just to look at a PR.

**AI cost visibility (no pre-flight gate, per your call):**

- Once a PR or ref comparison is selected, intent-check calls (§9) run automatically for every touched component — no confirmation dialog, no cap.
- The UI shows a running counter for the current review session — calls made and, where the configured provider reports it, approximate tokens used — so cost is visible in the moment rather than hidden, without gating anything. This is a thin log (call count + token usage per `Finding`/job), not a billing system.

**Findings on PR update (overwrite-only):**

- When a PR's head SHA changes (new push), the same staleness check above triggers re-analysis, and the AI intent-check re-runs for that PR's touched components. Existing `Finding` nodes for that `(prId, componentId)` pair are replaced, not versioned — only the current state matters (§7).
- **As built:** the replace happens per `(targetKey, componentId)` when a re-run finishes that component, so the UI never blanks during a re-run. The UI does **not** auto-re-run when a PR's head SHA changes (it would spend tokens unprompted); it shows the existing findings and offers Re-run. Detecting a moved head SHA and prompting for a re-run is a follow-up (§16).
- Trade-off, stated plainly: there's no audit trail of what the AI flagged before a fix or force-push. Acceptable given findings are advisory-only (decision #10) and not a compliance record — but worth knowing if that changes later.

## 11. Secrets & credential storage

Decision #6 waives real user authentication (single local admin), but the GitHub PAT and AI provider API key are still meaningful secrets and deserve better than plaintext-in-a-queryable-database defaults. Two proportionate, cheap steps — not a full secrets-manager:

1. **Neo4j and Redis ports are not published to the host** in the default `docker-compose.yml` — only the `app`/`worker` containers reach them over the internal Compose network. Anyone wanting the Neo4j Browser for debugging can add a port mapping themselves; it isn't exposed by default.
2. **Credential fields are encrypted at rest.** The PAT and AI API key on the `Settings` node (§7) are encrypted with AES-256-GCM, keyed by `SESSION_SECRET` (already an env var, §12), before being written to Neo4j, and decrypted only in-process when making an API call. This stops a plaintext DB dump or backup from being an instant credential leak, without building out per-user key management that decision #6 makes moot.

Out of scope: a full secrets manager/vault integration, or per-user credential isolation.

## 12. Docker Compose layout

- **Services**: `app` (Next.js web server), `worker` (same image, BullMQ worker entrypoint), `neo4j` (`neo4j:5`), `redis` (BullMQ backing store).
- **Volumes**: `neo4j_data` (persisted Neo4j data), `repo_cache` (shared between `app` and `worker` — app-managed clones live at `/data/repos/<repoId>`).
- **Local-working-directory support** (decision #4) requires an explicit host bind mount: `${LOCAL_REPOS_PATH}:/data/local-repos:ro`. See the caveat in §14.
- **Ports**: only `app`'s web port is published to the host by default; `neo4j` and `redis` stay on the internal Compose network (§11).
- **As built:** the compose file lives at `docker/docker-compose.yml` with its env at `docker/.env` (copy `docker/.env.example`); run it from `docker/` with `docker compose --env-file .env up -d --build`. One multi-stage `docker/Dockerfile` provides the `app` and `worker` targets. Extra optional env vars: `REPO_CACHE_DIR` (clone cache; defaults to `/data/repos`, else `./.data/repos`), `LOCAL_REPOS_ROOT`, `ANALYSIS_CONCURRENCY`, `STALENESS_SWEEP_INTERVAL_MS`. **Code changes require rebuilding the `app` and `worker` images** — there is no bind-mounted source. Pages that read Neo4j must be `dynamic = "force-dynamic"`: the image is built with no database reachable, so a statically prerendered DB-backed page bakes in "empty" (this hid saved credentials on `/settings` until fixed).
- **Env vars**: `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `REDIS_URL`, `LOCAL_REPOS_PATH`, `SESSION_SECRET`. The GitHub PAT and AI provider config (base URL/key/model) live primarily in the in-app settings UI, persisted encrypted to Neo4j (§11), since they are meant to be edited at runtime — env vars serve only as optional bootstrap defaults.

## 13. Module/folder structure

*Design-time sketch below; **as built** the notable additions are:* `lib/ai/` = `client, parse, budget, prompts, review, errors, types, mock-server` (+ smoke tests); `lib/jobs/` = `queue, review-queue, review, analyze, source, staleness, repo-status, github-access, local-git, diff-components`; `lib/analysis/` also has `louvain-cluster.ts`; `components/graph/` = `GraphView, GraphCanvas, DiffPanel, ComponentFilesPanel, ReviewPanel, useReview, review-visuals, types`; API routes under `app/api/repos/[repoId]/` = `graph, diff-impact, branches, pull-requests, refresh, review, components/[componentId]/files`, plus `app/api/local-repos`. Smoke tests run with `npx tsx lib/<module>/smoke-test*.ts`.

```
app/                     App Router routes (repo/[repoId]/graph, repo/[repoId]/pr/[prNumber], settings)
                          + thin app/api/* route handlers
components/               shadcn/ui components
components/graph/         Cytoscape wrapper, layout switcher, sidebar, minimap
lib/neo4j/                driver singleton + typed repository functions per entity
lib/analysis/             languages/<lang>/ (grammar/queries/resolver), graph-builder.ts, ir.ts
lib/github/                Octokit wrapper, PAT handling, PR/diff/linked-issue fetching
lib/ai/                    OpenAI-compatible client wrapper, prompt templates,
                          per-component orchestration, truncation helpers
lib/jobs/                  BullMQ queue/job-type definitions shared by app and worker
lib/crypto/                credential encrypt/decrypt helpers (§11)
worker/                    worker process entrypoint(s)
types/                     shared TS types (IR schema, entity types, API DTOs)
docker/                    Dockerfile(s), docker-compose.yml, .env.example
docs/                      DESIGN.md and future ADRs
```

## 14. Local repo access under Docker

Docker Compose (decision #5) cannot see an arbitrary host path unless it is bind-mounted at startup, and the mount set is fixed when `docker compose up` runs — so "point the app at any repo already cloned anywhere" is not fully free inside a container.

**Resolution**: a single configured parent folder is bind-mounted read-only into the containers via `LOCAL_REPOS_PATH` (§12). Any repo already cloned under that folder is immediately usable as a "local" source; anything outside it must be moved or symlinked in, or ingested through the app-managed clone-by-URL path instead. This keeps Docker Compose as the only supported run mode rather than also maintaining a parallel `npm run dev` path, at the cost of requiring repos to live under one known folder to be used locally.

## 15. Phasing

**Status (2026-09-21):**
- **v1 — done and live-verified** against a real 525-file / 109-component repo, including the deviations noted throughout (local-git branches and ref comparison, dropdown pickers, ELK layout, node-click file list, retry/failure reasons, visual redesign).
- **v2 — done except:** AI provider settings ✓ · per-component intent check ✓ · advisory annotations with `filePath`/`lineRange` ✓ · overwrite-on-rerun ✓ · cost counter ✓ · Test-connection ✓ · **LLM-assisted domain-tier labeling ✗** · **Go/Java/Rust analyzers ✗** · the GitHub-backed review paths (PR target, GitHub `compareRefs`) are code-reviewed but **not live-tested** (needs a real PAT). The AI path has only been exercised against the mock server, never a real model, so prompt quality is unproven.
- **v3 — started:** `clusterByCommunity` (Louvain, `lib/analysis/louvain-cluster.ts`, smoke-tested) exists as a library function but is **not wired** to any route or UI · LLM module labeling ✗ · call-graph edges ✗ · large-diff summarisation ✗ · multi-repo switcher polish ✗.

*Original plan:*

- **v1** — Compose skeleton (app + neo4j + redis + worker, with ports/secrets handling from §11–§12); local-path (bind-mounted) and URL-clone ingestion through one interface; the repo list → repo detail (Branches/PRs/Graph tabs) → settings navigation from §4; auto-analyze-on-add plus the staleness-triggered auto-refresh from §10 (this part needs no AI — it governs static analysis alone); analyzers scoped to JS/TS and Python; folder-based clustering, including the mechanical two-tier module/file split from §6.1 (module and file tiers only — just a second folder-depth cutoff, no AI needed); Cytoscape graph UI with Force/Circle/Grid layouts, compound-node nesting, and sidebar; GitHub PAT settings, PR selection, and touched-node highlighting. **No AI yet.** Already a demoable, useful product on its own.
- **v2** — AI provider settings and the per-component intent-check flow; advisory annotations on the graph, including `Finding.filePath`/`lineRange` precision (§6.2, §9) and the overwrite-on-push behavior (§10); the running call/token cost counter (§10); LLM-assisted labeling of the domain tier (§6.1) now that an AI provider is configured, completing the three-tier hierarchy; BullMQ formalized for AI and analysis jobs; Go/Java/Rust analyzers added to prove out the language extension point.
- **v3** — Louvain-based re-cluster suggestions; LLM cluster labeling for the module tier too; call-graph edges (not just imports) for JS/TS/Python; diff-summarization refinement for oversized files; multi-repo switcher UX polish (the schema is repo-scoped from v1, so this phase is mostly UI/concurrency work, not a data-model change).

## 16. Known caveats and open follow-ups

- **Local-path bind mount** (§14): only repos under `LOCAL_REPOS_PATH` are usable as "local" sources in the Docker run mode. Repos elsewhere need to be moved or symlinked in, or cloned through the app-managed cache instead.
- **"Polyglot from day one"** (decision #11) means the IR and extension point exist from day one, not that every language is supported in v1 — v1 ships JS/TS and Python only, per §15.
- **Component descriptions live only in Neo4j** (decision #9): wiping the `neo4j_data` volume loses curated purposes. A future "export graph metadata to JSON" backup feature is worth considering but is out of scope for v1.
- **The domain tier (§6.1) is not mechanically reliable.** Unlike the module/file split, "Frontend vs. Backend vs. Infrastructure" often doesn't correspond to a clean top-level folder boundary (a Next.js app mixes both under `app/`, for instance). Until the AI-assisted domain labeling lands in v2, v1's graph effectively starts at the module tier with domain grouping either absent or requiring manual tagging — this should be communicated in the UI, not silently mislabeled.
- **Not live-tested:** the GitHub-backed review paths (`{prNumber}` reviews, GitHub `compareRefs`, the `FOR` edge to a real `PullRequest` node) and the `503 queue_unavailable` response were verified by code reading only. The AI review has only run against the mock server.
- **A PR review does not notice a new push.** Findings are keyed by `pr:<number>`, and the UI shows existing findings with a Re-run button rather than checking whether the PR's head SHA moved. Storing the head SHA on the review and prompting for a re-run when it changes is the natural follow-up.
- **Louvain re-clustering has no entry point** — the function exists but no route triggers it and no UI lets a user accept/reject a suggestion.
- **Review job records age out** (BullMQ retention). The API reports `completed` when findings exist without a job record, but the cost counter for a very old review is then gone.
- **Findings have no history** (§10): overwriting on every PR push means there's no record of what the AI flagged before a fix or force-push. Fine for an advisory tool, but worth revisiting if GraphReview is ever used for anything audit-adjacent.

## 17. Implementation lessons (things that bit us — check these first when something "just doesn't work")

- **A `"use server"` file may export only async functions.** Exporting an object/constant (e.g. an `initialState`) crashes the whole page at runtime. Keep types/constants in a sibling `state.ts`.
- **BullMQ custom job ids must not contain `:`** ("Custom Id cannot contain :") — every enqueue silently failed until ids used `-`. Hash anything that may contain `/` or other punctuation (ref names).
- **Neo4j Community deadlocks on parallel relationship writes.** Concurrent `MERGE`s of edges that share an endpoint (`IMPORTS`, `DEPENDS_ON`, `BELONGS_TO`) deadlock once a repo has a few hundred edges. Node upserts may run in parallel (16-way); **relationship-creating writes run serially** (`NEO4J_RELATIONSHIP_WRITE_CONCURRENCY = 1`).
- **A React effect must not list, in its dependency array, state that it sets.** It re-invokes itself, and the first invocation's cleanup cancels the in-flight fetch: the request succeeds but the UI stays "loading" forever. Use refs, functional updates, or a run-id ref (this bit the dropdown loaders and shaped the review polling hook).
- **React 19 server-action forms:** uncontrolled inputs are reset after an action (make fields controlled if the action shouldn't wipe them), and a submit button's `name`/`value` is *not* included in the `FormData` — bind the argument with `action.bind(null, value)` instead.
- **Never statically prerender a page that reads the database.** Docker builds the image with no Neo4j reachable; add `export const dynamic = "force-dynamic"`.
- **Fonts:** `next/font` CSS variables must be on `<html>` (where `font-sans` is applied), not `<body>`, or the whole `font-family` declaration is invalid and the app renders in Times New Roman.
- **Cytoscape:** `opacity` doesn't cover `underlay-*` (restate underlay opacity for dimmed nodes); compound (parent) nodes ignore `width`/`height` rules and size from their children; a very low `minZoom` is needed for the Circle layout to fit ~100+ nodes.
- **`lib/analysis`'s WASM grammars:** `tree-sitter-wasms@0.1.x` does not load under `web-tree-sitter@0.27`; `@vscode/tree-sitter-wasm` does.
- **Windows + Docker Desktop after an unclean shutdown** can fail to start with `removing stale socket ... userAnalyticsOtlpHttp.sock: The file cannot be accessed by the system`. The socket can't be deleted normally; renaming `%LOCALAPPDATA%\Docker\run` aside lets Docker recreate it.
- **Verify by running the app.** Static checks (`tsc`, `lint`, `build`) missed every one of the runtime bugs above. Live click-through against the Docker stack, with a real repo, found them.
