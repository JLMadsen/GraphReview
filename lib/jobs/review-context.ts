// Related-code context for one component's review, by effort level
// (lib/ai/effort.ts):
//
//   medium  neighbouring components' descriptions (one query, no disk reads)
//   high    + declaration signatures from "related files": files that the
//             changed files import, or that import them (the file-level
//             IMPORTS edges static analysis stored) — in any component,
//             including the reviewed one, but never a file the diff changed
//   max     + the full source of those files' declarations that the diff
//             mentions by name
//
// Related files are read at the reviewed head commit when the job could open
// it (./head-source.ts), so a caller the PR already updated reads as updated
// and a callee shows its new signature. Failing that, they are read from the
// checkout on disk — the local path, or the app-managed clone of the default
// branch; if that is missing too, the review goes ahead without file context.
//
// Declarations are found with a deliberately simple, language-agnostic
// line matcher rather than tree-sitter: the output is context for a model,
// not an index, and a missed or extra declaration costs a few tokens, not
// correctness. Best-effort throughout — nothing here ever fails a review.

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ReviewEffortSettings, ReviewNeighbor, ReviewRelatedContext, ReviewRelatedFile } from "@/lib/ai";
import { listComponentNeighbours, listRelatedFiles } from "@/lib/db";
import type { RepoRecord } from "@/lib/db";
import type { JobLogger } from "./analyze";
import type { HeadSource } from "./head-source";
import type { compareApis } from "@/lib/analysis/api/compare";
import type { compareInfra } from "@/lib/analysis/infra/compare";
import type { compareSchemas } from "@/lib/analysis/db/compare";
import { describeDbFinding, reviewTables, schemaFindingsTouching, tablesTouching } from "@/lib/analysis/db/describe";
import { describeInfraChangeEntry, describeInfraFinding, infraChangesTouching } from "@/lib/analysis/infra/describe";
import { changesTouching, describeEndpointChange, describeLogicChange, logicTouching } from "@/lib/analysis/api/describe";
import { blockDiff, symbolRelatedFiles, type MovedCode, type TargetAnalyses } from "./symbol-context";
import type { loadOwnerNames } from "./review-target";
import { repoCacheDir, validateLocalRepoPath } from "./source";

/** Related files per component, nearest relation first ("imported" before "importer"). */
const MAX_RELATED_FILES = 16;
/** Files bigger than this are skipped rather than read — generated bundles, fixtures. */
const MAX_FILE_BYTES = 400_000;
const MAX_SIGNATURES_PER_FILE = 40;
const MAX_SNIPPETS_PER_FILE = 5;
const MAX_SNIPPET_LINES = 80;
/** Declarations indented deeper than this are locals, not API. */
const MAX_DECLARATION_INDENT = 4;

// ---------------------------------------------------------------------------
// Graph queries
// ---------------------------------------------------------------------------

async function loadNeighbors(repoId: string, componentId: string): Promise<ReviewNeighbor[]> {
  return listComponentNeighbours(repoId, componentId);
}

interface RelatedFileRef {
  path: string;
  componentName: string;
  relation: ReviewRelatedFile["relation"];
}

