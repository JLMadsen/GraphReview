/**
 * Rust module-path resolution.
 *
 * Rust's module tree maps onto the file tree by convention (`mod a;` in a
 * module living at directory `D` is `D/a.rs` or `D/a/mod.rs`, and `a`'s own
 * children live under `D/a/`), so instead of building the tree from `mod`
 * declarations this resolver derives every file's *module path* from its
 * location relative to its **crate root directory**, and resolves paths the same
 * way in reverse:
 *
 * - crate roots: `src/lib.rs`, `src/main.rs`, `build.rs`, `src/bin/*.rs`,
 *   `src/bin/<n>/main.rs`, `tests|examples|benches/*.rs` (and `<n>/main.rs`) next
 *   to the nearest `Cargo.toml`, plus any `path =` declared in `[lib]`/`[[bin]]`/...
 *   Without any manifest, `src/lib.rs` / `src/main.rs` still count, and a `.rs`
 *   file with no root above it is treated as a single-file crate.
 * - `mod foo;`             -> `foo.rs` or `foo/mod.rs` under the declaring module's
 *                             directory; `#[path = "x.rs"]` is honoured (relative to
 *                             the declaring file's directory).
 * - `crate::a::b::Item`    -> walk `a`, `b` from the crate root directory and take
 *                             the longest prefix that maps to a file (`Item` is an
 *                             item, not a module, so the result is `b`'s file). A
 *                             path that names only an item of the root resolves to
 *                             the root file.
 * - `self::` / `super::`   -> relative to the importing file's module path.
 * - `use foo::bar;`        -> if `foo` is a child module of the current module
 *                             (2018 uniform paths) it resolves like `self::foo::bar`;
 *                             if `foo` is a workspace crate's library it resolves into
 *                             that crate; otherwise it is external.
 * - `extern crate foo;`    -> that workspace crate's lib root, else external.
 *
 * External normalisation is the crate name (`serde_json`, `std`). A leading
 * segment is only reported as an external crate when it is `std`/`core`/`alloc`,
 * a dependency named in some `Cargo.toml` (`[dependencies]`, `[dev-...]`,
 * `[build-...]`, `[workspace.dependencies]`, `[target.*.dependencies]`), or - when
 * the repo has no manifests at all - anything unresolved. This keeps enum
 * variants (`use Shape::*`) and inline-module items from being mistaken for crates.
 *
 * Not modelled: macro-generated modules, `include!`, `#[path]` inside inline
 * modules, `#[cfg]` selection, and precisely which root (lib vs bin) owns a file
 * when a crate has both (`crate::Item` from a non-root file prefers `lib.rs`,
 * unless its top-level module is declared only by `main.rs`).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AnalyzerContext } from "../../analyzer";
import { dirOf, joinPosix } from "../../paths";

const CACHE_KEY = "rust:state";

interface RustState {
  files: ReadonlySet<string>;
  /** Every crate-root file. */
  rootFiles: Set<string>;
  /** Root directory -> its preferred root file (`lib.rs` > `main.rs` > first). */
  rootFileByDir: Map<string, string>;
  /** Library crate name (underscored) -> lib root file. */
  crates: Map<string, string>;
  /** Every dependency name (underscored) named in any Cargo.toml. */
  deps: Set<string>;
  hasManifest: boolean;
  /**
   * Root directory -> top-level modules declared by `main.rs` but not by `lib.rs`,
   * for crates with both roots (those modules belong to the binary, so their
   * `crate::` is `main.rs`).
   */
  binOnlyModules: Map<string, Set<string>>;
}

/** Root files relative to the directory of their `Cargo.toml`. */
const CONVENTIONAL_ROOT =
  /^(?:src\/(?:lib|main)\.rs|build\.rs|src\/bin\/[^/]+\.rs|src\/bin\/[^/]+\/main\.rs|(?:tests|examples|benches)\/[^/]+\.rs|(?:tests|examples|benches)\/[^/]+\/main\.rs)$/;

const STD_CRATES = new Set(["std", "core", "alloc", "proc_macro", "test"]);

interface CargoManifest {
  dir: string;
  packageName?: string;
  libName?: string;
  libPath?: string;
  /** `path = "..."` of `[[bin]]`/`[[test]]`/`[[example]]`/`[[bench]]`. */
  targetPaths: string[];
  deps: string[];
}

