// What the diff picker offers: branches, pull requests and commits, as the
// API lists them, and the fetch state of each list.

import { useEffect, useState } from "react";

/** Whether a picked (possibly abbreviated) sha names this commit. */
export function sameCommit(sha: string, picked: string): boolean {
  return sha.toLowerCase().startsWith(picked.toLowerCase());
}

// Minimal shapes for the two GitHub-backed list endpoints this panel
// consumes (`GET /api/repos/[repoId]/branches`,
// `GET /api/repos/[repoId]/pull-requests`). Kept local and framework-agnostic
// (mirroring this directory's types.ts convention) rather than importing
// lib/jobs's `BranchesResponse`/`PullRequestsResponse` — that package is
// server-only and this is a client component. Both endpoints share the
// `linked`/`error` envelope from lib/jobs/github-access.ts.
export interface BranchOption {
  name: string;
  protected: boolean;
}

export interface PullRequestOption {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  updatedAt: string;
  // The rest of the summary the endpoint sends — the diff summary's meta lines.
  draft?: boolean;
  author?: string | null;
  baseRef?: string;
  headRef?: string;
  createdAt?: string;
}

export interface CommitOption {
  sha: string;
  subject: string;
  author: string | null;
  date: string;
  parents: string[];
}

export interface CommitsApiResponse {
  linked: boolean;
  error?: string;
  commits: CommitOption[];
}

export interface BranchesApiResponse {
  linked: boolean;
  error?: string;
  branches: BranchOption[];
}

export interface PullRequestsApiResponse {
  linked: boolean;
  error?: string;
  pullRequests: PullRequestOption[];
}

/**
 * `idle` → not fetched yet (mode never opened). `loading` → in flight.
 * `loaded` → use the dropdown. `fallback` → not linked, fetch failed, or the
 * list came back empty — keep the free-text input rather than show a dead
 * end.
 */
export type ListFetchState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; items: T[] }
  | { status: "fallback" };

/**
 * A list fetched lazily the first time its mode is open (on mount if it is
 * the initial mode, e.g. arriving via `?base=`/`?head=`), then kept. Falls
 * back to the free-text inputs — rather than an empty dropdown — if the repo
 * isn't linked to GitHub, the request fails, or it comes back empty.
 */
export function useLazyList<R extends { linked: boolean; error?: string }, T>(
  active: boolean,
  url: string,
  pick: (json: R) => T[] | undefined
): ListFetchState<T> {
  const [state, setState] = useState<ListFetchState<T>>({ status: "idle" });
  useEffect(() => {
    if (!active || state.status !== "idle") return;
    let cancelled = false;
    setState({ status: "loading" });
    fetch(url)
      .then((res) => res.json())
      .then((json: R) => {
        if (cancelled) return;
        const items = json?.linked && !json.error ? pick(json) : undefined;
        setState(Array.isArray(items) && items.length > 0 ? { status: "loaded", items } : { status: "fallback" });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "fallback" });
      });
    return () => {
      cancelled = true;
    };
    // `state.status` is intentionally read but not listed: this effect must
    // run only when the mode or the URL change, not whenever the state *it*
    // just set changes too. Including it self-triggers a second invocation
    // the instant `setState({ status: "loading" })` commits — the cleanup
    // from that first invocation then cancels the in-flight fetch before its
    // response ever arrives, so the list gets stuck on "loading" forever
    // (rendering the same fallback input as "fallback", silently, even
    // though the request actually succeeded). `pick` is a plain accessor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, url]);
  return state;
}
