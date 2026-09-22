# lib/analysis

> `lib/analysis/` languages/<lang>/ (grammar/queries/resolver), graph-builder.ts, ir.ts

Each language implements a small `LanguageAnalyzer`: a tree-sitter query
file (`.scm`) that extracts import/require statements, plus a
`resolveImportPath` function that turns a raw import specifier into a
repo-relative file path where possible... **Extension point**:
`lib/analysis/languages/<lang>/{grammar.wasm, queries.scm, resolve.ts}`,
implementing a shared `LanguageAnalyzer` interface and registered by file
extension in a central registry.

v1 pipeline: build the file-level import graph → cluster by folder
depth → LLM-label if an AI provider is configured, else use the folder
name → persist as editable `Component` nodes → offer manual re-clustering
via community detection as a secondary action.

## Scope

- `languages/<lang>/` — one folder per language (`typescript`, `python`,
  `go`, `java`, `rust`, `kotlin`), each with its tree-sitter WASM grammar
  reference (or, for Kotlin, a grammar-free lexical reader — see below), `.scm`
  query file, and a `resolve.ts` implementing that language's import-path
  resolution. v1 covered JS/TS and Python; v2 added Go, Java and Rust to
  prove out the extension point; v3 added Kotlin and made Java + Kotlin share
  one resolver (`languages/jvm/`) so same-package and wildcard-imported
  coupling — invisible to a pure `import`-statement reading — shows up too, and
  hardened the JS/Node/Next.js resolver (tsconfig `extends` chains, npm/pnpm
  workspaces). The registry is designed so adding language *N+1* touches
  nothing outside its own folder.
- `ir.ts` — the common `FileAnalysis` intermediate representation that
  every `LanguageAnalyzer` emits, decoupling the graph builder from
  language specifics. `declares` (fully-qualified names a file declares) is an
  optional field of it, used by the JVM resolver.
- `graph-builder.ts` — turns per-file `FileAnalysis` output into the
  file-level import graph, then the folder-depth clustering pass that
  produces module/domain-tier `Component`s.

Out of scope here: LLM-assisted component labeling (calls out to
`lib/ai/`), and persisting the resulting graph (calls out to `lib/neo4j/`).

## Usage

```ts
import { analyzeRepo } from "@/lib/analysis";

const result = await analyzeRepo("/data/repos/<repoId>", { moduleDepth: 2 });
// result.files            FileAnalysis[]                (nodes, with their IR imports)
// result.edges            { from, to, kind }[]          (resolved file → file import edges)
// result.modules          { name, filePaths }[]         (module tier, folder-based)
// result.externalPackages string[]                      (grouped "external" nodes)
```

The module is self-contained — a directory path in, an in-memory result out. It
imports nothing from `lib/neo4j`, `lib/github`, `lib/ai` or `lib/jobs`.

## Layout

| File | Role |
| --- | --- |
| `ir.ts` | `FileImport` / `FileAnalysis` — the common IR |
| `analyzer.ts` | the `LanguageAnalyzer` extension point + `AnalyzerContext` |
| `registry.ts` | extension → analyzer lookup (the only file a new language touches) |
| `tree-sitter.ts` | `web-tree-sitter` runtime: WASM grammar loading, parser/query caches |
| `walk.ts` | repo walker, skipping `node_modules`, dot-dirs and build output |
| `graph-builder.ts` | `analyzeRepo()` — walk → analyze → edges → folder clustering |
| `paths.ts` | POSIX path helpers + grammar/query asset resolution |
| `languages/<lang>/` | `queries.scm`, `resolve.ts`, analyzer definition |
| `languages/jvm/tokenize.ts` | comment/string-aware Java+Kotlin tokenizer (shared) |
| `languages/jvm/references.ts` | explicit imports + same-package/wildcard type-reference candidates -> `RawImport[]` (shared) |
| `languages/jvm/resolve.ts` | the fully-qualified-name -> file index and its resolution rules (shared by Java and Kotlin) |
| `languages/kotlin/lexical.ts` | the grammar-free Kotlin reader (see "Kotlin" below) |
| `languages/typescript/probe.ts` | specifier cleanup + file/extension/index probing (shared) |
| `languages/typescript/tsconfig.ts` | `tsconfig`/`jsconfig` `extends` chains, nearest-config-per-file |
| `languages/typescript/workspace.ts` | npm/yarn/pnpm workspace packages + `package.json` `"imports"` |
| `__fixtures__/sample-repo.ts` | polyglot fixture, materialized into a temp dir |
| `__fixtures__/sample-repo-langs.ts` | Go + Java + Rust fixture, materialized into a temp dir |
| `__fixtures__/sample-repo-jvm.ts` | Gradle multi-module Java + Kotlin fixture, materialized into a temp dir |
| `__fixtures__/sample-repo-node.ts` | pnpm-style TS monorepo fixture, materialized into a temp dir |
| `smoke-test.ts` | end-to-end check (`npx tsx lib/analysis/smoke-test.ts`) |
| `smoke-test-langs.ts` | Go/Java/Rust check (`npx tsx lib/analysis/smoke-test-langs.ts [dir]`; with a `dir` it prints resolved/external stats per language) |
| `smoke-test-jvm.ts` | Java+Kotlin shared-resolver check (`npx tsx lib/analysis/smoke-test-jvm.ts [dir]`) |
| `smoke-test-node.ts` | JS/TS monorepo resolver check (`npx tsx lib/analysis/smoke-test-node.ts [dir]`) |

