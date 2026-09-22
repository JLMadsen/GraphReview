// The AI review job body — DESIGN.md §9, §10.
//
// Pipeline: load the repo → load and decrypt the AI provider settings (§11)
// → fetch the diff and the "intent" context for the target → map changed
// files onto the component graph (§6) → one LLM call per touched component
// (§9), a few in flight at a time → persist each component's findings the
// moment it completes (§10's overwrite-only semantics), so they stream into
// the UI → prune findings for components the target no longer touches.
//
// Kept out of `worker/index.ts` and out of lib/jobs' barrel on purpose, for
// the same reason as `./analyze.ts`: this is the unit of work (importable
// from a script or test without starting a queue consumer), and it pulls in
// lib/ai + lib/github, which the app bundle has no reason to carry just
// because a route imported `@/lib/jobs` to enqueue something.

import { randomUUID } from "node:crypto";
import { UnrecoverableError } from "bullmq";
import { reviewComponentChange } from "@/lib/ai";
import type { AiProviderConfig, ReviewInput } from "@/lib/ai";
import { decrypt } from "@/lib/crypto";
import { compareRefs, getLinkedIssues, getPullRequest, listPullRequestFiles } from "@/lib/github";
import type { LinkedIssue, PullRequestDetail } from "@/lib/github";
import {
  deleteFindingsForTargetExceptComponents,
  getActiveAiProvider,
  getRepoById,
  linkPullRequestToRepo,
  replaceFindingsForTargetComponent,
  upsertPullRequest,
} from "@/lib/neo4j";
import type { RepoRecord } from "@/lib/neo4j";
import type { TargetFindingInput } from "@/lib/neo4j";
import type { JobLogger } from "./analyze";
import {
  getComponentReviewContexts,
  matchFilesToComponents,
  type ComponentReviewContext,
} from "./diff-components";
import { resolveGitHubAccess } from "./github-access";
import {
  listLocalFilePatches,
  resolveLocalRefSha,
  toLocalFilePatch,
  type LocalFilePatch,
} from "./local-git";
import {
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
 * Small on purpose. §9's whole point is that calls are independent and can
 * be parallelized, but the configured provider may well be a single local
 * model server (decision #8) that serializes internally anyway, and a burst
 * of dozens of concurrent requests is the fastest way to trip a hosted
 * provider's rate limit — which, with `attempts: 1`, there is no automatic
 * second chance for.
 */
const MODEL_CONCURRENCY = 3;

/** Stable `(:PullRequest)` node id for a repo + PR number — mirrors the `<repoId>:<kind>:<key>` convention `analyze.ts` uses for components and files. */
function pullRequestNodeId(repoId: string, prNumber: number): string {
  return `${repoId}:pr:${prNumber}`;
}

// ---------------------------------------------------------------------------
// AI provider settings
// ---------------------------------------------------------------------------

/**
 * Reads and decrypts the currently *active* saved AI provider (§8, §11 —
 * now multiple providers can be saved, lib/neo4j/ai-provider.ts, with one
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
      `AI provider is not fully configured — missing ${missing.join(", ")}. Set it in Settings (DESIGN.md §8).`
    );
  }

  let apiKey: string;
  try {
    apiKey = decrypt(provider.apiKeyEncrypted as string);
  } catch {
    throw new UnrecoverableError(
      "The stored AI API key could not be decrypted — has SESSION_SECRET changed? Re-enter it in Settings."
    );
  }

  return {
    baseUrl: provider.baseUrl,
    apiKey,
    model: provider.model,
  };
}

// ---------------------------------------------------------------------------
// Diff + intent sources (§8, §9)
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  files: LocalFilePatch[];
  intent: ReviewInput["intent"];
  /** `(:PullRequest)` node id to hang `Finding -[:FOR]->` off, for PR targets only. */
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
 * Persists the PR being reviewed as a `(:PullRequest)` node (§7), so the
 * `Finding -[:FOR]-> (:PullRequest)` edge has something to point at.
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
    await linkPullRequestToRepo(id, repo.id);
    return id;
  } catch (error) {
    log(`could not persist PullRequest node ${id}: ${(error as Error).message}`);
    return undefined;
  }
}

