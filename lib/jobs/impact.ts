// The impact pass of a review: callers the PR left behind.
//
//   1. contracts  — declarations whose signature/shape changed, or that were
//                   removed (./impact-contracts.ts, from the diff + the head);
//                   one that moved to another file and changed on the way is
//                   a changed contract of its new file
//   2. usages     — whole-word search for each name at the head commit,
//                   kept only on lines the PR did NOT write (an edited call
//                   site counts as updated) and only where the file actually
//                   reaches the declaration: its import of the name, read
//                   from the head text and followed through re-exports, leads
//                   to the declaring file — or, where the text can't tell,
//                   the analysed import graph says so. For a removed
//                   declaration, only files where the name no longer resolves
//                   at all (a move with a re-export, updated imports or an
//                   alias left behind is not a removal)
//   3. judgement  — one model call (a few at most) that says which of those
//                   untouched usages no longer fit (lib/ai/impact.ts); only
//                   `incompatible` ones become findings
//
// Findings are `category: "impact"`, one per contract per caller file,
// attached to the *caller's* component — usually one the diff doesn't touch
// at all — with the caller's path, anchored at its first incompatible line.
// When the caps cut usages off, one note says how many weren't checked.

import { randomUUID } from "node:crypto";
import { checkImpact, type AiProviderConfig, type ImpactContract, type ImpactUsage } from "@/lib/ai";
import { listImportsByPath, type TargetFindingInput } from "@/lib/db";
import type { JobLogger } from "./analyze";
import { matchFilesToComponents } from "./diff-components";
import type { GrepHit, HeadSource } from "./head-source";
import { addedLineNumbers, detectChangedContracts, type ChangedContract } from "./impact-contracts";
import {
  movedBodyContracts,
  newDeadImports,
  symbolContracts,
  symbolCoveredPaths,
  symbolUsages,
  type MovedCode,
  type SymbolContract,
  type TargetAnalyses,
} from "./symbol-context";
import type { LocalFilePatch } from "./local-git";
import { extractDeclarations } from "./review-context";