## Supported languages

| Language | Extensions | `FileAnalysis.language` | Grammar |
| --- | --- | --- | --- |
| JavaScript / TypeScript | `.ts .tsx .js .jsx .mjs .cjs .mts .cts` | `typescript` / `tsx` / `javascript` | `tree-sitter-typescript`, `-tsx` |
| Python | `.py .pyi` | `python` | `tree-sitter-python` |
| Go | `.go` | `go` | `tree-sitter-go` |
| Java | `.java` | `java` | `tree-sitter-java` |
| Rust | `.rs` | `rust` | `tree-sitter-rust` |
| Kotlin | `.kt .kts` | `kotlin` | none — lexical (see "Kotlin" below) |

All emit file-level edges only (imports of kind `import`; no call graph). An
import that does not resolve to a repo file is reported under
`externalPackages` with a normalised package name, unless it is clearly
repo-internal (a missing relative file, an in-repo Go module path with no such
directory, a Java package that has a directory in the repo).

### Multi-target imports (`resolveImportPaths`)

Go packages and Java/Kotlin wildcard imports name a *group* of files.
`LanguageAnalyzer` therefore has an optional
`resolveImportPaths(raw, fromFile, ctx): string[]`; when present, the graph
builder emits one resolved import (one edge) per returned path. Analyzers that
resolve to a single file keep implementing only `resolveImportPath`. This is the
one generic hook in `graph-builder.ts`; no language is named there.

Resolution of every file's imports happens in a second pass, after *every*
file has been parsed and `FileAnalysis.declares` collected into
`ctx.declarations` — this is what lets the JVM resolver's name index (built in
`indexDeclarations`, run once between the two passes) see a Kotlin file's
declarations while resolving a Java file's imports, regardless of which one
happened to be read from disk first.

### Go

- Query: every `import_spec` (single, grouped, aliased, dot, blank; interpreted
  or raw string path). Comments and strings never match.
- **In-repo modules** are read from *every* `go.mod` (`module` line; nested and
  multiple modules per repo are fine). An import path is matched against the
  module paths, **longest module path wins**, and the rest of the path is
  joined onto that `go.mod`'s directory.
- **A Go package is a directory**, so an in-repo import resolves to **every
  non-`_test.go` `.go` file in that directory** (one edge per file). Rationale:
  without type-checking we cannot tell which file supplies a symbol, and
  "depends on the package" is the honest file-level reading. `_test.go` files
  are analysed as importers but never targeted. `vendor/` is skipped by the
  walker.
- **External**: stdlib (first segment has no dot) becomes the first two
  segments (`net/http`, `encoding/json`, `fmt`); third party becomes the module
  root, taken from the `require` lines of the repo's `go.mod` files (longest
  match), else a host-aware guess (`github.com/o/r`, `golang.org/x/n`,
  `gopkg.in/yaml.v3`, otherwise two segments, plus a `/vN` major suffix).
  `import "C"` is ignored.

### Java + Kotlin (the shared JVM resolver)

Java and Kotlin share one resolver, `languages/jvm/resolve.ts`, so a Kotlin
file can import a Java class and vice versa, and so coupling that needs no
`import` at all (same-package and wildcard-imported types) still shows up as
an edge. This replaced Java's old suffix-only matcher, which produced **zero**
resolved edges on real single-package-per-directory-tree-less Java projects
(see "Known limitations" history below) — same-package references are extremely
common in real Java/Kotlin code and were previously invisible.

