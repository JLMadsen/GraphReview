/**
 * Repo → import graph + names → folder clusters (DESIGN.md §5, §6, §6.1).
 *
 * `analyzeTree` is the core: a {@link SourceTree} goes in (one commit read
 * from git, or a folder on disk), an in-memory {@link AnalysisResult} comes
 * out. `analyzeCommit` and `analyzeRepo` are its two front doors. Persisting
 * the result, LLM-labeling the clusters and the domain tier of §6.1 all
 * happen elsewhere.
 *
 * Parsing runs in a worker thread (./syntax/parse-pool.ts). What a file's
 * syntax says doesn't depend on any other file, so it is cached by the
 * file's git blob id (`options.cache`): re-analysing after a pull, or
 * analysing a PR's base and head, only parses the files that changed.
 */
import { stat } from "node:fs/promises";
import type { AnalyzerContext, LanguageAnalyzer, RawImport } from "./analyzer";
import { countLines, type FileAnalysis, type FileImport, type SymbolFacts } from "./ir";
import { dirOf, extensionOf } from "./paths";
import { analyzerForPath, listAnalyzers } from "./registry";
import { diskSourceTree, gitSourceTree, type SourceTree } from "./source-tree";
import { splitLargeModules } from "./split-modules";
import { buildSymbolGraph, type SymbolGraph } from "./symbols";
import { parseSource } from "./syntax/parse-pool";
import type { WalkOptions } from "./walk";

/** A folder-derived cluster — the "module" tier of §6.1. */
export interface ModuleCluster {
  /** Derived from the folder name (path-qualified when names would collide). */
  name: string;
  /**
   * Repo-relative folder the cluster was cut at (`""` for files in the repo
   * root); its path pattern is `<folder>/**`. Usually the first `depth`
   * segments of its files' directory, deeper for JVM source roots (see
   * {@link clusterByFolderDepth}).
   */
  folder: string;
  /** Repo-relative paths of the analyzed files belonging to this module. */
  filePaths: string[];
  /**
   * Set on a part split off a large flat folder by name (./split-modules.ts):
   * it shares `folder` with the module it came from, so its path patterns
   * are its files, not `<folder>/**`.
   */
  exactFiles?: true;
}

/** Resolved file-to-file import edge. */
export interface ImportEdge {
  from: string;
  to: string;
  kind: FileImport["kind"];
  /**
   * How much `from` uses `to`: the lines it refers to `to`'s names on, for
   * languages with names; 1 otherwise.
   */
  weight?: number;
  /** Every import of `to` in `from` is type-only (`import type`): no runtime dependency. */
  typeOnly?: true;
}

export interface AnalysisResult {
  files: FileAnalysis[];
  /** Resolved file-to-file import edges (calls between declarations are in `symbols`). */
  edges: ImportEdge[];
  /** Folder-based clustering at `moduleDepth` (§6, §6.1), oversized modules split (./split-modules.ts). */
  modules: ModuleCluster[];
  /** Unresolved import specifiers, deduped — the grouped "external" nodes of §5. */
  externalPackages: string[];
  /** Declarations, uses and calls across files (./symbols.ts) — TS/JS, Python, Java, Kotlin. */
  symbols: SymbolGraph;
  /** Files counted but not parsed. */
  skipped: { binary: number; large: number; failed: number };
  /** Files whose parse came from the cache. */
  cached: number;
}

/**
 * DESIGN.md §6 leaves the "top-N folder depth" configurable; 2 is the sensible
 * default (`src/auth/**` → "auth", `lib/analysis/**` → "analysis").
 */
export const DEFAULT_MODULE_DEPTH = 2;

/** Files larger than this are counted but not parsed (generated/vendored blobs). */
const DEFAULT_MAX_FILE_BYTES = 1_500_000;

/** How many files to look up in the parse cache at once. */
const READ_CONCURRENCY = 24;

/**
 * Bumped whenever what a parse produces changes (queries, extractors, the
 * cached shape), so stale cache entries are never read back.
 */
export const PARSE_VERSION = 2;

/** What a file's own syntax says — the cached unit. */
export interface CachedParse {
  raws: RawImport[];
  declares?: string[];
  symbols?: SymbolFacts;
  loc: number;
}

/** Parse results by key; the app keeps them in SQLite (lib/db). */
export interface ParseCache {
  getMany(keys: readonly string[]): Promise<Map<string, CachedParse>>;
  setMany(entries: ReadonlyArray<[string, CachedParse]>): Promise<void>;
}