async function loadRelatedFiles(
  repoId: string,
  componentId: string,
  changedPaths: readonly string[]
): Promise<RelatedFileRef[]> {
  const rows = await listRelatedFiles(repoId, componentId, changedPaths);
  const seen = new Set<string>();
  const refs: RelatedFileRef[] = [];
  for (const row of rows) {
    if (seen.has(row.path)) continue;
    seen.add(row.path);
    refs.push(row);
  }
  return refs.slice(0, MAX_RELATED_FILES);
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

export interface Declaration {
  name: string;
  /** 0-based line index. */
  line: number;
  indent: number;
  signature: string;
}

const DECLARATION_PATTERNS: RegExp[] = [
  // JS/TS: functions, classes, interfaces, types, enums, top-level bindings.
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  // Python
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^class\s+([A-Za-z_]\w*)/,
  // Go
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^type\s+([A-Za-z_]\w*)/,
  // Rust. `const`/`static` only when `pub`: bare `const x = …` is far more
  // often a JS/TS local than a Rust item.
  /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/,
  /^pub(?:\([^)]*\))?\s+(?:const|static)\s+([A-Za-z_]\w*)/,
  // Kotlin / Java types and Kotlin functions
  /^(?:(?:public|protected|private|internal|open|abstract|final|static|override|data|sealed|suspend|inline)\s+)*(?:fun|class|interface|object|enum\s+class|record|enum)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/,
  // Java methods: modifiers, a return type, a name, an opening paren.
  /^(?:(?:public|protected|private|static|final|abstract|synchronized|default)\s+)+[\w<>[\],.?\s]+?\s+([A-Za-z_]\w*)\s*\(/,
];

function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line)![0];
  return match.replace(/\t/g, "    ").length;
}

/** Declaration line, minus its body opener, on one line. */
function toSignature(line: string): string {
  return line
    .trim()
    .replace(/\s*\{\s*$/, "")
    .replace(/\s*=>\s*$/, " =>")
    .replace(/:\s*$/, ":");
}

export function extractDeclarations(source: string): Declaration[] {
  const lines = source.split(/\r?\n/);
  const declarations: Declaration[] = [];
  lines.forEach((line, index) => {
    const indent = indentOf(line);
    if (indent > MAX_DECLARATION_INDENT) return;
    const trimmed = line.trim();
    for (const pattern of DECLARATION_PATTERNS) {
      const match = pattern.exec(trimmed);
      if (match?.[1]) {
        declarations.push({ name: match[1], line: index, indent, signature: toSignature(line) });
        return;
      }
    }
  });
  return declarations;
}

/**
 * The declaration's full text: its line, every following line indented
 * deeper (or blank), and one closing line at the same indent (`}`, `)`,
 * `end`…). Works for brace languages formatted the usual way and for
 * indentation-scoped ones alike.
 */
export function declarationBlock(lines: string[], declaration: Declaration): string {
  const out = [lines[declaration.line]];
  let index = declaration.line + 1;
  for (; index < lines.length && out.length < MAX_SNIPPET_LINES; index++) {
    const line = lines[index];
    if (line.trim() === "" || indentOf(line) > declaration.indent) {
      out.push(line);
      continue;
    }
    if (/^\s*(?:[}\])]|end\b)/.test(line)) out.push(line);
    break;
  }
  while (out.length > 1 && out[out.length - 1].trim() === "") out.pop();
  if (out.length >= MAX_SNIPPET_LINES && index < lines.length) out.push("… (truncated)");
  return out.join("\n");
}

