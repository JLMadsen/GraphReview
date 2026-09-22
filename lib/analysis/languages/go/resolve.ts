/**
 * Go import-path resolution.
 *
 * A Go import path names a *package*, and a package is a directory - so an
 * import that belongs to a module in this repo resolves to **every non-test
 * `.go` file in that directory** (one edge per file). That is the honest
 * file-level reading of "this file depends on that package": any of its files
 * may be what provides the symbol, and static analysis without type checking
 * cannot tell which. `_test.go` files are never link targets (they are not part
 * of the importable package) but they are still analysed as importers.
 *
 * In-repo modules come from every `go.mod` (there may be several; nested modules
 * are handled by longest-module-path-wins). Everything else is external:
 * - stdlib (first path segment has no dot) -> the first two segments (`net/http`)
 * - third party -> the module root, taken from the `require` lines of the repo's
 *   `go.mod` files when possible, otherwise a host-aware guess
 *   (`github.com/gin-gonic/gin`, `golang.org/x/net`, `gopkg.in/yaml.v3`, ...).
 *
 * Not modelled: build tags / GOOS-GOARCH file suffixes (all files of the
 * directory are linked), `replace` directives, `go.work`, cgo.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AnalyzerContext } from "../../analyzer";
import { dirOf, joinPosix } from "../../paths";

interface GoModule {
  /** Repo-relative directory holding `go.mod` (`""` for the repo root). */
  dir: string;
  /** The `module` path. */
  path: string;
}

interface GoState {
  /** In-repo modules, longest module path first. */
  modules: GoModule[];
  /** Module paths named in any `require`, longest first (external module roots). */
  requires: string[];
  /** Directory -> its non-test `.go` files, sorted. */
  packages: Map<string, string[]>;
}

const CACHE_KEY = "go:state";

/** Strip a `//` comment (go.mod has no block comments). */
function stripComment(line: string): string {
  const at = line.indexOf("//");
  return (at === -1 ? line : line.slice(0, at)).trim();
}

function unquote(token: string): string {
  const t = token.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "`") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

/** Pull the `module` path and `require`d module paths out of a `go.mod`. */
export function parseGoMod(text: string): { module?: string; requires: string[] } {
  let moduleName: string | undefined;
  const requires: string[] = [];
  let block: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line === "") continue;
    if (block !== undefined) {
      if (line === ")") {
        block = undefined;
        continue;
      }
      if (block === "require") requires.push(unquote(line.split(/\s+/)[0]));
      continue;
    }
    const opener = /^(\w+)\s*\(\s*$/.exec(line);
    if (opener) {
      block = opener[1];
      continue;
    }
    const moduleLine = /^module\s+(\S+)/.exec(line);
    if (moduleLine) {
      moduleName = unquote(moduleLine[1]);
      continue;
    }
    const require = /^require\s+(\S+)/.exec(line);
    if (require) requires.push(unquote(require[1]));
  }
  return { module: moduleName, requires };
}

export async function prepareGo(ctx: AnalyzerContext): Promise<void> {
  const state: GoState = { modules: [], requires: [], packages: new Map() };
  const requires = new Set<string>();

  for (const file of ctx.files) {
    if (file.endsWith(".go")) {
      if (file.endsWith("_test.go")) continue;
      const dir = dirOf(file);
      const bucket = state.packages.get(dir);
      if (bucket) bucket.push(file);
      else state.packages.set(dir, [file]);
    } else if (file === "go.mod" || file.endsWith("/go.mod")) {
      try {
        const parsed = parseGoMod(await readFile(path.join(ctx.rootDir, file), "utf8"));
        if (parsed.module) state.modules.push({ dir: dirOf(file), path: parsed.module });
        for (const r of parsed.requires) requires.add(r);
      } catch {
        // An unreadable go.mod just means its packages stay external.
      }
    }
  }
  for (const bucket of state.packages.values()) bucket.sort();
  state.modules.sort((a, b) => b.path.length - a.path.length || a.dir.localeCompare(b.dir));
  state.requires = [...requires].sort((a, b) => b.length - a.length);
  ctx.cache.set(CACHE_KEY, state);
}

function stateOf(ctx: AnalyzerContext): GoState {
  return (
    (ctx.cache.get(CACHE_KEY) as GoState | undefined) ?? {
      modules: [],
      requires: [],
      packages: new Map(),
    }
  );
}

/** The in-repo module whose path is a prefix of `importPath`, longest first. */
function owningModule(importPath: string, state: GoState): GoModule | undefined {
  return state.modules.find(
    (m) => importPath === m.path || importPath.startsWith(`${m.path}/`),
  );
}

/**
 * Resolve an import path to the `.go` files of its package directory, or `[]`
 * when it is not a package of a module in this repo.
 */
export function resolveGoImportPaths(raw: string, ctx: AnalyzerContext): string[] {
  const state = stateOf(ctx);
  const importPath = raw.trim();
  const owner = owningModule(importPath, state);
  if (!owner) return [];
  const sub = importPath.slice(owner.path.length).replace(/^\//, "");
  return state.packages.get(joinPosix(owner.dir, sub)) ?? [];
}

/** Hosts whose module roots are `host/owner/repo`. */
const THREE_SEGMENT_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "gitea.com",
  "codeberg.org",
  "golang.org", // golang.org/x/<name>
]);

/** Best-effort module root when no `require` line covers the import path. */
function guessModuleRoot(segments: string[]): string {
  const host = segments[0];
  let count = 2;
  if (THREE_SEGMENT_HOSTS.has(host)) {
    count = 3;
  } else if (host === "gopkg.in") {
    // gopkg.in/pkg.v3 or gopkg.in/user/pkg.v3
    const versioned = segments.findIndex((s, i) => i > 0 && /\.v\d+$/.test(s));
    count = versioned === -1 ? 2 : versioned + 1;
  }
  count = Math.min(count, segments.length);
  // A major-version suffix belongs to the module path (`github.com/a/b/v2`).
  if (segments.length > count && /^v\d+$/.test(segments[count])) count++;
  return segments.slice(0, count).join("/");
}

/**
 * The module (or stdlib package) an unresolved import belongs to, or
 * `undefined` for imports into a module of this repo whose directory holds no
 * analysed files (missing, or test-only) and for cgo's pseudo-package `"C"`.
 */
export function goExternalPackage(raw: string, ctx: AnalyzerContext): string | undefined {
  const importPath = raw.trim();
  if (importPath === "" || importPath === "C") return undefined;
  const state = stateOf(ctx);
  if (owningModule(importPath, state)) return undefined;

  const segments = importPath.split("/");
  if (!segments[0].includes(".")) {
    // Standard library: `fmt`, `net/http`, `encoding/json`, `crypto/tls`.
    return segments.slice(0, 2).join("/");
  }
  const required = state.requires.find((r) => importPath === r || importPath.startsWith(`${r}/`));
  return required ?? guessModuleRoot(segments);
}