export interface AnalyzeRepoOptions extends WalkOptions {
  /** Folder depth used for the module tier. Defaults to {@link DEFAULT_MODULE_DEPTH}. */
  moduleDepth?: number;
  /** Skip parsing files bigger than this many bytes. */
  maxFileBytes?: number;
  /** Progress callback, useful when driving this from a background job. */
  onProgress?: (progress: { analyzed: number; total: number; file: string }) => void;
  /** Reuse parses by blob id (only trees that know blob ids — commits — use it). */
  cache?: ParseCache;
}

/** Name used for files that sit directly in the repo root. */
export const ROOT_MODULE_NAME = "(root)";

/** Every repo-relative path a specifier resolves to (usually zero or one). */
function resolveTargets(
  analyzer: LanguageAnalyzer,
  raw: string,
  fromFile: string,
  ctx: AnalyzerContext,
): string[] {
  if (analyzer.resolveImportPaths) return analyzer.resolveImportPaths(raw, fromFile, ctx);
  const single = analyzer.resolveImportPath(raw, fromFile, ctx);
  return single ? [single] : [];
}

/** A file after parsing but before its imports are resolved. */
interface ParsedFile {
  analysis: FileAnalysis;
  analyzer: LanguageAnalyzer;
  raws: RawImport[];
}

function cacheKey(analyzer: LanguageAnalyzer, file: string, blob: string): string {
  return `${PARSE_VERSION}:${analyzer.id}:${extensionOf(file)}:${blob}`;
}

/** Parse one file's syntax: raw imports, JVM declarations and symbol facts. `null` when it can't be parsed. */
async function parseFile(analyzer: LanguageAnalyzer, file: string, source: string): Promise<CachedParse | null> {
  const ext = extensionOf(file);
  const loc = countLines(source);
  try {
    if (analyzer.analyzeSource) {
      const facts = analyzer.analyzeSource({ file, source });
      const symbols = analyzer.analyzeSymbols?.({ file, source });
      return { raws: facts.imports, ...(facts.declares?.length ? { declares: facts.declares } : {}), ...(symbols ? { symbols } : {}), loc };
    }
    if (!analyzer.grammarFor || !analyzer.queryPath) {
      throw new Error(`analyzer "${analyzer.id}" has neither analyzeSource nor a grammar`);
    }
    const { matches, symbols } = await parseSource({
      grammar: analyzer.grammarFor(ext),
      queryPath: analyzer.queryPath(),
      family: analyzer.symbolFamily,
      source,
    });
    const facts = analyzer.analyzeMatches
      ? analyzer.analyzeMatches(matches, { file, source })
      : analyzer.collectImports
        ? { imports: analyzer.collectImports(matches) }
        : null;
    if (!facts) throw new Error(`analyzer "${analyzer.id}" cannot collect imports`);
    return { raws: facts.imports, ...(facts.declares?.length ? { declares: facts.declares } : {}), ...(symbols ? { symbols } : {}), loc };
  } catch (error) {
    // A single unparseable file must not sink the whole repo analysis; it still
    // becomes a node in the graph, just without outgoing edges.
    console.warn(`[analysis] failed to parse ${file}: ${(error as Error).message}`);
    return null;
  }
}

function toParsed(analyzer: LanguageAnalyzer, file: string, parse: CachedParse | null, loc: number): ParsedFile {
  const ext = extensionOf(file);
  const analysis: FileAnalysis = {
    file,
    language: analyzer.languageId(ext),
    imports: [],
    loc: parse?.loc ?? loc,
  };
  if (parse?.declares && parse.declares.length > 0) analysis.declares = parse.declares;
  if (parse?.symbols) analysis.symbols = parse.symbols;
  return { analysis, analyzer, raws: parse?.raws ?? [] };
}

