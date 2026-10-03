"use client";

// Client-side orchestrator for the Graph tab: fetches the
// component graph and optional repo context, hosts the diff-selection
// sidebar, and feeds diff-impact results into GraphCanvas for touched-node
// highlighting. Everything fetches client-side (rather than the server
// page doing it) so a missing/not-yet-built `/api/repos/[repoId]` repo
// endpoint or an unreadable database degrades gracefully in the browser
// instead of failing the page render.
//
// It is also where the v2 AI review is hung off the diff flow:
// `DiffPanel` reports *what* was checked alongside the impact result, that
// target drives `useReview` (auto-run + polling), and the resulting findings
// fan out to three places — marker halos on the canvas, the full dock below
// it, and the selected component's own panel in the sidebar.
//
// Once a diff is selected the canvas slot has two views (DESIGN.md §6.4):
// **Repo** (the whole component graph, `GraphCanvas`) and **PR** (the PR
// map, `PrMapCanvas` — only what the diff touches, as cards). Both stay
// mounted, stacked in one grid cell with the inactive one transparent and
// `inert`, so Cytoscape keeps its real size, layout and zoom while the PR
// view is up. (Not `visibility: hidden`: React Flow sets `visibility:
// visible` inline on its nodes, which pokes straight through it.)
// Selection is shared: a card selects its component. Every module link —
// the explainer's modules and files, chat chips, a finding's component, the
// component panel, a PR map card's button — opens that module's card on the
// App map (`showInAppMap`).
//
// A third view, **App map** (DESIGN.md §6.5, `AppMapView`), is always
// available and is the default with no diff selected: the whole codebase
// drawn like the PR map, at an architecture, feature or module level of
// detail, carrying the diff's changes and the review's verdicts on its cards.
// It is mounted the first time it is opened and stays mounted after, like the
// other two. Its explainer (`AppMapPanel`) sits in the right column above the
// component panel, so a module picked from it opens right underneath; a
// component selected anywhere else rings the cards that hold it.
//
// Columns, left to right, edge to edge (DESIGN.md §6.6, §6.7): the diff
// (a picker, then a summary with the checklist folded into it) · the graph
// with the AI review under it · the right column, flush against the right
// edge and sticky: the inspector for whatever is selected on top, the chat
// below — about the diff when one is selected, about the repo otherwise.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical, LayoutGrid, LoaderCircle } from "lucide-react";
import { cn } from "cn";
import { GraphCanvas, type GraphCanvasHandle } from "./GraphCanvas";
import { FileDiffModal } from "./FileDiffModal";
import { PrMapCanvas } from "./PrMapCanvas";
import { usePrMap } from "./usePrMap";
import type { PrMapRequestDTO } from "./pr-map-types";
import { AppMapView } from "./AppMapView";
import { AppMapPanel, type AppMapSelection } from "./AppMapPanel";
import { useAppMap, useAppMapJob } from "./useAppMap";
import { isAppMapLevel, type AppMapLevel } from "./app-map-types";
import { PanelResizeHandle, usePanelWidth } from "./PanelResizeHandle";
import { ComponentFilesPanel } from "./ComponentFilesPanel";
import { ChatPanel } from "./ChatPanel";
import { ChecklistPanel } from "./ChecklistPanel";
import { LooksDifferentPanel } from "./LooksDifferentPanel";
import { usePreviewScan } from "./usePreviewScan";
import { useChecklist } from "./useChecklist";
import { usePrChat } from "./usePrChat";
import { MergesControl, MergeSuggestionsPanel } from "./MergeSuggestions";
import { DiffPanel, type DiffTargetMeta } from "./DiffPanel";
import { ReviewPanel } from "./ReviewPanel";
import { Segmented } from "./Segmented";
import { buildReviewMarkers, effectiveAssessment, worstAssessment } from "./review-visuals";
import { SAMPLE_EDGES, SAMPLE_NODES } from "./sample-data";
import { useLabels } from "./useLabels";
import { useMerges } from "./useMerges";
import { useReview } from "./useReview";
import {
  DEFAULT_REVIEW_EFFORT,
  reviewTargetLabel,
  type ReviewEffort,
} from "./types";
import type {
  AddedComponentDTO,
  DiffImpactResponseDTO,
  GraphNodeDTO,
  GraphResponseDTO,
  Assessment,
  ReviewTargetDTO,
} from "./types";

