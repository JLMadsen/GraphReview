/**
 * Shared Java + Kotlin import resolution.
 *
 * One fully-qualified-name -> file index is built per run from the analysers'
 * `FileAnalysis.declares` (package + top-level types; Kotlin also top-level
 * functions, properties and typealiases) and used by *both* languages, so a Kotlin
 * file importing a Java class and a Java file importing a Kotlin class resolve the
 * same way. Nothing hard-codes `src/main/java`: names come from `package`
 * declarations, not from paths.
 *
 * Resolution of `raw` (from an explicit import or a synthesized same-package /
 * wildcard candidate, see `references.ts`):
 *
 * 1. `a.b.*`            -> every file declaring something in package `a.b`
 *                          (`package-info.java` declares nothing, so it is never
 *                          a target). When the package lives in several source
 *                          sets (main + test, java + kotlin dirs), only those
 *                          closest to the importer are kept: main and test copies
 *                          of a package are separate source sets, while `java/`
 *                          and `kotlin/` siblings of one source set count as one.
 * 2. `a.b.C`, `a.b.foo` -> the file declaring that name. Trailing segments are
 *                          peeled off (`a.b.Outer.Inner`, `import static a.b.C.m`,
 *                          `a.b.Color.RED`, `a.b.Obj.member`) until a declared
 *                          type matches. With several declaring files (main vs test
 *                          copies, multi-module builds) the one sharing the
 *                          longest path prefix with the importer wins.
 * 3. fallback           -> the old path-suffix match (`a/b/C.java|kt`), but only
 *                          against files that declared nothing (a parse failure,
 *                          or a hand-built context without declarations), so it
 *                          cannot contradict a `package` statement.
 *
 * `java.*`, `javax.*`, `jdk.*`, and anything matching no file are external; for
 * `kotlin.*` / `android.*` etc. the usual "unresolved -> external" rule applies.
 *
 * Not modelled: the classpath, annotation-processor / generated sources (Lombok,
 * Dagger, KSP, protobuf...), `expect`/`actual` selection, Kotlin extension
 * functions or top-level properties used by simple name without an import unless
 * they are *called* (`foo(x)`, `x.foo()`), members inherited from a parent class in
 * another package.
 */
import type { AnalyzerContext } from "../../analyzer";
import { dirOf } from "../../paths";

interface JvmIndex {
  /** Fully-qualified declared name -> files declaring it (sorted). */
  byName: Map<string, string[]>;
  /** Package -> files declaring at least one name in it (sorted). */
  packageFiles: Map<string, string[]>;
  /** Declared packages. */
  packages: Set<string>;
  /** Files that reported at least one declaration. */
  declaring: Set<string>;
  /** Declaring file -> its package. */
  packageOf: Map<string, string>;
  declarationsIndexed: boolean;

  // Path-suffix fallback structures.
  fileSuffixes: Map<string, string[]>;
  dirSuffixes: Map<string, string[]>;
  filesByDir: Map<string, string[]>;
}

const CACHE_KEY = "jvm:index";

const SOURCE_EXTENSIONS = [".java", ".kt"];

/** JDK namespaces: never resolved by the path-suffix fallback. */
const JDK_PREFIXES = ["java.", "javax.", "jdk."];

/** Directory names that only split one source set by language (`src/main/java|kotlin`). */
const LANGUAGE_DIRS = new Set(["java", "kotlin", "scala", "groovy"]);

/** Top-level domains that mark a reverse-DNS package (`com.google`, `org.apache`, ...). */
const REVERSE_DOMAIN_ROOTS = new Set([
  "com", "org", "net", "io", "edu", "gov", "me", "dev", "app", "info", "biz", "eu",
  "de", "fr", "uk", "nl", "ru", "cn", "jp", "kr", "ch", "se", "no", "fi", "dk",
  "es", "it", "br", "au", "ca", "in", "at", "be", "pl", "cz", "tv", "ai",
]);

const SKIPPED_WILDCARD_FILES = new Set(["package-info.java", "module-info.java"]);

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/** `a/b/c.java` -> `c.java`, `b/c.java`, `a/b/c.java`. */
function suffixesOf(segments: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) out.push(segments.slice(i).join("/"));
  return out;
}

