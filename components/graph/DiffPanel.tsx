"use client";

// The Graph tab's diff-selection panel: "pick a PR, two branches, or two
// commits" — plus the prototype's "paste changed file paths" textarea. Lives
// as a sidebar inside the Graph tab, not a separate screen. Calls
// `POST /api/repos/[repoId]/diff-impact` and reports the result up to
// GraphView, which feeds it to GraphCanvas for touched-node highlighting.
//
// History (merged/closed PRs, commit comparisons) is browsable without cost:
// every result carries a `DiffTargetMeta` saying whether the AI review should
// start on its own — only for open PRs and branch comparisons — and whether
// the diff is older than the analyzed graph it is mapped onto.

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  GitCommitHorizontal,
  GitCompare,
  GitPullRequest,
  History,
  Info,
  LoaderCircle,
  Target,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "cn";
import { evictClosedAddedCache, readAddedCache, writeAddedCache } from "./added-cache";
import { isShaLike, shortRef } from "./types";
import type {
  AddedComponentDTO,
  AddedComponentsResponseDTO,
  DiffImpactRequestDTO,
  DiffImpactResponseDTO,
  ReviewTargetDTO,
} from "./types";

/** What GraphView needs to know about a result beyond the target itself. */
export interface DiffTargetMeta {
  /** Start the AI review without asking — open PRs and branch comparisons only. */
  autoReview: boolean;
  /** The diff is history (a merged/closed PR, or commits other than the analyzed tip), mapped onto today's graph. */
  historical: boolean;
}

/**
 * The reviewable target behind a diff-impact request, or `null` when there
 * isn't one.
 *
 * "Paste paths" is the `null` case, and deliberately so: the intent check
 * needs the diff *hunks* for each changed file, and a pasted list of paths
 * carries none — there is nothing for the model to read. PR and ref modes
 * both name something the worker can fetch a real diff for, so only those
 * two travel onward to the review endpoint.
 */
function reviewTargetFor(
  body: DiffImpactRequestDTO
): ReviewTargetDTO | null {
  if ("prNumber" in body) return { prNumber: body.prNumber };
  if ("baseRef" in body) return { baseRef: body.baseRef, headRef: body.headRef };
  return null;
}

type Mode = "pr" | "refs" | "commits" | "paths";

// "Paths" (paste changed file paths) is hidden from the mode switcher for
// now — the handling code below still supports it, it's just not reachable
// from the UI.
const MODES: Array<{
  value: Mode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: "pr", label: "PR", icon: GitPullRequest },
  { value: "refs", label: "Branches", icon: GitCompare },
  { value: "commits", label: "Commits", icon: GitCommitHorizontal },
];

