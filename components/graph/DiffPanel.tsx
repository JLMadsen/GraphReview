"use client";

// The Graph tab's diff-selection panel: "pick a PR, two branches, or two
// commits" — plus the prototype's "paste changed file paths" textarea. Lives
// as a sidebar inside the Graph tab, not a separate screen. Calls
// `POST /api/repos/[repoId]/diff-impact` and reports the result up to
// GraphView, which builds the PR map and starts the review from it.
//
// Once a check succeeds the picker folds away into a summary — what was
// picked, its size, and whatever GraphView slots in under it (the
// checklist). "Change" drops the diff altogether and brings back the plain
// picker: a picker is used once, a summary is read the whole time.
//
// History (merged/closed PRs, commit comparisons) is browsable without cost:
// every result carries a `DiffTargetMeta` saying whether the AI review should
// start on its own — only for open PRs and branch comparisons — and whether
// the diff is older than the analyzed graph it is mapped onto.

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, LoaderCircle, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Segmented } from "./Segmented";
import { isShaLike } from "./types";
import type {
  DiffImpactRequestDTO,
  DiffImpactResponseDTO,
  ReviewTargetDTO,
} from "./types";
import { CommitPicker } from "./diff/CommitPicker";
import { DiffSummary } from "./diff/DiffSummary";
import { GlyphField } from "./diff/GlyphField";
import { useLazyList, type BranchesApiResponse, type PullRequestsApiResponse, type CommitsApiResponse, sameCommit } from "./diff/options";

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
const MODES: Array<{ value: Mode; label: string }> = [
  { value: "pr", label: "PR" },
  { value: "refs", label: "Branches" },
  { value: "commits", label: "Commits" },
];

