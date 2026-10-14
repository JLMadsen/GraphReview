// The review's whole-PR passes after the per-component calls: the intent check
// (does the PR deliver what it claims) and the PR map grouping (DESIGN.md §6.4).

import { randomUUID } from "node:crypto";
import {
  checkPrIntent,
  groupPrMap,
} from "@/lib/ai";
import type { AiProviderConfig, PrIntentVerdict, PrMapAiInput, ReviewInput } from "@/lib/ai";
import {
  prMapFilesKey,
  savePrMapGrouping,
} from "@/lib/db";
import type { FindingAssessment, TargetFindingInput } from "@/lib/db";
import type { JobLogger } from "./analyze";
import {
  assemblePrMap,
  collectPrMapLinks,
  heuristicPrMapGroups,
  loadPrMapInput,
  patchHighlights,
} from "./pr-map";
import {
  type LocalFilePatch,
} from "./local-git";

export interface PrMapPassResult {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * One model call that regroups the changed files by their role in the
 * change and names the PR map's cards and edges (DESIGN.md §6.4), stored
 * for the PR map endpoint to apply. Runs after the per-component calls so
 * their finding summaries can inform the names.
 *
 * Never throws: the findings are already persisted and paid for, and the
 * PR map falls back to its heuristic grouping without this.
 */
export async function runPrMapPass(args: {
  repoId: string;
  targetKey: string;
  prId?: string;
  files: LocalFilePatch[];
  intent: ReviewInput["intent"];
  summariesByComponent: Map<string, string[]>;
  aiConfig: AiProviderConfig;
  tokenBudget: number;
  log: JobLogger;
  signal?: AbortSignal;
}): Promise<PrMapPassResult> {
  const { repoId, targetKey, files, log } = args;
  const spent: PrMapPassResult = { calls: 0, promptTokens: 0, completionTokens: 0 };
  if (files.length === 0) return spent;

  let aiInput: PrMapAiInput;
  try {
    const input = await loadPrMapInput(repoId, files);
    const map = assemblePrMap(input, collectPrMapLinks(input), heuristicPrMapGroups(input));
    const nameOf = new Map(map.nodes.map((node) => [node.id, node.name]));
    const cardOfFile = new Map<string, string>();
    for (const node of map.nodes) for (const file of node.files) cardOfFile.set(file.path, node.name);
    const cardOfComponent = (componentId: string): string | undefined =>
      (
        map.nodes.find((n) => n.role === "code" && n.componentIds.includes(componentId)) ??
        map.nodes.find((n) => n.role !== "context" && n.componentIds.includes(componentId))
      )?.name;

    aiInput = {
      intent:
        args.intent.source === "pull_request"
          ? { title: args.intent.title, body: args.intent.body }
          : undefined,
      files: files.map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        group: cardOfFile.get(file.path) ?? "",
        highlights: patchHighlights(file.patch),
      })),
      groups: map.nodes
        .filter((node) => node.role !== "context")
        .map((node) => ({ name: node.name, description: node.description, role: node.role })),
      context: map.nodes
        .filter((node) => node.role === "context")
        .map((node) => ({ name: node.name, description: node.description })),
      links: map.edges.map((edge) => ({
        from: nameOf.get(edge.source) ?? edge.source,
        to: nameOf.get(edge.target) ?? edge.target,
        label: edge.label,
        weight: edge.weight,
      })),
      summaries: [...args.summariesByComponent].flatMap(([componentId, summaries]) => {
        const group = cardOfComponent(componentId);
        return group ? summaries.map((summary) => ({ group, summary })) : [];
      }),
    };
  } catch (error) {
    log(`PR map: could not load the import graph — ${(error as Error).message}`);
    return spent;
  }

  try {
    const result = await groupPrMap(args.aiConfig, aiInput, { tokenBudget: args.tokenBudget, signal: args.signal });
    spent.calls = result.calls;
    spent.promptTokens = result.usage.promptTokens;
    spent.completionTokens = result.usage.completionTokens;
    if (result.parseFailed) {
      log("PR map: model output could not be parsed — keeping the heuristic grouping");
      return spent;
    }
    await savePrMapGrouping(
      {
        repoId,
        targetKey,
        filesKey: prMapFilesKey(files.map((file) => file.path)),
        groups: result.groups,
        edgeLabels: result.edgeLabels,
        model: args.aiConfig.model,
        createdAt: new Date().toISOString(),
      },
      args.prId
    );
    log(`PR map: ${result.groups.length} group(s), ${result.edgeLabels.length} edge label(s)`);
  } catch (error) {
    // As with a failed component call, it went out and may be billed.
    spent.calls = Math.max(spent.calls, 1);
    log(args.signal?.aborted ? "PR map: stopped — the review was cancelled" : `PR map: failed — ${(error as Error).message}`);
  }
  return spent;
}