function emptyIndex(): JvmIndex {
  return {
    byName: new Map(),
    packageFiles: new Map(),
    packages: new Set(),
    declaring: new Set(),
    packageOf: new Map(),
    declarationsIndexed: false,
    fileSuffixes: new Map(),
    dirSuffixes: new Map(),
    filesByDir: new Map(),
  };
}

function indexOf(ctx: AnalyzerContext): JvmIndex {
  return (ctx.cache.get(CACHE_KEY) as JvmIndex | undefined) ?? emptyIndex();
}

function ensureIndex(ctx: AnalyzerContext): JvmIndex {
  let index = ctx.cache.get(CACHE_KEY) as JvmIndex | undefined;
  if (!index) {
    index = emptyIndex();
    ctx.cache.set(CACHE_KEY, index);
  }
  return index;
}

/** Build the path-suffix fallback structures. Idempotent (Java and Kotlin both call it). */
export function prepareJvm(ctx: AnalyzerContext): void {
  const index = ensureIndex(ctx);
  if (index.fileSuffixes.size > 0 || index.filesByDir.size > 0) return;
  for (const file of ctx.files) {
    if (!SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
    for (const suffix of suffixesOf(file.split("/"))) pushTo(index.fileSuffixes, suffix, file);
    const dir = dirOf(file);
    const known = index.filesByDir.has(dir);
    pushTo(index.filesByDir, dir, file);
    if (!known && dir !== "") {
      for (const suffix of suffixesOf(dir.split("/"))) pushTo(index.dirSuffixes, suffix, dir);
    }
  }
  for (const bucket of index.filesByDir.values()) bucket.sort();
}

/** Split a declared FQN into `[package, simpleName]`. */
function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? ["", name] : [name.slice(0, dot), name.slice(dot + 1)];
}

/**
 * Build the name -> file index from `ctx.declarations`. Idempotent; the graph
 * builder calls it (via each analyzer's `indexDeclarations`) once every file is parsed.
 */