type PrFilter = "open" | "merged" | "closed" | "all";
const PR_FILTERS: Array<{ value: PrFilter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
const PR_FILTER_STORAGE_KEY = "graphreview.diff.prFilter";
/** The PR picker lists this many most-recently-updated PRs (an older one can still be opened by its `?pr=` URL). */
const PR_LIST_LIMIT = 100;
const COMMIT_LIST_LIMIT = 100;

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
      className="text-[11px] font-medium text-muted-foreground"
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
  /** Line totals of the checked diff, once known (from the PR map) — shown in the summary. */
  lineStats?: { additions: number; deletions: number } | null;
  /** The review's verdict, shown large under the diff's own lines once a check succeeds. */
  headline?: React.ReactNode;
  /** Rendered inside the summary, right under the verdict (the checklist). */
  children?: React.ReactNode;
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
  lineStats,
  headline,
  children,
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
  /** What the current result is a check of, for the summary's title. */
  const [checked, setChecked] = useState<DiffImpactRequestDTO | null>(null);
  /** The picker is open — always before the first result, and after "Change". */
  const [picking, setPicking] = useState(true);

  // The pickers' lists, each fetched the first time its mode is open. The PR
  // list is the most recently updated PRs of every state in one request,
  // filtered client-side by the Open/Merged/Closed/All chips; the commit
  // picker's is the default branch's newest commits.
  const branchesState = useLazyList(mode === "refs", `/api/repos/${repoId}/branches`, (json: BranchesApiResponse) => json.branches);
  const prListState = useLazyList(
    mode === "pr",
    `/api/repos/${repoId}/pull-requests?state=all&limit=${PR_LIST_LIMIT}`,
    (json: PullRequestsApiResponse) => json.pullRequests
  );
  const commitsState = useLazyList(mode === "commits", `/api/repos/${repoId}/commits?limit=${COMMIT_LIST_LIMIT}`, (json: CommitsApiResponse) => json.commits);

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
    return orderPair(pickedCommits);
  }

  function orderPair(picked: string[]): [string, string] | null {
    if (picked.length !== 2) return null;
    const [a, b] = picked;
    const ia = commitIndex(a);
    const ib = commitIndex(b);
    if (ia === -1 || ib === -1) return [a, b];
    return ia > ib ? [a, b] : [b, a];
  }

  function togglePick(sha: string) {
    setError(null);
    const prev = pickedCommits;
    const next = prev.some((p) => sameCommit(sha, p))
      ? prev.filter((p) => !sameCommit(sha, p))
      : prev.length < 2
        ? [...prev, sha]
        : [prev[1], sha];
    setPickedCommits(next);
    // The second pick loads the comparison — no button to press.
    const pair = orderPair(next);
    if (pair) void runCheck({ baseRef: pair[0], headRef: pair[1] });
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
        return;
      }
      const meta = metaFor(body);
      setResult(json);
      setChecked(body);
      setPicking(false);
      setResultMeta(meta);
      syncUrl(body);
      // Only a *successful* impact check can start a review, so a
      // 404/not-linked diff never fires an LLM job off the back of it —
      // and `meta.autoReview` keeps history from starting one per click.
      onResult(json, reviewTargetFor(body), meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
      setResult(null);
      setResultMeta(NO_META);
      onResult(null, null, NO_META);
    } finally {
      setLoading(false);
    }
  }

  /** Drops the current diff entirely — the page goes back to its no-diff state, and the URL loses its `?pr=` / `?base=&head=`. */
  function clearDiff() {
    setResult(null);
    setChecked(null);
    setResultMeta(NO_META);
    setError(null);
    setPrNumber("");
    setPickedCommits([]);
    setPicking(true);
    onResult(null, null, NO_META);
    try {
      const url = new URL(window.location.href);
      for (const key of ["pr", "base", "head"]) url.searchParams.delete(key);
      window.history.replaceState(window.history.state, "", url);
    } catch {
      /* URL sync is a convenience */
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

  if (result && checked && !picking) {
    return (
      <DiffSummary
        result={result}
        checked={checked}
        meta={resultMeta}
        lastAnalyzedSha={lastAnalyzedSha}
        pr={
          "prNumber" in checked && prListState.status === "loaded"
            ? prListState.items.find((pr) => pr.number === checked.prNumber)
            : undefined
        }
        lineStats={lineStats}
        loading={loading}
        onChange={clearDiff}
        headline={headline}
      >
        {children}
      </DiffSummary>
    );
  }

  return (
    <div className="relative isolate min-h-72 space-y-3 lg:min-h-full">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Pick a diff</h2>
        {result && checked && (
          <button
            type="button"
            onClick={() => setPicking(false)}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Cancel
          </button>
        )}
      </div>

      <Segmented
        label="Diff source"
        className="w-full"
        value={mode}
        onChange={(value) => {
          setMode(value);
          setError(null);
        }}
        options={MODES}
      />

      <form onSubmit={handleSubmit} className="space-y-3">
        {mode === "pr" &&
          (prListState.status === "loaded" ? (
            <div className="space-y-1.5">
              <label htmlFor="pr-number" className="sr-only">
                Pull request
              </label>
              <Segmented
                label="Pull request state"
                size="xs"
                className="w-full"
                value={prFilter}
                onChange={setPrFilter}
                options={PR_FILTERS}
              />
              <SelectShell>
                <select
                  id="pr-number"
                  value={visiblePrs.some((pr) => String(pr.number) === prNumber) ? prNumber : ""}
                  onChange={(e) => {
                    // Picking is loading: no separate button to press.
                    setPrNumber(e.target.value);
                    if (e.target.value) void runCheck({ prNumber: Number(e.target.value) });
                  }}
                  disabled={visiblePrs.length === 0}
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
          ) : (
            <div className="space-y-1.5">
              <FieldLabel htmlFor="pr-number">PR number</FieldLabel>
              <Input
                id="pr-number"
                inputMode="numeric"
                placeholder="128, then Enter"
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
                    onChange={(e) => {
                      setBaseRef(e.target.value);
                      if (e.target.value && headRef && e.target.value !== headRef) {
                        void runCheck({ baseRef: e.target.value, headRef });
                      }
                    }}
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
                    onChange={(e) => {
                      setHeadRef(e.target.value);
                      if (e.target.value && baseRef && e.target.value !== baseRef) {
                        void runCheck({ baseRef, headRef: e.target.value });
                      }
                    }}
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

        {/* No visible button: picking from a list loads it, and Enter in a
            typed field submits through this one. */}
        <button type="submit" className="sr-only" tabIndex={-1}>
          Load
        </button>
        {loading && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" aria-hidden />
            Loading…
          </p>
        )}
      </form>

      {error && (
        <p className="flex items-start gap-2 text-xs text-destructive">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}
      {/* Last child, so `space-y-3` doesn't count it. */}
      <GlyphField />
    </div>
  );
}