/** Fetches the changed files and the intent context for a review target, from whichever source the repo has (local checkout vs. GitHub API). */
async function resolveTarget(
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
      // asserted — §3's intent validation is specifically "diff vs. the PR's
      // stated intent". Inventing a title here would give the model
      // something to "match" that nobody actually claimed.
      intent: { source: "ref_comparison" },
      description: `local ${target.baseRef}...${target.headRef} (${baseSha.slice(0, 7)}...${headSha.slice(0, 7)})`,
    };
  }

  // --- GitHub repo ------------------------------------------------------
  const access = await resolveGitHubAccess(repo);
  if (!access.ok) {
    throw new UnrecoverableError(
      access.reason === "no_token"
        ? "No GitHub PAT configured in Settings — it is needed to fetch this diff (decision #7)."
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

  // PR: detail (title/body) + files (patches) + linked issues (§9's shared
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
// The job
// ---------------------------------------------------------------------------

/**
 * Runs one full review. Throws only on failures that make the *whole* run
 * impossible (repo gone, AI unconfigured, diff unfetchable) — an individual
 * component whose model call fails is recorded and stepped over, never
 * allowed to abort the run, since by then the other components' calls have
 * already been paid for and `attempts: 1` means there is no second chance.
 */
export async function runReviewJob(
  data: ReviewJobData,
  job?: Pick<ReviewJob, "updateProgress">,
  log: JobLogger = (message) => console.log(`[review] ${message}`)
): Promise<ReviewJobResult> {
  const startedAt = Date.now();
  const { repoId, target } = data;
  const targetKey = reviewTargetKey(target);

  const repo = await getRepoById(repoId);
  if (!repo) {
    throw new UnrecoverableError(`Repo ${repoId} no longer exists — nothing to review.`);
  }

  const aiConfig = await loadAiConfig();
  log(`repo ${repo.name} (${repo.provider}) · target ${targetKey} · model ${aiConfig.model}`);

  const resolved = await resolveTarget(repo, target, log);
  log(`diff source: ${resolved.description} — ${resolved.files.length} changed file(s)`);
  // Stamped on every finding this run writes (see `ResolvedTarget.reviewed`).
  // `reviewedAt` is the moment the shas were captured, not when each
  // component happened to finish.
  const reviewedAt = new Date().toISOString();
  const revision = {
    ...(resolved.reviewed.baseSha ? { reviewedBaseSha: resolved.reviewed.baseSha } : {}),
    ...(resolved.reviewed.headSha ? { reviewedHeadSha: resolved.reviewed.headSha } : {}),
    reviewedAt,
  };

  // --- Map the diff onto the component graph (§6) -----------------------
  const filesByPath = new Map(resolved.files.map((file) => [file.path, file]));
  const match = await matchFilesToComponents(repoId, [...filesByPath.keys()]);
  const contexts = await getComponentReviewContexts(repoId, match.touchedComponentIds);
  log(
    `mapped to ${contexts.length} touched component(s); ` +
      `${match.unmatchedFiles.length} changed path(s) matched no analyzed file`
  );

  const progress: ReviewProgress = {
    total: contexts.length,
    completed: 0,
    failed: 0,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    running: [],
    unmatchedFiles: match.unmatchedFiles.length,
  };
  // Keyed by component id, not name: two components can legitimately share a
  // display name, and removing one from a name-keyed set would drop both
  // from the "currently running" list.
  const running = new Map<string, string>();
  const publishProgress = async (): Promise<void> => {
    progress.running = [...running.values()];
    try {
      // Progress is advisory (§10's live counter) — a Redis hiccup writing
      // it must never take down a job that is otherwise succeeding.
      await job?.updateProgress({ ...progress });
    } catch {
      /* ignored */
    }
  };
  await publishProgress();

  // --- One call per component, a few at a time (§9) ---------------------
  let findingsWritten = 0;
  let nextIndex = 0;
  // Persistence is funnelled through this promise chain so that, however
  // many model calls finish at once, only one relationship-creating Neo4j
  // write is ever in flight. Neo4j Community deadlocks otherwise — every
  // finding for a component MERGEs an edge onto the same component node.
  // See NEO4J_RELATIONSHIP_WRITE_CONCURRENCY in ./analyze.ts.
  let writeChain: Promise<unknown> = Promise.resolve();

  const reviewOne = async (context: ComponentReviewContext): Promise<void> => {
    const paths = match.pathsByComponentId.get(context.id) ?? [];
    const files = paths
      .map((path) => filesByPath.get(path))
      .filter((file): file is LocalFilePatch => Boolean(file));

    running.set(context.id, context.name);
    await publishProgress();

    let findings: TargetFindingInput[];
    let failed = false;

    try {
      const result = await reviewComponentChange(aiConfig, {
        intent: resolved.intent,
        component: {
          id: context.id,
          name: context.name,
          description: context.description,
          dependsOn: context.dependsOn,
          dependents: context.dependents,
        },
        files,
      });

      progress.calls += result.calls;
      progress.promptTokens += result.usage.promptTokens;
      progress.completionTokens += result.usage.completionTokens;

      findings = result.findings.map((finding) => ({
        id: randomUUID(),
        prId: resolved.prId,
        filePath: finding.filePath,
        lineRange: finding.lineRange,
        summary: finding.summary,
        intentMatch: finding.intentMatch,
        confidence: finding.confidence,
        rationale: finding.rationale,
        model: aiConfig.model,
        createdAt: new Date().toISOString(),
        ...revision,
      }));
      log(
        `${context.name}: ${findings.length} finding(s) from ${files.length} changed file(s)` +
          (result.truncated ? " (diff truncated)" : "") +
          (result.parseFailed ? " (model output could not be parsed)" : "")
      );
    } catch (error) {
      failed = true;
      // A rejected call still went out (and, with a hosted provider, may
      // still be billed), so it counts toward §10's running call counter.
      // One is a lower bound — `reviewComponentChange` only throws after its
      // own attempts are exhausted and doesn't report how many it made.
      progress.calls += 1;
      // `AiClientError` (lib/ai) already carries a message naming the status
      // / network failure, so it needs no special-casing beyond `Error`.
      const message = error instanceof Error ? error.message : String(error);
      // A failed component becomes a visible `unknown` finding rather than
      // silence: §10 runs these automatically for every touched component,
      // so "nothing was said about this component" must not be ambiguous
      // between "the model found nothing" and "the call never landed".
      findings = [
        {
          id: randomUUID(),
          prId: resolved.prId,
          summary: `Review of ${context.name} failed.`,
          intentMatch: "unknown",
          confidence: 0,
          rationale: `The AI review call for this component did not complete: ${message}`,
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
    for (let index = nextIndex++; index < contexts.length; index = nextIndex++) {
      await reviewOne(contexts[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MODEL_CONCURRENCY, contexts.length) }, runner)
  );

  // --- Drop findings for components this target no longer touches -------
  const prunedFindings = await deleteFindingsForTargetExceptComponents(
    repoId,
    targetKey,
    contexts.map((context) => context.id)
  );
  if (prunedFindings > 0) {
    log(`pruned ${prunedFindings} finding(s) for components no longer touched`);
  }

  await publishProgress();

  const durationMs = Date.now() - startedAt;
  log(
    `done in ${durationMs}ms — ${progress.completed} component(s) reviewed, ` +
      `${progress.failed} failed, ${findingsWritten} finding(s), ${progress.calls} model call(s), ` +
      `${progress.promptTokens}+${progress.completionTokens} token(s)`
  );

  return {
    repoId,
    targetKey,
    components: contexts.length,
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
