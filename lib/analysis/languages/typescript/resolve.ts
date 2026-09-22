/**
 * JS/TS import-specifier resolution (DESIGN.md §5).
 *
 * Deliberately *not* a full Node/TS module resolver: it resolves relative
 * specifiers and `tsconfig.json`/`jsconfig.json` path aliases against the set of
 * files actually present in the repo, and leaves everything else unresolved so
 * it can be grouped under the "external" nodes from §5. No `node_modules`
 * traversal, no `package.json` `exports` handling — those describe dependencies
 * outside the repo, which the graph models as external packages anyway.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AnalyzerContext } from "../../analyzer";
import { dirOf, joinPosix } from "../../paths";

/** Extension probe order for extensionless specifiers. `""` means "as written". */
const EXTENSION_CANDIDATES = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];

/** TS lets an ESM import say `./x.js` while the file on disk is `./x.ts`. */
const JS_TO_TS_REWRITES: Array<[RegExp, string[]]> = [
  [/\.js$/, [".ts", ".tsx", ".d.ts"]],
  [/\.jsx$/, [".tsx"]],
  [/\.mjs$/, [".mts"]],
  [/\.cjs$/, [".cts"]],
];

interface PathAlias {
  prefix: string;
  suffix: string;
  hasStar: boolean;
  targets: string[];
}

interface TsPathConfig {
  /** Repo-relative POSIX base directory, or `undefined` when no baseUrl is set. */
  baseUrl?: string;
  aliases: PathAlias[];
}

const CACHE_KEY = "typescript:tsconfig";

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
  // Trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read `tsconfig.json`/`jsconfig.json` at the repo root for `baseUrl` + `paths`. */
export async function loadTsPathConfig(ctx: AnalyzerContext): Promise<TsPathConfig> {
  const cached = ctx.cache.get(CACHE_KEY) as TsPathConfig | undefined;
  if (cached) return cached;

  const config: TsPathConfig = { aliases: [] };
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    if (!ctx.files.has(name)) continue;
    try {
      const raw = await readFile(path.join(ctx.rootDir, name), "utf8");
      const options = asRecord(asRecord(parseJsonc(raw))?.compilerOptions);
      if (!options) continue;
      if (typeof options.baseUrl === "string") {
        config.baseUrl = joinPosix(options.baseUrl);
      }
      const paths = asRecord(options.paths);
      if (paths) {
        config.baseUrl ??= "";
        for (const [pattern, value] of Object.entries(paths)) {
          if (!Array.isArray(value)) continue;
          const targets = value.filter((t): t is string => typeof t === "string");
          if (targets.length === 0) continue;
          const star = pattern.indexOf("*");
          config.aliases.push(
            star === -1
              ? { prefix: pattern, suffix: "", hasStar: false, targets }
              : {
                  prefix: pattern.slice(0, star),
                  suffix: pattern.slice(star + 1),
                  hasStar: true,
                  targets,
                },
          );
        }
      }
      break;
    } catch {
      // A malformed config is not worth failing an entire repo analysis over.
    }
  }

  // Longest, most specific prefix first — same precedence rule TypeScript uses.
  config.aliases.sort((a, b) => b.prefix.length - a.prefix.length);
  ctx.cache.set(CACHE_KEY, config);
  return config;
}

export async function prepareTypeScript(ctx: AnalyzerContext): Promise<void> {
  await loadTsPathConfig(ctx);
}

/** Drop `?query`/`#hash` suffixes bundlers allow, and any trailing slash. */
function cleanSpecifier(raw: string): string {
  let spec = raw.split("?")[0].split("#")[0].trim();
  while (spec.length > 1 && spec.endsWith("/")) spec = spec.slice(0, -1);
  return spec;
}

/** Probe a repo-relative candidate against the files that actually exist. */
function probe(candidate: string, files: ReadonlySet<string>): string | undefined {
  if (candidate === "" || candidate.startsWith("..")) return undefined;

  for (const [pattern, replacements] of JS_TO_TS_REWRITES) {
    if (!pattern.test(candidate)) continue;
    if (files.has(candidate)) return candidate;
    for (const replacement of replacements) {
      const rewritten = candidate.replace(pattern, replacement);
      if (files.has(rewritten)) return rewritten;
    }
  }

  for (const ext of EXTENSION_CANDIDATES) {
    const withExt = candidate + ext;
    if (files.has(withExt)) return withExt;
  }
  for (const ext of EXTENSION_CANDIDATES) {
    if (ext === "") continue;
    const indexFile = `${candidate}/index${ext}`;
    if (files.has(indexFile)) return indexFile;
  }
  return undefined;
}

function isRelative(spec: string): boolean {
  return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}

/** The alias (if any) whose pattern claims this specifier. */
function matchAlias(spec: string, config: TsPathConfig): PathAlias | undefined {
  return config.aliases.find((alias) => {
    if (!alias.hasStar) return spec === alias.prefix;
    return (
      spec.length >= alias.prefix.length + alias.suffix.length &&
      spec.startsWith(alias.prefix) &&
      spec.endsWith(alias.suffix)
    );
  });
}

/**
 * Resolve a JS/TS specifier to a repo-relative path, or `undefined` when it is
 * external / unresolvable. `prepareTypeScript` must have run first.
 */
export function resolveTypeScriptImport(
  raw: string,
  fromFile: string,
  ctx: AnalyzerContext,
): string | undefined {
  const spec = cleanSpecifier(raw);
  if (spec === "") return undefined;

  if (isRelative(spec)) {
    return probe(joinPosix(dirOf(fromFile), spec), ctx.files);
  }
  if (spec.startsWith("/")) {
    // Root-absolute specifiers only appear in bundler-ish setups; treat them as
    // repo-root relative, which is what those setups mean in practice.
    return probe(joinPosix(spec), ctx.files);
  }

  const config = (ctx.cache.get(CACHE_KEY) as TsPathConfig | undefined) ?? { aliases: [] };
  const alias = matchAlias(spec, config);
  if (alias) {
    const star = alias.hasStar
      ? spec.slice(alias.prefix.length, spec.length - alias.suffix.length)
      : "";
    for (const target of alias.targets) {
      const expanded = alias.hasStar ? target.replace("*", star) : target;
      const hit = probe(joinPosix(config.baseUrl ?? "", expanded), ctx.files);
      if (hit) return hit;
    }
    return undefined;
  }

  if (config.baseUrl !== undefined) {
    // Classic `baseUrl`-relative bare imports (`import x from "lib/foo"`).
    const hit = probe(joinPosix(config.baseUrl, spec), ctx.files);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * npm package name behind an unresolved specifier, or `undefined` when the
 * specifier is repo-internal (a relative path to a missing file, or a path
 * alias that did not resolve) and therefore not an external dependency.
 */
export function typeScriptExternalPackage(
  raw: string,
  ctx: AnalyzerContext,
): string | undefined {
  const spec = cleanSpecifier(raw);
  if (spec === "" || isRelative(spec) || spec.startsWith("/")) return undefined;

  const config = (ctx.cache.get(CACHE_KEY) as TsPathConfig | undefined) ?? { aliases: [] };
  if (matchAlias(spec, config)) return undefined;

  const segments = spec.split("/");
  if (spec.startsWith("@") && segments.length >= 2) return `${segments[0]}/${segments[1]}`;
  return segments[0];
}