export function indexJvmDeclarations(ctx: AnalyzerContext): void {
  const index = ensureIndex(ctx);
  if (index.declarationsIndexed || !ctx.declarations) return;
  index.declarationsIndexed = true;
  for (const [file, names] of ctx.declarations) {
    if (!SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
    if (names.length === 0) continue;
    index.declaring.add(file);
    for (const name of names) {
      const [pkg] = splitName(name);
      pushTo(index.byName, name, file);
      index.packages.add(pkg);
      if (!index.packageOf.has(file)) index.packageOf.set(file, pkg);
      const bucket = index.packageFiles.get(pkg);
      if (!bucket) index.packageFiles.set(pkg, [file]);
      else if (bucket[bucket.length - 1] !== file && !bucket.includes(file)) bucket.push(file);
    }
  }
  for (const bucket of index.byName.values()) bucket.sort();
  for (const bucket of index.packageFiles.values()) bucket.sort();
}

/** Number of leading path segments two repo-relative paths share. */
function sharedPrefix(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

/** The candidate closest to `fromFile` in the tree; ties broken lexically. */
function closest(candidates: string[], fromFile: string): string {
  let best = candidates[0];
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = sharedPrefix(candidate, fromFile);
    if (score > bestScore || (score === bestScore && candidate < best)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The source set a file belongs to: its directory minus its package path (the
 * source root), minus a trailing language directory, so `src/main/java` and
 * `src/main/kotlin` are one set and `src/test/java` another.
 */
function sourceSetOf(file: string, index: JvmIndex): string {
  const dir = dirOf(file);
  const pkg = index.packageOf.get(file) ?? "";
  const pkgPath = pkg.replace(/\./g, "/");
  let root = dir;
  if (pkgPath !== "") {
    if (dir === pkgPath) root = "";
    else if (dir.endsWith(`/${pkgPath}`)) root = dir.slice(0, dir.length - pkgPath.length - 1);
  }
  const segments = root === "" ? [] : root.split("/");
  if (segments.length > 0 && LANGUAGE_DIRS.has(segments[segments.length - 1])) segments.pop();
  return segments.join("/");
}

/** Of `files`, those whose source set is closest to the importer's. */
function closestSourceSets(files: string[], fromFile: string, index: JvmIndex): string[] {
  if (files.length <= 1) return files;
  const from = sourceSetOf(fromFile, index);
  let best = -1;
  let picked: string[] = [];
  for (const file of files) {
    const score = sharedPrefix(sourceSetOf(file, index), from);
    if (score > best) {
      best = score;
      picked = [file];
    } else if (score === best) {
      picked.push(file);
    }
  }
  return picked;
}

/** The file(s) declaring `segments` (longest declared prefix; peeled segments must follow a type). */
function lookupDeclared(segments: string[], index: JvmIndex): string[] | undefined {
  for (let n = segments.length; n >= 1; n--) {
    const files = index.byName.get(segments.slice(0, n).join("."));
    if (!files) continue;
    if (n === segments.length) return files;
    // Peeled members (`Outer.Inner`, `Color.RED`, static members) hang off a type;
    // never off a lower-case function/property or a package.
    const owner = segments[n - 1];
    const first = owner.charCodeAt(0);
    if (first >= 65 && first <= 90) return files;
  }
  return undefined;
}

/**
 * Resolve `a.b.C` / `a.b.foo` / `a.b.*` to repo files (one for a name, possibly
 * several for a package wildcard), or `[]` when it is external / unknown.
 */
export function resolveJvmImportPaths(
  raw: string,
  fromFile: string,
  ctx: AnalyzerContext,
): string[] {
  const spec = raw.trim();
  if (spec === "") return [];
  const index = indexOf(ctx);
  const wildcard = spec.endsWith(".*");
  const dotted = wildcard ? spec.slice(0, -2) : spec;
  const segments = dotted.split(".").filter(Boolean);
  if (segments.length === 0) return [];

  if (wildcard) {
    const files = index.packageFiles.get(dotted);
    if (files && files.length > 0) return closestSourceSets(files, fromFile, index);
    // `import a.b.Outer.*;` / `import static a.b.C.*;` - the star sits on a class.
  }

  const declared = lookupDeclared(segments, index);
  if (declared && declared.length > 0) return [closest(declared, fromFile)];

  // Fallback: path-suffix matching, only for files with no recorded declarations.
  if (JDK_PREFIXES.some((p) => spec.startsWith(p))) return [];
  const isUndeclared = (file: string): boolean => !index.declaring.has(file);

  if (wildcard) {
    const dirs = index.dirSuffixes.get(segments.join("/"));
    if (dirs && dirs.length > 0) {
      const files = (index.filesByDir.get(closest(dirs, fromFile)) ?? []).filter(
        (f) => !SKIPPED_WILDCARD_FILES.has(f.slice(f.lastIndexOf("/") + 1)) && isUndeclared(f),
      );
      if (files.length > 0) return files;
    }
  }
  for (let peel = 0; peel <= 3 && segments.length - peel >= 2; peel++) {
    const base = segments.slice(0, segments.length - peel).join("/");
    for (const ext of SOURCE_EXTENSIONS) {
      const hits = index.fileSuffixes.get(`${base}${ext}`)?.filter(isUndeclared);
      if (hits && hits.length > 0) return [closest(hits, fromFile)];
    }
  }
  return [];
}

/**
 * The package an unresolved import belongs to (segments stop at the first
 * Capitalised one, so class/member names never leak in), capped at three segments
 * for reverse-domain roots (`org.springframework.boot`, `com.google.common`) and
 * two otherwise (`java.util`, `kotlinx.coroutines`). `undefined` when the package
 * is one of this repo's own (declared by a file, or having a directory here).
 */
export function jvmExternalPackage(raw: string, ctx: AnalyzerContext): string | undefined {
  const spec = raw.trim();
  const dotted = spec.endsWith(".*") ? spec.slice(0, -2) : spec;
  const all = dotted.split(".").filter(Boolean);
  if (all.length === 0) return undefined;

  const firstUpper = all.findIndex((s) => /^[A-Z]/.test(s));
  const end = firstUpper === -1 ? all.length : firstUpper;
  const pkg = all.slice(0, end);
  if (pkg.length === 0) return all[0];

  const index = indexOf(ctx);
  if (index.packages.has(pkg.join("."))) return undefined;
  // A Kotlin top-level function import (`a.b.helper`) has no capitalised segment,
  // so its last lower-case segment may be the function name: try the parent too.
  if (firstUpper === -1 && pkg.length > 1 && index.packages.has(pkg.slice(0, -1).join("."))) {
    return undefined;
  }
  if (index.dirSuffixes.has(pkg.join("/"))) return undefined;
  const cap = REVERSE_DOMAIN_ROOTS.has(pkg[0]) ? 3 : 2;
  return pkg.slice(0, cap).join(".");
}
