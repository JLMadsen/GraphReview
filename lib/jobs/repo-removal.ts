// Removing a repo: its stored data, its queued jobs and its clone.
//
// A job already running for the repo can't be stopped, and it may write a
// little more (files, findings, a fresh clone) after the repo is gone. So the
// worker calls `cleanUpIfRepoRemoved` when any job finishes, which repeats the
// removal for a repo that no longer exists.
//
// A local repo's checkout is the user's own and is never touched: the only
// folder removed is the repo's slot in GraphReview's clone cache, which
// exists only for GitHub/GitLab repos.

import { rm } from "node:fs/promises";
import { deleteRepo, getRepoById } from "@/lib/db";
import { repoCacheDir } from "./source";

async function removeClone(repoId: string): Promise<void> {
  await rm(repoCacheDir(repoId), { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
    console.error(`[repo-removal] could not delete the clone of ${repoId}: ${(error as Error).message}`);
  });
}

/** Deletes a repo, everything stored for it, and its clone (if it has one). */
export async function removeRepo(repoId: string): Promise<void> {
  await deleteRepo(repoId);
  await removeClone(repoId);
}

/** After a job for `repoId` finishes: if the repo was removed meanwhile, removes what the job left behind. */
export async function cleanUpIfRepoRemoved(repoId: string | undefined): Promise<void> {
  if (!repoId || (await getRepoById(repoId))) return;
  await removeRepo(repoId);
}
