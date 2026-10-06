// The repo behind every /repo/[repoId] page, loaded once per request.
//
// Two server components need it: the repo layout (404 for an unknown repo, a
// load error in the page) and the navbar's `@nav` slot (name, source and
// status in the top bar). React's `cache` makes them share one lookup — and
// one `autoEnqueue`, which is what implements "opening a repo enqueues a
// background re-analysis when the stored graph is behind": the check is one
// cheap HEAD probe and it never blocks the render on the analysis itself.

import { cache } from "react";
import { getRepoDto } from "@/lib/jobs";
import type { RepoDto } from "@/lib/jobs";
import { getRepoById } from "@/lib/db";

export interface LoadedRepo {
  /** The repo, when it could be read. */
  repo: RepoDto | null;
  /** No such repo (and the database was readable) — the layout 404s. */
  missing: boolean;
  /** The database or the status check failed; the page still renders. */
  loadError: string | null;
}

export const loadRepo = cache(async (repoId: string): Promise<LoadedRepo> => {
  // An unreadable database is a different failure from "this repo doesn't
  // exist": only the latter is a 404.
  let record: Awaited<ReturnType<typeof getRepoById>> = null;
  try {
    record = await getRepoById(repoId);
  } catch (error) {
    return { repo: null, missing: false, loadError: error instanceof Error ? error.message : String(error) };
  }
  if (!record) return { repo: null, missing: true, loadError: null };
  try {
    return { repo: await getRepoDto(record, { autoEnqueue: true }), missing: false, loadError: null };
  } catch (error) {
    return { repo: null, missing: false, loadError: error instanceof Error ? error.message : String(error) };
  }
});
