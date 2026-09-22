# lib/analysis

> `lib/analysis/` languages/<lang>/ (grammar/queries/resolver), graph-builder.ts, ir.ts

From DESIGN.md §5:

> Each language implements a small `LanguageAnalyzer`: a tree-sitter query
> file (`.scm`) that extracts import/require statements, plus a
> `resolveImportPath` function that turns a raw import specifier into a
> repo-relative file path where possible... **Extension point**:
> `lib/analysis/languages/<lang>/{grammar.wasm, queries.scm, resolve.ts}`,
> implementing a shared `LanguageAnalyzer` interface and registered by file
> extension in a central registry.

And DESIGN.md §6:

> v1 pipeline: build the file-level import graph (§5) → cluster by folder
> depth → LLM-label if an AI provider is configured, else use the folder
> name → persist as editable `Component` nodes → offer manual re-clustering
> via community detection as a secondary action.

## Scope

- `languages/<lang>/` — one folder per language (`typescript`, `python`,
  `go`, `java`, `rust`), each with its tree-sitter WASM grammar reference,
  `.scm` query file, and a `resolve.ts` implementing that language's
  import-path resolution. v1 covered JS/TS and Python (§15); v2 added Go, Java
  and Rust to prove out the extension point. The registry is designed so adding
  language *N+1* touches nothing outside its own folder.
- `ir.ts` — the common `FileAnalysis` intermediate representation (§5) that
  every `LanguageAnalyzer` emits, decoupling the graph builder from
  language specifics.
- `graph-builder.ts` — turns per-file `FileAnalysis` output into the
  file-level import graph, then the folder-depth clustering pass that
  produces module/domain-tier `Component`s (§6, §6.1).

Out of scope here: LLM-assisted component labeling (calls out to
`lib/ai/`), and persisting the resulting graph (calls out to `lib/neo4j/`).

## Usage

```ts
import { analyzeRepo } from "@/lib/analysis";

const result = await analyzeRepo("/data/repos/<repoId>", { moduleDepth: 2 });
// result.files            FileAnalysis[]                (nodes, with their IR imports)
// result.edges            { from, to, kind }[]          (resolved file → file import edges)
// result.modules          { name, filePaths }[]         (§6.1 module tier, folder-based)
// result.externalPackages string[]                      (grouped "external" nodes, §5)
```

The module is self-contained — a directory path in, an in-memory result out. It
imports nothing from `lib/neo4j`, `lib/github`, `lib/ai` or `lib/jobs`.

## Layout

| File | Role |
| --- | --- |
| `ir.ts` | `FileImport` / `FileAnalysis` — the common IR of §5 |
| `analyzer.ts` | the `LanguageAnalyzer` extension point + `AnalyzerContext` |
| `registry.ts` | extension → analyzer lookup (the only file a new language touches) |
| `tree-sitter.ts` | `web-tree-sitter` runtime: WASM grammar loading, parser/query caches |
| `walk.ts` | repo walker, skipping `node_modules`, dot-dirs and build output |
| `graph-builder.ts` | `analyzeRepo()` — walk → analyze → edges → folder clustering |
| `paths.ts` | POSIX path helpers + grammar/query asset resolution |
| `languages/<lang>/` | `queries.scm`, `resolve.ts`, analyzer definition |
| `__fixtures__/sample-repo.ts` | polyglot fixture, materialized into a temp dir |
| `__fixtures__/sample-repo-langs.ts` | Go + Java + Rust fixture, materialized into a temp dir |
| `smoke-test.ts` | end-to-end check (`npx tsx lib/analysis/smoke-test.ts`) |
| `smoke-test-langs.ts` | Go/Java/Rust check (`npx tsx lib/analysis/smoke-test-langs.ts [dir]`; with a `dir` it prints resolved/external stats per language) |

## Supported languages

| Language | Extensions | `FileAnalysis.language` | Grammar |
| --- | --- | --- | --- |
| JavaScript / TypeScript | `.ts .tsx .js .jsx .mjs .cjs .mts .cts` | `typescript` / `tsx` / `javascript` | `tree-sitter-typescript`, `-tsx` |
| Python | `.py .pyi` | `python` | `tree-sitter-python` |
| Go | `.go` | `go` | `tree-sitter-go` |
| Java | `.java` | `java` | `tree-sitter-java` |
| Rust | `.rs` | `rust` | `tree-sitter-rust` |

