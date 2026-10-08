// The AI review job body.
//
// Pipeline: load the repo → load and decrypt the AI provider settings →
// fetch the diff and the "intent" context for the target → map changed
// files onto the component graph → one LLM call per touched component,
// a few in flight at a time → persist each component's findings the
// moment it completes (overwriting any previous run's findings for that
// component), so they stream into the UI → prune findings for components
// the target no longer touches → the impact pass (usages of changed
// signatures/types the PR left behind, ./impact.ts) → for a PR, the one
// "does it deliver what it claims" call → one more call that groups and
// names the PR map's cards (DESIGN.md §6.4), best-effort.
//
// Kept out of `worker/index.ts` and out of lib/jobs' barrel on purpose, for
// the same reason as `./analyze.ts`: this is the unit of work (importable
// from a script or test without starting a queue consumer), and it pulls in
// lib/ai + lib/github, which the app bundle has no reason to carry just
// because a route imported `@/lib/jobs` to enqueue something.

import { randomUUID } from "node:crypto";
import { UnrecoverableError } from "./runner";
import {
  DEFAULT_REVIEW_EFFORT,
  REVIEW_EFFORT_SETTINGS,
  checkPrIntent,
  groupPrMap,
  reviewComponentChange,
} from "@/lib/ai";
import type { AiProviderConfig, PrIntentVerdict, PrMapAiInput, ReviewInput } from "@/lib/ai";
import { decrypt } from "@/lib/crypto";
import { compareRefs, getLinkedIssues, getPullRequest, listPullRequestFiles } from "@/lib/github";
import type { LinkedIssue, PullRequestDetail } from "@/lib/github";
import {
  compareRefs as compareGitLabRefs,
  getLinkedIssues as getGitLabLinkedIssues,
  getMergeRequest,
  listMergeRequestFiles,
} from "@/lib/gitlab";
import {
  deleteFindingsForTargetExceptComponents,
  getActiveAiProvider,
  getFileOwnerMap,
  listComponentsByRepoId,
  getRepoById,
  listFindingsByTargetKey,
  prMapFilesKey,
  replaceFindingsForTargetCategory,
  replaceFindingsForTargetComponent,
  savePrMapGrouping,
  upsertPullRequest,
} from "@/lib/db";
import type { RepoRecord } from "@/lib/db";
import type { FindingAssessment, TargetFindingInput } from "@/lib/db";
import type { JobLogger } from "./analyze";
import {
  getComponentReviewContexts,
  matchFilesToComponents,
  type ComponentReviewContext,
} from "./diff-components";
import { resolveGitHubAccess } from "./github-access";
import { openHeadSource } from "./head-source";
import { runImpactPass } from "./impact";
import { blockDiff, loadTargetAnalyses, movedCodeChanges, symbolRelatedFiles } from "./symbol-context";
import { compareApis } from "@/lib/analysis/api/compare";
import { apiChangeSummary, changesTouching, describeApiChange, describeEndpointChange, describeLogicChange, logicTouching } from "@/lib/analysis/api/describe";
import { gatherRelatedContext } from "./review-context";
import {
  assemblePrMap,
  collectPrMapLinks,
  heuristicPrMapGroups,
  loadPrMapInput,
  patchHighlights,
} from "./pr-map";
import { resolveGitLabAccess } from "./gitlab-access";
import {
  listLocalFilePatches,
  resolveLocalRefSha,
  toLocalFilePatch,
  type LocalFilePatch,
} from "./local-git";
import {
  REVIEW_CANCELLED_REASON,
  reviewTargetKey,
  type ReviewJob,
  type ReviewJobData,
  type ReviewJobResult,
  type ReviewProgress,
  type ReviewTarget,
} from "./review-queue";

/**
 * How many per-component LLM calls are in flight at once.
 *
 * Small on purpose. The whole point of per-component calls is that they are
 * independent and can be parallelized, but the configured provider may well
 * be a single local model server that serializes internally anyway, and a
 * burst of dozens of concurrent requests is the fastest way to trip a hosted
 * provider's rate limit — which, with `attempts: 1`, there is no automatic
 * second chance for.
 */
const MODEL_CONCURRENCY = 3;

