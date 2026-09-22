/**
 * npm/yarn/pnpm workspace resolution + `package.json` `"imports"` (`#foo/*`)
 * (DESIGN.md §5). An import of a local workspace package (`@scope/pkg`, `pkg`,
 * or a subpath of either) resolves to a file inside that package's directory —
 * via its `package.json` `exports["."]`/subpath entries, else `main`/`module`/
 * `types`, else a conventional `src/index.*`/`index.*` — and counts as an
 * internal edge, never an external dependency, even when the specific subpath
 * cannot be resolved to a file.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AnalyzerContext } from "../../analyzer";
import { dirOf } from "../../paths";
import { asRecord, matchStarPattern, pickCondition, probeUnder } from "./probe";

export interface WorkspacePackage {
  name: string;
  dir: string;
  exportsField?: unknown;
  main?: string;
  module?: string;
  types?: string;
}

interface WorkspaceIndex {
  byName: Map<string, WorkspacePackage>;
}

interface PackageImportsEntry {
  /** Repo-relative dir of the `package.json` declaring `"imports"`. */
  dir: string;
  imports: Record<string, unknown>;
}

const WORKSPACE_CACHE_KEY = "typescript:workspace-index";
const PKG_IMPORTS_CACHE_KEY = "typescript:package-imports";

async function readJson(file: string, ctx: AnalyzerContext): Promise<Record<string, unknown> | undefined> {
  if (!ctx.files.has(file)) return undefined;
  try {
    const text = await readFile(path.join(ctx.rootDir, ...file.split("/")), "utf8");
    return asRecord(JSON.parse(text));
  } catch {
    return undefined; // malformed package.json is not worth failing the run over
  }
}

function packageJsonPath(dir: string): string {
  return dir === "" ? "package.json" : `${dir}/package.json`;
}

/** Every directory that appears as a path prefix of some file, including `""` (repo root). */
function allDirs(ctx: AnalyzerContext): Set<string> {
  const dirs = new Set<string>([""]);
  for (const file of ctx.files) {
    let dir = dirOf(file);
    while (dir !== "" && !dirs.has(dir)) {
      dirs.add(dir);
      dir = dirOf(dir);
    }
  }
  return dirs;
}

/** `*` matches one path segment, `**` matches any number (including zero). */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i++;
      if (pattern[i + 1] === "/") i++;
    } else if (ch === "*") {
      source += "[^/]*";
    } else if ("\\^$.+?()[]{}|".includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  return new RegExp(`^${source}$`);
}

function expandWorkspacePatterns(patterns: string[], dirs: ReadonlySet<string>): string[] {
  const matched = new Set<string>();
  for (const raw of patterns) {
    const pattern = raw.replace(/\/+$/, "");
    if (pattern === "" || pattern.startsWith("!")) continue; // negation patterns are not modelled
    if (!pattern.includes("*")) {
      if (dirs.has(pattern)) matched.add(pattern);
      continue;
    }
    const re = globToRegExp(pattern);
    for (const dir of dirs) {
      if (dir !== "" && re.test(dir)) matched.add(dir);
    }
  }
  return [...matched];
}

/** Minimal `packages:` list reader for `pnpm-workspace.yaml` (block and inline-array forms). */
function parsePnpmWorkspaceYaml(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split(/\s+#/)[0]; // strip trailing comments
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^packages\s*:/.test(trimmed)) {
      const inline = trimmed.slice(trimmed.indexOf(":") + 1).trim();
      if (inline.startsWith("[")) {
        for (const m of inline.matchAll(/['"]([^'"]+)['"]/g)) out.push(m[1]);
        inPackages = false;
      } else {
        inPackages = true;
      }
      continue;
    }
    if (!inPackages) continue;
    const item = /^-\s*['"]?([^'"]+?)['"]?$/.exec(trimmed);
    if (item) {
      out.push(item[1]);
    } else if (!/^[-\s]/.test(rawLine)) {
      inPackages = false; // dedented out of the `packages:` list
    }
  }
  return out;
}

