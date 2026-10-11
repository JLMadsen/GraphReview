<!-- Part of the design doc: see ../DESIGN.md for the index. -->

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
  **As built (2026-10-08):** names, a base/head comparison and call edges for TS/JS, Python, Java and Kotlin, and graphs read from the default branch's tip commit (git objects) instead of the working tree — see §6.10.
- Unresolvable external packages (npm/PyPI/etc.) become optional grouped "external" nodes for context, rather than being expanded individually.

## 6. Component/node inference

Turning a raw file-level import graph into meaningful, named components:

- **v1 default: folder-based clustering.** A component is the set of files under a configurable top-N folder depth (e.g. everything under `src/auth/**` becomes "Auth"). This is deterministic, explainable, and matches the near-universal folder-per-module convention across languages and ecosystems. Results are stored as editable `Component` properties so users can merge, split, or rename after generation, per decision #9.
  - **JVM source roots:** for Java/Kotlin/Scala/Groovy files under `<project>/src/<set>/<lang>/` (Maven/Gradle) or a bare `<project>/src/` (Eclipse/Ant), the depth is counted from below the source root *and* the package prefix all of that project's files share, so `app/src/main/java/com/acme/shop/cart/**` becomes "cart" (tests: "cart (test)") instead of everything landing in one `src` module. Names collide → qualified by language, then by project (`core/util`), then by the full folder.
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

**As built (2026-10-06) — oversized modules are split** (`lib/analysis/split-modules.ts`, run right after `clusterByFolderDepth` by both `analyzeRepo` and `regroupRepo`). A fixed depth makes one big flat folder one module however many features live in it (`components/graph` was 48 files), and a module is the unit of a review call, a PR map card and an app-map node. A module over 30 files is cut: first by subfolder (subfolders of 3+ files become `analysis/languages`-style modules, only when no part keeps more than 75% of the files, so a route tree of one-file folders stays whole), then, if still too large and flat, by the leading word(s) of its file names (`PrMapNode`, `usePrMap`, `pr-map-types` → `graph · pr map`; a test is named for its subject). Groups too small to stand alone fold into the group most of their imports go to while it stays at 12 files or fewer; hub files (barrels, a view importing everything, `types` imported by everything) never drive a grouping. A folder with fewer internal imports than files (a `ui/` of primitives) is not cut by name. What stays behind keeps the module's name, `<folder>/**` pattern and id, so its description, findings and new files stay put; name-cut parts are stored with their files as path patterns (`ModuleCluster.exactFiles`). Merge suggestions list such a core file by file, since its folder pattern would claim the parts' files. The first re-analysis after this moves files to the new modules through the usual path: findings follow their files, new modules inherit their domain and the domain tier is marked for regrouping.
- The domain tier (1) does **not** label reliably from folder structure alone in a lot of real repos — a Next.js app in particular mixes server and UI code under `app/`, so "frontend vs. backend vs. infra" often isn't a top-level folder split. Getting a good domain tier needs either LLM-assisted labeling (send the module list, ask the model to bucket them into domains) or a short one-time manual tagging step per repo, not pure mechanical inference. See the phasing note in §15 and the caveat in §16.

**As built — the domain tier is implemented, on demand.** A **"Generate labels"** control in the graph toolbar (later **Relabel**; `components/graph/LabelsControl.tsx`) ran a two-phase AI pass (`lib/ai/label.ts`, `lib/jobs/label.ts`, its own `label` queue and `/api/repos/[repoId]/label` route):
1. **Domain grouping** — one call sends every module's name, file count, up to 3 sample file paths and up to 5 dependency names (plus an optional short README excerpt, per §6's "never full file contents") and asks for ≤8 domains, each a name + description + the module ids it contains.
2. **Module descriptions** — one sentence per module, in batches, written directly onto `Component.description`.

Deliberately **not automatic**, unlike the review flow in §9/§10: labeling isn't triggered by an explicit user action the way selecting a PR is, and re-analysis happens constantly (§10's staleness sweep), so an automatic pass would spend tokens nobody asked for. It only runs on a button press. A re-label **replaces** the previous domain tier rather than accumulating boxes (the old `createdBy: "auto"` domains are deleted first), and by default **never overwrites an existing module description** — only a `force: true` request does, since decision #9 makes descriptions user-editable data and an automatic pass shouldn't be the thing that establishes the habit of clobbering curated text. (There is no description editor in the UI yet, so `force` is API-only for now — see §16.) Re-analysis (§10, which runs far more often than labeling) is explicitly scoped to prune only the module tier, never the domain tier or a domain left with at least one child — a domain that ends up with zero children after a prune is removed, since an empty box groups nothing.

The Repo view drew the domains as collapsible Cytoscape compound boxes around their modules.

**Since 2026-10-06 nothing starts labeling,** and since 2026-10-11 the code is deleted: the button went with the Repo view (§6.4's note), the `label` route after it, and the job, its queue and `lib/ai/label.ts` in a later cleanup (`647cc02` is the last commit that has them). docs/ideas.md suggests a "Describe modules" action on the App map's Modules level if it comes back. What labeling already wrote stays: module descriptions feed the App map's card fallback, the PR map and the chat, and the repo-wide chat's summary lists the domains.

### 6.2 Worked example: diff granularity

Take a hypothetical bug where `square.ts`'s function doubles its input instead of squaring it, inside a "Math" module component. The graph highlights the touched node at the tier currently in view — most often "Math" at the module tier, shown as touched with one file changed underneath it. The graph itself does not, by default, spell out *what* is wrong at that zoomed-out level.

That detail comes from the AI finding, not the graph structure: the per-component LLM call (§9) already receives the actual diff hunk for `square.ts`, so a resulting mismatch ("this doubles instead of squares, but the PR says it implements a square function") lands in the `Finding`'s rationale text, naming the file and function explicitly — even though the `Finding` node is attached `ABOUT` the Math component, not a specific file. To make that precision navigable rather than just readable prose, `Finding` gets two additional properties (§7): `filePath` and `lineRange`, populated from the diff hunk the finding was generated from. This costs nothing extra to compute (the LLM call is already scoped to that file's hunk) and lets the UI jump straight to the offending file/lines from a finding, without requiring the graph visualization itself to render at file granularity by default.