/** Stable pull request record id for a repo + PR number — mirrors the `<repoId>:<kind>:<key>` convention `analyze.ts` uses for components and files. */
function pullRequestNodeId(repoId: string, prNumber: number): string {
  return `${repoId}:pr:${prNumber}`;
}

/** A path's owning component name ("" when it has none), for related-code headings. */
async function loadOwnerNames(repoId: string): Promise<(path: string) => string> {
  const [owners, components] = await Promise.all([getFileOwnerMap(repoId), listComponentsByRepoId(repoId)]);
  const names = new Map(components.map((c) => [c.id, c.name]));
  return (path) => names.get(owners.get(path) ?? "") ?? "";
}

// ---------------------------------------------------------------------------
// AI provider settings
// ---------------------------------------------------------------------------

/**
 * Reads and decrypts the currently *active* saved AI provider (multiple
 * providers can be saved, lib/db/ai-provider.ts, with one
 * marked active at a time).
 *
 * All three fields are required and checked together: a half-configured
 * provider can only ever produce a confusing failure deep inside an HTTP
 * call, so it fails fast here with a message that names what is missing.
 * The API route performs the same check *before* enqueueing (returning
 * `ai_not_configured`); this is the worker-side backstop for the window
 * where the active provider is changed/deleted between enqueue and
 * execution.
 */
async function loadAiConfig(): Promise<AiProviderConfig> {
  const provider = await getActiveAiProvider();
  const missing: string[] = [];
  if (!provider?.baseUrl) missing.push("base URL");
  if (!provider?.apiKeyEncrypted) missing.push("API key");
  if (!provider?.model) missing.push("model name");

  if (missing.length > 0 || !provider) {
    throw new UnrecoverableError(
      `AI provider is not fully configured — missing ${missing.join(", ")}. Set it in Settings.`
    );
  }

  let apiKey: string;
  try {
    apiKey = decrypt(provider.apiKeyEncrypted as string);
  } catch {
    throw new UnrecoverableError(
      "The stored AI API key could not be decrypted — has the secret key (SESSION_SECRET or secret.key in the data folder) changed? Re-enter it in Settings."
    );
  }

  return {
    baseUrl: provider.baseUrl,
    apiKey,
    model: provider.model,
  };
}

// ---------------------------------------------------------------------------
// Diff + intent sources
// ---------------------------------------------------------------------------

export interface ResolvedTarget {
  files: LocalFilePatch[];
  intent: ReviewInput["intent"];
  /** pull request record id to hang `Finding -[:FOR]->` off, for PR targets only. */
  prId?: string;
  /** Human-readable description of the diff source, for the job log. */
  description: string;
  /**
   * The exact commits this diff was taken from. Stamped onto every finding
   * so a later read can tell whether the branch/PR has moved since
   * (`./review-freshness.ts`). Resolved *before* the diff is fetched, so if
   * the branch moves mid-run the recorded sha is the older one and the
   * result errs towards "stale", never towards falsely "up to date".
   */
  reviewed: { baseSha?: string; headSha?: string };
}

function toIntentIssues(
  issues: readonly LinkedIssue[]
): NonNullable<ReviewInput["intent"]["linkedIssues"]> {
  return issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? undefined,
  }));
}

/**
 * Persists the PR being reviewed as a pull request record, so findings'
 * `prId` has something to point at.
 *
 * Best-effort by design: if this write fails, the review itself is still
 * perfectly valid — the findings just lose one edge — so it is logged and
 * swallowed rather than failing a job that has already spent API quota.
 */
async function persistPullRequestNode(
  repo: RepoRecord,
  pr: PullRequestDetail,
  log: JobLogger
): Promise<string | undefined> {
  const id = pullRequestNodeId(repo.id, pr.number);
  try {
    await upsertPullRequest({
      id,
      repoId: repo.id,
      number: pr.number,
      title: pr.title,
      description: pr.body ?? undefined,
      author: pr.author ?? "",
      state: pr.state,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      headSha: pr.headSha,
      url: pr.url,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
    });
    return id;
  } catch (error) {
    log(`could not persist PullRequest node ${id}: ${(error as Error).message}`);
    return undefined;
  }
}