export const INTENT_ASSESSMENT: Record<PrIntentVerdict, FindingAssessment> = {
  delivers: "ok",
  partial: "concern",
  missing: "defect",
  unknown: "unknown",
};

/**
 * One call: does the PR, as a whole, deliver what its title, description
 * and linked issues claim? Its answer is one `category: "intent"` finding
 * with no component — a line of the review verdict. A failed call becomes
 * an `unknown` one, the same as a failed component. Never throws — a
 * cancelled call comes back as that placeholder too, which the caller then
 * doesn't write.
 */
export async function runIntentPass(args: {
  intent: ReviewInput["intent"];
  files: LocalFilePatch[];
  findingLines: string[];
  /** The change to the endpoints, one line each (DESIGN.md §6.11). */
  apiLines?: string[];
  /** The change to the infrastructure, plan-style, one line each (DESIGN.md §6.12). */
  infraLines?: string[];
  /** The change to the database schema, one line each (DESIGN.md §6.13). */
  schemaLines?: string[];
  /** The change to the env vars, one line each, secret values masked (DESIGN.md §6.15). */
  envLines?: string[];
  aiConfig: AiProviderConfig;
  tokenBudget: number;
  prId?: string;
  revision: Pick<TargetFindingInput, "reviewedBaseSha" | "reviewedHeadSha" | "reviewedAt">;
  log: JobLogger;
  signal?: AbortSignal;
}): Promise<PrMapPassResult & { finding: TargetFindingInput & { componentId: string } }> {
  const base = {
    id: randomUUID(),
    prId: args.prId,
    componentId: "",
    model: args.aiConfig.model,
    createdAt: new Date().toISOString(),
    ...args.revision,
  };
  try {
    const result = await checkPrIntent(
      args.aiConfig,
      {
        intent: args.intent,
        files: args.files.map((file) => ({
          path: file.path,
          status: file.status,
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          patch: file.patch,
        })),
        findings: args.findingLines,
        ...(args.apiLines ? { api: args.apiLines } : {}),
        ...(args.infraLines ? { infra: args.infraLines } : {}),
        ...(args.schemaLines ? { schema: args.schemaLines } : {}),
        ...(args.envLines ? { env: args.envLines } : {}),
      },
      { tokenBudget: args.tokenBudget, signal: args.signal }
    );
    args.log(`intent: ${result.verdict}${result.parseFailed ? " (model output could not be parsed)" : ""}`);
    return {
      calls: 1,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      finding: {
        ...base,
        summary: result.summary,
        assessment: INTENT_ASSESSMENT[result.verdict],
        confidence: result.parseFailed ? 0 : 0.7,
        rationale: result.rationale,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.log(args.signal?.aborted ? "intent: stopped — the review was cancelled" : `intent: model call failed — ${message}`);
    return {
      calls: 1,
      promptTokens: 0,
      completionTokens: 0,
      finding: {
        ...base,
        summary: "The check of whether this PR delivers what it describes failed.",
        assessment: "unknown",
        confidence: 0,
        rationale: `The AI intent-check call did not complete: ${message}`,
        callFailed: true,
      },
    };
  }
}