/** Identifiers on the diff's added/removed lines — what the change actually refers to. */
export function diffIdentifiers(patches: readonly string[]): Set<string> {
  const identifiers = new Set<string>();
  for (const patch of patches) {
    for (const line of patch.split("\n")) {
      if (!/^[+-]/.test(line) || /^(?:\+\+\+|---)/.test(line)) continue;
      for (const match of line.slice(1).matchAll(/[A-Za-z_$][\w$]{2,}/g)) identifiers.add(match[0]);
    }
  }
  return identifiers;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export async function sourceDir(repo: RepoRecord): Promise<string | null> {
  try {
    const dir =
      repo.provider === "local" && repo.localPath
        ? await validateLocalRepoPath(repo.localPath)
        : repoCacheDir(repo.id);
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

export async function readRepoFile(dir: string, relativePath: string): Promise<string | null> {
  const resolved = path.resolve(dir, relativePath);
  // Stored paths come from our own analysis, but never read outside the repo.
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
  try {
    const info = await stat(resolved);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(resolved, "utf8");
  } catch {
    return null;
  }
}

export interface GatherRelatedContextInput {
  repo: RepoRecord;
  componentId: string;
  changedPaths: readonly string[];
  patches: readonly string[];
  settings: ReviewEffortSettings;
  /** Read related files at the reviewed head when given; else from the checkout on disk. */
  head?: HeadSource | null;
  /**
   * Related files found from names (lib/jobs/symbol-context.ts: definitions
   * the changed lines use, callers of what changed). They come first; the
   * import-hop files below fill the remaining slots.
   */
  symbolFiles?: ReviewRelatedFile[];
  log: JobLogger;
}

/** `undefined` when the effort level asks for nothing beyond the diff (low). */
export async function gatherRelatedContext({
  repo,
  componentId,
  changedPaths,
  patches,
  settings,
  head,
  symbolFiles,
  log,
}: GatherRelatedContextInput): Promise<ReviewRelatedContext | undefined> {
  if (!settings.neighborDescriptions && !settings.signatures && !settings.relatedSource) {
    return undefined;
  }
  const context: ReviewRelatedContext = {};

  if (settings.neighborDescriptions) {
    try {
      context.neighbors = await loadNeighbors(repo.id, componentId);
    } catch (error) {
      log(`neighbour lookup failed (continuing without it): ${(error as Error).message}`);
    }
  }

  if (settings.signatures || settings.relatedSource) {
    try {
      const dir = head ? head.dir : await sourceDir(repo);
      const read = (filePath: string) => (head ? head.read(filePath) : readRepoFile(dir!, filePath));
      const refs = dir ? await loadRelatedFiles(repo.id, componentId, changedPaths) : [];
      const identifiers = settings.relatedSource ? diffIdentifiers(patches) : new Set<string>();
      const files: ReviewRelatedFile[] = [];
      for (const ref of refs) {
        const source = await read(ref.path);
        if (source === null) continue;
        const declarations = extractDeclarations(source);
        const lines = source.split(/\r?\n/);
        const snippets = settings.relatedSource
          ? declarations
              .filter((declaration) => identifiers.has(declaration.name))
              .slice(0, MAX_SNIPPETS_PER_FILE)
              .map((declaration) => ({
                name: declaration.name,
                code: declarationBlock(lines, declaration),
              }))
          : [];
        const signatures = settings.signatures
          ? declarations.slice(0, MAX_SIGNATURES_PER_FILE).map((d) => d.signature)
          : [];
        if (signatures.length > 0 || snippets.length > 0) {
          files.push({ ...ref, signatures, snippets });
        }
      }
      const named = symbolFiles ?? [];
      const namedPaths = new Set(named.map((f) => f.path));
      context.files = [...named, ...files.filter((f) => !namedPaths.has(f.path))].slice(0, MAX_RELATED_FILES);
      if (!dir) log("no checkout on disk — reviewing without related-file context");
    } catch (error) {
      log(`related-file lookup failed (continuing without it): ${(error as Error).message}`);
    }
  }

  return context;
}

// --- Everything one component's review sees beyond its diff -----------------

/** What the target does as a whole, worked out once per review run; each component's review sees the parts that touch its files. */
export interface TargetChangeContext {
  analyses: TargetAnalyses | null;
  head: HeadSource | null;
  ownerNames: Awaited<ReturnType<typeof loadOwnerNames>> | null;
  /** Code moved to another file and changed on the way. */
  moved: readonly MovedCode[];
  apiChange: ReturnType<typeof compareApis> | null;
  infraChange: ReturnType<typeof compareInfra> | null;
  infraChanged: boolean;
  dbChange: ReturnType<typeof compareSchemas> | null;
}

/**
 * One component's related context: the related code by effort level
 * ({@link gatherRelatedContext}), plus the code moved into or out of its
 * files, the endpoints it serves or sits behind, the infra changes to its
 * files and workloads, the tables its code touches (DESIGN.md §6.13 §6), and
 * the certain infra and schema findings already reported for them.
 */
export async function componentReviewContext({
  repo,
  componentId,
  paths,
  patches,
  settings,
  target,
  log,
}: {
  repo: RepoRecord;
  componentId: string;
  paths: string[];
  patches: string[];
  settings: ReviewEffortSettings;
  target: TargetChangeContext;
  log: JobLogger;
}): Promise<ReviewRelatedContext | undefined> {
  const { analyses, head, ownerNames, moved, apiChange, infraChange, infraChanged, dbChange } = target;
  const symbolFiles =
    analyses && head && ownerNames && (settings.signatures || settings.relatedSource)
      ? await symbolRelatedFiles(analyses, paths, ownerNames, (path) => head.read(path), {
          signatures: settings.signatures,
          source: settings.relatedSource,
        })
      : undefined;
  const related = await gatherRelatedContext({
    repo,
    componentId,
    changedPaths: paths,
    patches,
    settings,
    head,
    symbolFiles,
    log,
  });
  const componentMoves = moved
    .filter((m) => paths.includes(m.from) || paths.includes(m.to))
    .map((m) => ({ name: m.name, from: m.from, to: m.to, diff: blockDiff(m.before, m.after) }));
  const pathSet = new Set(paths);
  const componentEndpoints = apiChange
    ? [
        ...changesTouching(apiChange, pathSet).slice(0, 12).map(describeEndpointChange),
        ...logicTouching(apiChange, pathSet).slice(0, 8).map(describeLogicChange),
      ]
    : [];
  const componentInfra = infraChange && infraChanged ? infraChangesTouching(infraChange, analyses?.head.infra, pathSet) : null;
  const infraLines = componentInfra ? [...componentInfra.entries.slice(0, 15).map((e) => describeInfraChangeEntry(e)), ...componentInfra.links.slice(0, 10)] : [];
  const tableIds = analyses ? tablesTouching(analyses.head.db, dbChange ?? undefined, pathSet) : [];
  const tables = tableIds.length ? reviewTables(tableIds, analyses?.head.db, dbChange ?? undefined, pathSet).slice(0, 30) : [];
  const alreadyReported = [
    ...(componentInfra ? componentInfra.findings.map(describeInfraFinding) : []),
    ...(dbChange ? schemaFindingsTouching(dbChange, tableIds, pathSet).map(describeDbFinding) : []),
  ];
  return componentMoves.length > 0 || componentEndpoints.length > 0 || infraLines.length > 0 || alreadyReported.length > 0 || tables.length > 0
    ? {
        ...(related ?? {}),
        ...(componentMoves.length ? { moves: componentMoves } : {}),
        ...(componentEndpoints.length ? { endpoints: componentEndpoints } : {}),
        ...(infraLines.length ? { infra: infraLines } : {}),
        ...(alreadyReported.length ? { alreadyReported } : {}),
        ...(tables.length ? { tables } : {}),
      }
    : related;
}


/** How much of a README is worth sending as repo context. */
export const README_CHARS = 800;


export const README_CANDIDATES = ["README.md", "readme.md", "README", "Readme.md", "README.rst"];

/**
 * A short README excerpt, if one can be read cheaply — sending
 * "perhaps a README/package.json snippet" alongside the paths.
 *
 * Entirely best-effort: a repo whose source isn't on disk (never cloned, or
 * a local path that no longer exists) simply gets labeled from its
 * module names and paths, which is the input the feature is designed around
 * anyway. Never throws.
 */
export async function readReadmeSnippet(repo: RepoRecord, log: JobLogger): Promise<string | undefined> {
  let dir: string | undefined;
  try {
    dir = repo.provider === "local" && repo.localPath
      ? await validateLocalRepoPath(repo.localPath)
      : repoCacheDir(repo.id);
  } catch {
    return undefined;
  }
  if (!dir) return undefined;

  for (const candidate of README_CANDIDATES) {
    try {
      const text = await readFile(path.join(dir, candidate), "utf8");
      const snippet = text.slice(0, README_CHARS).trim();
      if (snippet.length > 0) {
        log(`using ${candidate} as repo context (${snippet.length} chars)`);
        return snippet;
      }
    } catch {
      /* next candidate */
    }
  }
  return undefined;
}