type GraphViewMode = "repo" | "app" | "pr";

/** The two views share one grid cell; the inactive one stays laid out but can't be seen, clicked or focused. */
function viewLayerClass(active: boolean): string {
  return cn("col-start-1 row-start-1 min-w-0", active ? "relative z-10" : "pointer-events-none opacity-0");
}
const VIEW_STORAGE_KEY = "graphreview.graph.view";
const APP_LEVEL_STORAGE_KEY = "graphreview.appmap.level";

/** Trimmed shape of `GET /api/repos/[repoId]` — see this repo's task brief. Only the fields this view needs. */
interface RepoContext {
  name: string;
  defaultBranch?: string;
  lastAnalyzedSha?: string;
  status?: "analyzing" | "up_to_date" | "stale" | "error";
}

/** How often the repo's status is re-read while an analysis runs. */
const ANALYSIS_POLL_MS = 3000;

export interface GraphViewProps {
  repoId: string;
  /** From the page's `?pr=<number>` query param. */
  initialPrNumber?: number;
  /** From the page's `?base=<ref>&head=<ref>` query params (Branches tab's "Compare in graph" link). */
  initialBaseRef?: string;
  initialHeadRef?: string;
}

export function GraphView({
  repoId,
  initialPrNumber,
  initialBaseRef,
  initialHeadRef,
}: GraphViewProps) {
  const [repo, setRepo] = useState<RepoContext | null>(null);
  const [graph, setGraph] = useState<GraphResponseDTO | null>(null);
  const [usingSample, setUsingSample] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<DiffImpactResponseDTO | null>(null);
  /** AI-labeled components for the current PR's `unmatchedFiles` — see DiffPanel's `onAddedComponents`. Ephemeral: never part of `graph`, cleared the moment the check changes. */
  const [addedComponents, setAddedComponents] = useState<AddedComponentDTO[]>([]);
  /** What the current impact result was a check *of* — `null` for "paste paths" (no diff to review) and before any check. Drives the whole review flow below. */
  const [reviewTarget, setReviewTarget] = useState<ReviewTargetDTO | null>(null);
  /** The component whose node was clicked in the canvas — drives both the canvas's neighbourhood highlight and the file panel below. */
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  /**
   * Bumped to re-fetch the component graph without remounting anything —
   * currently by the AI labeling run finishing, which adds the domain-tier
   * nodes and the `parentId`s that turn them into compound boxes.
   * Never read by the effect that sets it — it only exists to retrigger the fetch.
   */
  const [graphNonce, setGraphNonce] = useState(0);

  const [reviewEffort, setReviewEffort] = useState<ReviewEffort>(DEFAULT_REVIEW_EFFORT);
  /** Whether the selected target reviews itself — open PRs and branch comparisons only (see DiffPanel's `DiffTargetMeta`). */
  const [autoReview, setAutoReview] = useState(true);
  const review = useReview(repoId, reviewTarget, reviewEffort, autoReview);
  const checklist = useChecklist(repoId, reviewTarget, review.state, autoReview);
  const chat = usePrChat(repoId, reviewTarget);
  const previewScan = usePreviewScan(repoId, reviewTarget);
  const handleLabelsCompleted = useCallback(() => setGraphNonce((n) => n + 1), []);
  const labels = useLabels(repoId, handleLabelsCompleted);
  // Feature merges (DESIGN.md §6.3). Every accept/unmerge/rename changes the
  // module tier server-side, so it refetches the graph the same way a
  // finished labeling run does; the suggestions list follows `graphNonce`.
  const merges = useMerges(repoId, graphNonce, handleLabelsCompleted);
  const [mergesOpen, setMergesOpen] = useState(false);
  const [previewIds, setPreviewIds] = useState<string[] | null>(null);
  /** The view last chosen — remembered per browser, `pr` by default. With no diff selected, `pr` falls back to the App map. */
  const [preferredView, setPreferredViewState] = useState<GraphViewMode>("pr");
  const [appLevel, setAppLevelState] = useState<AppMapLevel>("architecture");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (stored === "repo" || stored === "pr" || stored === "app") setPreferredViewState(stored);
      const level = window.localStorage.getItem(APP_LEVEL_STORAGE_KEY);
      if (isAppMapLevel(level)) setAppLevelState(level);
    } catch {
      /* storage unavailable — keep the defaults */
    }
  }, []);
  const setPreferredView = useCallback((view: GraphViewMode) => {
    setPreferredViewState(view);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
      /* ignored */
    }
  }, []);
  const canvasRef = useRef<GraphCanvasHandle>(null);
  /** The file open in the diff modal, and optionally the before/after component to start on. */
  const [openFile, setOpenFile] = useState<{ path: string; component?: string } | null>(null);
  const openFilePath = useCallback((path: string) => setOpenFile({ path }), []);
  const [leftWidth, setLeftWidth] = usePanelWidth("graphreview.panel.diff", 236, 200, 480);
  const [chatWidth, setChatWidth] = usePanelWidth("graphreview.panel.chat", 380, 300, 720);
  const rootRef = useRef<HTMLDivElement>(null);

  // On a desktop-sized window the tab exactly fills the viewport under the
  // app's nav and the repo header, and each column scrolls on its own — the
  // page itself never does. `--tab-h` is that height; the map takes a fixed
  // share of it and the review scrolls in the rest (see `--map-h` below).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = el.getBoundingClientRect().top + window.scrollY;
        el.style.setProperty("--tab-h", `${Math.max(480, window.innerHeight - top)}px`);
      });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
    };
  }, []);

  // A selection is only meaningful against the graph it was made in — but a
  // *re-fetch* of the same repo's graph (a finished labeling run) keeps the
  // same module ids, so it deliberately doesn't clear the selection.
  useEffect(() => {
    setSelectedNodeId(null);
  }, [repoId]);

  // Repo context: the header/defaults, and the analysis status. While an
  // analysis is running (`analyzing`, or `stale` = refreshing an existing
  // graph) the status is re-read every few seconds — a cheap read of the job
  // queue, no git call — and the moment it finishes (or the analyzed commit
  // changes) the graph and the App map are fetched again and the server-
  // rendered header is refreshed. Without this the tab kept showing the old
  // graph — or the sample one — until a manual reload. Fails silently: the
  // endpoint 404s for an unknown repo and errors without a readable database.
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasWorking = false;
    let lastSha: string | undefined;
    let first = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/repos/${repoId}`);
        const data = res.ok ? ((await res.json()) as RepoContext) : null;
        if (cancelled || !data) return;
        setRepo(data);
        const working = data.status === "analyzing" || data.status === "stale";
        const finished = (wasWorking && !working) || (!first && data.lastAnalyzedSha !== lastSha);
        if (finished) {
          setGraphNonce((n) => n + 1);
          router.refresh();
        }
        wasWorking = working;
        lastSha = data.lastAnalyzedSha;
        first = false;
        if (working) timer = setTimeout(() => void load(), ANALYSIS_POLL_MS);
      } catch {
        /* nice-to-have — keep what's on screen */
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [repoId, router]);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/repos/${repoId}/graph`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Graph request failed (${res.status}).`);
        return (await res.json()) as GraphResponseDTO;
      })
      .then((data) => {
        if (cancelled) return;
        if (data.nodes.length === 0) {
          // Genuinely empty (not-yet-analyzed repo) — fall back to a
          // sample graph so the Graph tab is never a dead end.
          setGraph({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES });
          setUsingSample(true);
        } else {
          setGraph(data);
          setUsingSample(false);
          setLoadError(null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // Database unreadable / repo not analyzed yet — show sample data rather
        // than a dead page, but surface the real error too.
        setGraph({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES });
        setUsingSample(true);
        setLoadError(err instanceof Error ? err.message : "Failed to load graph.");
      });

    return () => {
      cancelled = true;
    };
  }, [repoId, graphNonce]);

  const handleDiffResult = useCallback(
    (result: DiffImpactResponseDTO | null, target: ReviewTargetDTO | null, meta: DiffTargetMeta) => {
      setDiffResult(result);
      setReviewTarget(target);
      setAutoReview(meta.autoReview);
      // Opening a PR or a comparison is about that change: show its map.
      if (result) setPreferredView("pr");
    },
    [setPreferredView]
  );

  const handleAddedComponents = useCallback((components: AddedComponentDTO[]) => {
    setAddedComponents(components);
  }, []);

  // Synthetic, unpersisted nodes for the current PR's added files (green on
  // the canvas) — merged into the payload passed to GraphCanvas rather than
  // into `graph` itself, so a graph re-fetch (e.g. after labeling finishes)
  // can never accidentally drop or duplicate them.
  const addedNodes = useMemo<GraphNodeDTO[]>(
    () =>
      addedComponents.map((c) => ({
        id: c.id,
        name: c.name,
        tier: "module",
        fileCount: c.fileCount,
        description: c.description,
      })),
    [addedComponents]
  );
  const addedComponentIds = useMemo(
    () => addedComponents.map((c) => c.id),
    [addedComponents]
  );
  const addedFilesById = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of addedComponents) map.set(c.id, c.filePaths);
    return map;
  }, [addedComponents]);
  const canvasNodes = useMemo(
    () => (graph ? [...graph.nodes, ...addedNodes] : []),
    [graph, addedNodes]
  );

  const handleSelectNode = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
  }, []);

  const clearSelection = useCallback(() => setSelectedNodeId(null), []);

  // The graph payload already carries the selected component's name/tier/
  // count, so the panel's header renders instantly and only the file list
  // waits on the network.
  const selectedNode = useMemo(
    () =>
      selectedNodeId
        ? (graph?.nodes.find((n) => n.id === selectedNodeId) ??
          addedNodes.find((n) => n.id === selectedNodeId) ??
          null)
        : null,
    [graph, addedNodes, selectedNodeId]
  );

  // One marker per component (worst finding wins) for the canvas's third
  // highlight layer. Memoized because `GraphCanvas` uses it as an effect
  // dependency and this component re-renders on every poll tick.
  const reviewMarkers = useMemo(
    () => buildReviewMarkers(review.findings),
    [review.findings]
  );

  const selectedMerged = useMemo(
    () => (selectedNodeId ? merges.data?.merged.find((m) => m.id === selectedNodeId) : undefined),
    [merges.data, selectedNodeId]
  );
  const mergedBusy =
    merges.busy && selectedNodeId && merges.busy.id === selectedNodeId
      ? merges.busy.action === "unmerge" || merges.busy.action === "rename" || merges.busy.action === "naming"
        ? merges.busy.action
        : null
      : null;

  // The PR map follows the diff selection: the review target when there is
  // one, the pasted paths otherwise. Keyed on the review's state so the
  // cards pick up the AI grouping the moment the review job stores it.
  const prRequest = useMemo<PrMapRequestDTO | null>(() => {
    if (!diffResult) return null;
    if (reviewTarget) return reviewTarget;
    return { filePaths: [...diffResult.touchedFiles, ...diffResult.unmatchedFiles] };
  }, [diffResult, reviewTarget]);
  const prMap = usePrMap(repoId, prRequest, review.state);
  /** The diff's line totals for the summary — the PR map carries per-file +/-. */
  const lineStats = useMemo(() => {
    if (!prMap.map) return null;
    let additions = 0;
    let deletions = 0;
    for (const node of prMap.map.nodes) {
      for (const f of node.files) {
        additions += f.additions;
        deletions += f.deletions;
      }
    }
    return { additions, deletions };
  }, [prMap.map]);
  // Sample data has no app map (nothing is analyzed), so it always shows Repo.
  const view: GraphViewMode = usingSample
    ? "repo"
    : preferredView === "pr" && !prRequest
      ? "app"
      : preferredView;

  // --- App map (DESIGN.md §6.5) ---------------------------------------------
  /** Mounted (and fetching) from the first time the view is opened. */
  const [appMounted, setAppMounted] = useState(false);
  useEffect(() => {
    if (view === "app") setAppMounted(true);
  }, [view]);
  const [appRunNonce, setAppRunNonce] = useState(0);
  const appMap = useAppMap(repoId, appLevel, appMounted, `${graphNonce}:${appRunNonce}`);
  const handleAppRunCompleted = useCallback(() => setAppRunNonce((n) => n + 1), []);
  const appJob = useAppMapJob(repoId, appMounted, handleAppRunCompleted);
  const [appSelection, setAppSelection] = useState<AppMapSelection | null>(null);
  const setAppLevel = useCallback((level: AppMapLevel) => {
    setAppLevelState(level);
    setAppSelection(null);
    try {
      window.localStorage.setItem(APP_LEVEL_STORAGE_KEY, level);
    } catch {
      /* ignored */
    }
  }, []);
  useEffect(() => setAppSelection(null), [repoId]);
  /** The selected diff's files — the app map marks the cards they land on. */
  const changedFiles = useMemo(
    () => (diffResult ? new Set([...diffResult.touchedFiles, ...diffResult.unmatchedFiles]) : undefined),
    [diffResult]
  );
  /**
   * Where every module link goes (a module or file in the explainer, a chat
   * chip, a finding's component, the component panel, a PR map card): the
   * App map at module level with that module's card selected, so its
   * explainer opens. The card, not the old component panel, is the one place
   * a module is explained.
   */
  const showInAppMap = useCallback(
    (componentId: string) => {
      setAppLevel("modules");
      setAppSelection({ kind: "card", id: `mod:${componentId}` });
      setSelectedNodeId(null);
      setPreferredView("app");
    },
    [setAppLevel, setPreferredView]
  );
  const selectFileModule = useCallback(
    (path: string) => {
      const owner = appMap.map?.fileOwners[path];
      if (owner) showInAppMap(owner);
    },
    [appMap.map, showInAppMap]
  );
  const selectComponentLink = useCallback(
    (componentId: string | null) => {
      if (componentId) showInAppMap(componentId);
      else setSelectedNodeId(null);
    },
    [showInAppMap]
  );
  const showAppPanel = view === "app" && appSelection !== null && appMap.map !== null;

  useEffect(() => {
    setOpenFile(null);
  }, [prRequest]);

  const handleSelectCards = useCallback((componentIds: string[]) => {
    setSelectedNodeId(componentIds[0] ?? null);
  }, []);


  const componentNameById = useCallback(
    (id: string) => graph?.nodes.find((n) => n.id === id)?.name,
    [graph]
  );
  const chatChangedFiles = useMemo(() => changedFiles ?? new Set<string>(), [changedFiles]);

  /** Worst verdict per file, for the explainer's file list. */
  const fileMarkers = useMemo(() => {
    const map = new Map<string, Assessment>();
    for (const f of review.findings) {
      if (!f.filePath) continue;
      const prev = map.get(f.filePath);
      map.set(f.filePath, prev ? worstAssessment(prev, effectiveAssessment(f)) : effectiveAssessment(f));
    }
    return map;
  }, [review.findings]);

  const selectedFindings = useMemo(
    () =>
      selectedNodeId
        ? review.findings.filter((f) => f.componentId === selectedNodeId)
        : [],
    [review.findings, selectedNodeId]
  );

  const hasInspector = Boolean(selectedNode || (mergesOpen && !usingSample) || showAppPanel);

  return (
    // `data-wide-shell` opts this tab out of the repo shell's `max-w-6xl`
    // cap — see app/repo/[repoId]/layout.tsx for the mechanism and why.
    <div ref={rootRef} data-wide-shell className="flex flex-col lg:h-(--tab-h) lg:flex-row lg:overflow-hidden">
      <aside
        className="relative w-full shrink-0 border-border lg:h-full lg:w-(--panel-w) lg:border-r"
        style={{ "--panel-w": `${leftWidth}px` } as React.CSSProperties}
      >
        <PanelResizeHandle edge="right" width={leftWidth} onResize={setLeftWidth} label="Resize diff panel" />
        <div className="px-4 pb-4 lg:h-full lg:overflow-y-auto lg:pb-6">
          <DiffPanel
            repoId={repoId}
            defaultBranch={repo?.defaultBranch}
            lastAnalyzedSha={repo?.lastAnalyzedSha}
            initialPrNumber={initialPrNumber}
            initialBaseRef={initialBaseRef}
            initialHeadRef={initialHeadRef}
            onResult={handleDiffResult}
            onAddedComponents={handleAddedComponents}
            lineStats={lineStats}
          >
            {reviewTarget && <ChecklistPanel repoId={repoId} checklist={checklist} />}
            {reviewTarget && (
              <LooksDifferentPanel
                scan={previewScan}
                onOpen={(path, component) => setOpenFile({ path, component })}
              />
            )}
          </DiffPanel>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-3 px-4 pb-4 lg:h-full lg:overflow-hidden">
        {usingSample && (
          <p className="flex items-start gap-2 text-xs text-warning">
            <FlaskConical className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              <span className="font-medium">Showing sample data</span> — this repo has no analyzed component graph yet
              {loadError ? ` (${loadError})` : ""}.
            </span>
          </p>
        )}
        {!usingSample && (
          <Segmented
            label="Graph view"
            value={view}
            onChange={setPreferredView}
            options={[
              {
                value: "app" as const,
                label: "App map",
                title: "The whole app as cards — by architecture, feature or module, with explanations",
              },
              { value: "repo" as const, label: "Repo", title: "The whole component graph" },
              ...(prRequest ? [{ value: "pr" as const, label: "PR", title: "Only what this diff touches" }] : []),
            ]}
          />
        )}

        {/* The three views share this one fixed-height cell; each is a flex
            column whose canvas takes whatever its own toolbar leaves. With a
            review under it the map section gets a bit over half the tab,
            without one everything but the view switch. */}
        <div
          className="grid shrink-0"
          style={{
            height: reviewTarget ? "calc(var(--tab-h, 100vh) * 0.58)" : "calc(var(--tab-h, 100vh) - 3.75rem)",
          }}
        >
        {appMounted && !usingSample && (
          <div className={viewLayerClass(view === "app")} inert={view !== "app"}>
            <AppMapView
              className="flex h-full flex-col"
              map={appMap.map}
              loading={appMap.loading}
              error={appMap.error}
              level={appLevel}
              onLevelChange={setAppLevel}
              job={appJob}
              selection={appSelection}
              onSelect={setAppSelection}
              changedFiles={changedFiles}
              findings={review.findings}
              focusModuleId={selectedNodeId}
            />
          </div>
        )}
        {prRequest && (
          <div className={viewLayerClass(view === "pr")} inert={view !== "pr"}>
          <PrMapCanvas
            className="flex h-full flex-col"
            map={prMap.map}
            loading={prMap.loading}
            error={prMap.error}
            findings={review.findings}
            selectedComponentId={selectedNodeId}
            onSelectComponents={handleSelectCards}
            onOpenFile={reviewTarget ? openFilePath : undefined}
            onShowInRepo={(ids) => ids[0] && showInAppMap(ids[0])}
            reviewPending={review.state === "queued" || review.state === "running"}
          />
          </div>
        )}
        <div className={viewLayerClass(view === "repo")} inert={view !== "repo"}>
        {graph ? (
          <GraphCanvas
            className="flex h-full flex-col"
            ref={canvasRef}
            nodes={canvasNodes}
            edges={graph.edges}
            touchedComponentIds={diffResult?.touchedComponentIds}
            addedComponentIds={addedComponentIds}
            selectedNodeId={selectedNodeId}
            onSelectNode={handleSelectNode}
            reviewMarkers={reviewMarkers}
            // No labeling control over sample data: those component ids
            // don't exist in the database, so there is nothing to label.
            labels={usingSample ? undefined : labels}
            previewComponentIds={previewIds ?? undefined}
            toolbarExtra={
              usingSample ? undefined : (
                <MergesControl
                  merges={merges}
                  open={mergesOpen}
                  onToggle={() => setMergesOpen((v) => !v)}
                  onRegroup={
                    labels.aiConfigured && labels.domains > 0
                      ? () => labels.generate({ force: false })
                      : undefined
                  }
                />
              )
            }
          />
        ) : (
          <div className="bp-grid flex h-96 flex-col items-center justify-center gap-3 rounded-lg border border-border">
            <LoaderCircle
              className="size-5 animate-spin text-muted-foreground"
              aria-hidden
            />
            <p className="text-sm text-muted-foreground">Loading graph…</p>
          </div>
        )}
        </div>
        </div>

        {reviewTarget && (
          <FileDiffModal
            repoId={repoId}
            target={reviewTarget}
            finding={openFile ? { filePath: openFile.path } : null}
            initialComponent={openFile?.component}
            onClose={() => setOpenFile(null)}
          />
        )}

        {/* Under the graph, full width: the AI review, exceptions first —
            see ReviewPanel's header for why it lives here rather than in a
            sidebar. The checklist sits in the diff summary on the left. */}
        {reviewTarget && (
          <ReviewPanel
            repoId={repoId}
            target={reviewTarget}
            status={review.status}
            state={review.state}
            progress={review.progress}
            findings={review.findings}
            freshness={review.freshness}
            aiConfigured={review.aiConfigured}
            notice={review.notice}
            noticeCode={review.noticeCode}
            rerunning={review.rerunning}
            canRerun={review.canRerun}
            onRerun={review.rerun}
            selectedComponentId={selectedNodeId}
            onSelectComponent={selectComponentLink}
            onSetResolved={review.setResolved}
            effort={reviewEffort}
            onEffortChange={setReviewEffort}
          />
        )}
      </div>

      {/* The right column, flush against the right edge, full height: the
          inspector (whatever is selected) on top, the chat under it. It is
          always there — with no diff selected the chat answers questions
          about the repo itself. */}
      {(!usingSample || hasInspector) && (
        <aside
          className="relative flex w-full shrink-0 flex-col border-t border-border bg-card lg:h-full lg:w-(--panel-w) lg:border-t-0 lg:border-l"
          style={{ "--panel-w": `${chatWidth}px` } as React.CSSProperties}
        >
          <PanelResizeHandle edge="left" width={chatWidth} onResize={setChatWidth} label="Resize right column" />
          {hasInspector && (
            // `key` on the component panel forces a fresh fetch/state when
            // the selection moves to another node.
            <div
              className={cn(
                "min-h-0 shrink-0 space-y-3 overflow-y-auto",
                usingSample ? "flex-1" : "max-h-[58%] border-b border-border"
              )}
            >
              {showAppPanel && (
                <div className="px-3 py-3">
                  <AppMapPanel
                    map={appMap.map!}
                    selection={appSelection!}
                    changedFiles={changedFiles}
                    fileMarkers={fileMarkers}
                    onSelect={setAppSelection}
                    onSelectModule={showInAppMap}
                    onSelectFile={selectFileModule}
                  />
                </div>
              )}
              {mergesOpen && !usingSample && (
                <MergeSuggestionsPanel
                  merges={merges}
                  onPreview={setPreviewIds}
                  onAccepted={(id) => setSelectedNodeId(id)}
                  onClose={() => {
                    setMergesOpen(false);
                    setPreviewIds(null);
                  }}
                />
              )}
              {selectedNode && (
                <ComponentFilesPanel
                  key={selectedNode.id}
                  repoId={repoId}
                  componentId={selectedNode.id}
                  componentName={selectedNode.name}
                  tier={selectedNode.tier}
                  fileCount={selectedNode.fileCount}
                  description={selectedNode.description}
                  sampleData={usingSample}
                  localFiles={addedFilesById.get(selectedNode.id)}
                  findings={selectedFindings}
                  headerAction={
                    !usingSample ? (
                      <button
                        type="button"
                        onClick={() => showInAppMap(selectedNode.id)}
                        className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                        title="Show this module's card on the app map"
                      >
                        <LayoutGrid className="size-3.5" /> App map
                      </button>
                    ) : undefined
                  }
                  merged={
                    selectedMerged
                      ? {
                          pathPatterns: selectedMerged.pathPatterns,
                          aiConfigured: merges.data?.aiConfigured ?? false,
                          busy: mergedBusy,
                          onRename: (name) => merges.rename(selectedMerged.id, name),
                          onNameWithAi: () => void merges.nameWithAi(selectedMerged.id),
                          onUnmerge: async () => {
                            const ok = await merges.unmerge(selectedMerged.id);
                            if (ok) setSelectedNodeId(null);
                            return ok;
                          },
                        }
                      : undefined
                  }
                  onClear={clearSelection}
                />
              )}
            </div>
          )}
          {!usingSample && (
            <div className="min-h-0 flex-1">
              <ChatPanel
                chat={chat}
                targetLabel={reviewTarget ? reviewTargetLabel(reviewTarget) : null}
                repoName={repo?.name}
                focus={selectedNode ? { id: selectedNode.id, name: selectedNode.name } : null}
                componentName={componentNameById}
                changedFiles={chatChangedFiles}
                onSelectComponent={showInAppMap}
                onOpenFile={reviewTarget ? openFilePath : undefined}
              />
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
