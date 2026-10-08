/**
 * Static analysis engine.
 *
 * Self-contained by design: it takes a directory path and returns an in-memory
 * result. It knows nothing about the database, GitHub, jobs or the AI provider.
 *
 * ```ts
 * import { analyzeCommit } from "@/lib/analysis";
 * const result = await analyzeCommit("/data/repos/abc123", sha, { cache });
 * ```
 */
export {
  countLines,
  type CallFact,
  type DeclFact,
  type DeclKind,
  type FileAnalysis,
  type FileImport,
  type ImportFact,
  type SymbolFacts,
} from "./ir";
export {
  analyzeCommit,
  analyzeRepo,
  analyzeTree,
  PARSE_VERSION,
  type CachedParse,
  type ParseCache,
  clusterByFolderDepth,
  DEFAULT_MODULE_DEPTH,
  ROOT_MODULE_NAME,
  type AnalysisResult,
  type AnalyzeRepoOptions,
  type ImportEdge,
  type ModuleCluster,
} from "./graph-builder";
export { MAX_MODULE_FILES, nameStem, splitLargeModules } from "./split-modules";
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
export { diskSourceTree, gitSourceTree, isGitRepo, type SourceTree } from "./source-tree";
export type { DeadImport, SymbolCall, SymbolDecl, SymbolGraph, SymbolUse } from "./symbols";
export { disposeTreeSitter, initTreeSitter, withSyntaxTree } from "./tree-sitter";
export { dirOf, extensionOf, joinPosix, repoRelative, toPosix } from "./paths";
export {
  buildCallGraph,
  compareStructure,
  findMovedDeclarations,
  parseChangedLines,
  type CallGraph,
  type CallGraphEdge,
  type CallGraphFunction,
  type ChangedLines,
  type FunctionStatus,
  type NewCycle,
  type StructureChange,
} from "./compare";
