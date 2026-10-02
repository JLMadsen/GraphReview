// The impact pass of a review: callers the PR left behind.
//
//   1. contracts  — declarations whose signature/shape changed, or that were
//                   removed (./impact-contracts.ts, from the diff + the head)
//   2. usages     — whole-word search for each name at the head commit,
//                   kept only where the file can actually reach the
//                   declaration (same file; imports the declaring file or a
//                   file that re-exports it; same directory for package-
//                   scoped languages), and only on lines the PR did NOT
//                   write — an edited call site counts as updated
//   3. judgement  — one model call (a few at most) that says which of those
//                   untouched usages no longer fit (lib/ai/impact.ts); only
//                   `incompatible` ones become findings
//
// Findings are `category: "impact"`, attached to the *caller's* component —
// usually one the diff doesn't touch at all — with the caller's path and
// line. When the caps cut usages off, one note says how many weren't checked.

import { randomUUID } from "node:crypto";
import { checkImpact, type AiProviderConfig, type ImpactContract, type ImpactUsage } from "@/lib/ai";
import { runRead, type TargetFindingInput } from "@/lib/neo4j";
import type { JobLogger } from "./analyze";
import { matchFilesToComponents } from "./diff-components";
import type { GrepHit, HeadSource } from "./head-source";
import { addedLineNumbers, detectChangedContracts, type ChangedContract } from "./impact-contracts";
import type { LocalFilePatch } from "./local-git";
import { extractDeclarations } from "./review-context";

/** Grep hits read per name — a name this common is too generic to judge anyway. */
const MAX_HITS_PER_NAME = 300;
/** Untouched usages sent to the model per contract. */
const MAX_USAGES_PER_CONTRACT = 40;
const SNIPPET_RADIUS = 3;
const MAX_SNIPPET_LINE_CHARS = 240;
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
  const result = await runRead(
    `
    UNWIND $paths AS p
    MATCH (f:File {repoId: $repoId, path: p})
    OPTIONAL MATCH (f)-[:IMPORTS]->(g:File)
    RETURN p AS path, collect(DISTINCT g.path) AS imports
    `,
    { repoId, paths: [...paths] }
  );
  for (const record of result.records) {
    out.set(record.get("path") as string, new Set((record.get("imports") as string[]).filter(Boolean)));
  }
  return out;
}

/**
 * Which grep hits for a contract are usages worth judging: not a line the
 * PR wrote (that call site was updated), not a declaration of the name
 * itself, not a bare import when only the shape changed — and only in a
 * file that can reach the declaration: the declaring file, a file in the
 * same package (Go/Java/Kotlin), or one that imports the declaring file or
 * another file mentioning the name (a re-exporting barrel). Pure, for tests.
 */
export function untouchedReachableUsages(
  contract: ChangedContract,
  hits: readonly GrepHit[],
  addedByPath: ReadonlyMap<string, ReadonlySet<number>>,
  importsByPath: ReadonlyMap<string, ReadonlySet<string>>
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
  return candidates.filter((hit) => {
    if (hit.path === contract.filePath) return true;
    if (PACKAGE_SCOPED.test(hit.path) && dirOf(hit.path) === dirOf(contract.filePath)) return true;
    const fileImports = importsByPath.get(hit.path);
    if (!fileImports) return false;
    for (const target of fileImports) if (target !== hit.path && providers.has(target)) return true;
    return false;
  });
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

/**
 * Runs the whole pass. Never throws: a failed lookup or model call is
 * logged and the review goes on without impact findings — the per-component
 * findings are already persisted and paid for.
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
}): Promise<ImpactPassResult> {
  const { repoId, files, head, log } = args;
  const spent: ImpactPassResult = { findings: [], contracts: 0, calls: 0, promptTokens: 0, completionTokens: 0 };
  if (!head) {
    log("impact: skipped — the head commit could not be read");
    return spent;
  }

  try {
    // --- 1. What changed shape -------------------------------------------
    const candidates = files.filter((f) => f.patch && f.status !== "added");
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
    const contracts = detectChangedContracts(sources);
    spent.contracts = contracts.length;
    if (contracts.length === 0) {
      log("impact: no changed signatures, types, constants or removed declarations");
      return spent;
    }
    log(`impact: ${contracts.length} changed contract(s): ${contracts.map((c) => `${c.name} (${c.change})`).join(", ")}`);

    // --- 2. Untouched usages -------------------------------------------------
    const addedByPath = new Map(files.map((f) => [f.path, addedLineNumbers(f.patch)]));
    const hitsByContract = new Map<ChangedContract, GrepHit[]>();
    let unchecked = 0;
    let truncatedNames = 0;
    for (const contract of contracts) {
      const { hits, truncated } = await head.grepWord(contract.name, MAX_HITS_PER_NAME);
      if (truncated) truncatedNames++;
      hitsByContract.set(contract, hits);
    }

    const hitPaths = [...new Set([...hitsByContract.values()].flat().map((h) => h.path))];
    const imports = await loadImports(repoId, hitPaths);

    const contractInputs: Array<{ contract: ChangedContract; input: ImpactContract }> = [];
    const usageIndex = new Map<string, { contract: ChangedContract; path: string; line: number }>();
    let nextId = 1;
    for (const contract of contracts) {
      const reachable = untouchedReachableUsages(contract, hitsByContract.get(contract) ?? [], addedByPath, imports);
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

    const callerPaths = [...new Set(result.incompatible.map((v) => usageIndex.get(v.usageId)!.path))];
    const { componentIdByPath } = await matchFilesToComponents(repoId, callerPaths);
    for (const verdict of result.incompatible) {
      const usage = usageIndex.get(verdict.usageId)!;
      const { contract } = usage;
      const changeText =
        contract.change === "removed"
          ? `\`${contract.name}\` was removed from ${contract.filePath}`
          : `\`${contract.name}\` in ${contract.filePath} changed from \`${oneLine(contract.before)}\` to \`${oneLine(contract.after ?? "")}\``;
      spent.findings.push({
        id: randomUUID(),
        prId: args.prId,
        componentId: componentIdByPath.get(usage.path) ?? "",
        filePath: usage.path,
        lineRange: String(usage.line),
        summary: `Not updated for the change to ${contract.name}: ${verdict.reason || "this usage no longer fits."}`,
        assessment: "defect",
        confidence: 0.8,
        rationale: `${changeText}, but this line was not edited by the change. ${verdict.reason}`.trim(),
        model: args.aiConfig.model,
        createdAt: new Date().toISOString(),
        ...args.revision,
      });
    }
    return withNote(spent, unchecked, truncatedNames, args);
  } catch (error) {
    // A call that went out may still be billed.
    spent.calls = Math.max(spent.calls, 1);
    log(`impact: failed — ${(error as Error).message}`);
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