const DEP_SECTION = /^(?:workspace\.)?(?:dev-|build-)?dependencies$|^target\..+\.(?:dev-|build-)?dependencies$/;
const DEP_TABLE = /^(?:workspace\.)?(?:dev-|build-)?dependencies\.(.+)$|^target\..+\.(?:dev-|build-)?dependencies\.(.+)$/;

const underscored = (name: string): string => name.replace(/-/g, "_");

/** Minimal line-based Cargo.toml reader: only what root/dependency discovery needs. */
export function parseCargoToml(text: string, dir: string): CargoManifest {
  const manifest: CargoManifest = { dir, targetPaths: [], deps: [] };
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      section = header[1].replace(/\s*\.\s*/g, ".").replace(/"/g, "");
      const table = DEP_TABLE.exec(section);
      const tableName = table?.[1] ?? table?.[2];
      if (tableName) manifest.deps.push(underscored(tableName));
      continue;
    }
    const kv = /^([A-Za-z0-9_.\-"]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/"/g, "");
    const value = /^"([^"]*)"/.exec(kv[2])?.[1];
    if (section === "package" && key === "name" && value) manifest.packageName = value;
    else if (section === "lib" && key === "name" && value) manifest.libName = value;
    else if (section === "lib" && key === "path" && value) manifest.libPath = value;
    else if (/^(?:bin|test|example|bench)$/.test(section) && key === "path" && value) {
      manifest.targetPaths.push(value);
    } else if (DEP_SECTION.test(section)) {
      // `serde = "1"`, `serde.workspace = true`, `serde = { version = ... }`
      manifest.deps.push(underscored(key.split(".")[0]));
    }
  }
  return manifest;
}

export async function prepareRust(ctx: AnalyzerContext): Promise<void> {
  const state: RustState = {
    files: ctx.files,
    rootFiles: new Set(),
    rootFileByDir: new Map(),
    crates: new Map(),
    deps: new Set(),
    hasManifest: false,
    binOnlyModules: new Map(),
  };

  const manifests: CargoManifest[] = [];
  const rustFiles: string[] = [];
  for (const file of ctx.files) {
    if (file.endsWith(".rs")) rustFiles.push(file);
    else if (file === "Cargo.toml" || file.endsWith("/Cargo.toml")) {
      state.hasManifest = true;
      try {
        manifests.push(
          parseCargoToml(await readFile(path.join(ctx.rootDir, file), "utf8"), dirOf(file)),
        );
      } catch {
        // Unreadable manifest: fall back to file-name conventions for its crate.
      }
    }
  }
  if (rustFiles.length === 0 && manifests.length === 0) {
    ctx.cache.set(CACHE_KEY, state);
    return;
  }

  const cargoDirs = new Set<string>();
  for (const file of ctx.files) {
    if (file === "Cargo.toml" || file.endsWith("/Cargo.toml")) cargoDirs.add(dirOf(file));
  }

  for (const manifest of manifests) {
    for (const dep of manifest.deps) state.deps.add(dep);
    const libRoot = manifest.libPath
      ? joinPosix(manifest.dir, manifest.libPath)
      : joinPosix(manifest.dir, "src/lib.rs");
    if (ctx.files.has(libRoot)) {
      const name = underscored(manifest.libName ?? manifest.packageName ?? "");
      if (name !== "") state.crates.set(name, libRoot);
      state.rootFiles.add(libRoot);
    }
    for (const target of manifest.targetPaths) {
      const declared = joinPosix(manifest.dir, target);
      if (ctx.files.has(declared)) state.rootFiles.add(declared);
    }
  }

  for (const file of rustFiles) {
    let dir = dirOf(file);
    let cargoDir: string | undefined;
    for (;;) {
      if (cargoDirs.has(dir)) {
        cargoDir = dir;
        break;
      }
      if (dir === "") break;
      dir = dirOf(dir);
    }
    if (cargoDir !== undefined) {
      const rel = cargoDir === "" ? file : file.slice(cargoDir.length + 1);
      if (CONVENTIONAL_ROOT.test(rel)) state.rootFiles.add(file);
    } else if (/(?:^|\/)src\/(?:lib|main)\.rs$/.test(file)) {
      state.rootFiles.add(file);
    }
  }

  const rank = (file: string): number => {
    const base = file.slice(file.lastIndexOf("/") + 1);
    return base === "lib.rs" ? 0 : base === "main.rs" ? 1 : 2;
  };
  for (const file of [...state.rootFiles].sort()) {
    const dir = dirOf(file);
    const current = state.rootFileByDir.get(dir);
    if (current === undefined || rank(file) < rank(current)) state.rootFileByDir.set(dir, file);
  }

  for (const [dir, lib] of state.rootFileByDir) {
    const main = joinPosix(dir, "main.rs");
    if (!lib.endsWith("/lib.rs") && lib !== "lib.rs") continue;
    if (!state.rootFiles.has(main)) continue;
    try {
      const [libMods, mainMods] = await Promise.all(
        [lib, main].map(async (f) =>
          declaredModules(await readFile(path.join(ctx.rootDir, f), "utf8")),
        ),
      );
      const binOnly = new Set([...mainMods].filter((m) => !libMods.has(m)));
      if (binOnly.size > 0) state.binOnlyModules.set(dir, binOnly);
    } catch {
      // Fall back to preferring lib.rs.
    }
  }
  ctx.cache.set(CACHE_KEY, state);
}

