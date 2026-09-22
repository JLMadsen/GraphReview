/**
 * Repo → import graph → folder clusters (DESIGN.md §5, §6, §6.1).
 *
 * `analyzeRepo` is the single entry point of this package. It is deliberately
 * self-contained: a local directory path goes in, an in-memory
 * {@link AnalysisResult} comes out. Persisting that to Neo4j, LLM-labeling the
 * clusters and the domain tier of §6.1 all happen elsewhere.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AnalyzerContext, LanguageAnalyzer, RawImport, SyntaxFacts } from "./analyzer";
import { countLines, type FileAnalysis, type FileImport } from "./ir";
import { dirOf, extensionOf } from "./paths";
import { analyzerForPath, listAnalyzers } from "./registry";
import { runQuery } from "./tree-sitter";
import { walkRepo, type WalkOptions } from "./walk";

/** A folder-derived cluster — the "module" tier of §6.1. */
export interface ModuleCluster {
  /** Derived from the folder name (path-qualified when names would collide). */
  name: string;
  /** Repo-relative paths of the analyzed files belonging to this module. */
  filePaths: string[];
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
  /** Folder-based clustering at `moduleDepth` (§6, §6.1). */
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

/**
 * Folder-based clustering at a fixed depth — the mechanical module tier of
 * §6.1. Applying this at a second, shallower depth is all the "domain tier"
 * needs structurally; naming it reliably is the part that needs AI (§6.1/§16).
 */
export function clusterByFolderDepth(filePaths: string[], depth: number): ModuleCluster[] {
  const effectiveDepth = Math.max(1, Math.floor(depth));
  const groups = new Map<string, string[]>();
  for (const filePath of filePaths) {
    const dir = dirOf(filePath);
    const key = dir === "" ? "" : dir.split("/").slice(0, effectiveDepth).join("/");
    const bucket = groups.get(key);
    if (bucket) bucket.push(filePath);
    else groups.set(key, [filePath]);
  }

  // Name from the folder itself; fall back to the qualified path when two
  // different folders would otherwise produce the same name (app/utils vs lib/utils).
  const leafCounts = new Map<string, number>();
  for (const key of groups.keys()) {
    const leaf = key === "" ? ROOT_MODULE_NAME : (key.split("/").pop() as string);
    leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1);
  }

  const modules: ModuleCluster[] = [];
  for (const [key, files] of groups) {
    const leaf = key === "" ? ROOT_MODULE_NAME : (key.split("/").pop() as string);
    modules.push({
      name: (leafCounts.get(leaf) ?? 0) > 1 ? key : leaf,
      filePaths: files.slice().sort(),
    });
  }
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
    modules: clusterByFolderDepth(
      files.map((f) => f.file),
      options.moduleDepth ?? DEFAULT_MODULE_DEPTH,
    ),
    externalPackages: [...externals].sort(),
  };
}