async function collectWorkspacePatterns(ctx: AnalyzerContext): Promise<string[]> {
  const patterns: string[] = [];
  const rootPkg = await readJson("package.json", ctx);
  if (rootPkg) {
    const workspaces = rootPkg.workspaces;
    if (Array.isArray(workspaces)) {
      patterns.push(...workspaces.filter((w): w is string => typeof w === "string"));
    } else {
      const record = asRecord(workspaces);
      const packages = record?.packages;
      if (Array.isArray(packages)) patterns.push(...packages.filter((w): w is string => typeof w === "string"));
    }
  }
  if (ctx.files.has("pnpm-workspace.yaml")) {
    try {
      const text = await readFile(path.join(ctx.rootDir, "pnpm-workspace.yaml"), "utf8");
      patterns.push(...parsePnpmWorkspaceYaml(text));
    } catch {
      // ignore a malformed pnpm-workspace.yaml
    }
  }
  return patterns;
}

/** Build the workspace-package index and the repo-wide `package.json` `"imports"` index. */
export async function prepareWorkspaces(ctx: AnalyzerContext): Promise<void> {
  if (ctx.cache.has(WORKSPACE_CACHE_KEY)) return;

  const patterns = await collectWorkspacePatterns(ctx);
  const candidateDirs = expandWorkspacePatterns(patterns, allDirs(ctx));
  const byName = new Map<string, WorkspacePackage>();
  for (const dir of candidateDirs) {
    const json = await readJson(packageJsonPath(dir), ctx);
    if (!json || typeof json.name !== "string") continue;
    byName.set(json.name, {
      name: json.name,
      dir,
      exportsField: json.exports,
      main: typeof json.main === "string" ? json.main : undefined,
      module: typeof json.module === "string" ? json.module : undefined,
      types: typeof json.types === "string" ? json.types : typeof json.typings === "string" ? json.typings : undefined,
    });
  }
  ctx.cache.set(WORKSPACE_CACHE_KEY, { byName } satisfies WorkspaceIndex);

  // Node's `"imports"` field is private to the declaring package, so every
  // package.json in the repo (not just workspace roots) is worth indexing.
  const importsEntries: PackageImportsEntry[] = [];
  for (const file of ctx.files) {
    if (file !== "package.json" && !file.endsWith("/package.json")) continue;
    const dir = dirOf(file);
    const json = await readJson(file, ctx);
    const importsField = json ? asRecord(json.imports) : undefined;
    if (importsField) importsEntries.push({ dir, imports: importsField });
  }
  ctx.cache.set(PKG_IMPORTS_CACHE_KEY, importsEntries);
}