/** Fetches the changed files and the intent context for a review target, from whichever source the repo has (local checkout vs. GitHub API). */
export async function resolveTarget(
  repo: RepoRecord,
  target: ReviewTarget,
  log: JobLogger
): Promise<ResolvedTarget> {
  // --- Local repo: refs only, straight off the checkout on disk ---------
  if (repo.provider === "local") {
    if (target.kind === "pr") {
      // The API route rejects this with a 400; this is the backstop for a
      // job enqueued before a repo was switched to a local source.
      throw new UnrecoverableError(
        "A pull request cannot be reviewed on a repo with no GitHub link — compare two refs instead."
      );
    }
    if (!repo.localPath) {
      throw new UnrecoverableError(`Repo ${repo.id} is a local repo but has no localPath.`);
    }
    // Pin both refs to commits first and diff *those*, so the recorded shas
    // are guaranteed to be what was actually reviewed even if a branch moves
    // while the job is running. A missing ref fails the whole job here with a
    // clear message, instead of a cryptic git error a few calls later.
    let baseSha: string;
    let headSha: string;
    try {
      [baseSha, headSha] = await Promise.all([
        resolveLocalRefSha(repo.localPath, target.baseRef),
        resolveLocalRefSha(repo.localPath, target.headRef),
      ]);
    } catch (error) {
      throw new UnrecoverableError((error as Error).message);
    }
    const files = await listLocalFilePatches(repo.localPath, baseSha, headSha);
    return {
      files,
      reviewed: { baseSha, headSha },
      // No PR title/body exists for an ad-hoc comparison, so no intent is
      // asserted — intent validation is specifically "diff vs. the PR's
      // stated intent". Inventing a title here would give the model
      // something to "match" that nobody actually claimed.
      intent: { source: "ref_comparison" },
      description: `local ${target.baseRef}...${target.headRef} (${baseSha.slice(0, 7)}...${headSha.slice(0, 7)})`,
    };
  }

  // --- GitLab repo --------------------------------------------------------
  if (repo.provider === "gitlab") {
    const access = await resolveGitLabAccess(repo);
    if (!access.ok) {
      throw new UnrecoverableError(
        access.reason === "no_token"
          ? "No GitLab PAT configured in Settings — it is needed to fetch this diff."
          : `This repo is not usable over the GitLab API (${access.reason}).`
      );
    }
    const { path: projectPath } = access.ref;

    if (target.kind === "refs") {
      const { data: comparison } = await compareGitLabRefs(
        access.token,
        projectPath,
        target.baseRef,
        target.headRef
      );
      return {
        files: comparison.files.map(toLocalFilePatch),
        reviewed: { baseSha: comparison.baseSha, headSha: comparison.headSha },
        intent: { source: "ref_comparison" },
        description: `${projectPath} ${target.baseRef}...${target.headRef}`,
      };
    }

    const [detail, filesResult, linkedIssues] = await Promise.all([
      getMergeRequest(access.token, projectPath, target.prNumber),
      listMergeRequestFiles(access.token, projectPath, target.prNumber),
      getGitLabLinkedIssues(access.token, projectPath, target.prNumber).catch((error: unknown) => {
        log(`linked-issue lookup failed (continuing without it): ${(error as Error).message}`);
        return { data: [] as LinkedIssue[], rateLimit: null };
      }),
    ]);

    const mr = detail.data;
    const prId = await persistPullRequestNode(repo, mr, log);

    return {
      files: filesResult.data.map(toLocalFilePatch),
      reviewed: { baseSha: mr.baseSha, headSha: mr.headSha },
      intent: {
        source: "pull_request",
        title: mr.title,
        body: mr.body ?? undefined,
        linkedIssues: toIntentIssues(linkedIssues.data),
      },
      prId,
      description: `${projectPath}!${target.prNumber} "${mr.title}"`,
    };
  }

  // --- GitHub repo ------------------------------------------------------
  const access = await resolveGitHubAccess(repo);
  if (!access.ok) {
    throw new UnrecoverableError(
      access.reason === "no_token"
        ? "No GitHub PAT configured in Settings — it is needed to fetch this diff."
        : `This repo is not usable over the GitHub API (${access.reason}).`
    );
  }
  const { owner, repo: repoName } = access.ref;

  if (target.kind === "refs") {
    const { data: comparison } = await compareRefs(
      access.token,
      owner,
      repoName,
      target.baseRef,
      target.headRef
    );
    return {
      files: comparison.files.map(toLocalFilePatch),
      reviewed: { baseSha: comparison.baseSha, headSha: comparison.headSha },
      intent: { source: "ref_comparison" },
      description: `${owner}/${repoName} ${target.baseRef}...${target.headRef}`,
    };
  }

  // PR: detail (title/body) + files (patches) + linked issues (the shared
  // intent context). The three are independent reads, so they go out
  // together rather than serially.
  const [detail, filesResult, linkedIssues] = await Promise.all([
    getPullRequest(access.token, owner, repoName, target.prNumber),
    listPullRequestFiles(access.token, owner, repoName, target.prNumber),
    // Linked issues are a nice-to-have enrichment, and the GraphQL endpoint
    // needs scopes the REST calls don't — never fail a whole review over it.
    getLinkedIssues(access.token, owner, repoName, target.prNumber).catch(
      (error: unknown) => {
        log(`linked-issue lookup failed (continuing without it): ${(error as Error).message}`);
        return { data: [] as LinkedIssue[], rateLimit: null };
      }
    ),
  ]);

  const pr = detail.data;
  const prId = await persistPullRequestNode(repo, pr, log);

  return {
    files: filesResult.data.map(toLocalFilePatch),
    reviewed: { baseSha: pr.baseSha, headSha: pr.headSha },
    intent: {
      source: "pull_request",
      title: pr.title,
      body: pr.body ?? undefined,
      linkedIssues: toIntentIssues(linkedIssues.data),
    },
    prId,
    description: `${owner}/${repoName}#${target.prNumber} "${pr.title}"`,
  };
}

