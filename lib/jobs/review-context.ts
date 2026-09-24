// Related-code context for one component's review, by effort level
// (lib/ai/effort.ts):
//
//   medium  neighbouring components' descriptions (one query, no disk reads)
//   high    + declaration signatures from "related files": files in *other*
//             components that the changed files import, or that import them
//             (the file-level IMPORTS edges static analysis stored)
//   max     + the full source of those files' declarations that the diff
//             mentions by name
//
// Related files are read from the repo's checkout on disk — the local path,
// or the app-managed clone of the default branch — not from the reviewed
// ref. Neighbouring code usually isn't what the PR changed, so the default
// branch is a fair picture of it; if the checkout is missing, the review
// simply goes ahead without file context.
//
// Declarations are found with a deliberately simple, language-agnostic
// line matcher rather than tree-sitter: the output is context for a model,
// not an index, and a missed or extra declaration costs a few tokens, not
// correctness. Best-effort throughout — nothing here ever fails a review.

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ReviewEffortSettings, ReviewNeighbor, ReviewRelatedContext, ReviewRelatedFile } from "@/lib/ai";
import { runRead } from "@/lib/neo4j";
import type { RepoRecord } from "@/lib/neo4j";
import type { JobLogger } from "./analyze";
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
  const result = await runRead(
    `
    MATCH (c:Component {id: $componentId, repoId: $repoId})
    CALL {
      WITH c
      MATCH (c)-[:DEPENDS_ON]->(n:Component)
      RETURN n, "dependsOn" AS direction
      UNION
      WITH c
      MATCH (n:Component)-[:DEPENDS_ON]->(c)
      RETURN n, "dependent" AS direction
    }
    RETURN n.name AS name, n.description AS description, direction
    ORDER BY direction, name
    `,
    { repoId, componentId }
  );
  return result.records.map((record) => ({
    name: record.get("name") as string,
    description: (record.get("description") as string | null) ?? undefined,
    direction: record.get("direction") as ReviewNeighbor["direction"],
  }));
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
  const result = await runRead(
    `
    UNWIND $paths AS changedPath
    MATCH (f:File {repoId: $repoId, path: changedPath})
    CALL {
      WITH f
      MATCH (f)-[:IMPORTS]->(g:File)-[:BELONGS_TO]->(c:Component)
      RETURN g, c, "imported" AS relation
      UNION
      WITH f
      MATCH (g:File)-[:IMPORTS]->(f)
      MATCH (g)-[:BELONGS_TO]->(c:Component)
      RETURN g, c, "importer" AS relation
    }
    WITH g, c, relation
    WHERE c.id <> $componentId
    RETURN DISTINCT g.path AS path, c.name AS componentName, relation
    ORDER BY relation, path
    `,
    { repoId, componentId, paths: [...changedPaths] }
  );
  const seen = new Set<string>();
  const refs: RelatedFileRef[] = [];
  for (const record of result.records) {
    const filePath = record.get("path") as string;
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    refs.push({
      path: filePath,
      componentName: record.get("componentName") as string,
      relation: record.get("relation") as RelatedFileRef["relation"],
    });
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
  log: JobLogger;
}

/** `undefined` when the effort level asks for nothing beyond the diff (low). */
export async function gatherRelatedContext({
  repo,
  componentId,
  changedPaths,
  patches,
  settings,
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
      const dir = await sourceDir(repo);
      const refs = dir ? await loadRelatedFiles(repo.id, componentId, changedPaths) : [];
      const identifiers = settings.relatedSource ? diffIdentifiers(patches) : new Set<string>();
      const files: ReviewRelatedFile[] = [];
      for (const ref of refs) {
        const source = await readRepoFile(dir!, ref.path);
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
      context.files = files;
      if (!dir) log("no checkout on disk — reviewing without related-file context");
    } catch (error) {
      log(`related-file lookup failed (continuing without it): ${(error as Error).message}`);
    }
  }

  return context;
}