/** Grep hits read per name — a name this common is too generic to judge anyway. */
const MAX_HITS_PER_NAME = 300;
/** Untouched usages sent to the model per contract. */
const MAX_USAGES_PER_CONTRACT = 40;
const SNIPPET_RADIUS = 3;
const MAX_SNIPPET_LINE_CHARS = 240;
/** Head files read at once when resolving imports. */
const READ_CONCURRENCY = 16;
/** Languages whose files see each other by directory/package, without an import. */
const PACKAGE_SCOPED = /\.(?:go|java|kt|kts)$/;
const IMPORT_LINE =
  /^\s*(?:import\b|export\s*(?:\*|\{|type\s*\{)|from\s+\S+\s+import\b|use\s|using\s|#include|package\s|module\s)/;

export type ImpactFindingInput = TargetFindingInput & { componentId: string };

export interface ImpactPassResult {
  findings: ImpactFindingInput[];
  contracts: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

function dirOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash < 0 ? "" : filePath.slice(0, slash);
}

/** `path -> paths it imports`, from the analysed graph. */
async function loadImports(repoId: string, paths: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (paths.length === 0) return out;
  for (const [path, imports] of await listImportsByPath(repoId, paths)) out.set(path, new Set(imports));
  return out;
}

/**
 * Which grep hits for a contract are usages worth judging: not a line the
 * PR wrote (that call site was updated), not a declaration of the name
 * itself, not a bare import when only the shape changed — and only in a
 * file that can reach the declaration.
 *
 * Reaching it is decided from the head text of the hit files when given
 * (`headContents`, see {@link resolveName}): a file whose import of the name
 * leads to the declaring file reaches it, one whose import leads to another
 * declaration of the same name doesn't — and for a removed declaration, a
 * file where the name still resolves (moved, re-exported, aliased) is not
 * affected. Where the text can't tell (no import naming it, an import that
 * can't be placed, a language without import parsing), the analysed import
 * graph decides: the declaring file, a file in the same package
 * (Go/Java/Kotlin), or one that imports the declaring file or another file
 * mentioning the name (a re-exporting barrel). Pure, for tests.
 */
export function untouchedReachableUsages(
  contract: ChangedContract,
  hits: readonly GrepHit[],
  addedByPath: ReadonlyMap<string, ReadonlySet<number>>,
  importsByPath: ReadonlyMap<string, ReadonlySet<string>>,
  headContents?: ReadonlyMap<string, string | null>
): GrepHit[] {
  const candidates = hits.filter((hit) => {
    if (addedByPath.get(hit.path)?.has(hit.line)) return false; // the PR wrote this line
    if (extractDeclarations(hit.text.trimStart()).some((d) => d.name === contract.name)) return false;
    if (contract.change === "changed" && IMPORT_LINE.test(hit.text)) return false;
    return true;
  });
  // Files that mention the name and could pass it on: the declaring file,
  // and any re-exporting barrel among the hits (import lines included).
  const providers = new Set([contract.filePath, ...hits.map((h) => h.path)]);
  const known = [...providers];

  const graphReaches = (path: string): boolean => {
    if (path === contract.filePath) return true;
    if (PACKAGE_SCOPED.test(path) && dirOf(path) === dirOf(contract.filePath)) return true;
    const fileImports = importsByPath.get(path);
    if (!fileImports) return false;
    for (const target of fileImports) if (target !== path && providers.has(target)) return true;
    return false;
  };
  const affected = (path: string): boolean => {
    if (!headContents) return graphReaches(path);
    if (contract.change === "removed") {
      return graphReaches(path) && !stillResolves(contract.name, contract.filePath, path, headContents, known);
    }
    const resolution = resolveName(contract.name, path, headContents, known);
    if (resolution.kind === "file") return resolution.path === contract.filePath;
    return graphReaches(path);
  };

  const affectedByPath = new Map<string, boolean>();
  return candidates.filter((hit) => {
    let keep = affectedByPath.get(hit.path);
    if (keep === undefined) {
      keep = affected(hit.path);
      affectedByPath.set(hit.path, keep);
    }
    return keep;
  });
}

// ---------------------------------------------------------------------------
// Where a name resolves at the head (moves, re-exports, aliases)
// ---------------------------------------------------------------------------

const JS_LIKE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const PYTHON = /\.pyi?$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The name is bound at module level in this file: a declaration, or a plain binding (`const statusOf = symbolStatus`). */
function bindsLocally(content: string, name: string, path: string): boolean {
  if (extractDeclarations(content).some((d) => d.name === name)) return true;
  const word = escapeRegExp(name);
  if (new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${word}\\b`, "m").test(content)) return true;
  return PYTHON.test(path) && new RegExp(`^${word}\\s*(?::[^=\\n]*)?=(?!=)`, "m").test(content);
}

/** The module makes the name available to importers. Outside JS/TS, every module-level name is. */
function exportsName(content: string, name: string, path: string): boolean {
  if (!JS_LIKE.test(path)) return true;
  const word = escapeRegExp(name);
  const declared = new RegExp(
    `^\\s*export\\s+(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?` +
      `(?:function\\*?|class|interface|type|enum|namespace|const|let|var)\\s+${word}\\b`,
    "m"
  );
  if (declared.test(content)) return true;
  const named = new RegExp(`\\b${word}\\b`);
  for (const match of content.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g)) if (named.test(match[1])) return true;
  return false;
}

/** Module specifiers of the import (or re-export) statements in this file that bind the name. */
function importSpecifiers(content: string, name: string, path: string): string[] {
  const named = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  const out: string[] = [];
  if (PYTHON.test(path)) {
    for (const match of content.matchAll(/^\s*from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^\n]*)/gm)) {
      if (named.test(match[2])) out.push(match[1]);
    }
    return out;
  }
  for (const match of content.matchAll(/\b(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/g)) {
    if (named.test(match[1])) out.push(match[2]);
  }
  for (const match of content.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
    if (named.test(match[1])) out.push(match[2]);
  }
  return out;
}

/** `a/b/../c` → `a/c`. */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** A file's path without its extension, and without a trailing `index`/`__init__`. */
function moduleStems(path: string): string[] {
  const stem = path.replace(/\.[^./]+$/, "");
  const parent = stem.replace(/\/(?:index|__init__)$/, "");
  return parent === stem ? [stem] : [stem, parent];
}

/**
 * Which of the known files (the declaring file first, then every file that
 * mentions the name) an import specifier points at — loosely: relative
 * specifiers exactly, `@/`-style aliases and Python dotted paths by suffix.
 */
function resolveSpecifier(spec: string, fromPath: string, known: readonly string[]): string | undefined {
  let target: string;
  let exact: boolean;
  if (PYTHON.test(fromPath)) {
    const dots = /^\.*/.exec(spec)![0].length;
    const rest = spec.slice(dots).replace(/\./g, "/");
    if (dots > 0) {
      let dir = dirOf(fromPath);
      for (let i = 1; i < dots; i++) dir = dirOf(dir);
      target = normalizePath(`${dir}/${rest}`);
      exact = true;
    } else {
      target = rest;
      exact = false;
    }
  } else if (spec.startsWith(".")) {
    target = normalizePath(`${dirOf(fromPath)}/${spec}`);
    exact = true;
  } else {
    target = spec.replace(/^[@~#]\//, "");
    exact = false;
  }
  target = target.replace(/\.[cm]?[jt]sx?$/, "");
  return known.find((path) =>
    moduleStems(path).some((stem) => stem === target || (!exact && stem.endsWith(`/${target}`)))
  );
}

/**
 * Where `name`, as used in `path`, comes from at the head:
 *   - `file`     — the file whose module-level binding it is: `path` itself
 *                  (a declaration, or an alias such as `const statusOf =
 *                  symbolStatus`), or the module an import of it leads to,
 *                  followed through re-exports (`export { name }`, `export
 *                  { name } from`)
 *   - `external` — imported from a module that doesn't mention the name (a
 *                  package, an `export *` barrel, a path that can't be placed)
 *   - `unnamed`  — nothing in `path` binds or imports it (a namespace import,
 *                  a same-package caller, a language without import parsing)
 *   - `dead`     — its import leads to a file that doesn't provide it
 * `contents` is the head text by path (`null`: gone); `known` the files that
 * mention the name, the declaring file first.
 */
export type NameResolution = { kind: "file"; path: string } | { kind: "external" | "unnamed" | "dead" };

export function resolveName(
  name: string,
  path: string,
  contents: ReadonlyMap<string, string | null>,
  known: readonly string[],
  asModule = false,
  seen: Set<string> = new Set([path])
): NameResolution {
  const content = contents.get(path);
  if (content == null) return { kind: "dead" };
  if (asModule && !exportsName(content, name, path)) return { kind: "dead" };
  if (bindsLocally(content, name, path)) return { kind: "file", path };
  const specs = importSpecifiers(content, name, path);
  if (specs.length === 0) return { kind: asModule ? "dead" : "unnamed" };
  let best: NameResolution = { kind: "dead" };
  for (const spec of specs) {
    const target = resolveSpecifier(spec, path, known);
    if (!target) {
      best = { kind: "external" };
      continue;
    }
    if (seen.has(target)) continue;
    seen.add(target);
    const found = resolveName(name, target, contents, known, true, seen);
    if (found.kind === "file") return found;
    if (found.kind === "external") best = found;
  }
  return best;
}

/**
 * Whether `name`, removed from `declaringPath`, is still available at the
 * head to code in `path` — it resolves to some file, or to a module we can't
 * see into ({@link resolveName}). A caller with no import naming it resolves
 * only if the declaring file itself still provides the name (a re-export).
 */
export function stillResolves(
  name: string,
  declaringPath: string,
  path: string,
  contents: ReadonlyMap<string, string | null>,
  known: readonly string[]
): boolean {
  let resolution = resolveName(name, path, contents, known);
  if (resolution.kind === "unnamed" && path !== declaringPath) {
    resolution = resolveName(name, declaringPath, contents, known, true, new Set([path, declaringPath]));
  }
  return resolution.kind === "file" || resolution.kind === "external";
}

function snippet(content: string, line: number): string {
  const lines = content.split(/\r?\n/);
  const from = Math.max(1, line - SNIPPET_RADIUS);
  const to = Math.min(lines.length, line + SNIPPET_RADIUS);
  const width = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    const text = lines[n - 1] ?? "";
    out.push(`${String(n).padStart(width)}${n === line ? ">" : "|"} ${text.length > MAX_SNIPPET_LINE_CHARS ? `${text.slice(0, MAX_SNIPPET_LINE_CHARS)}…` : text}`);
  }
  return out.join("\n");
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** How the finding words what happened to the declaration. */
function changeText(contract: ChangedContract): string {
  const name = `\`${contract.name}\``;
  if (contract.change === "removed") return `${name} was removed from ${contract.filePath}`;
  const shape = `changed from \`${oneLine(contract.before)}\` to \`${oneLine(contract.after ?? "")}\``;
  return contract.movedFrom
    ? `${name} moved from ${contract.movedFrom} to ${contract.filePath} and ${shape}`
    : `${name} in ${contract.filePath} ${shape}`;
}

/**
 * One finding per caller file per contract, anchored at its first
 * incompatible line, with every line and the model's reason for it in the
 * rationale. The summary and the rationale's opening are parsed back by the
 * UI (components/graph/review-visuals.ts: impactSymbol, impactChange). Pure, for tests.
 */
export function impactFindings(
  verdicts: ReadonlyArray<{ contract: ChangedContract; path: string; line: number; reason: string }>,
  componentIdByPath: ReadonlyMap<string, string>,
  base: Pick<TargetFindingInput, "prId" | "model" | "createdAt" | "reviewedBaseSha" | "reviewedHeadSha" | "reviewedAt">
): ImpactFindingInput[] {
  const groups = new Map<ChangedContract, Map<string, Array<{ line: number; reason: string }>>>();
  for (const verdict of verdicts) {
    const byPath = groups.get(verdict.contract) ?? new Map<string, Array<{ line: number; reason: string }>>();
    groups.set(verdict.contract, byPath);
    const lines = byPath.get(verdict.path) ?? [];
    byPath.set(verdict.path, lines);
    if (!lines.some((l) => l.line === verdict.line)) lines.push({ line: verdict.line, reason: verdict.reason.trim() });
  }

  const findings: ImpactFindingInput[] = [];
  for (const [contract, byPath] of groups) {
    for (const [path, lines] of byPath) {
      lines.sort((a, b) => a.line - b.line);
      const [first] = lines;
      const reason = first.reason || "this usage no longer fits.";
      const more = lines.length - 1;
      findings.push({
        id: randomUUID(),
        ...base,
        componentId: componentIdByPath.get(path) ?? "",
        filePath: path,
        lineRange: String(first.line),
        summary:
          `Not updated for the change to ${contract.name}: ${reason}` +
          (more > 0 ? ` (and ${more} more place${more === 1 ? "" : "s"} in this file)` : ""),
        assessment: "defect",
        confidence: 0.8,
        rationale:
          lines.length === 1
            ? `${changeText(contract)}, but this line was not edited by the change. ${first.reason}`.trim()
            : `${changeText(contract)}, but these lines were not edited by the change:\n` +
              lines.map((l) => `- line ${l.line}: ${l.reason || "no longer fits."}`).join("\n"),
      });
    }
  }
  return findings;
}

/**
 * Runs the whole pass. Never throws: a failed lookup or model call is
 * logged and the review goes on without impact findings — the per-component
 * findings are already persisted and paid for. A cancelled review (`signal`
 * aborted) ends the pass the same way; the caller checks the signal.
 */
export async function runImpactPass(args: {
  repoId: string;
  files: LocalFilePatch[];
  head: HeadSource | null;
  aiConfig: AiProviderConfig;
  tokenBudget: number;
  prId?: string;
  revision: Pick<TargetFindingInput, "reviewedBaseSha" | "reviewedHeadSha" | "reviewedAt">;
  log: JobLogger;
  signal?: AbortSignal;
  /** The target analysed from names (./symbol-context.ts); `null`: everything by text. */
  analyses?: TargetAnalyses | null;
  /** Code the change moved and changed on the way (./symbol-context.ts): a changed body is judged against the callers too. */
  moved?: readonly MovedCode[];
}): Promise<ImpactPassResult> {
  const { repoId, files, head, log } = args;
  const spent: ImpactPassResult = { findings: [], contracts: 0, calls: 0, promptTokens: 0, completionTokens: 0 };
  if (!head) {
    log("impact: skipped — the head commit could not be read");
    return spent;
  }

  try {
    // Files whose language has names are handled from the analysed base and
    // head (./symbol-context.ts); the rest (Go, Rust) by text, as before.
    const analyses = args.analyses ?? null;
    const covered = analyses ? symbolCoveredPaths(analyses, files.map((f) => f.path)) : new Set<string>();

    // --- 0. Imports of names that are gone: certain, no model needed --------
    if (analyses) {
      const dead = newDeadImports(analyses);
      if (dead.length > 0) {
        const { componentIdByPath } = await matchFilesToComponents(repoId, [...new Set(dead.map((d) => d.file))]);
        spent.findings.push(
          ...impactFindings(
            dead.map((d) => ({
              contract: { name: d.imported, filePath: d.target, kind: "callable" as const, change: "removed" as const, before: d.imported },
              path: d.file,
              line: d.line,
              reason: `it imports \`${d.imported}\` from ${d.source}, which no longer provides it.`,
            })),
            componentIdByPath,
            { prId: args.prId, model: "static analysis", createdAt: new Date().toISOString(), ...args.revision }
          ).map((finding) => ({ ...finding, confidence: 0.95 }))
        );
        log(`impact: ${dead.length} import(s) of names that no longer exist`);
      }
    }

    // --- 1. What changed shape -------------------------------------------
    const symbolic = analyses ? [...symbolContracts(analyses, covered), ...movedBodyContracts(args.moved ?? [])] : [];
    // Added files are read too: a removed declaration may have moved into one.
    const candidates = files.filter((f) => f.patch && !covered.has(f.path));
    const sources = await Promise.all(
      candidates.map(async (file) => {
        const content = await head.read(file.path);
        return {
          path: file.path,
          status: file.status,
          patch: file.patch,
          // A modified file that can't be read is "unknown", not "deleted".
          headContent: content ?? (file.status === "removed" ? null : undefined),
        };
      })
    );
    const textual = detectChangedContracts(sources);
    const contracts: ChangedContract[] = [...symbolic, ...textual];
    spent.contracts = contracts.length;
    if (contracts.length === 0) {
      log("impact: no changed signatures, types, constants or removed declarations");
      return spent;
    }
    log(
      `impact: ${contracts.length} changed contract(s)` +
        (symbolic.length > 0 && textual.length > 0 ? ` (${symbolic.length} from names, ${textual.length} from text)` : "") +
        `: ${contracts.map((c) => `${c.name} (${c.change})`).join(", ")}`
    );

    // --- 2. Untouched usages -------------------------------------------------
    const addedByPath = new Map(files.map((f) => [f.path, addedLineNumbers(f.patch)]));
    const hitsByContract = new Map<ChangedContract, GrepHit[]>();
    const grepped = new Map<string, Awaited<ReturnType<HeadSource["grepWord"]>>>();
    let unchecked = 0;
    let truncatedNames = 0;
    for (const contract of textual) {
      // A moved declaration is two contracts of one name: search it once.
      let result = grepped.get(contract.name);
      if (!result) {
        result = await head.grepWord(contract.name, MAX_HITS_PER_NAME);
        grepped.set(contract.name, result);
        if (result.truncated) truncatedNames++;
      }
      hitsByContract.set(contract, result.hits);
    }

    const hitPaths = [...new Set([...hitsByContract.values()].flat().map((h) => h.path))];
    const imports = await loadImports(repoId, hitPaths);
    // Where each caller's import of the name leads is read from the head
    // text of every file that mentions it (and of the declaring files).
    const headContents = new Map<string, string | null>();
    const toRead = [...new Set([...textual.map((c) => c.filePath), ...hitPaths])];
    for (let i = 0; i < toRead.length; i += READ_CONCURRENCY) {
      const batch = toRead.slice(i, i + READ_CONCURRENCY);
      const texts = await Promise.all(batch.map((path) => head.read(path)));
      batch.forEach((path, j) => headContents.set(path, texts[j]));
    }

    const contractInputs: Array<{ contract: ChangedContract; input: ImpactContract }> = [];
    const usageIndex = new Map<string, { contract: ChangedContract; path: string; line: number }>();
    let nextId = 1;
    for (const contract of contracts) {
      const reachable: Array<{ path: string; line: number }> =
        analyses && symbolic.includes(contract as SymbolContract)
          ? symbolUsages(analyses, contract as SymbolContract).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
          : untouchedReachableUsages(contract, hitsByContract.get(contract) ?? [], addedByPath, imports, headContents);
      if (reachable.length > MAX_USAGES_PER_CONTRACT) unchecked += reachable.length - MAX_USAGES_PER_CONTRACT;

      const usages: ImpactUsage[] = [];
      for (const hit of reachable.slice(0, MAX_USAGES_PER_CONTRACT)) {
        const content = await head.read(hit.path);
        if (content === null) continue;
        const id = `u${nextId++}`;
        usages.push({ id, path: hit.path, line: hit.line, snippet: snippet(content, hit.line) });
        usageIndex.set(id, { contract, path: hit.path, line: hit.line });
      }
      contractInputs.push({
        contract,
        input: {
          name: contract.name,
          filePath: contract.filePath,
          kind: contract.kind,
          change: contract.change,
          before: contract.before,
          after: contract.after,
          movedFrom: contract.movedFrom,
          usages,
        },
      });
    }

    const total = contractInputs.reduce((sum, c) => sum + c.input.usages.length, 0);
    if (total === 0) {
      log("impact: no untouched usages of the changed contracts");
      return withNote(spent, unchecked, truncatedNames, args);
    }

    // --- 3. Judgement ----------------------------------------------------------
    const result = await checkImpact(args.aiConfig, contractInputs.map((c) => c.input), {
      tokenBudget: args.tokenBudget,
      signal: args.signal,
    });
    spent.calls = result.calls;
    spent.promptTokens = result.usage.promptTokens;
    spent.completionTokens = result.usage.completionTokens;
    unchecked += result.unchecked;
    log(
      `impact: ${result.checked} untouched usage(s) checked in ${result.calls} call(s), ` +
        `${result.incompatible.length} incompatible` +
        (result.unchecked > 0 ? `, ${result.unchecked} over the budget` : "") +
        (result.parseFailures > 0 ? `, ${result.parseFailures} unparseable answer(s)` : "")
    );

    const verdicts = result.incompatible.map((v) => ({ ...usageIndex.get(v.usageId)!, reason: v.reason }));
    const { componentIdByPath } = await matchFilesToComponents(repoId, [...new Set(verdicts.map((v) => v.path))]);
    spent.findings.push(
      ...impactFindings(verdicts, componentIdByPath, {
        prId: args.prId,
        model: args.aiConfig.model,
        createdAt: new Date().toISOString(),
        ...args.revision,
      })
    );
    return withNote(spent, unchecked, truncatedNames, args);
  } catch (error) {
    // A call that went out may still be billed.
    spent.calls = Math.max(spent.calls, 1);
    log(args.signal?.aborted ? "impact: stopped — the review was cancelled" : `impact: failed — ${(error as Error).message}`);
    return spent;
  }
}

/** Adds the one "not everything was checked" note when the caps cut usages off. */
function withNote(
  spent: ImpactPassResult,
  unchecked: number,
  truncatedNames: number,
  args: { aiConfig: AiProviderConfig; prId?: string; revision: ImpactPassArgsRevision }
): ImpactPassResult {
  if (unchecked === 0 && truncatedNames === 0) return spent;
  const parts: string[] = [];
  if (unchecked > 0) parts.push(`${unchecked} usage${unchecked === 1 ? "" : "s"} of changed declarations ${unchecked === 1 ? "was" : "were"} not checked`);
  if (truncatedNames > 0) parts.push(`${truncatedNames} name${truncatedNames === 1 ? " is" : "s are"} used in more than ${MAX_HITS_PER_NAME} places, so only the first ${MAX_HITS_PER_NAME} were looked at`);
  spent.findings.push({
    id: randomUUID(),
    prId: args.prId,
    componentId: "",
    summary: `Impact check incomplete: ${parts.join("; ")}.`,
    // A note, not a verdict: it never counts as something to look at.
    assessment: "ok",
    confidence: 1,
    rationale:
      `The impact check sends at most ${MAX_USAGES_PER_CONTRACT} untouched usages per changed declaration, ` +
      "in a few model calls at most; the rest are counted here instead of being judged.",
    model: args.aiConfig.model,
    createdAt: new Date().toISOString(),
    ...args.revision,
  });
  return spent;
}

type ImpactPassArgsRevision = Pick<TargetFindingInput, "reviewedBaseSha" | "reviewedHeadSha" | "reviewedAt">;
