/**
 * `tsconfig.json` / `jsconfig.json` loading (DESIGN.md §5): `baseUrl` + `paths`,
 * including `extends` chains and picking the *nearest* config per importing
 * file (a monorepo has many).
 *
 * `extends` may be relative (`"./tsconfig.base.json"`, extension optional) or an
 * array (`["a", "b"]`, TS 5.0+: later entries override earlier ones, the config
 * itself overrides all of them); a bare package name (`"@repo/tsconfig/base.json"`)
 * is resolved best-effort against `node_modules/...` and silently skipped when not
 * found there (the walker never enters `node_modules`, so a real npm package's
 * shared config is usually unreachable - only a local, non-`node_modules` path
 * reliably resolves).
 *
 * `paths` resolve relative to the config file that declares them, or to that
 * config's `baseUrl` when it (or an inherited ancestor, at the point the `paths`
 * entry is declared) sets one - never to the importing file, and not necessarily
 * to the repo root. A child config's own `baseUrl`/`paths` entry always overrides
 * whatever an ancestor set for the same key.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AnalyzerContext } from "../../analyzer";
import { dirOf, joinPosix } from "../../paths";
import { asRecord, probeUnder } from "./probe";

export interface PathAlias {
  prefix: string;
  suffix: string;
  hasStar: boolean;
  targets: string[];
  /** Repo-relative dir the targets are resolved against (see file header). */
  baseDir: string;
}

export interface TsPathConfig {
  /** Repo-relative POSIX base directory, or `undefined` when no baseUrl is set anywhere in the chain. */
  baseUrl?: string;
  aliases: PathAlias[];
}

const EMPTY_CONFIG: TsPathConfig = { aliases: [] };
const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];
const CACHE_KEY = "typescript:tsconfig-index";

interface ConfigIndex {
  /** Only directories that directly contain a tsconfig/jsconfig, already merged with their `extends` chain. */
  byDir: Map<string, TsPathConfig>;
  /** Memoized "nearest config" answers for directories that have no config of their own. */
  nearestCache: Map<string, TsPathConfig>;
}

/** Strip comments and trailing commas so `JSON.parse` can handle JSONC. */
function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1"); // trailing commas before `}`/`]`
  return JSON.parse(out) as unknown;
}

interface RawTsConfig {
  dir: string;
  /** Resolved repo-relative dir, only when this file itself sets `compilerOptions.baseUrl`. */
  baseUrlDir?: string;
  paths?: Record<string, string[]>;
  /** `extends` target(s), resolved to repo-relative config paths (unresolvable/missing entries dropped), in override order. */
  extendsRefs: string[];
}

/** Resolve one `extends` entry to a repo-relative config file path, or `undefined` (best-effort). */
function resolveExtendsRef(value: string, fromDir: string, ctx: AnalyzerContext): string | undefined {
  const candidates: string[] = [];
  if (value.startsWith(".") || value.startsWith("/")) {
    const base = value.startsWith("/") ? joinPosix(value) : joinPosix(fromDir, value);
    candidates.push(base, `${base}.json`);
  } else {
    // Bare package name (optionally with a subpath): best-effort, only ever
    // found when it happens to be a plain repo file (node_modules is unwalked).
    candidates.push(`node_modules/${value}`, `node_modules/${value}.json`, `node_modules/${value}/tsconfig.json`);
  }
  return candidates.find((c) => ctx.files.has(c));
}

async function readRawConfig(
  configPath: string,
  ctx: AnalyzerContext,
  cache: Map<string, Promise<RawTsConfig | undefined>>,
): Promise<RawTsConfig | undefined> {
  const cached = cache.get(configPath);
  if (cached) return cached;
  const pending = (async (): Promise<RawTsConfig | undefined> => {
    try {
      const dir = dirOf(configPath);
      const text = await readFile(path.join(ctx.rootDir, ...configPath.split("/")), "utf8");
      const json = asRecord(parseJsonc(text));
      if (!json) return undefined;
      const options = asRecord(json.compilerOptions);
      const baseUrlDir =
        options && typeof options.baseUrl === "string" ? joinPosix(dir, options.baseUrl) : undefined;

      let paths: Record<string, string[]> | undefined;
      const pathsRaw = options ? asRecord(options.paths) : undefined;
      if (pathsRaw) {
        paths = {};
        for (const [pattern, value] of Object.entries(pathsRaw)) {
          if (!Array.isArray(value)) continue;
          const targets = value.filter((t): t is string => typeof t === "string");
          if (targets.length > 0) paths[pattern] = targets;
        }
      }

      const extendsValue = json.extends;
      const extendsList = Array.isArray(extendsValue)
        ? extendsValue
        : typeof extendsValue === "string"
          ? [extendsValue]
          : [];
      const extendsRefs = extendsList
        .filter((v): v is string => typeof v === "string")
        .map((v) => resolveExtendsRef(v, dir, ctx))
        .filter((v): v is string => v !== undefined);

      return { dir, baseUrlDir, paths, extendsRefs };
    } catch {
      return undefined; // a malformed config is not worth failing an entire repo analysis over
    }
  })();
  cache.set(configPath, pending);
  return pending;
}

/**
 * Depth-first collect a config's `extends` ancestors, ancestors first (so a
 * later merge pass lets the child override). `visited` guards a circular
 * `extends` without ever awaiting a promise that depends on itself.
 */
