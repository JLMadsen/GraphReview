/**
 * Repo → import graph → folder clusters (DESIGN.md §5, §6, §6.1).
 *
 * `analyzeRepo` is the single entry point of this package. It is deliberately
 * self-contained: a local directory path goes in, an in-memory
 * {@link AnalysisResult} comes out. Persisting that to the database, LLM-labeling the
 * clusters and the domain tier of §6.1 all happen elsewhere.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AnalyzerContext, LanguageAnalyzer, RawImport, SyntaxFacts } from "./analyzer";
import { countLines, type FileAnalysis, type FileImport } from "./ir";
import { dirOf, extensionOf } from "./paths";
import { analyzerForPath, listAnalyzers } from "./registry";
import { runQuery } from "./tree-sitter";
import { splitLargeModules } from "./split-modules";
import { walkRepo, type WalkOptions } from "./walk";

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
}

export interface AnalysisResult {
  files: FileAnalysis[];
  /** Resolved file-to-file import edges only — no call-graph edges in v1 (§5). */
  edges: ImportEdge[];
  /** Folder-based clustering at `moduleDepth` (§6, §6.1), oversized modules split (./split-modules.ts). */
  modules: ModuleCluster[];
  /** Unresolved import specifiers, deduped — the grouped "external" nodes of §5. */
  externalPackages: string[];
}

/**
 * DESIGN.md §6 leaves the "top-N folder depth" configurable; 2 is the sensible
 * default (`src/auth/**` → "auth", `lib/analysis/**` → "analysis").
 */
export const DEFAULT_MODULE_DEPTH = 2;

/** Files larger than this are counted but not parsed (generated/vendored blobs). */
const DEFAULT_MAX_FILE_BYTES = 1_500_000;

/** How many files to read from disk concurrently; parsing itself is synchronous. */
const READ_CONCURRENCY = 24;

export interface AnalyzeRepoOptions extends WalkOptions {
  /** Folder depth used for the module tier. Defaults to {@link DEFAULT_MODULE_DEPTH}. */
  moduleDepth?: number;
  /** Skip parsing files bigger than this many bytes. */
  maxFileBytes?: number;
  /** Progress callback, useful when driving this from a background job. */
  onProgress?: (progress: { analyzed: number; total: number; file: string }) => void;
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

/** Extract the raw imports (and declarations) of one file; resolution happens later. */
async function parseFile(
  analyzer: LanguageAnalyzer,
  file: string,
  source: string,
): Promise<ParsedFile> {
  const ext = extensionOf(file);
  const analysis: FileAnalysis = {
    file,
    language: analyzer.languageId(ext),
    imports: [],
    loc: countLines(source),
  };

  let facts: SyntaxFacts;
  try {
    if (analyzer.analyzeSource) {
      facts = analyzer.analyzeSource({ file, source });
    } else {
      if (!analyzer.grammarFor || !analyzer.queryPath) {
        throw new Error(`analyzer "${analyzer.id}" has neither analyzeSource nor a grammar`);
      }
      const matches = await runQuery(analyzer.grammarFor(ext), analyzer.queryPath(), source);
      if (analyzer.analyzeMatches) {
        facts = analyzer.analyzeMatches(matches, { file, source });
      } else if (analyzer.collectImports) {
        facts = { imports: analyzer.collectImports(matches) };
      } else {
        throw new Error(`analyzer "${analyzer.id}" cannot collect imports`);
      }
    }
  } catch (error) {
    // A single unparseable file must not sink the whole repo analysis; it still
    // becomes a node in the graph, just without outgoing edges.
    console.warn(`[analysis] failed to parse ${file}: ${(error as Error).message}`);
    return { analysis, analyzer, raws: [] };
  }

  if (facts.declares && facts.declares.length > 0) analysis.declares = facts.declares;
  return { analysis, analyzer, raws: facts.imports };
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
 * Statically analyze a checkout on disk into an import graph plus its
 * folder-based module clustering.
 *
 * @param rootDir Absolute (or cwd-relative) path to the repository root.
 */
export async function analyzeRepo(
  rootDir: string,
  options: AnalyzeRepoOptions = {},
): Promise<AnalysisResult> {
  const root = path.resolve(rootDir);
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    throw new Error(`analyzeRepo: "${rootDir}" is not a directory`);
  }

  const allFiles = await walkRepo(root, options);
  const ctx: AnalyzerContext = {
    rootDir: root,
    files: new Set(allFiles),
    cache: new Map(),
  };

  for (const analyzer of listAnalyzers()) {
    await analyzer.prepare?.(ctx);
  }

  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const targets = allFiles
    .map((file) => ({ file, analyzer: analyzerForPath(file) }))
    .filter((t): t is { file: string; analyzer: LanguageAnalyzer } => t.analyzer !== undefined);

  const parsedFiles: ParsedFile[] = [];
  for (let i = 0; i < targets.length; i += READ_CONCURRENCY) {
    const batch = targets.slice(i, i + READ_CONCURRENCY);
    const sources = await Promise.all(
      batch.map(async ({ file }) => {
        try {
          const absolute = path.join(root, file);
          const info = await stat(absolute);
          if (info.size > maxFileBytes) return undefined;
          return await readFile(absolute, "utf8");
        } catch {
          return undefined;
        }
      }),
    );
    for (let j = 0; j < batch.length; j++) {
      const source = sources[j];
      if (source === undefined) continue;
      const { file, analyzer } = batch[j];
      parsedFiles.push(await parseFile(analyzer, file, source));
      options.onProgress?.({ analyzed: parsedFiles.length, total: targets.length, file });
    }
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
        const key = `${analysis.file} ${imported.resolvedPath} ${imported.kind}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({ from: analysis.file, to: imported.resolvedPath, kind: imported.kind });
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
  };
}
