/**
 * Static analysis engine.
 *
 * Self-contained by design: it takes a directory path and returns an in-memory
 * result. It knows nothing about Neo4j, GitHub, jobs or the AI provider.
 *
 * ```ts
 * import { analyzeRepo } from "@/lib/analysis";
 * const result = await analyzeRepo("/data/repos/abc123", { moduleDepth: 2 });
 * ```
 */
export { countLines, type FileAnalysis, type FileImport } from "./ir";
export {
  analyzeRepo,
  clusterByFolderDepth,
  DEFAULT_MODULE_DEPTH,
  ROOT_MODULE_NAME,
  type AnalysisResult,
  type AnalyzeRepoOptions,
  type ImportEdge,
  type ModuleCluster,
} from "./graph-builder";
export {
  analyzedExtensions,
  analyzerForExtension,
  analyzerForPath,
  listAnalyzers,
  registerAnalyzer,
} from "./registry";
export {
  type AnalyzerContext,
  type GrammarSpec,
  type LanguageAnalyzer,
  type QueryCaptureData,
  type QueryMatchData,
  type RawImport,
} from "./analyzer";
export { DEFAULT_IGNORED_DIRS, walkRepo, type WalkOptions } from "./walk";
export { disposeTreeSitter, initTreeSitter } from "./tree-sitter";
export { dirOf, extensionOf, joinPosix, repoRelative, toPosix } from "./paths";