async function collectChain(
  configPath: string,
  ctx: AnalyzerContext,
  rawCache: Map<string, Promise<RawTsConfig | undefined>>,
  visited: Set<string>,
  out: RawTsConfig[],
): Promise<void> {
  if (visited.has(configPath)) return;
  visited.add(configPath);
  const raw = await readRawConfig(configPath, ctx, rawCache);
  if (!raw) return;
  for (const ext of raw.extendsRefs) await collectChain(ext, ctx, rawCache, visited, out);
  out.push(raw);
}

/** Merge an ancestors-first chain: a later entry's `baseUrl`/`paths` key wins. */
function mergeChain(chain: RawTsConfig[]): TsPathConfig {
  let baseUrl: string | undefined;
  const aliasMap = new Map<string, PathAlias>();
  for (const raw of chain) {
    if (raw.baseUrlDir !== undefined) baseUrl = raw.baseUrlDir;
    if (!raw.paths) continue;
    const baseDir = baseUrl ?? raw.dir;
    for (const [pattern, targets] of Object.entries(raw.paths)) {
      const star = pattern.indexOf("*");
      aliasMap.set(
        pattern,
        star === -1
          ? { prefix: pattern, suffix: "", hasStar: false, targets, baseDir }
          : { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), hasStar: true, targets, baseDir },
      );
    }
  }
  // Longest, most specific prefix+suffix first — same precedence rule TypeScript uses.
  const aliases = [...aliasMap.values()].sort(
    (a, b) => b.prefix.length + b.suffix.length - (a.prefix.length + a.suffix.length),
  );
  return { baseUrl, aliases };
}

/** Every directory that directly contains a `tsconfig.json`/`jsconfig.json` (tsconfig preferred). */
function discoverConfigFiles(ctx: AnalyzerContext): Map<string, string> {
  const byDir = new Map<string, string>();
  for (const file of ctx.files) {
    const base = file.slice(file.lastIndexOf("/") + 1);
    if (!CONFIG_NAMES.includes(base)) continue;
    const dir = dirOf(file);
    const existing = byDir.get(dir);
    if (!existing || (existing.endsWith("jsconfig.json") && base === "tsconfig.json")) {
      byDir.set(dir, file);
    }
  }
  return byDir;
}

/** Parse every `tsconfig.json`/`jsconfig.json` in the repo and merge each one's `extends` chain. */
export async function prepareTsConfig(ctx: AnalyzerContext): Promise<void> {
  if (ctx.cache.has(CACHE_KEY)) return;
  const rawCache = new Map<string, Promise<RawTsConfig | undefined>>();
  const configFiles = discoverConfigFiles(ctx);
  const byDir = new Map<string, TsPathConfig>();
  for (const [dir, configPath] of configFiles) {
    const chain: RawTsConfig[] = [];
    await collectChain(configPath, ctx, rawCache, new Set(), chain);
    byDir.set(dir, mergeChain(chain));
  }
  ctx.cache.set(CACHE_KEY, { byDir, nearestCache: new Map() } satisfies ConfigIndex);
}

/** The effective config of the nearest `tsconfig`/`jsconfig` at or above `fromFile`'s directory. */
export function nearestTsConfig(fromFile: string, ctx: AnalyzerContext): TsPathConfig {
  const index = ctx.cache.get(CACHE_KEY) as ConfigIndex | undefined;
  if (!index) return EMPTY_CONFIG;

  const visited: string[] = [];
  let dir = dirOf(fromFile);
  for (;;) {
    const memoized = index.nearestCache.get(dir);
    if (memoized) {
      for (const d of visited) index.nearestCache.set(d, memoized);
      return memoized;
    }
    const own = index.byDir.get(dir);
    if (own) {
      index.nearestCache.set(dir, own);
      for (const d of visited) index.nearestCache.set(d, own);
      return own;
    }
    visited.push(dir);
    if (dir === "") break;
    dir = dirOf(dir);
  }
  for (const d of visited) index.nearestCache.set(d, EMPTY_CONFIG);
  return EMPTY_CONFIG;
}

/**
 * Whether *any* tsconfig/jsconfig in the repo declares a `paths` alias claiming
 * this specifier. Used where the caller has no importing file to pick a nearest
 * config from ({@link LanguageAnalyzer.externalPackageName} takes none) — a
 * conservative "is this internal at all" check, not a resolution.
 */
export function hasMatchingAlias(spec: string, ctx: AnalyzerContext): boolean {
  const index = ctx.cache.get(CACHE_KEY) as ConfigIndex | undefined;
  if (!index) return false;
  for (const config of index.byDir.values()) {
    if (matchAlias(spec, config)) return true;
  }
  return false;
}

/** The alias (if any) whose pattern claims this specifier. */
export function matchAlias(spec: string, config: TsPathConfig): PathAlias | undefined {
  return config.aliases.find((alias) => {
    if (!alias.hasStar) return spec === alias.prefix;
    return (
      spec.length >= alias.prefix.length + alias.suffix.length &&
      spec.startsWith(alias.prefix) &&
      spec.endsWith(alias.suffix)
    );
  });
}

/** Resolve a bare specifier against a config's `paths` aliases, then its `baseUrl`. */
export function resolveViaTsConfig(
  spec: string,
  config: TsPathConfig,
  files: ReadonlySet<string>,
): string | undefined {
  const alias = matchAlias(spec, config);
  if (alias) {
    const star = alias.hasStar ? spec.slice(alias.prefix.length, spec.length - alias.suffix.length) : "";
    for (const target of alias.targets) {
      const expanded = alias.hasStar ? target.replace("*", star) : target;
      const hit = probeUnder(alias.baseDir, expanded, files);
      if (hit) return hit;
    }
    return undefined;
  }
  if (config.baseUrl !== undefined) return probeUnder(config.baseUrl, spec, files);
  return undefined;
}