All emit file-level edges only (imports of kind `import`; no call graph). An
import that does not resolve to a repo file is reported under
`externalPackages` with a normalised package name, unless it is clearly
repo-internal (a missing relative file, an in-repo Go module path with no such
directory, a Java package that has a directory in the repo).

### Multi-target imports (`resolveImportPaths`)

Go packages and Java wildcard imports name a *group* of files.
`LanguageAnalyzer` therefore has an optional
`resolveImportPaths(raw, fromFile, ctx): string[]`; when present, the graph
builder emits one resolved import (one edge) per returned path. Analyzers that
resolve to a single file keep implementing only `resolveImportPath`. This is the
one generic hook in `graph-builder.ts`; no language is named there.

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

### Java

- Query: `import a.b.C;`, `import static a.b.C.m;`, `import a.b.*;`.
- Nothing hard-codes `src/main/java`: the dotted name is matched by **path
  suffix** at a directory boundary against the set of known files
  (`a/b/C.java`). Nested types and static members peel trailing segments (max
  3) until a class file matches, so `import a.b.Outer.Inner`,
  `import static a.b.C.m` and `import static a.b.C.*` land on the enclosing
  class file.
- `import a.b.*;` resolves to every `.java` file directly in a directory ending
  in `a/b` (`package-info.java` / `module-info.java` excluded). `java.*`,
  `javax.*`, `jdk.*` are never resolved.
- Several candidates (main vs test source sets, multi-module builds): the one
  sharing the longest directory prefix with the importing file wins.
- **External**: the *package* part only (stops at the first Capitalised
  segment), capped at **three** segments for reverse-domain roots (`com`,
  `org`, `io`, ... e.g. `org.springframework.boot`, `com.google.common`) and
  **two** otherwise (`java.util`, `javax.inject`, `lombok`). Packages that have
  a directory in the repo are never external.

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

### Known limitations

- **Java**: no classpath, no `package` declaration parsing (a file's package is
  assumed to follow its directory), no Maven/Gradle module graph, and
  **same-package classes need no import, so they produce no edge** - a typical
  Java repo's graph is therefore sparser than its real coupling. Suffix matching
  can pick a wrong file when a short package (`util.Foo`) is also the tail of a
  longer one. Unindexed generated or Kotlin/Scala classes appear as unresolved.
  Fully-qualified names used inline are not imports.
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
- All three: an edge is per file and per import, not per used symbol; a Go
  package import or Java wildcard therefore links to *all* files of the package.

## Grammars

Prebuilt WASM grammars come from `@vscode/tree-sitter-wasm` (built with
tree-sitter CLI 0.25.x, so they load under `web-tree-sitter` 0.27; the older
`tree-sitter-wasms` package is ABI-incompatible with it). Nothing is compiled
from source. Resolution order for each grammar:

1. `$GRAPHREVIEW_GRAMMAR_DIR/tree-sitter-<lang>.wasm`
2. a `.wasm` vendored next to the analyzer in `languages/<lang>/`
3. `node_modules/@vscode/tree-sitter-wasm/wasm/`

## Adding a language

1. `languages/<lang>/queries.scm` — captures `@specifier`/`@module` plus an
   `@import` / `@require` / `@call` marker naming the `FileImport["kind"]`.
2. `languages/<lang>/resolve.ts` — specifier → repo-relative path, plus the
   external-package name for unresolved specifiers. Per-run indexes (go.mod,
   Cargo.toml, file-suffix maps) are built in `prepare(ctx)` and cached in
   `ctx.cache`. Import units that span several files also implement
   `resolveImportPaths`.
3. `languages/<lang>/index.ts` — the `LanguageAnalyzer` object. Dump the real
   node types by parsing samples before writing the query; do not guess grammar
   node names.
4. One line in `registry.ts`. `graph-builder.ts` is untouched.
5. A fixture + smoke test asserting exact edges (see `smoke-test-langs.ts`).
