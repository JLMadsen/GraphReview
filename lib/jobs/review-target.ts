// What a review (and the checklist, chat and PR context) is about: the target
// resolved to its diff, its intent context (the PR's description and linked
// issues) and the PR's node in the graph — plus the AI provider and code
// owners the review job loads.

import { UnrecoverableError } from "./runner";
import type { AiProviderConfig, ReviewInput } from "@/lib/ai";
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
  getActiveAiProvider,
  getFileOwnerMap,
  listComponentsByRepoId,
  upsertPullRequest,
} from "@/lib/db";
import type { RepoRecord } from "@/lib/db";
import type { JobLogger } from "./analyze";
import { resolveGitHubAccess } from "./github-access";
import { resolveGitLabAccess } from "./gitlab-access";
import {
  listLocalFilePatches,
  resolveLocalRefSha,
  toLocalFilePatch,
  type LocalFilePatch,
} from "./local-git";
import {
  type ReviewTarget,
} from "./review-queue";

/** Stable pull request record id for a repo + PR number — mirrors the `<repoId>:<kind>:<key>` convention `analyze.ts` uses for components and files. */
export function pullRequestNodeId(repoId: string, prNumber: number): string {
  return `${repoId}:pr:${prNumber}`;
}

/** A path's owning component name ("" when it has none), for related-code headings. */
export async function loadOwnerNames(repoId: string): Promise<(path: string) => string> {
  const [owners, components] = await Promise.all([getFileOwnerMap(repoId), listComponentsByRepoId(repoId)]);
  const names = new Map(components.map((c) => [c.id, c.name]));
  return (path) => names.get(owners.get(path) ?? "") ?? "";
}

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
export async function loadAiConfig(): Promise<AiProviderConfig> {
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

export function toIntentIssues(
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
export async function persistPullRequestNode(
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