// ---------------------------------------------------------------------------
// The PR map pass
// ---------------------------------------------------------------------------

interface PrMapPassResult {
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
async function runPrMapPass(args: {
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

// ---------------------------------------------------------------------------
// The PR-level intent pass
// ---------------------------------------------------------------------------

const INTENT_ASSESSMENT: Record<PrIntentVerdict, FindingAssessment> = {
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
async function runIntentPass(args: {
  intent: ReviewInput["intent"];
  files: LocalFilePatch[];
  findingLines: string[];
  /** The change to the endpoints, one line each (DESIGN.md §6.11). */
  apiLines?: string[];
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

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/**
 * Runs one full review. Throws only on failures that make the *whole* run
 * impossible (repo gone, AI unconfigured, diff unfetchable) — an individual
 * component whose model call fails is recorded and stepped over, never
 * allowed to abort the run, since by then the other components' calls have
 * already been paid for and `attempts: 1` means there is no second chance.
 *
 * `signal` (aborted when the user cancels, worker/index.ts) stops the run
 * where it is: calls in flight are aborted, no further component is started,
 * and the job fails with {@link REVIEW_CANCELLED_REASON}. Findings already
 * written for finished components stay; nothing after that point is written,
 * and findings of components the target no longer touches are not pruned —
 * that only happens once every touched component has been reviewed.
 */
export async function runReviewJob(
  data: ReviewJobData,
  job?: Pick<ReviewJob, "updateProgress">,
  log: JobLogger = (message) => console.log(`[review] ${message}`),
  signal?: AbortSignal
): Promise<ReviewJobResult> {
  const startedAt = Date.now();
  const { repoId, target } = data;
  const targetKey = reviewTargetKey(target);
  const effort = data.effort ?? DEFAULT_REVIEW_EFFORT;
  const effortSettings = REVIEW_EFFORT_SETTINGS[effort];

  const progress: ReviewProgress = {
    total: 0,
    completed: 0,
    failed: 0,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    running: [],
    unmatchedFiles: 0,
    effort,
  };
  // Keyed by component id, not name: two components can legitimately share a
  // display name, and removing one from a name-keyed set would drop both
  // from the "currently running" list.
  const running = new Map<string, string>();
  const publishProgress = async (): Promise<void> => {
    progress.running = [...running.values()];
    try {
      // Progress is advisory (a live counter) — a hiccup writing
      // it must never take down a job that is otherwise succeeding.
      await job?.updateProgress({ ...progress });
    } catch {
      /* ignored */
    }
  };
  /** Ends a cancelled run, leaving the final cost counter behind for the UI. */
  const stopIfCancelled = async (): Promise<void> => {
    if (!signal?.aborted) return;
    running.clear();
    await publishProgress();
    log(
      `cancelled after ${progress.calls} model call(s) — the findings of ` +
        `${progress.completed + progress.failed} finished component(s) are kept`
    );
    throw new UnrecoverableError(REVIEW_CANCELLED_REASON);
  };

  const repo = await getRepoById(repoId);
  if (!repo) {
    throw new UnrecoverableError(`Repo ${repoId} no longer exists — nothing to review.`);
  }

  const aiConfig = await loadAiConfig();
  log(
    `repo ${repo.name} (${repo.provider}) · target ${targetKey} · model ${aiConfig.model} · ` +
      `effort ${effort} (${effortSettings.tokenBudget} token budget per call)`
  );

  const resolved = await resolveTarget(repo, target, log);
  log(`diff source: ${resolved.description} — ${resolved.files.length} changed file(s)`);
  await stopIfCancelled();
  // Stamped on every finding this run writes (see `ResolvedTarget.reviewed`).
  // `reviewedAt` is the moment the shas were captured, not when each
  // component happened to finish.
  const reviewedAt = new Date().toISOString();
  const revision = {
    ...(resolved.reviewed.baseSha ? { reviewedBaseSha: resolved.reviewed.baseSha } : {}),
    ...(resolved.reviewed.headSha ? { reviewedHeadSha: resolved.reviewed.headSha } : {}),
    reviewedAt,
  };

  // The code as the target leaves it — for related-code context and the
  // impact pass. `null` (logged) falls back to the default branch / skips.
  const head = await openHeadSource(repo, target, resolved.reviewed.headSha, log);
  await stopIfCancelled();
  // The target's base and head analysed from names (TS/JS, Python, Java,
  // Kotlin): the impact pass and the related-code context read from it.
  const analyses = await loadTargetAnalyses(repo, target, resolved.reviewed, head, log);
  await stopIfCancelled();
  const ownerNames = analyses ? await loadOwnerNames(repoId) : null;
  // Code moved to another file and changed on the way: each side's review sees the
  // old copy against the new one, and the impact pass judges the callers against it.
  const moved = analyses && head ? await movedCodeChanges(analyses, (path) => head.read(path)) : [];
  if (moved.length > 0) log(`moved and changed on the way: ${moved.map((m) => `${m.name} (${m.from} → ${m.to}, ${m.changed})`).join(", ")}`);
  // What the change does to the endpoints: each component's review sees the
  // ones it serves or sits behind, the intent check sees all of them.
  const apiChange = analyses ? compareApis(analyses.base, analyses.head, analyses.changed) : null;
  if (apiChange && (apiChange.changes.length > 0 || apiChange.logic.length > 0)) log(`API: ${apiChangeSummary(apiChange)} Logic changed behind ${apiChange.logic.length}.`);

  // --- Map the diff onto the component graph -----------------------------
  const filesByPath = new Map(resolved.files.map((file) => [file.path, file]));
  const match = await matchFilesToComponents(repoId, [...filesByPath.keys()]);
  const contexts = await getComponentReviewContexts(repoId, match.touchedComponentIds);
  log(
    `mapped to ${contexts.length} touched component(s); ` +
      `${match.unmatchedFiles.length} changed path(s) matched no analyzed file`
  );

  // --- "Retry failed": only the parts whose model call never completed ----
  // Everything else the last run wrote stays as it is (and isn't paid for
  // again). Only safe while the target is where that run left it — once the
  // head moves, the kept findings describe other code, so it's a full run.
  let retry: { componentIds: Set<string>; intent: boolean } | undefined;
  if (data.only === "failed") {
    const existing = await listFindingsByTargetKey(repoId, targetKey);
    const failed = existing.filter((finding) => finding.callFailed);
    const headSha = resolved.reviewed.headSha;
    const sameHead = !headSha || existing.every((f) => !f.reviewedHeadSha || f.reviewedHeadSha === headSha);
    if (failed.length === 0) {
      log("retry requested but nothing failed — running the full review");
    } else if (!sameHead) {
      log("the target moved since the last review — running a full review instead of retrying failures");
    } else {
      retry = {
        componentIds: new Set(failed.filter((f) => f.category === "change").map((f) => f.componentId)),
        intent: failed.some((f) => f.category === "intent"),
      };
      log(
        `retrying ${retry.componentIds.size} failed component(s)` +
          (retry.intent ? " and the intent check" : "") +
          "; keeping every other finding"
      );
    }
  }
  const toReview = retry ? contexts.filter((context) => retry.componentIds.has(context.id)) : contexts;

  progress.total = toReview.length;
  progress.unmatchedFiles = match.unmatchedFiles.length;
  await publishProgress();

  // --- One call per component, a few at a time ---------------------------
  let findingsWritten = 0;
  let nextIndex = 0;
  // Persistence is funnelled through this promise chain so that, however
  // many model calls finish at once, findings are written one component at
  // a time and in completion order.
  let writeChain: Promise<unknown> = Promise.resolve();
  /** A few finding summaries per component, for the PR map pass. */
  const summariesByComponent = new Map<string, string[]>();
  /** One line per finding, for the PR-level intent call. */
  const findingLines: string[] = [];

  const reviewOne = async (context: ComponentReviewContext): Promise<void> => {
    const paths = match.pathsByComponentId.get(context.id) ?? [];
    const files = paths
      .map((path) => filesByPath.get(path))
      .filter((file): file is LocalFilePatch => Boolean(file));

    running.set(context.id, context.name);
    await publishProgress();

    let findings: TargetFindingInput[];
    let failed = false;
    let sent = false;

    try {
      const symbolFiles =
        analyses && head && ownerNames && (effortSettings.signatures || effortSettings.relatedSource)
          ? await symbolRelatedFiles(analyses, paths, ownerNames, (path) => head.read(path), {
              signatures: effortSettings.signatures,
              source: effortSettings.relatedSource,
            })
          : undefined;
      const related = await gatherRelatedContext({
        repo,
        componentId: context.id,
        changedPaths: paths,
        patches: files.map((file) => file.patch ?? ""),
        settings: effortSettings,
        head,
        symbolFiles,
        log: (message) => log(`${context.name}: ${message}`),
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
      const relatedWithMoves =
        componentMoves.length > 0 || componentEndpoints.length > 0
          ? { ...(related ?? {}), ...(componentMoves.length ? { moves: componentMoves } : {}), ...(componentEndpoints.length ? { endpoints: componentEndpoints } : {}) }
          : related;
      signal?.throwIfAborted();
      sent = true;
      const result = await reviewComponentChange(
        aiConfig,
        {
          intent: resolved.intent,
          component: {
            id: context.id,
            name: context.name,
            description: context.description,
            dependsOn: context.dependsOn,
            dependents: context.dependents,
          },
          files,
          related: relatedWithMoves,
        },
        { tokenBudget: effortSettings.tokenBudget, signal }
      );

      progress.calls += result.calls;
      progress.promptTokens += result.usage.promptTokens;
      progress.completionTokens += result.usage.completionTokens;
      summariesByComponent.set(
        context.id,
        result.findings.slice(0, 3).map((finding) => finding.summary)
      );
      for (const finding of result.findings) {
        const labels = [finding.kind, finding.scope, finding.assessment].filter(Boolean).join(", ");
        findingLines.push(`${finding.filePath ?? context.name}: ${finding.summary} (${labels})`);
      }

      findings = result.findings.map((finding) => ({
        id: randomUUID(),
        prId: resolved.prId,
        filePath: finding.filePath,
        lineRange: finding.lineRange,
        summary: finding.summary,
        assessment: finding.assessment,
        scope: finding.scope,
        kind: finding.kind,
        confidence: finding.confidence,
        rationale: finding.rationale,
        model: aiConfig.model,
        createdAt: new Date().toISOString(),
        ...revision,
      }));
      log(
        `${context.name}: ${findings.length} finding(s) from ${files.length} changed file(s)` +
          (result.chunks > 1 ? ` in ${result.chunks} parts` : "") +
          (related?.files?.length ? `, ${related.files.length} related file(s) as context` : "") +
          (result.truncated ? " (diff truncated)" : "") +
          (result.parseFailed ? " (model output could not be parsed)" : "")
      );
    } catch (error) {
      if (signal?.aborted) {
        // Cut off by a cancel. Nothing is written, so whatever this component
        // had from an earlier run stays as it was — and it isn't a failed call
        // for "Retry failed" to pick up. A call in flight may still be billed.
        if (sent) progress.calls += 1;
        running.delete(context.id);
        await publishProgress();
        return;
      }
      failed = true;
      // A rejected call still went out (and, with a hosted provider, may
      // still be billed), so it counts toward the running call counter.
      // One is a lower bound — `reviewComponentChange` only throws after its
      // own attempts are exhausted and doesn't report how many it made.
      progress.calls += 1;
      // `AiClientError` (lib/ai) already carries a message naming the status
      // / network failure, so it needs no special-casing beyond `Error`.
      const message = error instanceof Error ? error.message : String(error);
      // A failed component becomes a visible `unknown` finding rather than
      // silence: reviews run automatically for every touched component,
      // so "nothing was said about this component" must not be ambiguous
      // between "the model found nothing" and "the call never landed".
      findings = [
        {
          id: randomUUID(),
          prId: resolved.prId,
          summary: `Review of ${context.name} failed.`,
          assessment: "unknown",
          confidence: 0,
          rationale: `The AI review call for this component did not complete: ${message}`,
          callFailed: true,
          model: aiConfig.model,
          createdAt: new Date().toISOString(),
          ...revision,
        },
      ];
      log(`${context.name}: model call failed — ${message}`);
    }

    running.delete(context.id);

    const write = writeChain.then(() =>
      replaceFindingsForTargetComponent(repoId, targetKey, context.id, findings)
    );
    // Keep the chain alive even when this link rejects, so one failed write
    // can't poison every component queued behind it.
    writeChain = write.catch(() => undefined);
    try {
      await write;
      findingsWritten += findings.length;
    } catch (error) {
      failed = true;
      log(`${context.name}: persisting findings failed — ${(error as Error).message}`);
    }

    if (failed) progress.failed += 1;
    else progress.completed += 1;
    await publishProgress();
  };

  const runner = async (): Promise<void> => {
    // A cancel stops the next component from starting; the ones in flight
    // are aborted inside `reviewOne`.
    for (let index = nextIndex++; index < toReview.length && !signal?.aborted; index = nextIndex++) {
      await reviewOne(toReview[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MODEL_CONCURRENCY, toReview.length) }, runner)
  );
  // Before pruning: a cancelled run hasn't looked at every touched component.
  await stopIfCancelled();

  // --- Drop findings for components this target no longer touches -------
  const prunedFindings = await deleteFindingsForTargetExceptComponents(
    repoId,
    targetKey,
    contexts.map((context) => context.id)
  );
  if (prunedFindings > 0) {
    log(`pruned ${prunedFindings} finding(s) for components no longer touched`);
  }

  // Impact and intent findings are replaced wholesale per run, through the
  // same serialised write chain as the component findings.
  const persistCategory = async (
    category: "impact" | "intent",
    findings: Parameters<typeof replaceFindingsForTargetCategory>[3]
  ): Promise<void> => {
    const write = writeChain.then(() => replaceFindingsForTargetCategory(repoId, targetKey, category, findings));
    writeChain = write.catch(() => undefined);
    try {
      await write;
      findingsWritten += findings.length;
    } catch (error) {
      log(`persisting ${category} findings failed — ${(error as Error).message}`);
    }
  };

  if (retry) {
    // The intent call sees one line per finding — the kept ones included.
    if (retry.intent && resolved.intent.source === "pull_request") {
      const lines = (await listFindingsByTargetKey(repoId, targetKey))
        .filter((f) => f.category !== "intent" && !f.callFailed)
        .map((f) => `${f.filePath ?? f.componentName}: ${f.summary} (${[f.kind, f.scope, f.assessment].filter(Boolean).join(", ")})`);
      running.set("__intent", "Intent check");
      await publishProgress();
      const intentPass = await runIntentPass({
        intent: resolved.intent,
        files: resolved.files,
        findingLines: lines,
        ...(apiChange && (apiChange.changes.length || apiChange.logic.length) ? { apiLines: describeApiChange(apiChange) } : {}),
        aiConfig,
        tokenBudget: effortSettings.tokenBudget,
        prId: resolved.prId,
        revision,
        log,
        signal,
      });
      running.delete("__intent");
      progress.calls += intentPass.calls;
      progress.promptTokens += intentPass.promptTokens;
      progress.completionTokens += intentPass.completionTokens;
      await stopIfCancelled();
      await persistCategory("intent", [intentPass.finding]);
    }
    await publishProgress();
    return finish();
  }

  // --- Usages the change left behind ----------------------------------------
  running.set("__impact", "Impact check");
  await publishProgress();
  const impact = await runImpactPass({
    repoId,
    files: resolved.files,
    head,
    aiConfig,
    tokenBudget: effortSettings.tokenBudget,
    prId: resolved.prId,
    revision,
    log,
    signal,
    analyses,
    moved,
  });
  running.delete("__impact");
  progress.calls += impact.calls;
  progress.promptTokens += impact.promptTokens;
  progress.completionTokens += impact.completionTokens;
  // A cut-off pass found nothing; writing that would wipe the last run's impact findings.
  await stopIfCancelled();
  await persistCategory("impact", impact.findings);
  for (const finding of impact.findings) {
    if (finding.assessment !== "ok") findingLines.push(`${finding.filePath}: ${finding.summary} (impact, ${finding.assessment})`);
  }

  // --- Does the PR deliver what it claims? ----------------------------------
  if (resolved.intent.source === "pull_request") {
    running.set("__intent", "Intent check");
    await publishProgress();
    const intentPass = await runIntentPass({
      intent: resolved.intent,
      files: resolved.files,
      findingLines,
      ...(apiChange && (apiChange.changes.length || apiChange.logic.length) ? { apiLines: describeApiChange(apiChange) } : {}),
      aiConfig,
      tokenBudget: effortSettings.tokenBudget,
      prId: resolved.prId,
      revision,
      log,
      signal,
    });
    running.delete("__intent");
    progress.calls += intentPass.calls;
    progress.promptTokens += intentPass.promptTokens;
    progress.completionTokens += intentPass.completionTokens;
    await stopIfCancelled();
    await persistCategory("intent", [intentPass.finding]);
  } else {
    await persistCategory("intent", []);
  }

  // --- Group and name the PR map (DESIGN.md §6.4) -------------------------
  running.set("__pr-map", "PR map");
  await publishProgress();
  const prMapSpent = await runPrMapPass({
    repoId,
    targetKey,
    prId: resolved.prId,
    files: resolved.files,
    intent: resolved.intent,
    summariesByComponent,
    aiConfig,
    tokenBudget: effortSettings.tokenBudget,
    log,
    signal,
  });
  running.delete("__pr-map");
  progress.calls += prMapSpent.calls;
  progress.promptTokens += prMapSpent.promptTokens;
  progress.completionTokens += prMapSpent.completionTokens;
  await stopIfCancelled();

  await publishProgress();
  return finish();

  function finish(): ReviewJobResult {
    const durationMs = Date.now() - startedAt;
    log(
      `done in ${durationMs}ms — ${progress.completed} component(s) reviewed, ` +
        `${progress.failed} failed, ${findingsWritten} finding(s), ${progress.calls} model call(s), ` +
        `${progress.promptTokens}+${progress.completionTokens} token(s)`
    );

    return {
      repoId,
      targetKey,
      components: toReview.length,
      failedComponents: progress.failed,
      findings: findingsWritten,
      calls: progress.calls,
      promptTokens: progress.promptTokens,
      completionTokens: progress.completionTokens,
      prunedFindings,
      durationMs,
      ...(resolved.reviewed.baseSha ? { reviewedBaseSha: resolved.reviewed.baseSha } : {}),
      ...(resolved.reviewed.headSha ? { reviewedHeadSha: resolved.reviewed.headSha } : {}),
      reviewedAt,
    };
  }
}