/** `@scope/pkg/sub/path` -> `{ name: "@scope/pkg", subpath: "sub/path" }`; `pkg` -> `{ name: "pkg", subpath: "" }`. */
function splitPackageSpec(spec: string): { name: string; subpath: string } | undefined {
  if (spec === "" || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#")) return undefined;
  const segments = spec.split("/");
  if (spec.startsWith("@")) {
    if (segments.length < 2 || segments[1] === "") return undefined;
    return { name: `${segments[0]}/${segments[1]}`, subpath: segments.slice(2).join("/") };
  }
  return { name: segments[0], subpath: segments.slice(1).join("/") };
}

function resolveExportsSubpath(pkg: WorkspacePackage, subpath: string, files: ReadonlySet<string>): string | undefined {
  const exportsRecord = asRecord(pkg.exportsField);
  const key = subpath === "" ? "." : `./${subpath}`;
  if (typeof pkg.exportsField === "string") {
    return subpath === "" ? probeUnder(pkg.dir, pkg.exportsField, files) : undefined;
  }
  if (!exportsRecord) return undefined;
  if (key in exportsRecord) {
    const target = pickCondition(exportsRecord[key]);
    return target ? probeUnder(pkg.dir, target, files) : undefined;
  }
  for (const [pattern, value] of Object.entries(exportsRecord)) {
    if (!pattern.includes("*")) continue;
    const star = matchStarPattern(pattern, key);
    if (star === undefined) continue;
    const targetPattern = pickCondition(value);
    if (!targetPattern) continue;
    const hit = probeUnder(pkg.dir, targetPattern.replace("*", star), files);
    if (hit) return hit;
  }
  return undefined;
}

function resolveWithinPackage(pkg: WorkspacePackage, subpath: string, files: ReadonlySet<string>): string | undefined {
  const viaExports = resolveExportsSubpath(pkg, subpath, files);
  if (viaExports) return viaExports;

  if (subpath !== "") return probeUnder(pkg.dir, subpath, files); // conventional subpath, no `exports` map entry for it

  for (const field of [pkg.types, pkg.module, pkg.main]) {
    if (!field) continue;
    const hit = probeUnder(pkg.dir, field, files);
    if (hit) return hit;
  }
  return probeUnder(pkg.dir, "src/index", files) ?? probeUnder(pkg.dir, "index", files);
}

function lookupWorkspacePackage(spec: string, ctx: AnalyzerContext): WorkspacePackage | undefined {
  const index = ctx.cache.get(WORKSPACE_CACHE_KEY) as WorkspaceIndex | undefined;
  if (!index || index.byName.size === 0) return undefined;
  const parsed = splitPackageSpec(spec);
  return parsed && index.byName.get(parsed.name);
}

/** Resolve a bare specifier that names a workspace package (or a subpath of one). */
export function resolveWorkspaceImport(spec: string, ctx: AnalyzerContext): string | undefined {
  const pkg = lookupWorkspacePackage(spec, ctx);
  if (!pkg) return undefined;
  const parsed = splitPackageSpec(spec);
  return parsed ? resolveWithinPackage(pkg, parsed.subpath, ctx.files) : undefined;
}

/** True when `spec` names a workspace package - it must never be reported as an external dependency. */
export function isWorkspacePackageSpecifier(spec: string, ctx: AnalyzerContext): boolean {
  return lookupWorkspacePackage(spec, ctx) !== undefined;
}

function isAncestorDir(ancestor: string, dir: string): boolean {
  return ancestor === "" || dir === ancestor || dir.startsWith(`${ancestor}/`);
}

/** The `package.json` `"imports"` entry closest to (at or above) `fromFile`. */
function nearestPackageImports(fromFile: string, entries: readonly PackageImportsEntry[]): PackageImportsEntry | undefined {
  const fromDir = dirOf(fromFile);
  let best: PackageImportsEntry | undefined;
  for (const entry of entries) {
    if (!isAncestorDir(entry.dir, fromDir)) continue;
    if (!best || entry.dir.length > best.dir.length) best = entry;
  }
  return best;
}

/** Resolve a `#foo/*`-style subpath import against the nearest package's `"imports"` map. */
export function resolvePackageImportsSpecifier(spec: string, fromFile: string, ctx: AnalyzerContext): string | undefined {
  if (!spec.startsWith("#")) return undefined;
  const entries = ctx.cache.get(PKG_IMPORTS_CACHE_KEY) as PackageImportsEntry[] | undefined;
  if (!entries || entries.length === 0) return undefined;
  const entry = nearestPackageImports(fromFile, entries);
  if (!entry) return undefined;

  if (spec in entry.imports) {
    const target = pickCondition(entry.imports[spec]);
    if (target) {
      const hit = probeUnder(entry.dir, target, ctx.files);
      if (hit) return hit;
    }
  }
  for (const [pattern, value] of Object.entries(entry.imports)) {
    if (!pattern.includes("*")) continue;
    const star = matchStarPattern(pattern, spec);
    if (star === undefined) continue;
    const targetPattern = pickCondition(value);
    if (!targetPattern) continue;
    const hit = probeUnder(entry.dir, targetPattern.replace("*", star), ctx.files);
    if (hit) return hit;
  }
  return undefined;
}

/** True when `spec` is a `#...` subpath claimed by some package's `"imports"` map (even if unresolved). */
export function isPackageImportsSpecifier(spec: string, ctx: AnalyzerContext): boolean {
  if (!spec.startsWith("#")) return false;
  const entries = ctx.cache.get(PKG_IMPORTS_CACHE_KEY) as PackageImportsEntry[] | undefined;
  return entries !== undefined && entries.length > 0;
}
