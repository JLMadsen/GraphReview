// What the review knows about a target from names (lib/analysis/symbols.ts),
// for the languages that have them (TS/JS, Python, Java, Kotlin):
//
//   loadTargetAnalyses   the target's merge-base and head, analysed (parse
//                        cache + in-memory memo, ./commit-analysis.ts), and
//                        the lines the change touched
//   symbolContracts      declarations whose signature/shape the change
//                        changed or removed — compared declaration by
//                        declaration, not read off the diff text
//   symbolUsages         where the head still uses one: imports that resolve
//                        to it (through re-exports), namespace members,
//                        calls, same-file references — on lines the change
//                        didn't write
//   newDeadImports       imports of a name its module no longer provides,
//                        that the base didn't have: a certain break, no model
//   symbolRelatedFiles   for the review's context: definitions of the names
//                        the changed lines use, and the callers of what changed
//
// Files of other languages (Go, Rust) keep the text-based path in ./impact.ts
// and ./review-context.ts. Worker-only (pulls in lib/analysis).

import type { AnalysisResult, ChangedLines, DeadImport, SymbolDecl } from "@/lib/analysis";
import type { ReviewRelatedFile } from "@/lib/ai";
import type { RepoRecord } from "@/lib/db";
import { mergeBaseOf } from "@/lib/preview/checkout";
import type { JobLogger } from "./analyze";
import { analyzeRepoCommit } from "./commit-analysis";
import type { HeadSource } from "./head-source";
import type { ChangedContract, ContractKind } from "./impact-contracts";
import type { ReviewTarget } from "./review-queue";
import { ensureCommitsInCache } from "./source";
import { changedLinesBetween } from "./target-graph";

export interface TargetAnalyses {
  base: AnalysisResult;
  head: AnalysisResult;
  /** The merge-base the diff is anchored on. */
  baseSha: string;
  headSha: string;
  changed: Map<string, ChangedLines>;
}

function fallbackRefspecs(repo: RepoRecord, target: ReviewTarget): string[] {
  if (target.kind === "refs") return [target.baseRef, target.headRef];
  return repo.provider === "gitlab" ? [`merge-requests/${target.prNumber}/head`] : [`pull/${target.prNumber}/head`];
}

/** Analyses of the target's merge-base and head, or `null` (logged) when they can't be had. */
export async function loadTargetAnalyses(
  repo: RepoRecord,
  target: ReviewTarget,
  reviewed: { baseSha?: string; headSha?: string },
  head: HeadSource | null,
  log: JobLogger
): Promise<TargetAnalyses | null> {
  if (!head || !reviewed.baseSha || !reviewed.headSha) {
    log("names: base or head commit unknown — impact and related code fall back to text search");
    return null;
  }
  try {
    const dir =
      repo.provider === "local"
        ? head.dir
        : await ensureCommitsInCache(repo, [reviewed.baseSha, reviewed.headSha], fallbackRefspecs(repo, target), log);
    const baseSha = await mergeBaseOf(dir, reviewed.baseSha, reviewed.headSha);
    const [base, headAnalysis, changed] = await Promise.all([
      analyzeRepoCommit(dir, baseSha),
      analyzeRepoCommit(dir, reviewed.headSha),
      changedLinesBetween(dir, baseSha, reviewed.headSha),
    ]);
    log(`names: analysed ${baseSha.slice(0, 7)} and ${reviewed.headSha.slice(0, 7)} (${base.cached + headAnalysis.cached} file(s) from the cache)`);
    return { base, head: headAnalysis, baseSha, headSha: reviewed.headSha, changed };
  } catch (error) {
    log(`names: could not analyse the target (${(error as Error).message.split("\n")[0]}) — falling back to text search`);
    return null;
  }
}