/** Names of the out-of-line `mod x;` declarations in a root file (comments ignored). */
function declaredModules(text: string): Set<string> {
  const names = new Set<string>();
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  for (const m of clean.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) names.add(m[1]);
  return names;
}

function stateOf(ctx: AnalyzerContext): RustState {
  return (
    (ctx.cache.get(CACHE_KEY) as RustState | undefined) ?? {
      files: ctx.files,
      rootFiles: new Set(),
      rootFileByDir: new Map(),
      crates: new Map(),
      deps: new Set(),
      hasManifest: false,
      binOnlyModules: new Map(),
    }
  );
}

interface ModuleInfo {
  /** Crate root directory. */
  dir: string;
  /** Module path of the file below the crate root (`[]` for a root file). */
  module: string[];
  /** The crate's root file, when known. */
  root: string | undefined;
}

function moduleInfo(file: string, state: RustState): ModuleInfo {
  if (state.rootFiles.has(file)) return { dir: dirOf(file), module: [], root: file };
  let dir = dirOf(file);
  for (;;) {
    const root = state.rootFileByDir.get(dir);
    if (root !== undefined) {
      const rel = dir === "" ? file : file.slice(dir.length + 1);
      const segments = rel.split("/");
      const last = (segments.pop() as string).replace(/\.rs$/, "");
      if (last !== "mod") segments.push(last);
      const binOnly = state.binOnlyModules.get(dir);
      return {
        dir,
        module: segments,
        root: binOnly?.has(segments[0]) ? joinPosix(dir, "main.rs") : root,
      };
    }
    if (dir === "") break;
    dir = dirOf(dir);
  }
  // No crate root above the file: a single-file crate.
  return { dir: dirOf(file), module: [], root: file };
}

/**
 * Walk `segments` down from `dir`, returning the file of the deepest module that
 * maps to a file and how many segments that consumed.
 */
function walkModules(
  dir: string,
  segments: string[],
  state: RustState,
): { file: string | undefined; consumed: number } {
  let current = dir;
  let file: string | undefined;
  let consumed = 0;
  for (const segment of segments) {
    if (segment === "*" || segment === "") break;
    const flat = joinPosix(current, `${segment}.rs`);
    const nested = joinPosix(current, segment, "mod.rs");
    const hit = state.files.has(flat) ? flat : state.files.has(nested) ? nested : undefined;
    // `use crate::lib::x` must not "find" the root file itself as a child module.
    if (hit === undefined || state.rootFiles.has(hit)) break;
    file = hit;
    consumed++;
    current = joinPosix(current, segment);
  }
  return { file, consumed };
}

const MOD_WITH_PATH = /^#\[path\s*=\s*"([^"]*)"\]\s*mod\s+(\w+)$/;

