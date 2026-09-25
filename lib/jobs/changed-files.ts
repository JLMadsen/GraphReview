// The changed files of a review target — status, line counts and patch text —
// from whichever source the repo has (local checkout, GitHub or GitLab).
//
// Used by the PR map endpoint, which needs statuses and +/- counts that the
// diff-impact endpoint's path-only lookup doesn't carry. The review job has
// its own copy of this dispatch (`resolveTarget` in ./review.ts) because it
// also needs the PR's intent and shas; the two only share the file shape.
//
// Cached in memory for a short while: the Graph tab asks for the PR map on
// every target change and again when a review finishes, and a large PR's
// file list is several paginated API calls.

import { compareRefs, listPullRequestFiles } from "@/lib/github";
import { compareRefs as compareGitLabRefs, listMergeRequestFiles } from "@/lib/gitlab";
import type { RepoRecord } from "@/lib/neo4j";
import { resolveGitHubAccess } from "./github-access";
import { resolveGitLabAccess } from "./gitlab-access";
import { listLocalFilePatches, toLocalFilePatch, type LocalFilePatch } from "./local-git";
import { reviewTargetKey, type ReviewTarget } from "./review-queue";

/** A target whose files can't be fetched for a reason the user can fix (no PAT, bad URL, PR on a local repo …). */
export class ChangedFilesError extends Error {}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 50;
const cache = new Map<string, { fetchedAt: number; files: LocalFilePatch[] }>();

export async function listTargetChangedFiles(
  repo: RepoRecord,
  target: ReviewTarget
): Promise<LocalFilePatch[]> {
  const key = `${repo.id}\u0000${reviewTargetKey(target)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.files;

  const files = await fetchChangedFiles(repo, target);
  cache.delete(key);
  cache.set(key, { fetchedAt: Date.now(), files });
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return files;
}

async function fetchChangedFiles(repo: RepoRecord, target: ReviewTarget): Promise<LocalFilePatch[]> {
  if (repo.provider === "local") {
    if (target.kind === "pr") {
      throw new ChangedFilesError(
        "A pull request cannot be diffed on a repo with no git-host link — compare two refs instead."
      );
    }
    if (!repo.localPath) throw new ChangedFilesError("This local repo has no path on record.");
    return listLocalFilePatches(repo.localPath, target.baseRef, target.headRef);
  }

  if (repo.provider === "gitlab") {
    const access = await resolveGitLabAccess(repo);
    if (!access.ok) {
      throw new ChangedFilesError(
        access.reason === "no_token"
          ? "No GitLab PAT configured in Settings."
          : "This repo is not usable over the GitLab API."
      );
    }
    if (target.kind === "pr") {
      const { data } = await listMergeRequestFiles(access.token, access.ref.path, target.prNumber);
      return data.map(toLocalFilePatch);
    }
    const { data } = await compareGitLabRefs(access.token, access.ref.path, target.baseRef, target.headRef);
    return data.files.map(toLocalFilePatch);
  }

  const access = await resolveGitHubAccess(repo);
  if (!access.ok) {
    throw new ChangedFilesError(
      access.reason === "no_token"
        ? "No GitHub PAT configured in Settings."
        : "This repo is not usable over the GitHub API."
    );
  }
  const { owner, repo: name } = access.ref;
  if (target.kind === "pr") {
    const { data } = await listPullRequestFiles(access.token, owner, name, target.prNumber);
    return data.map(toLocalFilePatch);
  }
  const { data } = await compareRefs(access.token, owner, name, target.baseRef, target.headRef);
  return data.files.map(toLocalFilePatch);
}
