# GraphReview — Design Document

Status: **v1 done; v2 done (AI review + AI domain labeling); v3 partially done** (Go/Java/Kotlin/Rust analyzers and Next.js/Node workspace resolution shipped; Louvain re-clustering was built as an unwired library function, then removed) — synced with the code on 2026-09-22. Per-phase status is in §15; things that are built but not yet verified live are listed in §16; hard-won implementation gotchas are in §17. Sections below describe the design; where the build deliberately differs, a **"As built"** note says so.

## 1. Product concept

GraphReview is a locally-run tool for reviewing GitHub pull requests — and, as built, GitLab merge requests — in a different way than a flat diff. It statically analyzes a target codebase into an **ontological graph** of components (e.g. "Auth", "DB layer", "UI primitives") connected by their code dependencies. When you select a PR/MR — or diff any two refs — it highlights which components are touched by the changed files. An AI model then explains, per touched component, what the change does in plain English, and checks whether the change's actual content is consistent with the PR/MR's stated intent (its title/description and any linked issue), surfacing mismatches as advisory annotations directly on the graph.

The app is designed to run entirely on a developer's own machine, against repos they choose, with a fully swappable AI backend and no dependency on a specific GitHub App registration.

## 2. Locked decisions

These were decided deliberately and should not be relitigated without a documented reason — they shape every section below.

