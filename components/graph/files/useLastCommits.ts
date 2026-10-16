// The newest commit per entry of one folder, for the Files view's rows and a
// file's header. Kept per repo, commit and folder for the page's life — a
// commit's history never changes — so opening a file reuses its folder's walk.

import { useEffect, useState } from "react";
import type { LastCommitDTO, LastCommitsResponseDTO } from "../files-types";

type Commits = Record<string, LastCommitDTO | null>;

const cache = new Map<string, Promise<Commits | null>>();

function load(repoId: string, sha: string, dir: string): Promise<Commits | null> {
  const key = `${repoId}\0${sha}\0${dir}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = fetch(`/api/repos/${encodeURIComponent(repoId)}/last-commits?sha=${encodeURIComponent(sha)}&dir=${encodeURIComponent(dir)}`)
      .then(async (res) => (res.ok ? ((await res.json()) as LastCommitsResponseDTO).commits : null))
      .catch(() => null);
    // A failure is retried next time.
    entry.then((commits) => commits ?? cache.delete(key));
    cache.set(key, entry);
  }
  return entry;
}

/** `undefined` while loading; `null` when the history couldn't be read (rows then show no message) or `dir` is `null`. */
export function useLastCommits(repoId: string, sha: string, dir: string | null): Commits | null | undefined {
  const [state, setState] = useState<{ key: string; commits: Commits | null } | null>(null);
  const key = `${repoId}\0${sha}\0${dir}`;
  useEffect(() => {
    if (dir === null) return;
    let cancelled = false;
    void load(repoId, sha, dir).then((commits) => {
      if (!cancelled) setState({ key, commits });
    });
    return () => {
      cancelled = true;
    };
  }, [repoId, sha, dir, key]);
  if (dir === null) return null;
  return state?.key === key ? state.commits : undefined;
}