/** Resolve a parsed file's raw imports into IR imports (deduped, speculative ones pruned). */
function resolveFile(parsed: ParsedFile, ctx: AnalyzerContext): void {
  const { analysis, analyzer, raws } = parsed;
  const seen = new Set<string>();
  for (const raw of raws) {
    const resolved = resolveTargets(analyzer, raw.raw, analysis.file, ctx);
    if (raw.speculative && resolved.length === 0) continue;
    // One entry per resolved target (a Go package or a Java wildcard import fans
    // out to several files); an unresolved import is a single entry without a path.
    for (const resolvedPath of resolved.length > 0 ? resolved : [undefined]) {
      const key = `${raw.kind} ${raw.raw} ${resolvedPath ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      analysis.imports.push(
        resolvedPath
          ? { raw: raw.raw, resolvedPath, kind: raw.kind }
          : { raw: raw.raw, kind: raw.kind },
      );
    }
  }
}

/** Extensions whose files live in package folders under a JVM source root. */
const JVM_EXTENSIONS = new Set([".java", ".kt", ".kts", ".scala", ".groovy"]);
/** Language folder of a Maven/Gradle source set: `src/<set>/<lang>/`. */
const JVM_LANGUAGE_DIRS = new Set(["java", "kotlin", "scala", "groovy"]);

/** Where a JVM file's package path starts. */
interface JvmSourceRoot {
  /** Folder holding the source root's `src` (`""` at the repo root): one Gradle/Maven project. */
  project: string;
  /** `main`, `test`, `commonMain`, …; `undefined` for a bare `src/` root (Eclipse/Ant). */
  sourceSet?: string;
  /** `java`, `kotlin`, …; `undefined` for a bare `src/` root. */
  language?: string;
  /** The source root itself (`app/src/main/java`, `src`). */
  root: string;
  /** Package folders below the root (`["com", "acme", "shop", "cart"]`). */
  packageDirs: string[];
}

/**
 * Locate a JVM file's source root from its path alone (the stored graph that
 * `regroupRepo` re-clusters has no package declarations). Recognizes the
 * Maven/Gradle `<project>/src/<set>/<lang>/` layout first, then a bare
 * `<project>/src/` (Eclipse/Ant). `undefined` for non-JVM files and JVM files
 * outside any `src` folder.
 */
function jvmSourceRoot(filePath: string): JvmSourceRoot | undefined {
  if (!JVM_EXTENSIONS.has(extensionOf(filePath))) return undefined;
  const dir = dirOf(filePath);
  if (dir === "") return undefined;
  const segments = dir.split("/");
  const make = (srcIndex: number, rootLength: number, sourceSet?: string, language?: string): JvmSourceRoot => ({
    project: segments.slice(0, srcIndex).join("/"),
    sourceSet,
    language,
    root: segments.slice(0, rootLength).join("/"),
    packageDirs: segments.slice(rootLength),
  });
  for (let i = 0; i + 2 < segments.length; i++) {
    if (segments[i] === "src" && JVM_LANGUAGE_DIRS.has(segments[i + 2])) {
      return make(i, i + 3, segments[i + 1], segments[i + 2]);
    }
  }
  const src = segments.indexOf("src");
  return src === -1 ? undefined : make(src, src + 1);
}

/** Longest common leading run of the given segment lists. */
function commonPrefix(lists: readonly string[][]): string[] {
  if (lists.length === 0) return [];
  const prefix = lists[0].slice();
  for (const list of lists.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < list.length && prefix[i] === list[i]) i++;
    prefix.length = i;
  }
  return prefix;
}

/** A cluster before it is named. */
interface ClusterGroup {
  folder: string;
  /**
   * Display names from most to least preferred; the last is always unique
   * (the folder itself). A group moves down its list while its name collides.
   */
  names: string[];
  files: string[];
}

/** `cart`, `cart (test)`, `cart (test, kotlin)`. */
function withTags(base: string, tags: Array<string | undefined>): string {
  const kept = tags.filter((t): t is string => Boolean(t));
  return kept.length === 0 ? base : `${base} (${kept.join(", ")})`;
}

/**
 * Folder-based clustering at a fixed depth — the mechanical module tier of
 * §6.1. Applying this at a second, shallower depth is all the "domain tier"
 * needs structurally; naming it reliably is the part that needs AI (§6.1/§16).
 *
 * JVM sources are the exception: a fixed depth lands inside the build layout
 * (`app/src/main/java/com/acme/…` → everything in `app/src`). Their depth is
 * counted from below the source root *and* the package prefix every file of
 * that project shares, so `com/acme/shop/cart/Cart.java` clusters as `cart`
 * (and its tests as `cart (test)`).
 */
export function clusterByFolderDepth(filePaths: string[], depth: number): ModuleCluster[] {
  const effectiveDepth = Math.max(1, Math.floor(depth));
  const groups = new Map<string, ClusterGroup>();
  const add = (folder: string, names: string[], filePath: string) => {
    const group = groups.get(folder);
    if (group) group.files.push(filePath);
    else groups.set(folder, { folder, names: [...names, folder || ROOT_MODULE_NAME], files: [filePath] });
  };

  // The package prefix is shared per project, across its source sets and
  // languages, so main and test cut their packages at the same level.
  const jvmRoots = new Map<string, JvmSourceRoot>();
  const packagesByProject = new Map<string, string[][]>();
  for (const filePath of filePaths) {
    const root = jvmSourceRoot(filePath);
    if (!root) continue;
    jvmRoots.set(filePath, root);
    const lists = packagesByProject.get(root.project);
    if (lists) lists.push(root.packageDirs);
    else packagesByProject.set(root.project, [root.packageDirs]);
  }
  const prefixByProject = new Map<string, string[]>();
  for (const [project, lists] of packagesByProject) prefixByProject.set(project, commonPrefix(lists));

  for (const filePath of filePaths) {
    const jvm = jvmRoots.get(filePath);
    if (jvm) {
      const prefix = prefixByProject.get(jvm.project) ?? [];
      // `depth` 2 means "one level below the container", as for `src/auth`.
      const feature = jvm.packageDirs.slice(prefix.length, prefix.length + effectiveDepth - 1);
      const folder = [jvm.root, ...prefix, ...feature].join("/");
      const base = feature.join("/") || prefix[prefix.length - 1] || jvm.project.split("/").pop() || "src";
      const sourceSet = jvm.sourceSet === "main" ? undefined : jvm.sourceSet;
      const project = jvm.project ? `${jvm.project}/` : "";
      add(
        folder,
        [
          withTags(base, [sourceSet]),
          withTags(base, [sourceSet, jvm.language]),
          withTags(`${project}${base}`, [sourceSet]),
          withTags(`${project}${base}`, [sourceSet, jvm.language]),
        ],
        filePath,
      );
      continue;
    }
    const dir = dirOf(filePath);
    const folder = dir === "" ? "" : dir.split("/").slice(0, effectiveDepth).join("/");
    add(folder, [folder === "" ? ROOT_MODULE_NAME : (folder.split("/").pop() as string)], filePath);
  }

  // Name from the folder itself; qualify only the names that collide
  // (app/utils vs lib/utils → the full paths), until every name is unique.
  const all = [...groups.values()];
  const level = all.map(() => 0);
  for (;;) {
    const counts = new Map<string, number>();
    all.forEach((g, i) => counts.set(g.names[level[i]], (counts.get(g.names[level[i]]) ?? 0) + 1));
    let advanced = false;
    all.forEach((g, i) => {
      if ((counts.get(g.names[level[i]]) ?? 0) > 1 && level[i] < g.names.length - 1) {
        level[i]++;
        advanced = true;
      }
    });
    if (!advanced) break;
  }

  const modules: ModuleCluster[] = all.map((group, i) => ({
    name: group.names[level[i]],
    folder: group.folder,
    filePaths: group.files.slice().sort(),
  }));
  modules.sort((a, b) => a.name.localeCompare(b.name));
  return modules;
}


/**
 * Statically analyze a folder on disk (fixtures, scripts). The app analyses
 * commits instead — see {@link analyzeCommit}.
 *
 * @param rootDir Absolute (or cwd-relative) path to the repository root.
 */
export async function analyzeRepo(
  rootDir: string,
  options: AnalyzeRepoOptions = {},
): Promise<AnalysisResult> {
  const rootStat = await stat(rootDir).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    throw new Error(`analyzeRepo: "${rootDir}" is not a directory`);
  }
  const tree = await diskSourceTree(rootDir, options);
  try {
    return await analyzeTree(tree, options);
  } finally {
    tree.close();
  }
}

/**
 * Statically analyze one commit of the git repository at `repoDir`, read
 * from git's object store — the checkout's working files are never looked
 * at, so uncommitted edits, untracked and ignored files don't count.
 */
export async function analyzeCommit(
  repoDir: string,
  sha: string,
  options: AnalyzeRepoOptions = {},
): Promise<AnalysisResult> {
  const tree = await gitSourceTree(repoDir, sha, options);
  try {
    return await analyzeTree(tree, options);
  } finally {
    tree.close();
  }
}

/** The core: parse (or reuse) every file, resolve imports and names, cluster. */
export async function analyzeTree(tree: SourceTree, options: AnalyzeRepoOptions = {}): Promise<AnalysisResult> {
  const allFiles = tree.files;
  const ctx: AnalyzerContext = {
    rootDir: tree.rootDir,
    files: new Set(allFiles),
    cache: new Map(),
    readText: (relPath) => tree.readConfig(relPath),
  };

  for (const analyzer of listAnalyzers()) {
    await analyzer.prepare?.(ctx);
  }

  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const targets = allFiles
    .map((file) => ({ file, analyzer: analyzerForPath(file) }))
    .filter((t): t is { file: string; analyzer: LanguageAnalyzer } => t.analyzer !== undefined);

  const parsedFiles: ParsedFile[] = [];
  let cached = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i += READ_CONCURRENCY) {
    const batch = targets.slice(i, i + READ_CONCURRENCY);
    const keys = batch.map(({ file, analyzer }) => {
      const blob = tree.blobOf(file);
      return blob ? cacheKey(analyzer, file, blob) : undefined;
    });
    const hits = options.cache
      ? await options.cache.getMany(keys.filter((k): k is string => Boolean(k)))
      : new Map<string, CachedParse>();
    const fresh: Array<[string, CachedParse]> = [];
    for (let j = 0; j < batch.length; j++) {
      const { file, analyzer } = batch[j];
      const key = keys[j];
      const hit = key ? hits.get(key) : undefined;
      if (hit) {
        cached++;
        parsedFiles.push(toParsed(analyzer, file, hit, hit.loc));
      } else {
        const source = await tree.read(file, maxFileBytes);
        if (source === null) continue;
        const parse = await parseFile(analyzer, file, source);
        if (!parse) failed++;
        else if (key) fresh.push([key, parse]);
        parsedFiles.push(toParsed(analyzer, file, parse, countLines(source)));
      }
      options.onProgress?.({ analyzed: parsedFiles.length, total: targets.length, file });
    }
    if (options.cache && fresh.length > 0) await options.cache.setMany(fresh);
  }

  // Every file is parsed now: publish the declarations, let analyzers index them
  // (JVM: fully-qualified name -> file), then resolve all imports against that.
  const declarations = new Map<string, readonly string[]>();
  for (const { analysis } of parsedFiles) {
    if (analysis.declares) declarations.set(analysis.file, analysis.declares);
  }
  ctx.declarations = declarations;
  for (const analyzer of listAnalyzers()) analyzer.indexDeclarations?.(ctx);

  const files: FileAnalysis[] = [];
  for (const parsed of parsedFiles) {
    resolveFile(parsed, ctx);
    files.push(parsed.analysis);
  }

  const symbols = buildSymbolGraph(files, ctx, analyzerForPath);
  const declFile = new Map(symbols.decls.map((d) => [d.id, d.file]));
  const weights = new Map<string, number>();
  for (const use of symbols.uses) {
    const to = declFile.get(use.target);
    if (!to || to === use.file) continue;
    const key = `${use.file}\u0000${to}`;
    weights.set(key, (weights.get(key) ?? 0) + Math.max(1, use.lines.length));
  }
  const typeOnly = new Set(symbols.typeOnlyEdges);

  const analyzedFiles = new Set(files.map((f) => f.file));
  const edgeKeys = new Set<string>();
  const edges: ImportEdge[] = [];
  const externals = new Set<string>();

  for (const analysis of files) {
    const analyzer = analyzerForPath(analysis.file);
    for (const imported of analysis.imports) {
      if (imported.resolvedPath) {
        // Edges connect nodes that exist: a resolved path pointing at a file no
        // analyzer handles (a .css or .json asset) stays in the IR but is not an edge.
        if (imported.resolvedPath === analysis.file) continue;
        if (!analyzedFiles.has(imported.resolvedPath)) continue;
        const key = `${analysis.file}\u0000${imported.resolvedPath}\u0000${imported.kind}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        const pair = `${analysis.file}\u0000${imported.resolvedPath}`;
        edges.push({
          from: analysis.file,
          to: imported.resolvedPath,
          kind: imported.kind,
          weight: weights.get(pair) ?? 1,
          ...(typeOnly.has(pair) ? { typeOnly: true as const } : {}),
        });
        continue;
      }
      const external = analyzer?.externalPackageName(imported.raw, ctx);
      if (external) externals.add(external);
    }
  }

  edges.sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
  );
  files.sort((a, b) => a.file.localeCompare(b.file));

  return {
    files,
    edges,
    modules: splitLargeModules(
      clusterByFolderDepth(
        files.map((f) => f.file),
        options.moduleDepth ?? DEFAULT_MODULE_DEPTH,
      ),
      edges,
    ),
    externalPackages: [...externals].sort(),
    symbols,
    skipped: { ...tree.skipped, failed },
    cached,
  };
}