| # | Decision |
|---|---|
| 1 | **Graph construction** is static analysis, fully automatic. No manual curation is required to get an initial graph; nodes remain editable afterward. |
| 2 | **Edges** represent code dependencies (imports/calls) — objective, derived from static analysis, not asserted relationships. |
| 3 | **Intent validation** compares the diff against the PR's title/description (and linked issue, when resolvable) fetched from GitHub. **As built:** the same check runs for a GitLab merge request, fetched from the GitLab API instead. |
| 4 | **Repo access** supports a local clone already on disk, or an app-managed clone by URL, through one interface. Under Docker, local sources must live under one bind-mounted parent folder (`LOCAL_REPOS_PATH`) — see §14's caveat. |
| 5 | **Distribution** is Docker Compose as the primary, recommended way to run the app: one `docker compose up` starts the app and Neo4j together. |
| 6 | **Auth** is a single local admin user, no real authentication — at most a lightweight local session gate. |
| 7 | **GitHub auth** is a user-supplied Personal Access Token (PAT) entered in settings — no OAuth App or GitHub App registration. **As built:** GitLab support (gitlab.com or one self-hosted instance) mirrors this exactly — a separate user-supplied GitLab PAT, also entered in settings. |
| 8 | **AI provider** is a generic OpenAI-compatible chat-completions endpoint (base URL + API key + model name), fully user-configurable. No hardcoded provider, and no reliance on provider-specific structured-output/tool-calling features. |
| 9 | **Node purpose/description** lives only in Neo4j as a component property, edited in-app — never committed to the target repo. |
| 10 | **Intent-check UX** is advisory annotations only in the graph UI. It never blocks a review and never auto-posts to GitHub or GitLab. |
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
  - **As built:** layouts are Force (`fcose`), Circle, Grid and **Hierarchical (ELK, top-to-bottom layered)**. `elkjs` is large, so `cytoscape-elk` is dynamically imported only the first time Hierarchical is selected. The **minimap was removed** on user feedback (`cytoscape-navigator` uninstalled), and tooltips are a small custom overlay rather than `cytoscape-popper` (which needs a positioning engine that isn't a dependency — the package sat in `package.json`, fully unused, until a later cleanup pass removed it). Wheel zoom uses Cytoscape's default sensitivity — a custom `wheelSensitivity` made zoom feel slow. Domain (compound) nodes need `elk.hierarchyHandling: "INCLUDE_CHILDREN"` on the ELK layout — the default lays each compound node out in isolation, which routes every cross-domain edge (i.e. most of them) around the boxes instead of through them. Circle and Grid have no native compound-node concept at all, so each domain is laid out separately and tiled into its own screen region by hand (`runTiledByDomain` in `GraphCanvas.tsx`) rather than relying on the layout engine to avoid overlaps.

## 4. Screens & navigation

- **Repo list (landing page)** — every added repo, with name, source (`local` | `github` | `gitlab`), and a status indicator (`analyzing…` / `up to date as of <sha>` / `stale, refreshing…`, per §10). Adding a repo (local path under `LOCAL_REPOS_PATH`, a GitHub URL, or a GitLab URL) kicks off the first analysis automatically (§10).
- **Repo detail**, reached by clicking a repo, with three tabs:
  - **Branches** — branch list, plus the ad-hoc "compare two refs" tool from the original prototype's sidebar.
  - **Pull Requests** — PR (or GitLab merge request) list fetched from the linked host (state filter: open/closed/merged), so a reviewer can browse without loading the graph first.
  - **Graph** — the main visualization (§6). Opened directly with no filter, or pre-filtered when arrived at from a PR row or a ref comparison. The diff-selection control itself (pick a PR, or two refs) lives as a panel inside this tab, not a separate screen — matching the prototype's always-present sidebar, just scoped to this one tab instead of being global. **As built (2026-09-24), three modes:** **PR** — the 100 most recently updated PRs of every state (`GET …/pull-requests?state=all&limit=100`), filtered client-side by Open / Merged / Closed / All chips (remembered per browser), plus a number box for anything older; **Branches** — the two branch pickers; **Commits** — the default branch's newest 100 commits (`GET /api/repos/[repoId]/commits`, GitHub / GitLab / `git log`), pick any two and the *older* one becomes the base, whatever the click order (the diff is three-dot, so a reversed pair would be silently empty); per-commit "Only this" (compare with its first parent) and "Since last analysis" (`lastAnalyzedSha` → newest) shortcuts. Commit comparisons reuse the `{ baseRef, headRef }` target unchanged — every diff source already accepts shas. A successful check is mirrored into the URL (`?pr=` / `?base=&head=`), and two shas in the URL open the Commits mode. A historical diff (a merged/closed PR, or a commit range whose head isn't the analyzed commit) is mapped onto today's graph, and the panel says so: files moved or deleted since show as unmatched. Analyzing the graph *at* an old commit is not built.
- **Settings** — a single global (not per-repo) page for the GitHub PAT, GitLab PAT, and AI provider config, since all are instance-wide under decision #6's single-local-admin model. **As built:** AI provider config is a *list* of saved providers (base URL/key/model each), with a toggle marking one active — so a local model server and a hosted one can both stay configured and switching between them doesn't mean hunting down and re-entering a base URL/key each time (§7). The GitHub and GitLab PATs each stay a single instance-wide credential, not a list — one GitHub PAT and one GitLab PAT (gitlab.com or one self-hosted instance) at a time.

This differs from the prototype screenshot's single always-on graph+sidebar view: browsing branches/PRs is a first-class step before committing to loading a graph, which matters more once repos are polyglot and potentially large (§5).

**As built (deltas from the list above):**
- **Repo list** — the whole card is the click target and opens the **Graph** tab directly (a stretched link; the earlier Branches / Pull Requests / Graph quick-link buttons were removed — those tabs remain reachable from inside the repo). A repo whose analysis failed shows the **actual failure reason** (BullMQ `failedReason`) and a **Retry** button that force re-enqueues analysis. The Add-repo dialog lists the git repos found one level under `LOCAL_REPOS_PATH` as a dropdown (manual path entry still works).
- **Branches** — for `provider: "local"` repos the list comes from the local `.git` (`git for-each-ref`), so **no PAT is needed**; GitHub- or GitLab-linked repos use the matching host's API. **Pull Requests** stays GitHub-or-GitLab-only ("not linked" for local repos).
- **Graph tab** — uses the full page width (only this tab opts out of the repo shell's width cap). Clicking a node shows that component's **file list** and highlights its direct dependency neighbours (both directions), dimming the rest; clicking the background or the node again clears it. The diff panel's PR / base / head pickers are **dropdowns fed by real data** (open PRs, local or GitHub branches) with a free-text fallback when the data isn't available. Ref comparison works for local repos via local `git diff base...head`.
- **Review dock** — the AI review's progress, cost counter, verdict filters and findings live in a full-width dock under the canvas (see §9/§10 "As built").
- **Settings** — a **Test connection** button for the AI provider (a tiny chat call, run server-side, using the typed values or the saved key), and **Clear** actions for the saved GitHub PAT, GitLab PAT, and AI key. The page is dynamically rendered (never prerendered at build time).
- **Repo switcher** — the repo-detail breadcrumb's name segment (`app/repo-switcher.tsx`) is a filterable dropdown listing every repo, not just static text, so switching repos no longer means "back to the list, find the card, click it." Picking another repo jumps straight to its Graph tab, matching the repo-list card's own whole-card-opens-the-graph convention. Built without a new dependency (a plain anchored panel + outside-click/Escape-to-close), following the same convention as `DiffPanel`'s hand-rolled `<select>` and `GraphCanvas`'s custom tooltip — no Popover/Command primitive exists in `components/ui/` yet.

## 5. Polyglot static analysis strategy

The goal is an import/dependency graph across multiple languages without turning "add a language" into "install and shell out to a whole new toolchain" (e.g. a JVM for `jdeps`, a Go toolchain for `go list`, etc., all bloating the Docker image).

- Use **`web-tree-sitter`** with **WASM grammars**, not native bindings — this avoids native module rebuilds across platforms/architectures and keeps the Docker image portable.
- v1 language coverage: **JavaScript/TypeScript and Python** (see phasing in §15); the grammar set is designed to grow without touching the core pipeline.
- **As built — language coverage grew to eight**: JS/TS, Python, Go, Rust, Java and Kotlin, all registered by extension with zero changes to `graph-builder.ts`. Two languages needed the extension point to flex beyond "one grammar, one resolver":
  - **Kotlin has no usable tree-sitter grammar.** Every prebuilt `.wasm` tried either fails to load under `web-tree-sitter@0.27`, or loads but mis-parses common formatting (one-line class bodies, `companion object { }`) into `ERROR` nodes that swallow later declarations. `LanguageAnalyzer` gained an optional `analyzeSource` hook (generic, not Kotlin-specific) so a language can supply a **lexical analyzer** instead of a grammar: `lib/analysis/languages/jvm/tokenize.ts` is a hand-written, comment/string-aware tokenizer (nested block comments, Kotlin `${}` templates, raw strings) immune to the formatting that breaks the grammar.
  - **Java and Kotlin coupling was badly undercounted** by import-only resolution: same-package classes need no `import` statement at all, so real Java repos looked far sparser than their actual coupling (one real project showed 0 resolved edges). Fixed with a shared JVM resolution layer (`lib/analysis/languages/jvm/{tokenize,references,resolve}.ts`): a fully-qualified-name → file index built once per run from a new `FileAnalysis.declares?: string[]` IR field (see below), used to resolve explicit imports (including nested/static members and `a.b.*` wildcards) *and* to resolve same-package/wildcard-imported type references that carry no import at all — those are emitted as **speculative** candidates and silently dropped unless they resolve against the index, the same pattern Python already used for its own speculative imports. `package` is parsed via a tree-sitter query rather than inferred from the file's path, so Maven/Gradle/mixed source-set layouts need no configuration. Real-world result: 0 → 27 resolved edges on a project that previously showed none.
  - **JS/TS/Next.js resolution was hardened**: `tsconfig`/`jsconfig` `extends` chains (relative and array form, nearest-config-per-file, `paths` resolved relative to the config that declares them), npm/yarn/pnpm **workspace** resolution (`exports`/`main`/conventional subpaths, so a monorepo-internal package import is classed internal, not external), and `package.json` `"imports"` (`#foo/*`). A real bug was found and fixed along the way: the file walker unconditionally skipped any directory literally named `target` (assuming Cargo build output), which was silently dropping a real Next.js app's own `lib/target/` source folder — now conditional on a sibling `Cargo.toml` actually being present.
- Each language implements a small `LanguageAnalyzer`: a tree-sitter query file (`.scm`) that extracts import/require statements, plus a `resolveImportPath` function that turns a raw import specifier into a repo-relative file path where possible (straightforward for JS/TS/Python relative imports; best-effort elsewhere, falling back to an "external dependency" placeholder when unresolvable). Go and Java also support **`resolveImportPaths` (plural)**, since a Go package import or a Java wildcard import can resolve to several files at once, not one.
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
    /** As built: fully-qualified names this file declares (Java/Kotlin only) — see §5's JVM resolution note. */
    declares?: string[];
  }
  ```
- **Extension point**: `lib/analysis/languages/<lang>/{grammar.wasm, queries.scm, resolve.ts}`, implementing a shared `LanguageAnalyzer` interface and registered by file extension in a central registry. Adding language *N+1* means implementing the interface and shipping its grammar — no change to the graph builder.
- **Call-graph edges** (as opposed to file-level import edges) are deferred past v1 — reliable call/scope resolution is much harder and highly language-specific. v1 ships file-level import edges only, which already satisfies decision #2 ("edges = code dependencies").
- Unresolvable external packages (npm/PyPI/etc.) become optional grouped "external" nodes for context, rather than being expanded individually.

## 6. Component/node inference

Turning a raw file-level import graph into meaningful, named components:

- **v1 default: folder-based clustering.** A component is the set of files under a configurable top-N folder depth (e.g. everything under `src/auth/**` becomes "Auth"). This is deterministic, explainable, and matches the near-universal folder-per-module convention across languages and ecosystems. Results are stored as editable `Component` properties so users can merge, split, or rename after generation, per decision #9.
- **Community detection (Louvain, via `graphology` + `graphology-communities-louvain`)** — *as built: the unwired library function and both packages were removed on 2026-09-23 to trim rarely used dependencies; this bullet is kept as the design rationale should it come back.* It was offered later as an opt-in "suggest a different clustering" action, computed on the file-level import graph — useful for flatter `src/` layouts where folders don't reflect logical boundaries. It is not the default path, since Louvain output can be non-deterministic and non-intuitive to a human; users explicitly accept or reject the suggestion.
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

**As built — the domain tier is implemented, on demand.** A **"Generate labels"** control in the graph toolbar (`components/graph/LabelsControl.tsx`) runs a two-phase AI pass (`lib/ai/label.ts`, `lib/jobs/label.ts`, its own BullMQ `label` queue and `/api/repos/[repoId]/label` route):
1. **Domain grouping** — one call sends every module's name, file count, up to 3 sample file paths and up to 5 dependency names (plus an optional short README excerpt, per §6's "never full file contents") and asks for ≤8 domains, each a name + description + the module ids it contains.
2. **Module descriptions** — one sentence per module, in batches, written directly onto `Component.description`.

Deliberately **not automatic**, unlike the review flow in §9/§10: labeling isn't triggered by an explicit user action the way selecting a PR is, and re-analysis happens constantly (§10's staleness sweep), so an automatic pass would spend tokens nobody asked for. It only runs on a button press. A re-label **replaces** the previous domain tier rather than accumulating boxes (the old `createdBy: "auto"` domains are deleted first), and by default **never overwrites an existing module description** — only a `force: true` request does, since decision #9 makes descriptions user-editable data and an automatic pass shouldn't be the thing that establishes the habit of clobbering curated text. (There is no description editor in the UI yet, so `force` is API-only for now — see §16.) Re-analysis (§10, which runs far more often than labeling) is explicitly scoped to prune only the module tier, never the domain tier or a domain left with at least one child — a domain that ends up with zero children after a prune is removed, since an empty box groups nothing.

Rendering-wise, this maps directly onto Cytoscape's compound-node model (`cytoscape-expand-collapse`, already chosen in §3): tiers are nested/collapsible compound nodes rather than three separate graphs, so a reviewer can start at the domain view and expand down to modules and files in place.

### 6.2 Worked example: diff granularity

Take a hypothetical bug where `square.ts`'s function doubles its input instead of squaring it, inside a "Math" module component. The graph highlights the touched node at the tier currently in view — most often "Math" at the module tier, shown as touched with one file changed underneath it. The graph itself does not, by default, spell out *what* is wrong at that zoomed-out level.

That detail comes from the AI finding, not the graph structure: the per-component LLM call (§9) already receives the actual diff hunk for `square.ts`, so a resulting mismatch ("this doubles instead of squares, but the PR says it implements a square function") lands in the `Finding`'s rationale text, naming the file and function explicitly — even though the `Finding` node is attached `ABOUT` the Math component, not a specific file. To make that precision navigable rather than just readable prose, `Finding` gets two additional properties (§7): `filePath` and `lineRange`, populated from the diff hunk the finding was generated from. This costs nothing extra to compute (the LLM call is already scoped to that file's hunk) and lets the UI jump straight to the offending file/lines from a finding, without requiring the graph visualization itself to render at file granularity by default.

### 6.3 Feature merges and splits (decided and built 2026-09-24)

**Problem.** Folder modules follow the repo's *layers*, not its *features*. In a Next.js repo the map feature is `app/map` (pages), `components/map` (UI) and `app/api/map` (API route) — three nodes, and at the default module depth of 2 the API route isn't even its own node: it sits inside one `app/api` module with every other route. The AI domain tier (§6.1) can put the first two in the same box, but they stay two unrelated nodes, and a layer-style prompt tends to group by Frontend/Backend anyway.

**As built** — all five build steps below are in: `lib/jobs/ownership.ts` (who owns which file), `lib/jobs/merge-heuristics.ts` (suggestions), `lib/jobs/module-tier.ts` (the one writer of the module tier, used by analysis and by regroup), `lib/jobs/merges.ts` (accept/reject/unmerge/rename), `lib/jobs/merge-naming.ts` + `lib/ai/merge-name.ts` (AI naming), `lib/neo4j/merge.ts`, the routes under `app/api/repos/[repoId]/merges/`, and in the Graph tab `useMerges.ts`, `MergeSuggestions.tsx` and a merged-module section in `ComponentFilesPanel.tsx`. The pure parts are covered by `npx tsx lib/jobs/smoke-test-merges.ts`. Where the build differs from the plan below, an **As built** note says so. Live-tested on a real 529-file Next.js repo (MultiTool): 26 suggestions, all plausible, including the `app/map` + `components/map` case; accept → AI naming against a real model → unmerge → reopen all worked.

**What a merge is.** A merge turns several folders into **one module node** (e.g. "Map"). A split does the opposite: it moves individual files of one folder into different feature nodes (`lib/ai/review.ts` → Review, `lib/ai/label.ts` → Labeling). Nothing moves on disk; only the module tier changes. This is a real change of module boundaries — deliberately, since the goal is one node per feature, not a box around several.

#### Decisions

| Question | Decision |
|---|---|
| How merges happen | **Suggested, the user accepts or rejects.** The *apply* step is separate from what produces suggestions, so automatic mode (auto-accept) or manual mode (the user proposes a merge) can be added later without redesign. |
| Re-analysis | **Merged nodes win.** Folder modules are built as usual, then files claimed by a merge/split are taken out of them. |
| What a merged node remembers | **Folders** (a new file in `components/map/` joins Map automatically). Splits remember **files**. |
| New file in a split folder | Goes to the **leftover** folder module (whatever wasn't split out) and gets a "move to …" suggestion. |
| Folders serving several features | **Split by file.** |
| Findings | **Move with their file** to whichever node now owns it. |
| Where suggestions come from | **Free heuristics** (shared feature names + imports) choose the members; the **AI only names and describes** the group, with rich context. (Letting the AI choose the groups is parked in `docs/ideas.md`.) |
| When suggestions are computed | **After every analysis**, heuristics only, shown as a badge. The AI runs only when a suggestion is accepted. |
| Undo | An **Unmerge** button on the merged node restores the folder modules. |
| Rejected suggestions | Remembered **until the suggestion's score rises clearly** (≥ 1.5× the score when it was rejected). |
| "Group by" tier above modules | Stays. A merged node **inherits** the domain most of its files were in; the AI Layer grouping shows a "regroup?" hint (a future Louvain grouping would simply recompute). |
| A merged folder disappears | **Dropped without a warning.** If it looks renamed (see below), suggest adding the new folder. |

#### Data model

Reuses `(:Component)`'s existing `pathPatterns` and `createdBy` — no new label for the node itself:

- **Merged/split module**: `tier: "module"`, `createdBy: "user"` (a user accepted it, so re-analysis never prunes or renames it), new property **`origin: "merge"`**, id `<repoId>:feature:<uuid>` (a random id so renaming never changes it). `pathPatterns` holds folder patterns (`app/map/**`, `app/api/map/**`) and/or exact file paths (`lib/ai/review.ts`). New property **`absorbedModuleIds`**: the folder module ids it replaced, used for findings without a `filePath` and for Unmerge.
- **Folder modules** are unchanged apart from `origin: "folder"` now being written: `createdBy: "auto"`, id `<repoId>:module:<name>`.
- **As built, two more properties on merged modules:** `absorbedDescriptions` (JSON, absorbed module id → description — pruning deletes the absorbed folder modules and their curated descriptions with them, so Unmerge writes these back onto the folder modules it restores) and `lostFolders` (JSON, the folders that vanished with the file names they held — the input to rename detection).
- **`(:MergeSuggestion)`** (new), repo-scoped: `id`, `repoId`, `key` (the sorted member patterns, so the same suggestion is recognised across runs), `kind` (`merge` | `move-file` | `extend` — as built there is no separate `split` kind: a split is a `move-file` into an existing feature), `members` (patterns), `targetComponentId` (for `move-file`/`extend`), `score` (0–1), `reasons` (short strings shown in the UI, e.g. "shared name 'map'", "14 of 16 imports stay inside"), `status` (`open` | `rejected`), `scoreAtRejection`, `updatedAt`. Accepted suggestions are deleted; the merged node is their record.

**Which node owns a file.** Most specific wins (`resolveOwnership` in `lib/jobs/ownership.ts`, called by `writeModuleTier` in `lib/jobs/module-tier.ts` before any module-tier write):
1. an exact file path in a merged node's `pathPatterns`;
2. otherwise the **longest** folder pattern of any merged node (`app/api/map/**` beats nothing; it carves those files out of the `app/api` folder module);
3. otherwise the folder module, as today.

`liveComponentIds` is then computed from the resulting ownership, so a folder module left with no files is pruned exactly like any removed folder today, and a merged node with no matching files left is deleted (its patterns all point at deleted folders). A pattern that matches nothing is dropped from `pathPatterns` on that run. `DEPENDS_ON` aggregation already works from `componentIdByFile`, so edges between features come for free.

**Findings.** After ownership is written: every `Finding` of the repo with a `filePath` gets `componentId` (and its `ABOUT` edge) set to the node that now owns that file. A finding without a `filePath` whose component no longer exists follows `absorbedModuleIds` to the merged node. One set-based Cypher statement for each case, done serially (the §17 deadlock rule applies).

**Domain tier.** A new merged node gets `CHILD_OF` the domain that held most of its files beforehand (by file count). If any merge happened, set `Repo.domainsStale = true`; the Labels control shows "regroup?" until "Generate labels" runs again.

#### Applying a change

Accept and Unmerge only write the merged node (or delete it) and then apply the ownership rules above through the same writer re-analysis uses. One code path owns module membership, so there is no second implementation to drift.

**As built — a synchronous regroup, not an analysis job.** `regroupRepo` rebuilds the folder clusters from the files and import edges already in Neo4j (no checkout, no parsing) and calls `writeModuleTier`, inside the request. It takes well under a second on a 529-file repo because the module-tier writes are batched `UNWIND`s that only touch files whose owner changed. An enqueued analysis would also have been skipped whenever one was already running (`enqueueAnalysis` is idempotent per repo), silently dropping the change.

- **Accept:** create the merged node, named from the feature key ("Map"), regroup. The Graph tab then calls `name-with-ai` if an AI provider is configured (as built: a route call from the UI rather than a job on the `label` queue — it is one model call, and the node is already on screen under its heuristic name while it runs). No AI configured, or an unusable reply → the heuristic name stays.
- **Accept all** (added after the first build): applies every open suggestion strongest first with **one** regroup at the end (`acceptAllMergeSuggestions`). A suggestion whose members overlap one already applied in the same pass is skipped; the regroup recomputes it, usually as an "Add to …". The Graph tab then names the new modules with AI one at a time (sequential, so a single local model server isn't flooded), showing `done/total`. The button needs two clicks and disarms itself after 4 s. On the 529-file MultiTool repo: 26 suggestions → 26 merged modules, 110 → 69 nodes, 1.4 s.
- **Unmerge:** delete the merged node, regroup, write the absorbed descriptions back, and mark the suggestion it came from as rejected so it doesn't reappear straight away (it can be reopened). Findings follow their files back.

#### Heuristics (free, deterministic, run at the end of every analysis)

1. **Feature key.** For every folder, strip layer segments (`app`, `src`, `components`, `lib`, `api`, `pages`, `hooks`, `services`, `routes`, `server`, `client`, `features`, `modules`; as built also `actions`, `contexts`, `providers`, `types`, `workers` and a few more — `LAYER_SEGMENTS` in `merge-heuristics.ts`) and skip generic names (`utils`, `common`, `types`, …), Next.js route groups `(group)` and dynamic segments `[id]`; normalise case, `-`/`_` and plurals. What's left is the key: `app/map`, `components/map` and `app/api/map` all become `map`. Folders deeper than the module depth are included, which is what lets `app/api/map` be carved out of `app/api`.
2. **Merge candidates.** Folders that share a key (none nested in another) make one candidate. Separately, **import-only** candidates: folder B imported *mostly* by folder A (≥ 70 % of B's incoming imports, at least 3 imports), e.g. `components/map` only used by `app/map`. As built, an import-only pair is skipped when the folders are nested or A is already in a shared-name suggestion, and a module *shallower* than the module depth (the root `app/` files) is listed file by file — `app/**` would claim the whole app tree.
3. **Shared code is excluded.** A folder imported by many other modules (≥ 30 % of them) is shared foundation (`lib/utils`, db clients) and is never pulled into one feature.
4. **Score** (0–1) = 0.5 × name match (1 if the keys match, else 0) + 0.5 × import cohesion (imports that stay inside the group ÷ all imports touching it). Import-only candidates use their import share in place of the name match. Only suggestions with a score ≥ 0.5 are shown.
5. **Splits.** For each file of a folder module next to existing merged features, find the feature it imports from / is imported by most. If ≥ 2 files of one folder clearly belong to different features (≥ 60 % of their imports going to that feature), suggest a split. Files with no clear home stay in the leftover folder module — the same place new files land, and the same `move-file` suggestion picks them up later.
6. **Renames.** When a merged node loses a folder and a new folder appears whose file names match ≥ 70 % of the lost folder's, suggest `extend` (add the new folder to the merged node).

A rejected suggestion with the same `key` reappears only when its score is ≥ 1.5× `scoreAtRejection`; a suggestion whose members change is a different suggestion.

#### AI naming (on accept only)

`nameMergeGroup` in `lib/ai/merge-name.ts` (as built, its own file rather than `label.ts`), same plain-JSON-in-a-fence contract and budget helpers as the domain labeling. Context, deliberately generous for now (trimming it is parked in `docs/ideas.md`): member folder names and file paths; exported declarations of each file (already extracted for review context); the imports between the members, with counts; the README excerpt the domain labeler uses; route/URL hints (`app/map/page.tsx` serves `/map`, `app/api/map/route.ts` serves `/api/map`). Output: `{name, description}`, where the description says what the feature *enables*, not which layer it is.

#### UI

- **Graph toolbar:** a "Merge suggestions N" button next to the Labels control, and a "Groups out of date — regroup" chip when `domainsStale` (it re-runs labeling). Merged modules are drawn as rounded hexagons.
- **Suggestions panel:** each suggestion shows its members, reasons and score. Hovering it highlights the members on the graph (a preview before anything changes). Accept / Reject; a "Rejected" section allows un-rejecting.
- **Merged node side panel:** Rename, Unmerge, and the member patterns (read-only at first; editing members is a later addition).

#### API

As built (wire types in `components/graph/merge-types.ts`):

- `GET /api/repos/[repoId]/merges` → `{suggestions, merged, domainsStale, aiConfigured}`; each suggestion carries `memberComponentIds` for the canvas preview.
- `POST /api/repos/[repoId]/merges` with `{action: "accept-all"}` → `{accepted, skipped, createdComponentIds}`.
- `POST /api/repos/[repoId]/merges/suggestions/[suggestionId]` with `{action: "accept" | "reject" | "reopen"}`.
- `POST /api/repos/[repoId]/merges/modules/[componentId]` with `{action: "unmerge"}`, `{action: "rename", name, description?}` or `{action: "name-with-ai"}`.

#### Build order (all done)

1. Data model plus the ownership rules in `persistAnalysis`, findings following their files, domain inheritance, and the Accept/Unmerge API (testable by creating suggestions by hand).
2. Merge heuristics (feature key, import-only candidates, scoring, rejection memory) plus the badge and panel.
3. AI naming on accept.
4. Splits and `move-file` suggestions.
5. Rename detection (`extend`).

### 6.4 The PR map — a second view of the same diff (built 2026-09-24)

**Problem.** The module graph answers "where in the whole app does this change land?", but on a real repo it's 50–150 nodes with every import drawn. It doesn't answer "what is this change, as a picture?" The inspiration is the per-PR diagram in Steve Sanderson's NDC talk: four or five cards, each naming a *role in the change* ("FFI Lifecycle Coverage", "ffi-rs Runtime Host", "ffi-rs Dependency"), each listing its changed files with a status badge, joined by a few edges with verbs ("covers", "starts", "uses").

**What it is.** Once a diff is selected, the Graph tab's canvas slot has two views behind a **Repo | PR** switch:
- **Repo** — the existing Cytoscape graph, unchanged (touched/added highlighting still on).
- **PR** — the PR map: only the changed files, grouped into cards, with labelled edges, laid out left-to-right.

Both stay mounted (stacked in one grid cell, the inactive one transparent and `inert`, so Cytoscape keeps its size, layout and zoom; not `visibility: hidden`, which React Flow's inline `visibility: visible` on nodes pokes through). Selection is shared: clicking a card selects its component and opens the usual side panel; the panel and each card have **Show in repo** (switches view and pans to the component and its neighbours, resolving a collapsed domain to its box), and the panel has **Show in PR** when the selected component is on the map. File chips open the existing diff modal. The review dock stays under whichever view is showing, and findings mark cards (worst verdict + count) and chips (a dot). The last view chosen is remembered per browser; `pr` is the default.

**Level of detail.** About 2–8 cards per PR, 1–4 files each, every changed file on exactly one card; a name of 2–4 words, a one-line description; edges only where the code justifies one. Up to 6 faded **unchanged neighbour** cards (untouched modules the changed *code* imports or is imported by) give context, and are dropped once the map has 14 cards of its own. Above 12 edges, labels show only on the selected card's edges; stroke width carries the weight.

#### Two groupings over one set of links

`lib/jobs/pr-map.ts` does the work, in three pure steps over data loaded once (`loadPrMapInput`: the owning component of each changed file, and every `IMPORTS` edge into or out of a changed file, one hop):

1. **Classify** each changed file by path: `code`, `test` (`*.test.*`, `*_test.go`, `__tests__/`, `src/test/` …), `dependency` (manifests and lockfiles), `config` (CI, Docker, `*.config.*`, dotfiles, YAML/TOML), `docs` (prose).
2. **Collect file-level links** — the only source of edges: `import` (an `IMPORTS` edge touching a changed file; the far end is a changed file or, failing that, its owning component), `covers` (a changed test whose own module has changed code, when it doesn't already import changed code), and `uses` (a changed code line importing a package whose manifest entry this diff changed — package names are read from `package.json`/`composer.json`/`go.mod`/`Cargo.toml`/`requirements*.txt`/`pyproject.toml`/`Gemfile` diff lines; lockfiles contribute none).
3. **Assemble** cards and edges for *a grouping* (`assemblePrMap`): links are aggregated over whichever card holds each end, verbs come from the roles (`covers` from a test card, `uses` into a dependency card, otherwise `imports`), and context cards are picked by link weight.

- **Heuristic grouping** (`heuristicPrMapGroups`, no AI): one card per owning component for code, one per owning component for tests ("X tests"), one per top folder for files the analysis doesn't know yet, and one each for Dependencies ("Changes ffi-rs"), Build & config, and Documentation. Works for pasted paths too (no statuses or counts then).
- **AI grouping** (`groupPrMap` in `lib/ai/pr-map.ts`): one call at the **end of every review job**, after the per-component calls, so their finding summaries can inform the names. Input: the stated intent, every changed file with its status, counts, heuristic card and a few changed declaration lines (`patchHighlights`), the heuristic cards, context cards and links by name, and the review's finding summaries. Output: groups `{name, description, files[]}` and edge verbs `{from, to, label}`. The model regroups and names; it **never decides which edges exist** — `applyPrMapGrouping` re-runs step 3 with its grouping, so a verb is only applied to an edge the links already justify, and any file it didn't place keeps its heuristic card. Normalisation drops unknown paths, files placed twice, duplicate names, and labels that aren't a short lower-case verb phrase. Its tokens count toward the review's cost counter; "PR map" shows in the dock's running list while it runs. It never fails a review.

#### Storage and freshness

`(:PrMap)` (one per repo + review target, `-[:FOR]->` its `PullRequest` when there is one) stores only the AI **grouping** — names, descriptions, file lists, verbs, the model — never the assembled map, so cards, edges, context and +/- counts are always re-derived from the current diff and graph. It also stores `filesKey`, the sorted changed paths it grouped. The endpoint applies it only while the target's changed files are exactly that set; otherwise it serves the heuristic map with `aiOutdated: true` ("re-run the review to refresh it"). A re-run replaces it.

#### API

`POST /api/repos/[repoId]/pr-map` with the diff-impact body (`{prNumber}` | `{baseRef, headRef}` | `{filePaths}`) → `{nodes, edges, source: "heuristic" | "ai", model?, aiOutdated?}` (wire types in `components/graph/pr-map-types.ts`). Read-only. The changed files (status, counts, patches) come from `listTargetChangedFiles` (`lib/jobs/changed-files.ts`), cached for 30 s, since the tab asks again on every review state change. 400 for a fixable access problem (no PAT, PR on a local repo).

#### Rendering

`PrMapCanvas.tsx` uses **React Flow** (`@xyflow/react`) with **elkjs** (layered, left-to-right), not Cytoscape: a card holds clickable file chips, which is HTML, and the map is small enough that DOM nodes cost nothing. Layout is two-pass — every card is rendered offscreen at the fixed card width and measured, ELK places the measured boxes, React Flow draws them — and nodes aren't draggable. elkjs is loaded on first layout. Colours come from the app's CSS tokens (React Flow's un-suffixed `--xy-*` variables); edge colours are literal because React Flow writes marker colours into SVG attributes.

Covered by `npx tsx lib/jobs/smoke-test-pr-map.ts` (builder, normalisation, and the real client against the mock server, which answers `TASK: pr-map` by renaming the heuristic cards).

### 6.5 The app map — the whole codebase as cards, at three levels (built 2026-09-26)

**Problem.** The PR map (§6.4) turned out to be the most readable picture in the app, but it only exists for a diff. The Repo graph shows the whole codebase, yet at 50–150 module nodes with every import drawn it says *where* code is, not *what the app is made of* or *how the parts work together*.

**What it is.** A third view behind the Graph tab's switch, always available: **Repo | App map | PR** (PR only while a diff is selected). It draws the whole analyzed codebase on the PR map's canvas (cards of files, labelled edges, left-to-right ELK layout) at one of three **levels of detail**:
- **Architecture** — one card per layer from a fixed palette: UI, Server & API, Logic, Data & storage, Integrations, Infrastructure, Tests & tooling (`APP_LAYERS` in `components/graph/app-map-types.ts`). Chips are the modules contributing files to the layer.
- **Features** — one card per capability, across every folder that implements it: "GitLab" = `lib/gitlab/` + `lib/jobs/gitlab-access.ts`. Chips are files (key files first); a bar shows which layers the feature spans.
- **Modules** — one card per analyzed module (the Repo graph's nodes), coloured by dominant layer.

Every card is coloured by layer (a stripe; per-file dots on multi-layer cards). Selecting a card or an arrow opens the **explainer** (`AppMapPanel`, right column): the AI explanation ("How it works"), "Start here" key files with their role, the layers it spans, every connection in and out with its verb and one-sentence explanation, its modules and all its files. A connection shows the file-level imports behind it. Modules and files open the usual component panel underneath. With a diff selected, cards and chips holding changed files are marked ("3 changed"). A search box dims cards that match neither by name nor by file path. Busy maps draw only their strongest connections (about 1.5 per card, at least 16) plus every connection of the selected card; the layout is computed from the strong set, so clicking never reshuffles cards. A footer toggle shows all.

#### Heuristic first, AI on demand

The map is free and instant without a model (`lib/jobs/app-map.ts`, pure apart from `loadAppMapInput`, which reads every file, its owner and every `IMPORTS` edge):
- **Layers** — `classifyLayer(path)`: tests → infrastructure (CI, Docker, `worker/`, `*-queue`) → server (`app/**/route.ts`, `actions.ts`, `api/`, `routes/` …) → UI by extension (`.tsx/.vue/…`) → data (`db`, `neo4j`, `prisma`, `schema`, `migrations` … anywhere in the path) → integrations (`github`, `gitlab`, `ai`, `stripe`, `webhook`, `adapters` …) → UI by folder or `useX` hooks → logic.
- **Features** — each file gets one key: its stem's feature-word compound shared with another file (`pr-map-types`, `PrMapCanvas` → "prmap"), else its most widely shared stem word (`gitlab-access` → "gitlab", `ReviewPanel` → "review"; a word that is only ever one file name repeated across folders, `resolve.ts` × 6, is a convention and skipped), else the deepest folder whose name or a word of it appears elsewhere (`…/review/route.ts` → "review", `diff-impact/` → "diff"), else the outermost feature-like folder, else the owning module. One-file features fold into their module's usual feature, and while there are more than 16, the least feature-like group (module/folder fallbacks first, groups spanning several top-level folders last) folds into the feature its files import from or are imported by most.
- **Modules** — the analysis's own.
- **Edges** — always aggregated from file-level imports between cards (`assembleAppMap`), with up to three sample imports each. Heuristic key files are the files most imported from other cards.

**"Explain with AI"** (toolbar button, per level, never automatic — same reasoning as labeling, §9.2) runs an `app-map` BullMQ job (`lib/jobs/app-map-queue.ts`, `lib/jobs/app-map-job.ts`, `attempts: 1`, one run per repo, cooperative cancel like the label queue):
1. **grouping** (`lib/ai/app-map.ts`) — *features*: one call over the whole file tree (per folder: owning module and description, file names, top-level declaration names read from the checkout) returns features whose members are folder prefixes or file paths, the longest match winning, so `lib/jobs/` can be "Background Jobs" while `lib/jobs/gitlab-access.ts` is "GitLab". *Architecture*: the same tree with each file's heuristic layer in brackets; the model returns a description per layer and **only the corrections** (`moves`), so the path heuristic stays the deterministic base. *Modules*: nothing to group.
2. **explaining** — the cards are assembled exactly as the read path does, then explained a few per call (1 layer, 2 features or 4 modules): per card its files with declarations, modules, layers and its outgoing/incoming connections with sample imports; back come a description, a 3–5 sentence explanation, up to 5 key files with roles, and a verb + sentence per outgoing connection. Normalisation drops unknown paths, members, cards and connections — the model can name and explain an edge, never invent one.
3. **saving** — one `(:AppMap)` node per repo and level.

Grouping calls get a 16k-token budget (`APP_MAP_TOKEN_BUDGET`), fitted by dropping declarations and files per folder. An unusable feature grouping falls back to explaining the heuristic features; a failed explain batch is logged and skipped.

#### Storage and freshness

`(:AppMap)` stores only naming, membership rules and prose; cards, files, edges and counts are re-derived from the current graph on every read, like `(:PrMap)`. A file added after a features run lands on its card when it sits under a member folder; otherwise the heuristic places it and the view says how many files aren't in the AI grouping. A stored architecture run also colours every other level (a feature's layer bar follows the AI's corrections).

#### API

- `GET /api/repos/[repoId]/app-map?level=architecture|features|modules` → `{level, nodes, edges, source: "heuristic"|"ai", model?, generatedAt?, newFiles?, totalFiles, fileOwners}` (wire types in `components/graph/app-map-types.ts`). Read-only, no model calls.
- `POST /api/repos/[repoId]/app-map/job {level}` → `{jobId, enqueued}` (400 `ai_not_configured`, 503 `queue_unavailable`); `GET` → `{state, level?, progress?: {level, phase: grouping|explaining|saving, done, total, calls, promptTokens, completionTokens}, error?, finishedAt?, aiConfigured, generated: {<level>: {generatedAt, model}}}` (`?logs=1` adds the job log); `DELETE` cancels.

#### Rendering

`CardFlow.tsx` is the PR map's canvas extracted for both maps: React Flow + elkjs, cards measured offscreen then laid out, not draggable, refit when the layout changes **or the pane is resized** (so opening the explainer or resizing the window never leaves the map small in a corner). `PrMapCanvas` renders through it unchanged. The App map view mounts the first time it is opened and stays mounted, like the other two views.

Covered by `npx tsx lib/jobs/smoke-test-app-map.ts` (layer classification, the GitLab/Review cross-folder features, member matching, assembly at all three levels, stored runs applied, normalisation, and all three calls against the mock server, which answers `TASK: app-map-features` / `-layers` / `-explain`). **Not yet run live** against Neo4j/Redis or a real model — verified with the real analyzer's output for this repo served to the UI through a stubbed fetch.

### 6.6 The PR prerequisite checklist (built 2026-09-26)

A card under the graph, left of the AI review (1/3 : 2/3 of the middle column), listing checks a change should meet before it's approved. **A failing check is only a badge** — GraphReview gates nothing and posts nothing.

**Where items are defined: GraphReview's own settings, never the reviewed repo.** Global defaults (Settings → PR checklist) apply to every repo; each repo can switch a default off or add items of its own (the gear on the card). Stored as `(:ChecklistItem {scope: "global" | <repoId>})` plus `Repo.disabledChecklistItemIds`. Six defaults are seeded once (`ensureDefaultChecklist`, guarded by `(:ChecklistMeta {id:"global"})`) — edits and deletions after that stick.

| kind | passes when | notes |
|---|---|---|
| `ci` | the head commit's CI succeeded | GitHub check runs + commit statuses, GitLab's latest pipeline + its jobs (`getCommitCiStatus` in both clients). Local repos: *doesn't apply*. Polled every 30 s while pending. GraphReview never runs code itself. |
| `description` | the PR description has ≥ N characters | ref comparisons: *doesn't apply* |
| `linked-issue` | the PR closes/links an issue | ref comparisons: *doesn't apply* |
| `max-files` / `max-lines` | ≤ N files / changed lines | |
| `protected-paths` | none of the patterns is touched | `dir/**`, `*.ext`, `prefix*`, exact paths; touching one fails as "needs extra care" |
| `ai` | the model answers the question `pass` | see below |

**Evaluation** (`lib/jobs/checklist.ts`) reads the target through the review's own `resolveTarget` (exported from `review.ts`, wrapped in a 60 s per-target cache in `lib/jobs/pr-context.ts`), so the checklist, the chat and the review all see a target the same way. Deterministic items are computed on every read and never stored.

**AI items** are answered **about the whole PR in one model call** (`lib/ai/checklist.ts`, marker `TASK: pr-checklist`): intent, changed-file list, as much diff as fits a 14k-token budget, and the review's finding summaries. Answers are `pass | fail | unknown` with a rationale, stored as `(:ChecklistAnswer)` per (repo, target, item) and stamped with the head sha — a push turns them back into *pending* rather than leaving them wrong. The card runs them **automatically once per head commit, after the AI review finishes** (so they can use its findings and don't compete with it); targets that don't auto-review (a merged PR) wait for the "Run AI checks" button.

API: `GET /api/repos/[repoId]/checklist?prNumber=|baseRef=&headRef=[&fresh=1]`, `POST …/checklist {target, action:"run-ai"}`, `POST …/checklist/overrides {itemId, disabled}`, `GET|POST /api/checklist/items[?repoId=]`, `PATCH|DELETE /api/checklist/items/[itemId]`. Wire types in `components/graph/checklist-types.ts`.

Live-tested on MultiTool (a local repo, ref comparison, real Gemini model): CI/description/linked-issue correctly *doesn't apply*, line count exact, both AI questions answered with concrete rationales (~14k prompt tokens).

**Known limitation:** AI questions are asked for ref comparisons too, where a question about the description can only fail or be unknown. A per-item "PRs only" switch would fix that.

### 6.7 The PR chat (built 2026-09-26)

The last column of the Graph tab, flush against the right edge and sticky under the app's nav (its height follows its real top so the input is always on screen; width resizable). One conversation **per review target**, stored as `(:ChatMessage)` nodes (`lib/neo4j/chat.ts`) with the head sha each message was about — the column marks where the change moved on since. Chats are for the local single user; there is no sharing.

**What it's for**, as decided: explain a change, trace its impact ("what else uses this?"), challenge a finding. So the model gets **read-only lookups** (`lib/jobs/pr-chat.ts`), never shell access or writes:

| tool | what it returns |
|---|---|
| `list_changed_files` | the diff's files with +/- and their component |
| `get_diff` | one changed file's patch |
| `read_file` | up to 250 lines of a file at the PR's head (or base) — `git show` for local repos, the contents API for GitHub/GitLab, the default-branch checkout as a labelled fallback |
| `search_code` | fixed-string search with each hit's component — `git grep` at the head commit for local repos, the default-branch checkout otherwise (labelled) |
| `get_component` | a component's description, files, dependencies and dependents |
| `get_findings` | the AI review's findings, optionally for one component |

**The agent loop** (`lib/ai/pr-chat.ts`, marker `TASK: pr-chat`) uses the same plain-prompted JSON as every other AI call — each reply is one fenced block, `{"tool", "args"}` or `{"answer"}` — rather than provider-native tool calling: one code path for hosted APIs and local model servers alike. At most 8 lookups per question, then it must answer. The PR summary (intent, files, review verdicts) is in the system message, which budget trimming never drops; older turns go first (24k-token budget). Argument parsing is deliberately forgiving (`args`/`arguments`/`parameters`/`input`, a JSON string, or keys next to `"tool"`) — the first live test with Gemini Flash Lite sent every call's arguments outside `args`, and each lookup silently came back empty until this was fixed.

**Tied to the graph both ways:** the component selected in the graph is sent as the question's focus (a dismissable "About …" chip); components an answer's lookups touched become chips that select them in the graph, and changed-file paths in an answer open that file's diff.

`POST /api/repos/[repoId]/chat {target, message, focusComponentId?}` streams NDJSON — the stored question, one line per lookup as it happens, then the stored answer (a failed turn is stored as an error message) — so the column shows "read the diff of …" while a slow model works. `GET …/chat?target` returns the thread plus the target's current head; `DELETE …/chat?target` clears it. Wire types in `components/graph/chat-types.ts`.

Live-tested on MultiTool with a real model: "What does the commute feature do, and which other parts of the app use the new commute API route?" → `get_diff app/api/commute/route.ts`, `search_code "/api/commute"` → a grounded answer naming `components/map/commute_dialog.tsx` (~4.4k tokens).

**Not built:** answers are not streamed token by token (lookups are; the answer arrives whole); no provider-native tool calling.

## 7. Neo4j schema

Single Neo4j database; every node except `Settings` is `repoId`-scoped so multiple repos coexist without needing per-repo databases (revisit only if strict isolation becomes necessary).

**Node labels and key properties:**

- `(:Repo)` — `id`, `name`, `url`/`localPath`, `defaultBranch`, `provider` (`local` | `github`), `createdAt`, `lastAnalyzedAt`, `lastAnalyzedSha`. *Planned (§6.3):* `domainsStale`
- `(:Component)` — `id`, `repoId`, `name`, `description`, `createdBy` (`auto` | `user`), `pathPatterns`, `tier` (`domain` | `module` | ... — see §6.1). *Planned (§6.3):* `origin` (`folder` | `merge`) and `absorbedModuleIds` for merged/split feature modules.
- *Planned (§6.3):* `(:MergeSuggestion)` — `id`, `repoId`, `key`, `kind`, `members`, `targetComponentId`, `score`, `reasons`, `status`, `scoreAtRejection`, `updatedAt`
- `(:File)` — `id`, `repoId`, `path`, `language`, `loc`, `lastSeenCommit`
- `(:PullRequest)` — `id`, `repoId`, `number`, `title`, `description`, `author`, `state`, `baseRef`, `headRef`, `headSha`, `url`, `createdAt`, `updatedAt`
- `(:RefSnapshot)` — `sha`, `repoId`, `ref`, `message`, `author`, `timestamp` — covers both a PR's base/head and ad-hoc ref-to-ref comparisons
- `(:Finding)` — `id`, `repoId`, `prId` (nullable), **`targetKey`** (what was reviewed: `pr:<number>` or `refs:<baseRef>...<headRef>` — added so ref-comparison reviews, which have no `PullRequest` node, can be stored and replaced), `componentId`, `filePath`, `lineRange`, `summary`, `intentMatch` (`match` | `partial` | `mismatch` | `unknown`), `confidence`, `rationale`, `model`, `createdAt`, **`reviewedBaseSha`, `reviewedHeadSha`, `reviewedAt`** (as built — the exact commits the review actually covered, captured at review time so staleness can be detected later even after the BullMQ job record has aged out; see §10's "As built") — `filePath`/`lineRange` are populated from the diff hunk the finding was generated from (§6.2, §9), so a finding attached to a component can still be navigated to the exact file/lines it's about. Findings are **overwritten**, not versioned, when a PR's head SHA changes — see §10.
- `(:AppMap)` — **as built (§6.5)**: `id` (`<repoId>:appmap:<level>`), `repoId`, `level`, `groupsJson`, `edgesJson`, `model`, `createdAt` — one level's AI grouping and explanations of the app map
- `(:PrMap)` — **as built (§6.4)**: `id` (`<repoId>:prmap:<targetKey>`), `repoId`, `targetKey`, `filesKey` (the sorted changed paths the grouping covers), `groupsJson`, `edgeLabelsJson`, `model`, `createdAt` — the review job's AI grouping of one target's PR map
- `(:Settings {id: "global"})` — a singleton, not `repoId`-scoped, since GitHub PAT and AI provider config are shared instance-wide under decision #6. Credential fields are stored encrypted — see §11. `activeAiProviderId` points at whichever `AiProvider` node (below) is currently in use.
- `(:AiProvider)` — **as built (beyond the original single-provider design)**: `id`, `name`, `baseUrl`, `apiKeyEncrypted`, `model`, `createdAt`. Decision #8 fixes the *shape* of a provider (generic OpenAI-compatible base URL/key/model, no per-vendor fields) but says nothing about how many can be saved at once; in practice, switching between e.g. a local model server and a hosted one by re-typing a base URL/key every time was annoying enough to warrant more than one, so this is a list of saved providers rather than three properties directly on `Settings`. Exactly one is "active" at a time (`Settings.activeAiProviderId`), and only the active provider's config is used for reviews/labeling. A one-time lazy migration (`lib/neo4j/ai-provider.ts`) converts an existing single-provider `Settings` node (its old `aiBaseUrl`/`aiApiKeyEncrypted`/`aiModel` properties) into the first saved, auto-activated `AiProvider` node, so nobody who already had a provider configured has to re-enter it.

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
- `(PrMap)-[:FOR]->(PullRequest)` — as built (§6.4), for PR targets only
- `(Settings)-[:HAS_AI_PROVIDER]->(AiProvider)` — as built, links every saved provider to the singleton

## 8. GitHub integration surface

- **Data needed**: repo and branch lists, PR list and detail (title, body, base/head SHA, author, state), per-file diffs, linked issues, and ad-hoc ref-to-ref comparisons.
- **REST v3** (`@octokit/rest`) covers most of this — notably `GET /repos/{owner}/{repo}/pulls/{pull_number}/files`, which returns per-file unified-diff `patch` text directly (no separate diff-parsing step needed), and `GET /repos/{owner}/{repo}/compare/{base}...{head}` for non-PR ref comparisons (decision #4).
- **GraphQL v4** (`@octokit/graphql`) is used specifically for linked-issue resolution — `closingIssuesReferences` on a PR is reliably available only via GraphQL — and optionally to batch PR + files + linked-issues into fewer round-trips.
- The PAT (decision #7) is stored via in-app settings, persisted in Neo4j, and used as a Bearer token. REST rate-limit headers are surfaced in the UI (PAT auth gets 5000 req/hr, generous for single-user local use).
- **As built — local repos need no GitHub at all.** Branch listing, ref comparison and the per-file diff text used by the AI review all come from the checkout's own git (`lib/jobs/local-git.ts`: `git for-each-ref`, `git diff --name-only|--name-status|--numstat base...head`, per-file `-U3` patches capped at ~60 KB). Local git runs with `safe.directory=*` because the repo arrives through a read-only bind mount owned by a different uid. Only PRs, linked issues and private-repo cloning require a PAT. A failed clone now reports *why* ("likely private / invalid PAT — needs `repo` scope") instead of git's raw "could not read Username".
- **As built — GitLab is a second, symmetric remote provider** (`lib/gitlab/`), not a GitHub-Enterprise-style compatibility mode. A merge request is mapped onto the exact same `PullRequestSummary`/`PullRequestDetail`/`PullRequestFile`/`LinkedIssue` shapes GitHub uses, so the review pipeline, the `(:PullRequest)` node schema, and every route past the fetch layer are unchanged — only `lib/jobs/gitlab-access.ts`/`repo-access.ts` know which host a given repo talks to. Differences from GitHub, all absorbed inside `lib/gitlab/client.ts`: plain REST v4 over `fetch` (no GraphQL — GitLab's `closes_issues` is a REST endpoint), auth via `PRIVATE-TOKEN`, a project identified by its URL-encoded full namespace path rather than a 2-segment owner/repo split (GitLab supports nested subgroups), per-file added/removed counts computed from the diff text (GitLab doesn't return them), and `state=closed` fetching both `closed` and `merged` to match GitHub's closed-includes-merged semantics.

## 9. AI integration flow

- **One LLM call per touched component**, not one call for the whole PR. This naturally caps prompt size, lets calls run in parallel via the job queue, and lets findings stream into the UI per node as they complete.
- Each call sends:
  1. Shared "intent" context, once: the PR's title, description, and linked-issue text.
  2. **Diff hunks only** for that component's changed files — the `patch` text already returned by GitHub's files API, with no extra diffing step.
  3. Lightweight structural context: the component's stored name/description and its `DEPENDS_ON` neighbors.
  4. Full file contents are never sent.
- Because the call is already scoped to a specific file's diff hunk, the parser extracts a `filePath`/`lineRange` from that hunk alongside the model's summary/rationale, populating the corresponding `Finding` properties (§7) — so a finding attached to a component in the graph still carries exact file/line precision (§6.2), rather than only ever saying "something in this component looks off."
- Oversized single-file diffs are truncated to hunks touching top-level declarations in v1, with a "diff truncated" flag shown in the UI; a smarter pre-summarization pass is deferred to v2.
  - **As built:** the truncation marker now names what was cut, for free. Unified-diff hunk headers (`@@ -12,7 +12,9 @@ function handleSubmit() {`) already carry git's own "which function/class is this hunk inside" heading; the truncated marker lists up to 3 unique headings from the dropped hunks plus a `+N more hunks` count, e.g. `[diff truncated] (also touches: handleSubmit(), validateInput(), +5 more hunks)`. This is deliberately *not* a second model call per oversized file — §9's "one call per component" stays exactly as designed — it's a purely mechanical read of text `git diff` already generated, so it costs nothing extra and adds no latency.
- For PRs touching many components (roughly 8–10+), a lazy two-tier flow — a cheap one-line summary per component eagerly, full intent-match analysis only on-demand when a node is expanded — is a natural v2/v3 refinement rather than eagerly running full analysis on every touched component synchronously.
- Because decision #8 requires a fully generic OpenAI-compatible endpoint, the integration **does not rely on `response_format` or tool-calling** for structured output, since these aren't universally supported (e.g. by some Ollama/LM Studio setups). Output uses plain prompted instructions with a robust parser (fenced-JSON extraction plus a fallback). The per-call token budget is configurable, with a conservative default (e.g. 6–8k input tokens), since local models often have much smaller context windows than hosted ones.

### 9.1 As built — the review pipeline

- **`lib/ai/`**: `client.ts` (generic OpenAI-compatible `chatCompletion`, no `response_format`/tools), `parse.ts` (`extractJson`: fenced block → any fence → first brace-balanced span → `null`, never throws), `budget.ts` (≈4 chars/token estimate; default 7000-token budget; system message always kept, most call-specific message preserved, oldest context dropped first), `prompts.ts`, and `review.ts` — `reviewComponentChange(config, {intent, component, files})`. It truncates oversized diffs hunk-by-hunk (`[diff truncated]`, `truncated: true`), makes **no model call at all** if no file has patch text (binary/oversized), normalises model output (confidence clamped to 0..1, unknown `intentMatch` → `unknown`, a `filePath` not among the inputs is dropped), and falls back to a single `unknown` finding with `parseFailed: true` when the output can't be parsed. API/network errors propagate to the caller. `pingProvider` is a one-token "does this config work" probe.
- **Intent semantics.** `match` = plausibly implements the stated intent; `partial` = only part of it or includes unrelated extras; `mismatch` = contradicts the intent **or contains an apparent defect** (§6.2's doubles-instead-of-squares); `unknown` = not enough information. For a **ref comparison there is no PR, hence no stated intent** — the model is told to judge against the code's own evident purpose (names, comments, the component description) and to use `mismatch` for apparent defects. So the feature also works, in a weaker form, on local repos.
- **Job**: a second BullMQ queue, `review`, with a worker in the same process as the analysis worker (concurrency 1). Payload `{ repoId, target: {kind:"pr", prNumber} | {kind:"refs", baseRef, headRef} }`. **`attempts: 1`** — a job that spends money on model calls is never retried automatically; re-running is a deliberate action. Job id = `review-<repoId>-<sha1(targetKey)[0..12]>` (hashed because ref names contain `/`, and BullMQ forbids `:` in custom ids). The job fetches the diff and intent, maps changed files → components (`lib/jobs/diff-components.ts`, shared with the diff-impact route), then calls the model once per touched component with concurrency 3, persisting each component's findings **as it completes** (so they stream into the UI) and updating `job.progress`. One failed model call never aborts the job: that component gets a persisted `unknown` finding whose rationale states the error, and the cost counter still counts the call (a rejected request may be billed). After the run, findings for components no longer touched are pruned.
- **API** (`/api/repos/[repoId]/review`): `POST {prNumber}|{baseRef,headRef}` → `{jobId, targetKey, enqueued}` (400 `ai_not_configured` / `not_linked`, 404, 503 `queue_unavailable`; a POST while a run is pending is a no-op). `GET ?prNumber=N|?baseRef=X&headRef=Y` → `{targetKey, state: none|queued|running|completed|failed, progress?: {total, completed, failed, calls, promptTokens, completionTokens, running[], unmatchedFiles}, error?, findings[], aiConfigured}`. `findings` is whatever is persisted so far. `completed` is also returned when findings exist but the job record has aged out, so an old review isn't mistaken for "never run".
- **UI** (`components/graph/`): after a successful PR / compare-refs impact check the UI GETs the review. **AI not configured** → a non-alarming note linking to Settings, never a POST. **No findings yet** → POSTs automatically (§10: automatic, no confirmation) and polls every ~1.2 s. **Findings already exist** → shows them and offers **Re-run review**; it deliberately does *not* silently re-spend tokens. Findings appear as (1) a marker halo on each component's node for its *worst* verdict — a third, independent highlight layer using Cytoscape `underlay-*` (mismatch rose, partial orchid, unknown slate, match emerald), which composes with the impact layer (node fill) and the selection layer (border/opacity) rather than overwriting either; (2) count chips in the legend; (3) the full-width dock — progress bar, live names of in-flight components, the **cost counter** (`N calls · P prompt + C completion tokens`), verdict filters, findings sorted worst-first with collapsible rationale, and click-to-select-the-node; (4) the selected component's own findings above its file list. Every verdict also carries a distinct icon and word (colour-blind safe), and the dock states that AI can be wrong.
- **Testing without a provider**: `npx tsx lib/ai/mock-server.ts --port 4010` starts a deterministic OpenAI-compatible mock (≈50% match / 25% partial / 25% mismatch by hash of component name; `MOCK_FAIL` in a prompt → HTTP 500, `MOCK_GARBAGE` → non-JSON; `MOCK_DELAY_MS` simulates latency). From the Docker containers use base URL `http://host.docker.internal:4010/v1`. On Windows `tsx` leaves a child process behind — stop the mock by killing the PID listening on the port.
- **As built — real-provider robustness.** "OpenAI-compatible" turned out to be a loose promise; `lib/ai/client.ts` tolerates three real deviations found against an actual Gemini endpoint:
  - A **reasoning ("thinking") model can spend an entire `max_tokens` budget on hidden reasoning and return no visible text at all.** The client now reports this specifically (`finish_reason: length`, "reasoning models spend their token budget on reasoning first…") instead of a generic "no content" error, and `pingProvider` no longer sets any `max_tokens`/`temperature` at all — a 16-token cap was making a perfectly working reasoning-model provider fail the connection test outright (observed: an ~11s empty response from Gemini). The ping's timeout is 60s for the same reason.
  - A model that **rejects a non-default `temperature`** (OpenAI's o-series) — the client detects the 400 and retries once without it.
  - A model that **rejects `max_tokens` in favor of `max_completion_tokens`** (newer OpenAI models) — retried once with the field renamed.
  - `message.content` returned as an **array of `{type, text}` parts** by some gateways, rather than a plain string, is now handled.
- **As built — one real-provider-key incident during development**, worth recording as a process note rather than a design fact: two live calls (~6.8k prompt + ~1.5k completion tokens) reached a user's actual configured provider during a background agent's test pass, before a warning about the now-configured real provider reached it. Both failed on the provider's own 503, so nothing was generated or persisted — but it's a reminder that any test harness touching `Settings` must snapshot and restore the real values, and must point its own test traffic at a mock it controls, never at whatever's currently configured.

### 9.2 As built — AI-assisted labeling (the domain tier)

The domain-tier feature described in §6.1 has its own pipeline, structurally parallel to §9.1's review pipeline but deliberately simpler in one respect (no per-component streaming — see below):

- **`lib/ai/label.ts`**: `labelDomains(config, input)` (repo name + optional README + every module's name/file-count/sample-paths/dependency-names → ≤8 domains, each with every module assigned to exactly one domain, unknown/duplicate ids fixed up, leftovers into an "Other" domain) and `labelDescriptions(config, input, batchSize)` (one sentence per module, batched). Same plain-JSON-in-a-fence contract as the review prompts, same `extractJson`/budget machinery.
- **Job** (`lib/jobs/label.ts`, its own `label` BullMQ queue, `attempts: 1` for the same reasoning as review — no auto-retry of a job that spends money): loads the repo's modules (with file paths and dependency names, via a dedicated `lib/neo4j/label.ts` query module rather than crowding `component.ts`/`file.ts`) → best-effort README snippet from the repo's checkout → both AI phases → **persists the domain tier serially** (Neo4j Community's parallel-relationship-write deadlock applies here exactly as it does in `analyze.ts`, §17) → persists descriptions with the never-clobber-unless-`force` rule from §6.1.
- **API** (`/api/repos/[repoId]/label`): `POST {}` or `{force?: boolean}` → `{jobId, enqueued}` (400 `ai_not_configured`, checked before enqueue; 404; 503 `queue_unavailable`). `GET` → `{state: none|queued|running|completed|failed, progress?: {phase: "domains"|"descriptions", done, total, calls, promptTokens, completionTokens}, error?, aiConfigured, domains, describedModules, modules}` — same "`completed` survives the job record aging out" treatment as the review endpoint.
- **UI**: the toolbar's Labels control shows progress (phase + `done/total` + live token counter), a "Re-generate" action once domains exist, and Collapse-all/Expand-all for the resulting compound boxes (`cytoscape-expand-collapse`, already registered for §3's tier nesting). The graph API's node payload gained `parentId` (module → its domain) and a domain node's own `fileCount` (summed from its children); the component-files endpoint returns the de-duplicated union of a domain's children's files when asked about a domain id.

## 10. Analysis lifecycle, staleness & AI cost

**When static analysis (re-)runs:**

- Adding a repo triggers a full analysis immediately (clone/pull if needed → static analysis §5 → clustering §6), recording `Repo.lastAnalyzedAt`/`lastAnalyzedSha`.
- Opening a repo's **Graph** tab, or selecting a PR/ref comparison, compares `lastAnalyzedSha` against the current HEAD (or the PR's head SHA) via a cheap check (`git ls-remote` for local/URL repos, or the GitHub API for the PR's head). If they differ, a background re-analysis job is enqueued automatically — no manual "refresh" button to remember.
- While that job runs, the UI keeps showing the last-known graph with a non-blocking "refreshing as of a newer commit…" indicator (stale-while-revalidate), rather than blocking navigation — a reviewer should never be stuck on a spinner just to look at a PR.

**AI cost visibility (no pre-flight gate, per your call):**

- Once a PR or ref comparison is selected, intent-check calls (§9) run automatically for every touched component — no confirmation dialog, no cap. **As built (2026-09-24): only for open PRs and branch comparisons.** Merged/closed PRs (and PR numbers typed in that aren't among the recent open ones) and commit comparisons are history — browsing them must not spend tokens per click — so they show any existing review, and otherwise a **Review** button in the dock (`useReview`'s `autoRun`, decided by DiffPanel's `DiffTargetMeta`). A `?pr=` link waits for the PR list before checking, so reloading a merged PR's URL doesn't start a review either. If the PR list can't load at all, the old always-automatic behaviour applies.
- The UI shows a running counter for the current review session — calls made and, where the configured provider reports it, approximate tokens used — so cost is visible in the moment rather than hidden, without gating anything. This is a thin log (call count + token usage per `Finding`/job), not a billing system.

**Findings on PR update (overwrite-only):**

- When a PR's head SHA changes (new push), the same staleness check above triggers re-analysis, and the AI intent-check re-runs for that PR's touched components. Existing `Finding` nodes for that `(prId, componentId)` pair are replaced, not versioned — only the current state matters (§7).
- **As built:** the replace happens per `(targetKey, componentId)` when a re-run finishes that component, so the UI never blanks during a re-run. The UI does **not** auto-re-run when a PR's head SHA changes (it would spend tokens unprompted); it shows the existing findings and offers Re-run.
- **As built — stale-review detection.** Findings now record the exact commits they were generated against (`reviewedBaseSha`/`reviewedHeadSha`/`reviewedAt`, §7 — durable on the `Finding` itself, since a BullMQ job record ages out but a finding doesn't). The review `GET` endpoint resolves the *current* head (and, for local repos, base) SHA — local via `git rev-parse`, GitHub PR via `getPullRequest`, GitHub refs via a light `GET /commits/{ref}` call — and adds an optional `freshness: { stale, reviewedHeadSha, currentHeadSha, reviewedBaseSha?, currentBaseSha?, reviewedAt?, checkError? }`. A moved head is always stale; a base-only move is flagged stale only when the merge-base itself changed (checked exactly for local repos; reported but not flagged for GitHub, since the merge-base isn't cheaply knowable there). The check is cached per `(repoId, targetKey)` for 10s, skipped entirely while a job is queued/running, and a failure (deleted branch, GitHub unreachable) degrades to `checkError` rather than an error response — a missing ref is "can't tell", not a crash. The UI shows an amber "new commits since this review (`abc1234` → `def5678`)" banner with its own Re-run action when stale, a quiet "up to date" note otherwise, and nothing during a run. **Still never automatic** — moving the head only changes what the banner says, it never triggers a POST on its own. The GitHub-backed half of this (PR/ref SHA resolution via the API) is code-reviewed but not live-tested — see §16.
- Trade-off, stated plainly: there's no audit trail of what the AI flagged before a fix or force-push. Acceptable given findings are advisory-only (decision #10) and not a compliance record — but worth knowing if that changes later.

## 11. Secrets & credential storage

Decision #6 waives real user authentication (single local admin), but the GitHub PAT and each saved AI provider's API key are still meaningful secrets and deserve better than plaintext-in-a-queryable-database defaults. Two proportionate, cheap steps — not a full secrets-manager:

1. **Neo4j and Redis ports are not published to the host** in the default `docker-compose.yml` — only the `app`/`worker` containers reach them over the internal Compose network. Anyone wanting the Neo4j Browser for debugging can add a port mapping themselves; it isn't exposed by default.
2. **Credential fields are encrypted at rest.** The PAT (on `Settings`, §7) and every saved provider's API key (on its own `AiProvider` node, §7) are encrypted with AES-256-GCM, keyed by `SESSION_SECRET` (already an env var, §12), before being written to Neo4j, and decrypted only in-process when making an API call. This stops a plaintext DB dump or backup from being an instant credential leak, without building out per-user key management that decision #6 makes moot.

Out of scope: a full secrets manager/vault integration, or per-user credential isolation.

## 12. Docker Compose layout

- **Services**: `app` (Next.js web server), `worker` (same image, BullMQ worker entrypoint), `neo4j` (`neo4j:5`), `redis` (BullMQ backing store).
- **Volumes**: `neo4j_data` (persisted Neo4j data), `repo_cache` (shared between `app` and `worker` — app-managed clones live at `/data/repos/<repoId>`).
- **Local-working-directory support** (decision #4) requires an explicit host bind mount: `${LOCAL_REPOS_PATH}:/data/local-repos:ro`. See the caveat in §14.
- **Ports**: only `app`'s web port is published to the host by default; `neo4j` and `redis` stay on the internal Compose network (§11).
- **As built:** the compose file lives at `docker/docker-compose.yml` with its env at `docker/.env` (copy `docker/.env.example`); run it from `docker/` with `docker compose --env-file .env up -d --build`. One multi-stage `docker/Dockerfile` provides the `app` and `worker` targets. Extra optional env vars: `REPO_CACHE_DIR` (clone cache; defaults to `/data/repos`, else `./.data/repos`), `LOCAL_REPOS_ROOT`, `ANALYSIS_CONCURRENCY`, `STALENESS_SWEEP_INTERVAL_MS`. **Code changes require rebuilding the `app` and `worker` images** — there is no bind-mounted source. Pages that read Neo4j must be `dynamic = "force-dynamic"`: the image is built with no database reachable, so a statically prerendered DB-backed page bakes in "empty" (this hid saved credentials on `/settings` until fixed).
- **Env vars**: `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `REDIS_URL`, `LOCAL_REPOS_PATH`, `SESSION_SECRET`. The GitHub PAT and AI provider config (base URL/key/model) live primarily in the in-app settings UI, persisted encrypted to Neo4j (§11), since they are meant to be edited at runtime — env vars serve only as optional bootstrap defaults.
- **As built — closed-network / mirror support.** Every other outbound third-party dependency this app has (besides the AI provider, which was already fully user-configurable via Settings, §8) is now also overridable by env var, so the whole stack can run against internal mirrors instead of the real GitHub/GitLab/Docker Hub/Alpine: `GITHUB_API_URL` and `GITHUB_WEB_URL` (GitHub Enterprise Server or an internal GitHub proxy — lib/github/client.ts, lib/jobs/github-access.ts), `GITLAB_API_URL` and `GITLAB_WEB_URL` (a self-hosted GitLab instance — lib/gitlab/client.ts, lib/jobs/gitlab-access.ts), and, at the Docker layer, `NODE_BASE_IMAGE`/`ALPINE_MIRROR` (build args, `docker/Dockerfile`) and `NEO4J_IMAGE`/`REDIS_IMAGE` (`docker/docker-compose.yml`). All default to the real-world service, so none of this changes anything for a normal internet-connected setup. Deliberately **not covered**: npm's own registry — `npm ci`/`npm run build` inside the image build still need either real registry access or a `.npmrc`/`NPM_CONFIG_REGISTRY` pointed at a mirror, set up independently of this app's env vars. See `docker/.env.example`'s "Closed-network / mirror support" section for the full list.

## 13. Module/folder structure

*Design-time sketch below; **as built** the notable additions are:*
- `lib/ai/` = `client, parse, budget, prompts, review, label, errors, types, mock-server` (+ several smoke tests, incl. `smoke-test-label.ts`)
- `lib/jobs/` = `queue, review-queue, review, label-queue, label, review-freshness, analyze, source, staleness, repo-status, github-access, local-git, diff-components`
- `lib/neo4j/` also has `label.ts` (the labeling job's repo-scoped bulk queries, kept out of `component.ts`/`file.ts`)
- `lib/analysis/` also has `languages/{go,rust,java,kotlin,jvm}/` (`jvm/` is shared Java+Kotlin resolution infrastructure, not a language of its own — see §5)
- `components/graph/` = `GraphView, GraphCanvas, DiffPanel, ComponentFilesPanel, ReviewPanel, useReview, review-visuals, LabelsControl, useLabels, label-types, types`
- API routes under `app/api/repos/[repoId]/` = `graph, diff-impact, branches, pull-requests, refresh, review, label, components/[componentId]/files`, plus `app/api/local-repos`
- Smoke tests run with `npx tsx lib/<module>/smoke-test*.ts`.

```
app/                     App Router routes (repo/[repoId]/graph, repo/[repoId]/pr/[prNumber], settings)
                          + thin app/api/* route handlers
components/               shadcn/ui components
components/graph/         Cytoscape wrapper, layout switcher, sidebar, minimap
lib/neo4j/                driver singleton + typed repository functions per entity
lib/analysis/             languages/<lang>/ (grammar/queries/resolver), graph-builder.ts, ir.ts
lib/github/                Octokit wrapper, PAT handling, PR/diff/linked-issue fetching
lib/gitlab/                 fetch-based GitLab REST v4 wrapper, PAT handling, MR/diff/linked-issue fetching
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

**Status (2026-09-22):**
- **v1 — done and live-verified** against a real 525+-file / 109-component repo, including the deviations noted throughout (local-git branches and ref comparison, dropdown pickers, ELK layout, node-click file list, retry/failure reasons, visual redesign).
- **v2 — done.** AI provider settings ✓ · per-component intent check ✓ · advisory annotations with `filePath`/`lineRange` ✓ · overwrite-on-rerun ✓ · cost counter ✓ · Test-connection ✓ · stale-review detection (§10) ✓ · **LLM-assisted domain-tier labeling ✓** (§6.1/§9.2, on-demand "Generate labels") · **Go/Java/Rust/Kotlin analyzers ✓** (§5). What's left: the GitHub-backed review paths (PR target, GitHub `compareRefs`, the freshness check's GitHub SHA resolution) are code-reviewed but **not live-tested** (needs a real PAT), and the AI path has only been exercised against a mock server, never a real model end-to-end without hitting a provider-side error — so prompt/label *quality* against a real model is unproven, only the plumbing.
- **v3 — partially done:** JS/TS/Next.js monorepo resolution (`tsconfig` `extends`, npm/yarn/pnpm workspaces) ✓ · JVM cross-file resolution (same-package/wildcard type references) ✓ · **large-diff summarisation ✓** (§9's "As built" note — mechanical, from hunk headers, no added model call) · **multi-repo switcher polish ✓** (§4's "As built" note — a breadcrumb dropdown, filterable, jumps straight to another repo's Graph tab) · `clusterByCommunity` (Louvain) was built as a library function but never wired to any route or UI (§16 explains the blast-radius reasoning), and was removed with its dependencies on 2026-09-23 · call-graph edges ✗.

*Original plan:*

- **v1** — Compose skeleton (app + neo4j + redis + worker, with ports/secrets handling from §11–§12); local-path (bind-mounted) and URL-clone ingestion through one interface; the repo list → repo detail (Branches/PRs/Graph tabs) → settings navigation from §4; auto-analyze-on-add plus the staleness-triggered auto-refresh from §10 (this part needs no AI — it governs static analysis alone); analyzers scoped to JS/TS and Python; folder-based clustering, including the mechanical two-tier module/file split from §6.1 (module and file tiers only — just a second folder-depth cutoff, no AI needed); Cytoscape graph UI with Force/Circle/Grid layouts, compound-node nesting, and sidebar; GitHub PAT settings, PR selection, and touched-node highlighting. **No AI yet.** Already a demoable, useful product on its own.
- **v2** — AI provider settings and the per-component intent-check flow; advisory annotations on the graph, including `Finding.filePath`/`lineRange` precision (§6.2, §9) and the overwrite-on-push behavior (§10); the running call/token cost counter (§10); LLM-assisted labeling of the domain tier (§6.1) now that an AI provider is configured, completing the three-tier hierarchy; BullMQ formalized for AI and analysis jobs; Go/Java/Rust analyzers added to prove out the language extension point.
- **v3** — Louvain-based re-cluster suggestions; LLM cluster labeling for the module tier too; call-graph edges (not just imports) for JS/TS/Python; diff-summarization refinement for oversized files; multi-repo switcher UX polish (the schema is repo-scoped from v1, so this phase is mostly UI/concurrency work, not a data-model change).

## 16. Known caveats and open follow-ups

- **Local-path bind mount** (§14): only repos under `LOCAL_REPOS_PATH` are usable as "local" sources in the Docker run mode. Repos elsewhere need to be moved or symlinked in, or cloned through the app-managed cache instead.
- **"Polyglot from day one"** (decision #11) means the IR and extension point exist from day one, not that every language is supported in v1 — v1 ships JS/TS and Python only, per §15.
- **Component descriptions live only in Neo4j** (decision #9): wiping the `neo4j_data` volume loses curated purposes. A future "export graph metadata to JSON" backup feature is worth considering but is out of scope for v1.
- **The domain tier (§6.1) needs a button press.** It's implemented (§9.2), but nothing runs it automatically — a repo analyzed for the first time still starts at the module tier until someone clicks "Generate labels". This is deliberate (§9.2 explains why), but worth remembering when a fresh repo's graph looks flatter than expected.
- **Not live-tested:** the GitHub-backed review paths (`{prNumber}` reviews, GitHub `compareRefs`, the `FOR` edge to a real `PullRequest` node), the freshness check's GitHub SHA resolution (`getRefSha`), and the `503 queue_unavailable` response were verified by code reading only (no PAT was available in the environment that built this). The AI review and labeling paths have only run against a mock server — real-model prompt/label quality is unproven, and one real-provider test (Gemini) surfaced the client-robustness issues documented in §9.1, which is exactly the kind of thing mock-only testing can't catch.
- **Louvain re-clustering has no entry point, deliberately, for now** (and since 2026-09-23 no code either — removed as an unused dependency). When it existed, no route triggered it and no UI let a user accept/reject a suggestion. Unlike the domain tier (§9.2, purely additive — a new empty tier grouping *existing* modules), a Louvain re-cluster would change the *module* tier's own boundaries: every `Finding.componentId`, every domain's `CHILD_OF` edges, and any user-edited module description or name would need a migration story, since Louvain's buckets don't naturally map onto the folder-based buckets they'd replace. §6 already says this needs an explicit human accept/reject step, not silent application — building that safely (almost certainly a preview-before-commit UI, not a one-click action) is real, undone design and implementation work, not a small addition.
- **Review and label job records age out** (BullMQ retention). The API reports `completed` when findings/domains exist without a job record, but the cost counter for a very old run is then gone.
- **Findings have no history** (§10): overwriting on every PR push means there's no record of what the AI flagged before a fix or force-push. Fine for an advisory tool, but worth revisiting if GraphReview is ever used for anything audit-adjacent.
- **Java/Kotlin resolution is lexical, not a real type checker.** Same-package and wildcard-import type references (§5) are speculative token-level candidates filtered against a declared-name index, with no actual scope/overload/shadowing resolution — a local variable or parameter that happens to share a name with a real class in the same package can produce a false edge. Acceptable for "what does this code depend on," not something to treat as ground truth.
- **The labeling `force` flag is API-only.** There is no description editor in the UI yet (§6.1/§9.2), so overwriting an existing curated module description currently requires calling the API directly with `{force:true}`.
- **The stale-review base-move check is asymmetric.** A moved *head* is always flagged stale; a moved *base* is only flagged for local repos (where the merge-base can be checked exactly) — for GitHub-backed reviews the new base SHA is reported in `freshness` but never flags staleness on its own, since a cheap merge-base check isn't available there.

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
- **Windows + Docker Desktop after an unclean shutdown** can fail to start with `removing stale socket ... userAnalyticsOtlpHttp.sock: The file cannot be accessed by the system`. The socket can't be deleted normally; renaming `%LOCALAPPDATA%\Docker\run` aside lets Docker recreate it. This recurred across multiple sessions — check for it first whenever Docker won't start after a machine restart, before assuming something in the app broke it.
- **A JSDoc (`/** … */`) comment must never contain a literal `/*`/`*/` sequence**, even inside backticks describing block-comment syntax as prose. TS/JS block comments don't nest: the first `*/` anywhere inside closes the comment immediately, and everything after silently becomes code — producing confusing cascading syntax errors many lines later, not an error pointing at the actual mistake. Describe comment syntax in words instead of showing it literally.
- **"OpenAI-compatible" is a loose promise in practice** — see §9.1's real-provider robustness notes (reasoning models eating `max_tokens` with no visible output, `temperature`/`max_tokens` rejections, array-shaped `message.content`). Test the AI client against something more adversarial than a hand-written mock before trusting it against a real provider.
- **Any background-agent test that touches global mutable state the user also uses live (here: the `Settings` node's real AI/GitHub credentials) needs its own point-in-time backup/restore around the test**, not just "clear it at the end" — a coordinator message warning an agent not to touch real settings can arrive *after* the agent already started, if the agent doesn't check first. Two things helped: reading current values immediately before mutating, and never sending real test traffic anywhere but a mock server the test itself started.
- **Verify by running the app.** Static checks (`tsc`, `lint`, `build`) missed every one of the runtime bugs above. Live click-through against the Docker stack, with a real repo, found them.