/** Paths whose language has names on either side (the rest use the text-based path). */
export function symbolCoveredPaths(analyses: TargetAnalyses, paths: readonly string[]): Set<string> {
  const covered = new Set<string>();
  const withSymbols = (result: AnalysisResult) => new Set(result.files.filter((f) => f.symbols).map((f) => f.file));
  const base = withSymbols(analyses.base);
  const head = withSymbols(analyses.head);
  for (const path of paths) if (base.has(path) || head.has(path)) covered.add(path);
  return covered;
}

// ---------------------------------------------------------------------------
// Contracts and usages
// ---------------------------------------------------------------------------

/** A contract found from names: which declaration (at the head) callers depend on. */
export interface SymbolContract extends ChangedContract {
  /** The declaration at the head; absent for a removed one. */
  headId?: string;
  /** The declaration at the base. */
  baseId: string;
}

const CONTRACT_KINDS: Record<string, ContractKind | undefined> = {
  function: "callable",
  method: "callable",
  class: "callable",
  interface: "type",
  type: "type",
  enum: "type",
  const: "value",
};

/**
 * Something other files can depend on: an exported declaration, or a
 * non-private method of an exported class (TS/Python methods carry no
 * export of their own).
 */
function publicCheck(decls: readonly SymbolDecl[]): (decl: SymbolDecl) => boolean {
  const exportedClasses = new Set(decls.filter((d) => d.kind === "class" && d.exported !== null).map((d) => d.id));
  return (decl) => {
    if (decl.kind !== "method") return decl.exported !== null;
    if (/^(private|#)/.test(decl.signature) || decl.name.startsWith("#")) return false;
    if (decl.exported !== null) return true;
    return exportedClasses.has(`${decl.file}#${decl.parent}`) && !decl.name.startsWith("_");
  };
}

export function symbolContracts(analyses: TargetAnalyses, covered: ReadonlySet<string>): SymbolContract[] {
  const headById = new Map(analyses.head.symbols.decls.map((d) => [d.id, d]));
  const headFiles = new Map(analyses.head.files.map((f) => [f.file, f]));
  const isPublic = publicCheck(analyses.base.symbols.decls);
  const isPublicAtHead = publicCheck(analyses.head.symbols.decls);
  const headExported = new Map<string, SymbolDecl[]>();
  for (const decl of analyses.head.symbols.decls) {
    if (!isPublicAtHead(decl) || !covered.has(decl.file)) continue;
    const list = headExported.get(decl.qualified) ?? [];
    list.push(decl);
    headExported.set(decl.qualified, list);
  }
  const contracts: SymbolContract[] = [];
  for (const decl of analyses.base.symbols.decls) {
    if (!covered.has(decl.file) || !isPublic(decl)) continue;
    const kind = CONTRACT_KINDS[decl.kind];
    if (!kind) continue;
    const now = headById.get(decl.id);
    if (now) {
      if (now.signature !== decl.signature) {
        contracts.push({ name: decl.qualified, filePath: decl.file, kind, change: "changed", before: decl.signature, after: now.signature, headId: now.id, baseId: decl.id });
      }
      continue;
    }
    // Still provided by the same module (re-exported after a move, or bound
    // to an import there): nothing was removed for its importers.
    const facts = headFiles.get(decl.file)?.symbols;
    const stillProvided =
      !decl.parent &&
      facts !== undefined &&
      (facts.exports.some((e) => e.exported === decl.name) ||
        facts.imports.some((imp) => imp.bindings.some((b) => b.local === decl.name)) ||
        facts.decls.some((d) => !d.parent && d.name === decl.name));
    if (!stillProvided) {
      contracts.push({ name: decl.qualified, filePath: decl.file, kind, change: "removed", before: decl.signature, baseId: decl.id });
    }
    // Moved into another changed file — with a different contract on the way.
    const moved = (headExported.get(decl.qualified) ?? []).find((d) => d.file !== decl.file && analyses.changed.has(d.file));
    if (moved && moved.signature !== decl.signature) {
      contracts.push({ name: decl.qualified, filePath: moved.file, kind, change: "changed", before: decl.signature, after: moved.signature, movedFrom: decl.file, headId: moved.id, baseId: decl.id });
    }
  }
  return contracts;
}

export interface SymbolUsage {
  path: string;
  line: number;
}

/**
 * Where the head still uses a changed declaration, on lines the change didn't
 * write. For a removed one: callers it had at the base that still mention its
 * name at the head (an import that no longer resolves is reported separately,
 * by {@link newDeadImports}).
 */
export function symbolUsages(analyses: TargetAnalyses, contract: SymbolContract): SymbolUsage[] {
  const { head, base, changed } = analyses;
  const out = new Map<string, SymbolUsage>();
  const add = (path: string, line: number) => {
    if (changed.get(path)?.added.has(line)) return; // the change wrote this line: updated
    out.set(`${path}:${line}`, { path, line });
  };
  const headFiles = new Map(head.files.map((f) => [f.file, f]));

  if (contract.headId) {
    const decl = head.symbols.decls.find((d) => d.id === contract.headId);
    for (const use of head.symbols.uses) if (use.target === contract.headId) for (const line of use.lines) add(use.file, line);
    for (const call of head.symbols.calls) if (call.to === contract.headId) add(call.file, call.line);
    if (decl && !decl.parent) {
      // Callers in the declaring file itself.
      const refs = headFiles.get(decl.file)?.symbols?.refs[decl.name] ?? [];
      for (const line of refs) if (line < decl.startLine || line > decl.endLine) add(decl.file, line);
    }
    if (decl?.parent) {
      // Instance calls can't be resolved; files that use the class and call
      // a member of that name are candidates for the model to judge.
      const classId = `${decl.file}#${decl.parent}`;
      const users = new Set(head.symbols.uses.filter((u) => u.target === classId).map((u) => u.file));
      users.add(decl.file);
      for (const file of users) {
        const members = headFiles.get(file)?.symbols?.members ?? {};
        for (const [key, lines] of Object.entries(members)) {
          if (!key.endsWith(`.${decl.name}`)) continue;
          for (const line of lines) if (file !== decl.file || line < decl.startLine || line > decl.endLine) add(file, line);
        }
      }
    }
    return [...out.values()];
  }

  // Removed: who called or used it at the base, and still names it at the head.
  const name = contract.name.split(".").pop()!;
  const callers = new Set<string>();
  for (const call of base.symbols.calls) if (call.to === contract.baseId) callers.add(call.file);
  for (const use of base.symbols.uses) if (use.target === contract.baseId) callers.add(use.file);
  for (const file of callers) {
    const facts = headFiles.get(file)?.symbols;
    if (!facts) continue;
    // Still resolving somewhere (moved and re-exported, aliased): not affected.
    const stillResolved = head.symbols.uses.some((u) => u.file === file && (u.local === name || u.local.endsWith(`.${name}`)));
    if (stillResolved) continue;
    const importLines = new Set<number>();
    for (const imp of facts.imports) for (let l = imp.startLine; l <= imp.endLine; l++) importLines.add(l);
    for (const line of facts.refs[name] ?? []) if (!importLines.has(line)) add(file, line);
    for (const [key, lines] of Object.entries(facts.members)) if (key.endsWith(`.${name}`)) for (const line of lines) add(file, line);
  }
  return [...out.values()];
}

/** Imports at the head of a name its module doesn't provide, that the base didn't have. */
export function newDeadImports(analyses: TargetAnalyses): DeadImport[] {
  const key = (d: DeadImport) => `${d.file}\u0000${d.source}\u0000${d.imported}`;
  const before = new Set(analyses.base.symbols.deadImports.map(key));
  return analyses.head.symbols.deadImports.filter((d) => !before.has(key(d)));
}

// ---------------------------------------------------------------------------
// Related code for the per-component review
// ---------------------------------------------------------------------------

const MAX_DEFINITIONS = 12;
const MAX_CALLERS = 8;
const MAX_BLOCK_LINES = 60;
const MAX_CALLER_LINES = 30;

function block(content: string, start: number, end: number, max: number): string {
  const lines = content.split(/\r?\n/).slice(start - 1, end);
  return lines.length > max ? `${lines.slice(0, max).join("\n")}\n… (truncated)` : lines.join("\n");
}

/**
 * Related files for one component's changed paths: the declarations the
 * changed lines use from other files ("defines"), and functions elsewhere
 * that call what changed ("caller") — with their source.
 */
export async function symbolRelatedFiles(
  analyses: TargetAnalyses,
  changedPaths: readonly string[],
  componentNameOf: (path: string) => string,
  read: (path: string) => Promise<string | null>,
  options: { signatures: boolean; source: boolean }
): Promise<ReviewRelatedFile[]> {
  const { head, changed } = analyses;
  const own = new Set(changedPaths);
  const declById = new Map(head.symbols.decls.map((d) => [d.id, d]));

  // Definitions the changed lines use.
  const defined = new Map<string, SymbolDecl>();
  for (const use of head.symbols.uses) {
    if (!own.has(use.file) || defined.size >= MAX_DEFINITIONS) continue;
    const added = changed.get(use.file)?.added;
    if (!added || !use.lines.some((l) => added.has(l))) continue;
    const decl = declById.get(use.target);
    if (decl && !own.has(decl.file)) defined.set(decl.id, decl);
  }
  for (const call of head.symbols.calls) {
    if (!own.has(call.file) || defined.size >= MAX_DEFINITIONS) continue;
    if (!changed.get(call.file)?.added.has(call.line)) continue;
    const decl = declById.get(call.to);
    if (decl && !own.has(decl.file)) defined.set(decl.id, decl);
  }

  // Callers of the declarations the change touched.
  const touched = new Set<string>();
  for (const decl of head.symbols.decls) {
    if (!own.has(decl.file)) continue;
    const added = changed.get(decl.file)?.added;
    if (!added) continue;
    for (const line of added) {
      if (line >= decl.startLine && line <= decl.endLine) {
        touched.add(decl.id);
        break;
      }
    }
  }
  const callers = new Map<string, { caller: SymbolDecl; callee: SymbolDecl }>();
  for (const call of head.symbols.calls) {
    if (callers.size >= MAX_CALLERS || !touched.has(call.to) || own.has(call.file)) continue;
    const caller = declById.get(call.from);
    const callee = declById.get(call.to);
    if (caller && callee && !callers.has(caller.id)) callers.set(caller.id, { caller, callee });
  }

  const byFile = new Map<string, ReviewRelatedFile>();
  const fileEntry = (path: string, relation: ReviewRelatedFile["relation"]) => {
    const key = `${relation}\u0000${path}`;
    let entry = byFile.get(key);
    if (!entry) byFile.set(key, (entry = { path, componentName: componentNameOf(path), relation, signatures: [], snippets: [] }));
    return entry;
  };
  for (const decl of defined.values()) {
    const entry = fileEntry(decl.file, "defines");
    if (options.signatures) entry.signatures.push(decl.signature);
    if (options.source) {
      const content = await read(decl.file);
      if (content) entry.snippets.push({ name: decl.qualified, code: block(content, decl.startLine, decl.endLine, MAX_BLOCK_LINES) });
    }
  }
  if (options.source) {
    for (const { caller, callee } of callers.values()) {
      const content = await read(caller.file);
      if (!content) continue;
      fileEntry(caller.file, "caller").snippets.push({
        name: `${caller.qualified} (calls ${callee.qualified})`,
        code: block(content, caller.startLine, caller.endLine, MAX_CALLER_LINES),
      });
    }
  }
  return [...byFile.values()].filter((f) => f.signatures.length > 0 || f.snippets.length > 0);
}
