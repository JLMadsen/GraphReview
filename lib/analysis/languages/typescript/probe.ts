/**
 * Specifier cleanup + file probing shared by the relative-import resolver, the
 * tsconfig `paths`/`baseUrl` resolver and the workspace-package resolver.
 */
import { joinPosix } from "../../paths";

/** Extension probe order for extensionless specifiers. `""` means "as written". */
export const EXTENSION_CANDIDATES = [
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

/**
 * Drop a bundler `?query` suffix and a trailing `#hash` fragment, plus any
 * trailing slash. A *leading* `#` is a Node subpath-import specifier
 * (`#internal/config`), not a fragment, so it is never touched here.
 */
export function cleanSpecifier(raw: string): string {
  const withoutQuery = raw.split("?")[0];
  const hash = withoutQuery.indexOf("#");
  let spec = (hash <= 0 ? withoutQuery : withoutQuery.slice(0, hash)).trim();
  while (spec.length > 1 && spec.endsWith("/")) spec = spec.slice(0, -1);
  return spec;
}

export function isRelative(spec: string): boolean {
  return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}

/** Probe a repo-relative candidate against the files that actually exist. */
export function probe(candidate: string, files: ReadonlySet<string>): string | undefined {
  if (candidate === "" || candidate === "." || candidate.startsWith("..")) return undefined;

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

/** `probe` against a relative target/module specifier under `baseDir`. */
export function probeUnder(
  baseDir: string,
  target: string,
  files: ReadonlySet<string>,
): string | undefined {
  return probe(joinPosix(baseDir, target), files);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Pick a target string out of a `package.json` `exports`/`imports` condition
 * value: a plain string, an array of fallbacks, or a conditions object
 * (`import`/`module`/`default`/... - first match wins, then any remaining key).
 */
export function pickCondition(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const picked = pickCondition(entry);
      if (picked) return picked;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["import", "module", "default", "require", "types", "node"]) {
    if (key in record) {
      const picked = pickCondition(record[key]);
      if (picked) return picked;
    }
  }
  for (const nested of Object.values(record)) {
    const picked = pickCondition(nested);
    if (picked) return picked;
  }
  return undefined;
}

/** Match `spec` against a `"./*"`-style single-star subpath pattern. */
export function matchStarPattern(pattern: string, spec: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star === -1) return spec === pattern ? "" : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (spec.length < prefix.length + suffix.length) return undefined;
  if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return undefined;
  return spec.slice(prefix.length, spec.length - suffix.length);
}