/** Resolve one flattened import (see `raw` formats in `index.ts`) to repo files. */
export function resolveRustImportPaths(
  raw: string,
  fromFile: string,
  ctx: AnalyzerContext,
): string[] {
  const state = stateOf(ctx);
  const spec = raw.trim();

  const pathed = MOD_WITH_PATH.exec(spec);
  if (pathed) {
    const target = joinPosix(dirOf(fromFile), pathed[1]);
    return state.files.has(target) && target !== fromFile ? [target] : [];
  }

  const info = moduleInfo(fromFile, state);

  if (spec.startsWith("mod ")) {
    const name = spec.slice(4).trim();
    const base = joinPosix(info.dir, ...info.module);
    for (const candidate of [joinPosix(base, `${name}.rs`), joinPosix(base, name, "mod.rs")]) {
      if (state.files.has(candidate) && candidate !== fromFile) return [candidate];
    }
    return [];
  }

  if (spec.startsWith("extern crate ")) {
    const lib = state.crates.get(underscored(spec.slice(13).trim()));
    return lib && lib !== fromFile ? [lib] : [];
  }

  const segments = spec.split("::").filter(Boolean);
  if (segments.length === 0) return [];
  const first = segments[0];

  let dir = info.dir;
  let root = info.root;
  let base: string[];
  let rest: string[];

  if (first === "crate") {
    base = [];
    rest = segments.slice(1);
  } else if (first === "self") {
    base = info.module;
    rest = segments.slice(1);
  } else if (first === "super") {
    base = info.module;
    let i = 0;
    while (segments[i] === "super") {
      if (base.length === 0) return [];
      base = base.slice(0, -1);
      i++;
    }
    rest = segments.slice(i);
  } else if (walkModules(info.dir, [...info.module, first], state).consumed === info.module.length + 1) {
    // 2018 uniform paths: `use utils::x` where `utils` is a child of this module.
    base = info.module;
    rest = segments;
  } else {
    const lib = state.crates.get(underscored(first));
    if (lib === undefined) return [];
    dir = dirOf(lib);
    root = lib;
    base = [];
    rest = segments.slice(1);
  }

  const walked = walkModules(dir, [...base, ...rest], state);
  if (walked.consumed < base.length) return [];
  const target = walked.file ?? root;
  return target !== undefined && target !== fromFile ? [target] : [];
}

/** Crate an unresolved import belongs to (`serde_json`, `std`), or `undefined` when repo-internal. */
export function rustExternalPackage(raw: string, ctx: AnalyzerContext): string | undefined {
  const state = stateOf(ctx);
  const spec = raw.trim();
  if (spec.startsWith("mod ") || spec.startsWith("#[path")) return undefined;
  const name = spec.startsWith("extern crate ")
    ? spec.slice(13).trim()
    : (spec.split("::").filter(Boolean)[0] ?? "");
  if (name === "" || name === "crate" || name === "self" || name === "super") return undefined;

  const crate = underscored(name);
  if (STD_CRATES.has(crate)) return crate;
  if (state.crates.has(crate)) return undefined;
  if (state.deps.has(crate)) return crate;
  return state.hasManifest ? undefined : crate;
}

// --- use-tree flattening -----------------------------------------------------

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Split on commas that are not inside a nested `{ ... }`. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function expand(tree: string, prefix: string[], out: string[]): void {
  const t = tree.trim();
  if (t === "") return;
  const brace = t.indexOf("{");
  if (brace !== -1) {
    const head = t
      .slice(0, brace)
      .trim()
      .replace(/::\s*$/, "");
    const close = t.lastIndexOf("}");
    const inner = t.slice(brace + 1, close === -1 ? undefined : close);
    const headSegments = head === "" ? [] : head.split("::").map((s) => s.trim()).filter(Boolean);
    for (const item of splitTopLevel(inner)) expand(item, [...prefix, ...headSegments], out);
    return;
  }
  const segments = t
    .replace(/\s+as\s+\S+$/, "")
    .split("::")
    .map((s) => s.trim())
    .filter(Boolean);
  // `use a::{self, b}`: `self` imports the module `a` itself.
  if (segments[segments.length - 1] === "self" && prefix.length + segments.length > 1) {
    segments.pop();
  }
  const full = [...prefix, ...segments];
  if (full.length > 0) out.push(full.join("::"));
}

/**
 * Flatten a `use` argument into plain `::`-separated paths:
 * `a::{b, c::d, self, e::*}` -> `a::b`, `a::c::d`, `a`, `a::e::*`.
 * A leading `::` (`::serde::Serialize`) is dropped; aliases are discarded.
 */
export function expandUseTree(text: string): string[] {
  const out: string[] = [];
  expand(stripComments(text).replace(/\s+/g, " "), [], out);
  return out;
}