- **`FileAnalysis.declares`**: each file reports its `package` plus the
  fully-qualified names it declares — Java: top-level types (a file can declare
  more than the one matching its filename); Kotlin: top-level classes,
  interfaces, objects, `typealias`es, and top-level functions/properties (Kotlin
  files may be named anything and declare many things, so filename matching
  doesn't work). A Kotlin file with top-level functions/properties also declares
  the synthesized `<File>Kt` class the JVM generates for them (or the name from
  `@file:JvmName(...)`), so `import a.b.UtilsKt` from Java resolves.
- **One name -> file index**, built once per run from every file's `declares`
  (`languages/jvm/resolve.ts`): `import a.b.C` (Java, and Kotlin's identical
  `import a.b.C`/`import a.b.foo`), nested types and static members
  (`a.b.Outer.Inner`, `import static a.b.C.m`), and `a.b.*` wildcards (resolving
  to every file declaring something in that package) all look up this index
  first, **across both languages**. A path-suffix fallback (the old Java
  behaviour) only ever applies to files that reported no declarations (a parse
  failure).
- **Same-package / wildcard references need no import**: for every capitalised
  identifier a Java/Kotlin file uses that isn't imported and isn't declared in
  the file itself, `languages/jvm/references.ts` emits a **speculative**
  candidate `<filesOwnPackage>.<Name>` (and `<wildcardPackage>.<Name>` for each
  `import x.*`), reported with `kind: "import"` even though nothing was
  literally imported — a *type reference*, not an import statement. Speculative
  candidates are dropped unless they resolve to a real declared name (the same
  pattern the Python analyzer already used for `from pkg import name`), so this
  costs one map lookup per identifier and never pollutes `externalPackages`.
  Kotlin additionally speculates on *called* lower-case names (`foo(x)`,
  `x.foo()`) against top-level functions, since those need no import either.
- **Package**: read from the `package` declaration (a tree-sitter query for
  Java, a token scan for Kotlin) — never inferred from the file's path, so
  Maven/Gradle/mixed/multi-module layouts (`src/main/java`, `src/main/kotlin`,
  `app/src/main/java`, ...) need no configuration.
- **Source sets**: when a name is declared in several files (a main and a test
  copy, or two Gradle modules), the one whose *source set* — its directory minus
  its package path, minus a trailing `java`/`kotlin`/`scala`/`groovy` segment —
  is closest to the importing file's own source set wins. `src/main/java` and
  `src/main/kotlin` of the same module count as one source set; `src/main` and
  `src/test` do not.
- **`import x as y` (Kotlin)** resolves under the pre-alias name; the alias only
  affects how the file refers to it afterwards (already handled generically —
  the alias never appears in `raw`).
- **External**: same rule for both languages — the package part only (stops at
  the first Capitalised segment; for a Kotlin top-level-function import with no
  Capitalised segment at all, the parent of the last segment is tried too),
  capped at **three** segments for reverse-domain roots (`com`, `org`, `io`, ...)
  and **two** otherwise. A package declared by some file, or with a directory in
  the repo, is never external. `java.*`, `javax.*`, `jdk.*` are never resolved
  as internal.

### Kotlin

No prebuilt Kotlin `.wasm` grammar loads under this project's
`web-tree-sitter@0.27` cleanly enough to use: `tree-sitter-wasms@0.1.x` fails to
load at all under 0.27 (ABI mismatch, matching the existing Go/Java/Rust
constraint), and `@vscode/tree-sitter-wasm` ships no Kotlin grammar.
`@tree-sitter-grammars/tree-sitter-kotlin@1.1.0` **does** load (ABI 14) and
parses simple input, but mis-parses very common formatting — a class body whose
last member sits on the same line as the closing brace
(`class A { fun a() = 1 }`, `sealed class S { object C : S() }`,
`class A { companion object { const val X = 1 } }`) produces `ERROR` nodes, and
in some shapes the declarations after the error vanish from the tree entirely.
In the "best-effort... falling back" spirit and this task's
instruction to time-box the grammar search, Kotlin instead gets a **lexical
analyzer** (`languages/kotlin/lexical.ts`, `languages/jvm/tokenize.ts`): no
tree-sitter, no WASM asset.

- `tokenize.ts` is a small comment/string-aware tokenizer shared with Java's
  reference-collection (`languages/jvm/references.ts`): it strips line/block
  comments (Kotlin's nest) and string contents (regular, raw `"""..."""`,
  character literals), while still tokenizing the *code* inside a Kotlin
  `"${...}"` interpolation (including nested strings inside it).
- `lexical.ts` recovers top-level structure from brace/paren depth alone: a
  `class`/`interface`/`object`/`typealias`/`fun`/`val`/`var` keyword at depth 0
  declares a top-level name (a `private` one is excluded from `declares`, since
  nothing outside the file could import it); anything deeper is a nested/local
  declaration, tracked only so it isn't mistaken for an external reference. It
  reads `package`, every `import` (dotted name, `.*` wildcard, `as` alias), and
  runs the same same-package/wildcard reference speculation as Java.
  `data class`/`sealed class`/`object`/companion `object`/enum/interface/
  `typealias`/extension functions (`fun String.shout()`, receiver tracked so
  the *function name* is what's declared)/generic type parameters are all
  handled at the token level.
- Because it never builds a tree, it **cannot fail on a syntax error** (at worst
  a stray unbalanced brace hides the declarations physically after it) and is
  **immune to the exact formatting that breaks the tree-sitter grammar** above.
  `.kts` script files are read the same way but never contribute `declares`
  (a build script's top-level `val`/`fun` aren't meant to be imported).
- **Known Kotlin-specific limitations**: extension functions/properties used by
  simple name in the *same* package without an import are only caught when they
  are *called* (`foo(x)`, `x.foo()` — the common case); a bare reference used as
  a value (`val f = ::foo`) is not. `expect`/`actual` declaration pairing,
  multiplatform source-set selection, and annotation-processor / KSP-generated
  code are not modelled. Local/nested declarations correctly never leak into
  `declares`, but a same-named local shadowing a top-level declaration is not
  detected (purely lexical — no scoping).

### Rust

- Query: out-of-line `mod x;` (optionally with `#[path = "..."]`),
  `extern crate`, and every `use` (including `pub use`, aliases, globs and
  nested brace trees, which are flattened into one import per leaf:
  `use a::{b, c::d}` gives `a::b` and `a::c::d`). Inline `mod x { .. }` blocks
  are not imports, but `use` declarations inside them are (`super::` there
  means the enclosing file, so a bare `use super::*` is dropped).
- Crate roots: `src/lib.rs`, `src/main.rs`, `build.rs`, `src/bin/**`,
  `tests|examples|benches/*.rs` beside the nearest `Cargo.toml` (plus `path =`
  keys of `[lib]`/`[[bin]]`/...). A file's module path is derived from its
  location under its crate-root directory.
- `mod foo;` resolves to `foo.rs` or `foo/mod.rs` under the declaring module's
  directory. `crate::a::b::Item` walks `a`, `b` and takes the **longest prefix
  that maps to a file** (an item of a module resolves to that module's file, an
  item of the root to the root file). `self::` / `super::` are relative to the
  importing file's module. A bare `use foo::x` resolves when `foo` is a child
  module (2018 uniform paths) or a workspace crate's library (its `[package]` /
  `[lib]` name); `extern crate` likewise.
- **External**: the crate name (`std`, `serde_json`) when it is
  `std`/`core`/`alloc` or a dependency named in any `Cargo.toml`
  (`[dependencies]`, dev/build/workspace/target tables, dotted keys and
  `[dependencies.foo]` tables). Unresolved leading names that are *not*
  declared dependencies (enum variants, inline-module items) are dropped rather
  than reported as crates; with no manifest in the repo, every unresolved name
  counts as external.

### JavaScript / TypeScript / Next.js

`languages/typescript/resolve.ts` orchestrates three concerns, each in its own
module (`probe.ts`, `tsconfig.ts`, `workspace.ts`); resolution order for a bare
specifier is `#subpath` imports -> nearest tsconfig/jsconfig `paths` alias ->
that config's `baseUrl` -> a workspace package name/subpath.

- **Relative imports** (`./x`, `../x`) probe the file set directly: extensionless
  specifiers try `.ts .tsx .d.ts .mts .cts .js .jsx .mjs .cjs .json` then
  `index.*` of a directory; an ESM `./x.js` specifier is also tried as
  `./x.ts`/`./x.tsx`/`./x.d.ts` (`.mjs`->`.mts`, `.cjs`->`.cts`) since that's
  legal under `moduleResolution: "bundler"`/`"node16"`. A root-absolute
  specifier (`/lib/x`, from bundler-style setups) is treated as repo-root
  relative.
- **`tsconfig.json`/`jsconfig.json`** (`tsconfig.ts`): every config file in the
  repo is discovered and merged with its own `extends` chain (relative, or an
  array — TS 5.0+ semantics: later array entries override earlier ones, the
  child overrides all of them; a bare package-name `extends` is resolved
  best-effort against a literal `node_modules/<pkg>` path in the repo — the
  walker never enters `node_modules`, so an *npm* package's shared config is
  normally unreachable, only a workspace package referenced by name sometimes
  is). **A `paths` entry resolves relative to the config file that declares
  it, or to that config's `baseUrl` when one is set at that point in the chain
  (own or inherited)** — not to the importing file, and not necessarily to the
  repo root; a child overriding its *own* `baseUrl` does not retroactively
  change how an *inherited* `paths` entry (declared by an ancestor) resolves.
  Each importing file uses the **nearest** config found by walking up from its
  own directory (a monorepo has many; a package's own, non-extending tsconfig
  correctly shadows the repo root's).
- **Workspaces** (`workspace.ts`): npm/yarn `package.json` `"workspaces"`
  (array or `{packages}`) and `pnpm-workspace.yaml` `packages:` (block or
  inline-array list) are both read and glob-expanded (`*` = one path segment,
  `**` = any number) against the repo's real directories. A bare specifier
  naming a workspace package's `name` (`@scope/pkg`, `pkg`) or a subpath of one
  (`pkg/sub/path`) resolves inside that package: `exports["."]`/subpath entries
  first (exact key, then a single-`*` wildcard pattern; a conditions object
  picks `import`/`module`/`default`/`require`/`types`/`node`, in that order,
  else its first value), else `main`/`module`/`types`, else conventional
  `src/index.*`/`index.*`; a subpath absent from `exports` (or a package with no
  `exports` at all) falls back to treating it as a literal path under the
  package directory. This counts as an **internal edge**, never an external
  package — even when the specific subpath can't be resolved to a file (a
  known workspace dependency that the resolver merely couldn't pin down is
  still not npm).
- **`package.json` `"imports"`** (`#foo/*`, Node's package-private subpath
  imports): every `package.json` in the repo (not just workspace roots) is
  indexed if it has an `"imports"` field; a `#...` specifier resolves against
  the **nearest** ancestor `package.json` declaring it (exact key, then a
  single-`*` wildcard, same conditions-object handling as `exports`), targets
  resolved relative to that `package.json`'s own directory.
- **Verified working as-is** (query-level, not specifier-level — `queries.scm`
  matches on the `source` field of `import_statement`/`export_statement` nodes
  regardless of the surrounding clause shape): `export * from`,
  `export { a } from`, `export * as ns from`, `export type { X } from`,
  side-effect imports (`import "./x"`), `import type`, `require()`, dynamic
  `import()`, TS `import x = require()`, and every extension in the family
  (`.mjs .cjs .mts .cts`).
- A directory named `target` is Cargo's build output and is skipped by the
  walker, but *only* when a `Cargo.toml` sits next to it — a JS/TS repo's own
  `lib/target/` (or similar) source folder is walked normally (`walk.ts`).

#### Known JS/TS/Next.js limitations

- No real Node resolution algorithm: no `node_modules` traversal (by design —
  those are external packages), no `exports` conditions beyond the fixed
  preference list above, no `package.json` `browser` field, no TS
  `moduleSuffixes`/`rootDirs`/`typeRoots`.
- `extends` of a bare *npm* package name (as opposed to a local/workspace path)
  essentially never resolves, since `node_modules` isn't walked — this is a
  known, accepted gap (npm-published shared tsconfigs, e.g. `@tsconfig/node20`).
- Workspace glob patterns support `*` and `**`; other glob syntax (`{a,b}`,
  `[abc]`, `!negation` beyond being ignored outright) is not implemented.
- A bare specifier that happens to match *both* a `paths` alias and a workspace
  package name always resolves via the alias (checked first) — if the alias's
  own target doesn't exist as a file, resolution fails rather than falling
  through to the workspace, on the theory that an explicit alias is the more
  deliberate mapping to trust.
- `import.meta.resolve`, `require.resolve`, non-string-literal specifiers
  (`import(someVariable)`), and TS path-mapped ambient module declarations are
  not modelled.

### Known limitations

- **Java / Kotlin** (`languages/jvm/`): no classpath, so a name that resolves
  only via an external/JDK/stdlib type inheriting into scope is invisible; no
  Maven/Gradle *dependency* graph (module-to-module deps are only as good as
  what's actually declared/imported in source, not the build file's `implementation`
  lines); annotation-processor / KSP / codegen output (Lombok, Dagger,
  protobuf, `@Composable` compiler plugins) is unindexed and appears
  unresolved; a short package (`util.Foo`) can, in the path-suffix fallback
  only (used for files with no parsed declarations), match the tail of a longer
  one. Same-package/wildcard reference detection is lexical (identifiers, not
  types) — it doesn't know a bare capitalised identifier's *actual* meaning, so
  a local variable or parameter that happens to share a name with a real
  top-level type could in principle create a spurious speculative candidate,
  though this only ever produces an edge when a real declaration of that exact
  name exists in the searched packages.
- **Go**: build tags and `GOOS`/`GOARCH` file suffixes are ignored (all files of
  a package directory are linked, including `//go:build ignore` generators);
  `replace` directives, `go.work` and cgo are not modelled; same-package files
  (no import) get no edge; `internal/` visibility is not enforced.
- **Rust**: module paths are derived from file layout, so `#[path]` on an
  *inline* module, macro-generated modules, `include!` and `#[cfg]` selection
  are invisible (`#[path]` on `mod x;` is honoured, but files reached through it
  get a conventional, possibly wrong, module path for `super::`). When a crate
  has both `lib.rs` and `main.rs`, `crate::Item` from a non-root file prefers
  `lib.rs` unless the file's top-level module is declared only by `main.rs`.
  Dependencies renamed via `package = "..."` are matched by the name they are
  used under, not the package.
- Go/Java/Kotlin: an edge is per file and per import, not per used symbol; a Go
  package import or a Java/Kotlin wildcard therefore links to *all* files of
  the package.

## Grammars

Prebuilt WASM grammars come from `@vscode/tree-sitter-wasm` (built with
tree-sitter CLI 0.25.x, so they load under `web-tree-sitter` 0.27; the older
`tree-sitter-wasms` package is ABI-incompatible with it). Nothing is compiled
from source. Resolution order for each grammar:

1. `$GRAPHREVIEW_GRAMMAR_DIR/tree-sitter-<lang>.wasm`
2. a `.wasm` vendored next to the analyzer in `languages/<lang>/`
3. `node_modules/@vscode/tree-sitter-wasm/wasm/`

## Adding a language

The common path (Go/Java/Python/Rust/TypeScript) uses a tree-sitter grammar:

1. `languages/<lang>/queries.scm` — captures `@specifier`/`@module` plus an
   `@import` / `@require` / `@call` marker naming the `FileImport["kind"]`.
2. `languages/<lang>/resolve.ts` — specifier → repo-relative path, plus the
   external-package name for unresolved specifiers. Per-run indexes (go.mod,
   Cargo.toml, file-suffix maps, the JVM name index) are built in `prepare(ctx)`
   and cached in `ctx.cache`. Import units that span several files also
   implement `resolveImportPaths`. A resolver that needs cross-file
   declarations (à la the JVM one) implements `indexDeclarations(ctx)` instead,
   run once every file in the repo has been parsed (`ctx.declarations` is only
   populated at that point — never during `prepare`).
3. `languages/<lang>/index.ts` — the `LanguageAnalyzer` object:
   `queryPath`/`grammarFor`/`collectImports` (or the richer `analyzeMatches`,
   which also gets the raw source text and can report `FileAnalysis.declares`
   — see Java). Dump the real node types by parsing samples before writing the
   query; do not guess grammar node names.
4. One line in `registry.ts`. `graph-builder.ts` is untouched.
5. A fixture + smoke test asserting exact edges (see `smoke-test-langs.ts`).

A language with **no usable grammar** (Kotlin: see above) implements
`analyzeSource(input): SyntaxFacts` instead of `queryPath`/`grammarFor`/
`collectImports`/`analyzeMatches` — the graph builder calls it with the raw
`{ file, source }` and never touches tree-sitter for that language.
`LanguageAnalyzer`'s tree-sitter-shaped members are therefore all optional; the
graph builder picks `analyzeSource` when present, else the query-based path.
This is a property of the shared `LanguageAnalyzer` interface
(`analyzer.ts`) and `graph-builder.ts`'s dispatch, not a Kotlin special case —
any future language without a workable grammar can do the same.
