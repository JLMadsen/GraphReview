"use client";

// The Graph tab's diff-selection panel: "pick a PR, or two
// refs" — plus the prototype's "paste changed file paths" textarea. Lives
// as a sidebar inside the Graph tab, not a separate screen. Calls
// `POST /api/repos/[repoId]/diff-impact` and reports the result up to
// GraphView, which feeds it to GraphCanvas for touched-node highlighting.

import { useEffect, useState } from "react";
import {
  ChevronDown,
  GitCompare,
  GitPullRequest,
  LoaderCircle,
  Target,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "cn";
import { evictClosedAddedCache, readAddedCache, writeAddedCache } from "./added-cache";
import type {
  AddedComponentDTO,
  AddedComponentsResponseDTO,
  DiffImpactRequestDTO,
  DiffImpactResponseDTO,
  ReviewTargetDTO,
} from "./types";

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

type Mode = "pr" | "refs" | "paths";

// "Paths" (paste changed file paths) is hidden from the mode switcher for
// now — the handling code below still supports it, it's just not reachable
// from the UI.
const MODES: Array<{
  value: Mode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: "pr", label: "PR", icon: GitPullRequest },
  { value: "refs", label: "Refs", icon: GitCompare },
];

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
  /** Versions the added-components cache — see added-cache.ts. */
  updatedAt: string;
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
    target: ReviewTargetDTO | null
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

export function DiffPanel({
  repoId,
  defaultBranch,
  initialPrNumber,
  initialBaseRef,
  initialHeadRef,
  onResult,
  onAddedComponents,
}: DiffPanelProps) {
  const initialRefsMode = !initialPrNumber && Boolean(initialBaseRef && initialHeadRef);
  const [mode, setMode] = useState<Mode>(initialRefsMode ? "refs" : "pr");
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

  // Same lazy-fetch-once-then-fallback pattern for the PR dropdown, sourced
  // from open PRs.
  useEffect(() => {
    if (mode !== "pr" || prListState.status !== "idle") return;
    let cancelled = false;
    setPrListState({ status: "loading" });
    fetch(`/api/repos/${repoId}/pull-requests?state=open`)
      .then((res) => res.json())
      .then((json: PullRequestsApiResponse) => {
        if (cancelled) return;
        const loaded = json?.linked && !json.error && Array.isArray(json.pullRequests);
        if (loaded) {
          // A genuine, successful load of the open-PR list — including a
          // truly empty one — is exactly when a stale added-components
          // cache entry (for a PR that's since merged/closed) is safe to
          // drop. A failed/not-linked fetch never reaches here, so a
          // network hiccup can't wipe a still-valid cache.
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
        onResult(null, null);
        reportAddedComponents([]);
        return;
      }
      setResult(json);
      // Only a *successful* impact check starts a review (once a PR or
      // ref comparison is selected), so a 404/not-linked diff never fires an
      // LLM job off the back of it.
      onResult(json, reviewTargetFor(body));
      if ("prNumber" in body) {
        void loadAddedComponents(body.prNumber, json.unmatchedFiles);
      } else {
        reportAddedComponents([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
      setResult(null);
      onResult(null, null);
      reportAddedComponents([]);
    } finally {
      setLoading(false);
    }
  }

  // Auto-run once on mount when arriving via `?pr=<number>` or
  // `?base=<ref>&head=<ref>` (GraphView's conventions — see that file's
  // comment for how they're read from the URL).
  useEffect(() => {
    if (initialPrNumber) {
      void runCheck({ prNumber: initialPrNumber });
    } else if (initialBaseRef && initialHeadRef) {
      void runCheck({ baseRef: initialBaseRef, headRef: initialHeadRef });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          Pick a PR, compare two refs, or paste changed file paths to see
          which components are touched.
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
              <FieldLabel htmlFor="pr-number">Pull request</FieldLabel>
              <SelectShell>
                <select
                  id="pr-number"
                  value={prNumber}
                  onChange={(e) => setPrNumber(e.target.value)}
                  className={SELECT_CLASSNAME}
                >
                  <option value="" disabled>
                    Select a pull request…
                  </option>
                  {prNumber &&
                    !prListState.items.some((pr) => String(pr.number) === prNumber) && (
                      <option value={prNumber}>#{prNumber}</option>
                    )}
                  {prListState.items.map((pr) => (
                    <option key={pr.number} value={String(pr.number)}>
                      #{pr.number} — {pr.title}
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