type PrFilter = "open" | "merged" | "closed" | "all";
const PR_FILTERS: Array<{ value: PrFilter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
const PR_FILTER_STORAGE_KEY = "graphreview.diff.prFilter";
/** The PR picker lists this many most-recently-updated PRs; older ones are reached by number. */
const PR_LIST_LIMIT = 100;
const COMMIT_LIST_LIMIT = 100;

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
/** "3 days ago" — coarse on purpose, it's for telling commits apart. */
function relativeDate(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((then - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return RELATIVE.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return RELATIVE.format(months, "month");
  return RELATIVE.format(Math.round(months / 12), "year");
}

/** Whether a picked (possibly abbreviated) sha names this commit. */
function sameCommit(sha: string, picked: string): boolean {
  return sha.toLowerCase().startsWith(picked.toLowerCase());
}

/** Mirrors the current check into the URL (`?pr=` / `?base=&head=`) so it can be bookmarked or shared; the page reads the same params on load. */
function syncUrl(body: DiffImpactRequestDTO): void {
  try {
    const url = new URL(window.location.href);
    for (const key of ["pr", "base", "head"]) url.searchParams.delete(key);
    if ("prNumber" in body) url.searchParams.set("pr", String(body.prNumber));
    else if ("baseRef" in body) {
      url.searchParams.set("base", body.baseRef);
      url.searchParams.set("head", body.headRef);
    }
    window.history.replaceState(window.history.state, "", url);
  } catch {
    /* URL sync is a convenience */
  }
}

// Minimal shapes for the two GitHub-backed list endpoints this panel
// consumes (`GET /api/repos/[repoId]/branches`,
// `GET /api/repos/[repoId]/pull-requests`). Kept local and framework-agnostic
// (mirroring this directory's types.ts convention) rather than importing
// lib/jobs's `BranchesResponse`/`PullRequestsResponse` — that package is
// server-only and this is a client component. Both endpoints share the
// `linked`/`error` envelope from lib/jobs/github-access.ts.
interface BranchOption {
  name: string;
  protected: boolean;
}

interface PullRequestOption {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  /** Versions the added-components cache — see added-cache.ts. */
  updatedAt: string;
}

interface CommitOption {
  sha: string;
  subject: string;
  author: string | null;
  date: string;
  parents: string[];
}

interface CommitsApiResponse {
  linked: boolean;
  error?: string;
  commits: CommitOption[];
}

interface BranchesApiResponse {
  linked: boolean;
  error?: string;
  branches: BranchOption[];
}

interface PullRequestsApiResponse {
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
type ListFetchState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; items: T[] }
  | { status: "fallback" };

// `appearance-none` + the chevron rendered next to it (see `SelectShell`)
// replaces the OS-native dropdown arrow, which on a dark surface renders as
// a light-grey system widget that doesn't match anything else in the app.
const SELECT_CLASSNAME =
  "h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent py-1 pr-8 pl-2.5 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30";

/** Positions the custom chevron over a native `<select>`. */
function SelectShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </div>
  );
}

function FieldLabel({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
    >
      {children}
    </label>
  );
}

export interface DiffPanelProps {
  repoId: string;
  defaultBranch?: string;
  /** The commit the component graph was analyzed at — marks that commit in the picker and decides whether a diff is "historical". */
  lastAnalyzedSha?: string;
  /** Pre-fills and auto-runs the PR mode — see GraphView's `?pr=` handling. */
  initialPrNumber?: number;
  /** Pre-fills and auto-runs the "Compare refs" mode — see GraphView's `?base=`/`?head=` handling. */
  initialBaseRef?: string;
  initialHeadRef?: string;
  /**
   * Reports the impact result *and* what it was a result of. The second
   * argument is what the Graph tab's AI review is keyed
   * on — it is `null` for the "paste paths" mode and for any failed check,
   * which is what stops a review from being started for a target that has
   * no diff behind it.
   */
  onResult: (
    result: DiffImpactResponseDTO | null,
    target: ReviewTargetDTO | null,
    meta: DiffTargetMeta
  ) => void;
  /**
   * Reports the AI-labeled components for this check's `unmatchedFiles`
   * (files the PR added with no stored component yet — see
   * `AddedComponentDTO`). Fired with `[]` alongside every `onResult` call
   * that isn't a successful PR-mode check, so the canvas's green highlight
   * always matches the current result. PR mode only: refs/paths checks have
   * no stable identity to cache these against, so they're never labeled.
   */
  onAddedComponents: (components: AddedComponentDTO[]) => void;
}

const NO_META: DiffTargetMeta = { autoReview: false, historical: false };

export function DiffPanel({
  repoId,
  defaultBranch,
  lastAnalyzedSha,
  initialPrNumber,
  initialBaseRef,
  initialHeadRef,
  onResult,
  onAddedComponents,
}: DiffPanelProps) {
  const initialRefsMode = !initialPrNumber && Boolean(initialBaseRef && initialHeadRef);
  // Two shas in the URL are a commit comparison — open the picker for it.
  const initialCommitsMode =
    initialRefsMode && isShaLike(initialBaseRef ?? "") && isShaLike(initialHeadRef ?? "");
  const [mode, setMode] = useState<Mode>(
    initialCommitsMode ? "commits" : initialRefsMode ? "refs" : "pr"
  );
  const [prFilter, setPrFilterState] = useState<PrFilter>("open");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PR_FILTER_STORAGE_KEY);
      if (PR_FILTERS.some((f) => f.value === stored)) setPrFilterState(stored as PrFilter);
    } catch {
      /* keep the default */
    }
  }, []);
  function setPrFilter(filter: PrFilter) {
    setPrFilterState(filter);
    try {
      window.localStorage.setItem(PR_FILTER_STORAGE_KEY, filter);
    } catch {
      /* ignored */
    }
  }
  /** Picked commits, in click order (at most two). Which one is the base is decided by their order in history, not by click order. */
  const [pickedCommits, setPickedCommits] = useState<string[]>(
    initialCommitsMode ? [initialBaseRef!, initialHeadRef!] : []
  );
  /** Set by the last successful check — drives the "mapped onto the current graph" note. */
  const [resultMeta, setResultMeta] = useState<DiffTargetMeta>(NO_META);
  const [prNumber, setPrNumber] = useState(
    initialPrNumber ? String(initialPrNumber) : ""
  );
  const [baseRef, setBaseRef] = useState(initialBaseRef ?? defaultBranch ?? "");
  const [headRef, setHeadRef] = useState(initialHeadRef ?? "");
  const [pathsText, setPathsText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiffImpactResponseDTO | null>(null);
  /** Local copy of whatever was last reported via `onAddedComponents`, for this panel's own "Added" list below. */
  const [addedComponents, setAddedComponents] = useState<AddedComponentDTO[]>([]);

  function reportAddedComponents(components: AddedComponentDTO[]) {
    setAddedComponents(components);
    onAddedComponents(components);
  }

  const [branchesState, setBranchesState] = useState<ListFetchState<BranchOption>>({
    status: "idle",
  });
  const [prListState, setPrListState] = useState<ListFetchState<PullRequestOption>>({
    status: "idle",
  });
  const [commitsState, setCommitsState] = useState<ListFetchState<CommitOption>>({
    status: "idle",
  });

  // Lazily fetch branches the first time "Compare refs" mode is open (on
  // mount if it's the initial mode, e.g. arriving via `?base=`/`?head=`).
  // Falls back to the free-text inputs — rather than an empty dropdown — if
  // the repo isn't linked to GitHub, the request fails, or it comes back
  // with zero branches.
  useEffect(() => {
    if (mode !== "refs" || branchesState.status !== "idle") return;
    let cancelled = false;
    setBranchesState({ status: "loading" });
    fetch(`/api/repos/${repoId}/branches`)
      .then((res) => res.json())
      .then((json: BranchesApiResponse) => {
        if (cancelled) return;
        if (json?.linked && !json.error && Array.isArray(json.branches) && json.branches.length > 0) {
          setBranchesState({ status: "loaded", items: json.branches });
        } else {
          setBranchesState({ status: "fallback" });
        }
      })
      .catch(() => {
        if (!cancelled) setBranchesState({ status: "fallback" });
      });
    return () => {
      cancelled = true;
    };
    // `branchesState.status` is intentionally read but not listed: this
    // effect must run only when `mode`/`repoId` change, not whenever the
    // state *it* just set changes too. Including it self-triggers a second
    // invocation the instant `setBranchesState({ status: "loading" })`
    // commits — the cleanup from that first invocation then cancels the
    // in-flight fetch before its response ever arrives, so `branchesState`
    // gets stuck on "loading" forever (rendering the same fallback input as
    // "fallback", silently, even though the request actually succeeded).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, repoId]);

  // Same lazy-fetch-once-then-fallback pattern for the PR dropdown: the
  // most recently updated PRs of every state in one request, filtered
  // client-side by the Open/Merged/Closed/All chips.
  useEffect(() => {
    if (mode !== "pr" || prListState.status !== "idle") return;
    let cancelled = false;
    setPrListState({ status: "loading" });
    fetch(`/api/repos/${repoId}/pull-requests?state=all&limit=${PR_LIST_LIMIT}`)
      .then((res) => res.json())
      .then((json: PullRequestsApiResponse) => {
        if (cancelled) return;
        const loaded = json?.linked && !json.error && Array.isArray(json.pullRequests);
        if (loaded) {
          // A genuine, successful load — including a truly empty one — is
          // when cache entries for PRs that dropped out of the recent list
          // are safe to drop. Merged PRs stay cached: their `updatedAt`
          // rarely moves again, so their labels stay valid. A failed or
          // not-linked fetch never reaches here, so a network hiccup can't
          // wipe a still-valid cache.
          evictClosedAddedCache(repoId, new Set(json.pullRequests.map((pr) => pr.number)));
        }
        if (loaded && json.pullRequests.length > 0) {
          setPrListState({ status: "loaded", items: json.pullRequests });
        } else {
          setPrListState({ status: "fallback" });
        }
      })
      .catch(() => {
        if (!cancelled) setPrListState({ status: "fallback" });
      });
    return () => {
      cancelled = true;
    };
    // See the branches effect above for why `prListState.status` is
    // deliberately not in this array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, repoId]);

  // The commit picker's list: the default branch's newest commits.
  useEffect(() => {
    if (mode !== "commits" || commitsState.status !== "idle") return;
    let cancelled = false;
    setCommitsState({ status: "loading" });
    fetch(`/api/repos/${repoId}/commits?limit=${COMMIT_LIST_LIMIT}`)
      .then((res) => res.json())
      .then((json: CommitsApiResponse) => {
        if (cancelled) return;
        if (json?.linked && !json.error && Array.isArray(json.commits) && json.commits.length > 0) {
          setCommitsState({ status: "loaded", items: json.commits });
        } else {
          setCommitsState({ status: "fallback" });
        }
      })
      .catch(() => {
        if (!cancelled) setCommitsState({ status: "fallback" });
      });
    return () => {
      cancelled = true;
    };
    // See the branches effect above for why `commitsState.status` is
    // deliberately not in this array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, repoId]);

  const visiblePrs = useMemo(
    () =>
      prListState.status === "loaded"
        ? prListState.items.filter((pr) => prFilter === "all" || pr.state === prFilter)
        : [],
    [prListState, prFilter]
  );

  /** Position of a picked sha in the loaded history (0 = newest), or -1. */
  function commitIndex(sha: string): number {
    return commitsState.status === "loaded"
      ? commitsState.items.findIndex((c) => sameCommit(c.sha, sha))
      : -1;
  }

  /** `[base, head]` for the picked pair: the older commit is always the base, so the three-dot diff is never silently empty. */
  function orderedPick(): [string, string] | null {
    if (pickedCommits.length !== 2) return null;
    const [a, b] = pickedCommits;
    const ia = commitIndex(a);
    const ib = commitIndex(b);
    if (ia === -1 || ib === -1) return [a, b];
    return ia > ib ? [a, b] : [b, a];
  }

  function togglePick(sha: string) {
    setError(null);
    setPickedCommits((prev) => {
      if (prev.some((p) => sameCommit(sha, p))) return prev.filter((p) => !sameCommit(sha, p));
      return prev.length < 2 ? [...prev, sha] : [prev[1], sha];
    });
  }

  /** How the target a check is about should be treated — see `DiffTargetMeta`. */
  function metaFor(body: DiffImpactRequestDTO): DiffTargetMeta {
    if ("prNumber" in body) {
      if (prListState.status !== "loaded") {
        // No list to consult (not linked, fetch failed): keep the old
        // behaviour of reviewing whatever was typed.
        return { autoReview: true, historical: false };
      }
      const pr = prListState.items.find((item) => item.number === body.prNumber);
      // Not among the recent PRs → an old one, typed by number.
      const open = pr?.state === "open";
      return { autoReview: open, historical: !open };
    }
    if ("baseRef" in body && isShaLike(body.headRef)) {
      const atAnalyzedTip = Boolean(lastAnalyzedSha && sameCommit(lastAnalyzedSha, body.headRef));
      return { autoReview: false, historical: !atAnalyzedTip };
    }
    if ("baseRef" in body) return { autoReview: true, historical: false };
    return NO_META;
  }

  // Labels `unmatchedFiles` for a PR-mode check — cache-first (see
  // added-cache.ts), only reaching the network on a miss. `prList` is read
  // fresh from state at call time (not a dependency) since this is only
  // ever invoked from inside `runCheck`, itself an event/effect callback.
  async function loadAddedComponents(prNumber: number, unmatchedFiles: string[]) {
    if (unmatchedFiles.length === 0) {
      reportAddedComponents([]);
      return;
    }
    const knownPr =
      prListState.status === "loaded"
        ? prListState.items.find((pr) => pr.number === prNumber)
        : undefined;
    if (knownPr) {
      const cached = readAddedCache(repoId, prNumber, knownPr.updatedAt);
      if (cached) {
        reportAddedComponents(cached);
        return;
      }
    }
    try {
      const res = await fetch(`/api/repos/${repoId}/diff-impact/added-components`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePaths: unmatchedFiles }),
      });
      const json = (await res.json().catch(() => null)) as
        | AddedComponentsResponseDTO
        | { error: string }
        | null;
      if (!res.ok || !json || "error" in json) {
        reportAddedComponents([]);
        return;
      }
      reportAddedComponents(json.components);
      // Only cacheable when the PR list is loaded — that's where `updatedAt`
      // (the cache's version tag) comes from. Without it, this result is
      // still shown, just re-labeled on the next check.
      if (knownPr) writeAddedCache(repoId, prNumber, knownPr.updatedAt, json.components);
    } catch {
      reportAddedComponents([]);
    }
  }

  async function runCheck(body: DiffImpactRequestDTO) {
    setLoading(true);
    setError(null);
    // Note: the previous result/target is deliberately *not* cleared here.
    // A check takes a moment, and blanking the touched-node highlighting and
    // the review dock for its duration makes the whole page flash back to
    // empty; both are replaced atomically when the new result lands below.
    try {
      const res = await fetch(`/api/repos/${repoId}/diff-impact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as
        | DiffImpactResponseDTO
        | { error: string }
        | null;
      if (!res.ok || !json || "error" in json) {
        const message =
          json && "error" in json ? json.error : `Request failed (${res.status}).`;
        setError(message);
        setResult(null);
        setResultMeta(NO_META);
        onResult(null, null, NO_META);
        reportAddedComponents([]);
        return;
      }
      const meta = metaFor(body);
      setResult(json);
      setResultMeta(meta);
      syncUrl(body);
      // Only a *successful* impact check can start a review, so a
      // 404/not-linked diff never fires an LLM job off the back of it —
      // and `meta.autoReview` keeps history from starting one per click.
      onResult(json, reviewTargetFor(body), meta);
      if ("prNumber" in body) {
        void loadAddedComponents(body.prNumber, json.unmatchedFiles);
      } else {
        reportAddedComponents([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
      setResult(null);
      setResultMeta(NO_META);
      onResult(null, null, NO_META);
      reportAddedComponents([]);
    } finally {
      setLoading(false);
    }
  }

  // Auto-run once on mount when arriving via `?pr=<number>` or
  // `?base=<ref>&head=<ref>` (GraphView's conventions — see that file's
  // comment for how they're read from the URL).
  // A `?pr=` check waits for the PR list (or its failure): whether the review
  // starts on its own depends on the PR's state, and a reload of a merged
  // PR's URL must not start a paid review just because the list was slower.
  const [pendingInitialPr, setPendingInitialPr] = useState(initialPrNumber);
  useEffect(() => {
    if (!initialPrNumber && initialBaseRef && initialHeadRef) {
      void runCheck({ baseRef: initialBaseRef, headRef: initialHeadRef });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!pendingInitialPr) return;
    if (prListState.status !== "loaded" && prListState.status !== "fallback") return;
    setPendingInitialPr(undefined);
    void runCheck({ prNumber: pendingInitialPr });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInitialPr, prListState.status]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "pr") {
      const n = Number(prNumber);
      if (!Number.isFinite(n) || n <= 0) {
        setError("Enter a valid PR number.");
        return;
      }
      void runCheck({ prNumber: n });
    } else if (mode === "refs") {
      if (!baseRef.trim() || !headRef.trim()) {
        setError("Enter both a base and head ref.");
        return;
      }
      void runCheck({ baseRef: baseRef.trim(), headRef: headRef.trim() });
    } else if (mode === "commits") {
      const pair = orderedPick();
      if (!pair) {
        setError("Pick two commits to compare.");
        return;
      }
      void runCheck({ baseRef: pair[0], headRef: pair[1] });
    } else {
      const paths = pathsText
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean);
      if (paths.length === 0) {
        setError("Paste at least one file path.");
        return;
      }
      void runCheck({ filePaths: paths });
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Target className="size-4 text-brand" aria-hidden />
          Diff selection
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Pick a pull request (open or old), or compare two branches or two
          commits, to see which components are touched.
        </p>
      </div>

      <div
        className="flex items-center gap-0.5 rounded-lg bg-muted p-[3px] ring-1 ring-border/60"
        role="group"
        aria-label="Diff source"
      >
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = mode === m.value;
          return (
            <button
              key={m.value}
              type="button"
              onClick={() => {
                setMode(m.value);
                setError(null);
              }}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "bg-elevated text-foreground shadow-sm ring-1 ring-border/60"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-pressed={active}
            >
              <Icon
                className={cn("size-3.5", active ? "text-brand" : "opacity-70")}
              />
              {m.label}
            </button>
          );
        })}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {mode === "pr" &&
          (prListState.status === "loaded" ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="pr-number">Pull request</FieldLabel>
                <div className="flex items-center gap-0.5" role="group" aria-label="Pull request state">
                  {PR_FILTERS.map((f) => (
                    <button
                      key={f.value}
                      type="button"
                      onClick={() => setPrFilter(f.value)}
                      aria-pressed={prFilter === f.value}
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                        prFilter === f.value
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-1.5">
                <div className="min-w-0 flex-1">
                  <SelectShell>
                    <select
                      id="pr-number"
                      value={visiblePrs.some((pr) => String(pr.number) === prNumber) ? prNumber : ""}
                      onChange={(e) => setPrNumber(e.target.value)}
                      className={SELECT_CLASSNAME}
                    >
                      <option value="" disabled>
                        {visiblePrs.length > 0
                          ? "Select a pull request…"
                          : `No ${prFilter === "all" ? "" : `${prFilter} `}pull requests`}
                      </option>
                      {visiblePrs.map((pr) => (
                        <option key={pr.number} value={String(pr.number)}>
                          #{pr.number}
                          {pr.state !== "open" ? ` · ${pr.state}` : ""} — {pr.title}
                        </option>
                      ))}
                    </select>
                  </SelectShell>
                </div>
                <Input
                  aria-label="Pull request number"
                  inputMode="numeric"
                  placeholder="#"
                  title={`Any PR number — the list shows the ${PR_LIST_LIMIT} most recently updated`}
                  value={prNumber}
                  onChange={(e) => setPrNumber(e.target.value.replace(/^#/, ""))}
                  className="w-16 shrink-0 font-mono"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <FieldLabel htmlFor="pr-number">PR number</FieldLabel>
              <Input
                id="pr-number"
                inputMode="numeric"
                placeholder="e.g. 128"
                value={prNumber}
                onChange={(e) => setPrNumber(e.target.value)}
              />
            </div>
          ))}

        {mode === "refs" && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="base-ref">Base ref</FieldLabel>
              {branchesState.status === "loaded" ? (
                <SelectShell>
                  <select
                    id="base-ref"
                    value={baseRef}
                    onChange={(e) => setBaseRef(e.target.value)}
                    className={SELECT_CLASSNAME}
                  >
                    {baseRef &&
                      !branchesState.items.some((b) => b.name === baseRef) && (
                        <option value={baseRef}>{baseRef}</option>
                      )}
                    {!baseRef && (
                      <option value="" disabled>
                        Select a branch…
                      </option>
                    )}
                    {branchesState.items.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                        {b.name === defaultBranch ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </SelectShell>
              ) : (
                <Input
                  id="base-ref"
                  placeholder={defaultBranch ?? "main"}
                  value={baseRef}
                  onChange={(e) => setBaseRef(e.target.value)}
                />
              )}
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="head-ref">Head ref</FieldLabel>
              {branchesState.status === "loaded" ? (
                <SelectShell>
                  <select
                    id="head-ref"
                    value={headRef}
                    onChange={(e) => setHeadRef(e.target.value)}
                    className={SELECT_CLASSNAME}
                  >
                    <option value="" disabled>
                      Select a branch…
                    </option>
                    {headRef &&
                      !branchesState.items.some((b) => b.name === headRef) && (
                        <option value={headRef}>{headRef}</option>
                      )}
                    {branchesState.items.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </SelectShell>
              ) : (
                <Input
                  id="head-ref"
                  placeholder="feature/my-branch"
                  value={headRef}
                  onChange={(e) => setHeadRef(e.target.value)}
                />
              )}
            </div>
          </div>
        )}

        {mode === "commits" && (
          <CommitPicker
            state={commitsState}
            picked={pickedCommits}
            lastAnalyzedSha={lastAnalyzedSha}
            onToggle={togglePick}
            onClear={() => setPickedCommits([])}
            ordered={orderedPick()}
            commitIndex={commitIndex}
            onCompare={(base, head) => {
              setPickedCommits([base, head]);
              void runCheck({ baseRef: base, headRef: head });
            }}
          />
        )}

        {mode === "paths" && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor="paths">Changed file paths</FieldLabel>
            <textarea
              id="paths"
              rows={6}
              placeholder={"src/auth/login.ts\nsrc/db/client.ts"}
              value={pathsText}
              onChange={(e) => setPathsText(e.target.value)}
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            />
            <p className="text-[11px] text-muted-foreground">One per line.</p>
          </div>
        )}

        <Button type="submit" size="sm" className="w-full" disabled={loading}>
          {loading ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden />
              Checking…
            </>
          ) : (
            <>
              <Target aria-hidden />
              Check impact
            </>
          )}
        </Button>
      </form>

      {error && (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}

      {result && (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
          {resultMeta.historical && (
            <p className="flex items-start gap-1.5 border-b border-border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              <Info className="mt-px size-3 shrink-0" aria-hidden />
              <span>
                Mapped onto the graph analyzed at{" "}
                <span className="font-mono">{lastAnalyzedSha ? shortRef(lastAnalyzedSha) : "the latest analysis"}</span>
                {" "}— files moved or deleted since then show as unmatched.
              </span>
            </p>
          )}
          <div className="grid grid-cols-2 divide-x divide-border">
            <div className="px-3 py-2.5">
              <p className="font-mono text-lg leading-none font-semibold tracking-tight">
                {result.touchedFiles.length}
              </p>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                touched file{result.touchedFiles.length === 1 ? "" : "s"}
              </p>
            </div>
            <div className="px-3 py-2.5">
              <p className="font-mono text-lg leading-none font-semibold tracking-tight text-warning">
                {result.touchedComponentIds.length}
              </p>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                touched component
                {result.touchedComponentIds.length === 1 ? "" : "s"}
              </p>
            </div>
          </div>
          {result.unmatchedFiles.length > 0 && (
            <div className="border-t border-border px-3 py-2.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                Unmatched ({result.unmatchedFiles.length})
                {addedComponents.length > 0 && " — shown in green on the graph"}
              </p>
              <ul className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto font-mono text-[11px] text-muted-foreground/80">
                {result.unmatchedFiles.map((f) => (
                  <li key={f} className="truncate" title={f}>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {addedComponents.length > 0 && (
            <div className="border-t border-border px-3 py-2.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                Added ({addedComponents.length})
              </p>
              <ul className="mt-1.5 max-h-40 space-y-1.5 overflow-y-auto">
                {addedComponents.map((c) => (
                  <li key={c.id} className="text-[11px]">
                    <p className="flex items-center gap-1.5">
                      <span className="size-1.5 shrink-0 rounded-full bg-[#22c55e]" aria-hidden />
                      <span className="truncate font-medium" title={c.name}>
                        {c.name}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {c.fileCount} file{c.fileCount === 1 ? "" : "s"}
                      </span>
                    </p>
                    {c.description && (
                      <p className="mt-0.5 pl-3 leading-relaxed text-muted-foreground/80">
                        {c.description}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface CommitPickerProps {
  state: ListFetchState<CommitOption>;
  picked: string[];
  lastAnalyzedSha?: string;
  onToggle: (sha: string) => void;
  onClear: () => void;
  /** `[base, head]` for the current pick, or `null` until two are picked. */
  ordered: [string, string] | null;
  commitIndex: (sha: string) => number;
  /** Compare immediately (the per-row and "since last analysis" shortcuts). */
  onCompare: (base: string, head: string) => void;
}

/**
 * The default branch's newest commits; pick two to compare. Whichever is
 * older becomes the base (the diff is `base...head`), so the order they're
 * clicked in never matters.
 */
function CommitPicker({
  state,
  picked,
  lastAnalyzedSha,
  onToggle,
  onClear,
  ordered,
  commitIndex,
  onCompare,
}: CommitPickerProps) {
  if (state.status === "idle" || state.status === "loading") {
    return (
      <p className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        Loading commits…
      </p>
    );
  }
  if (state.status === "fallback") {
    return (
      <p className="rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
        Couldn&apos;t list this repo&apos;s commits (not linked, or the request failed). Use{" "}
        <span className="font-medium text-foreground">Branches</span> with commit shas instead.
      </p>
    );
  }

  const commits = state.items;
  const isPicked = (sha: string) => picked.some((p) => sameCommit(sha, p));
  const analyzedIndex = lastAnalyzedSha ? commits.findIndex((c) => sameCommit(c.sha, lastAnalyzedSha)) : -1;
  const span =
    ordered && commitIndex(ordered[0]) !== -1 && commitIndex(ordered[1]) !== -1
      ? commitIndex(ordered[0]) - commitIndex(ordered[1])
      : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Commits on the default branch
        </span>
        {analyzedIndex > 0 && (
          <button
            type="button"
            onClick={() => onCompare(commits[analyzedIndex].sha, commits[0].sha)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            title="Compare the analyzed commit with the newest one"
          >
            <History className="size-3" aria-hidden />
            Since last analysis
          </button>
        )}
      </div>

      <p className="min-h-4 text-[11px] text-muted-foreground">
        {ordered ? (
          <>
            <span className="font-mono text-foreground">{shortRef(ordered[0])}</span> →{" "}
            <span className="font-mono text-foreground">{shortRef(ordered[1])}</span>
            {span !== null && ` · ${span} commit${span === 1 ? "" : "s"}`}
            <button type="button" onClick={onClear} className="ml-2 underline-offset-2 hover:text-foreground hover:underline">
              clear
            </button>
          </>
        ) : picked.length === 1 ? (
          "Pick one more commit."
        ) : (
          "Pick two commits — the older one is the base."
        )}
      </p>

      <ul className="max-h-72 divide-y divide-border/60 overflow-y-auto rounded-lg ring-1 ring-border">
        {commits.map((commit, index) => {
          const selected = isPicked(commit.sha);
          const parent = commit.parents[0];
          return (
            <li key={commit.sha} className={cn("group flex items-stretch", selected && "bg-brand-muted")}>
              <button
                type="button"
                onClick={() => onToggle(commit.sha)}
                aria-pressed={selected}
                className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-1.5 text-left"
                title={commit.subject}
              >
                <span
                  className={cn(
                    "mt-1 size-2.5 shrink-0 rounded-full ring-1",
                    selected ? "bg-brand ring-brand" : "ring-border"
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">{commit.subject || "(no message)"}</span>
                  <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span className="font-mono">{commit.sha.slice(0, 7)}</span>
                    <span>{relativeDate(commit.date)}</span>
                    {commit.author && <span className="truncate">{commit.author}</span>}
                    {index === analyzedIndex && (
                      <span className="rounded bg-secondary px-1 text-[9px] font-medium text-foreground uppercase">
                        analyzed
                      </span>
                    )}
                  </span>
                </span>
              </button>
              {parent && (
                <button
                  type="button"
                  onClick={() => onCompare(parent, commit.sha)}
                  className="shrink-0 px-2 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                  title="What this commit changed (compare with its parent)"
                >
                  Only this
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
