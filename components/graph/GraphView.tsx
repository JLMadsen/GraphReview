"use client";

// Client-side orchestrator for the Graph tab. Everything fetches
// client-side (rather than the server page doing it) so a missing endpoint or
// an unreadable database degrades gracefully in the browser instead of
// failing the page render.
//
// Three views share the canvas slot (DESIGN.md §6.4, §6.5, §6.11):
//   - **App map** (`AppMapView`) — the whole codebase as cards, at an
//     architecture, feature or module level of detail, carrying the diff's
//     changes and the review's verdicts. The default with no diff selected.
//   - **API** (`ApiView`) — every endpoint the app exposes, like an OpenAPI
//     page, each opening in place; with a diff selected, its API changes
//     with before / after payloads. It takes the whole column (the review
//     dock stays with the PR view).
//   - **PR** (`PrMapCanvas`) — only what the diff touches, as area cards.
// Both stay mounted once opened, stacked in one grid cell with the inactive
// one transparent and `inert`, so each keeps its layout and zoom. (Not
// `visibility: hidden`: React Flow sets `visibility: visible` inline on its
// nodes, which pokes straight through it.) Every module link — the
// explainer's modules, chat chips, a finding's component, an area's "App
// map" button — opens that module's card on the App map (`showInAppMap`).
// The old Repo view (the Cytoscape component graph) was removed on
// 2026-10-06; see docs/ideas.md for what went with it.
//
// The v2 AI review hangs off the diff flow: `DiffPanel` reports *what* was
// checked alongside the impact result, that target drives `useReview`
// (auto-run + polling), and the findings fan out to the cards, the dock
// under the map and the area inspector.
//
// Columns, left to right, edge to edge (DESIGN.md §6.6, §6.7): the diff
// (a picker, then a summary with the checklist folded into it) · the map
// with the AI review under it · the right column, flush against the right
// edge: the inspector for whatever is selected on top, the chat below —
// about the diff when one is selected, about the repo otherwise.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "cn";
import { FileDiffModal } from "./FileDiffModal";
import { PrMapCanvas, type PrMapMode } from "./PrMapCanvas";
import { FunctionPanel } from "./FunctionPanel";
import { buildFunctionView, NOTHING_HIDDEN, type HiddenFunctions } from "./call-graph-view";
import { useTargetGraph } from "./useTargetGraph";
import { PrAreaList, PrAreaPanel } from "./PrAreaPanel";
import { buildPrAreas } from "./pr-areas";
import { usePrMap } from "./usePrMap";
import type { PrMapRequestDTO } from "./pr-map-types";
import { AppMapView } from "./AppMapView";
import { AppMapPanel, type AppMapSelection } from "./AppMapPanel";
import { useAppMap, useAppMapJob } from "./useAppMap";
import { isAppMapLevel, type AppMapLevel } from "./app-map-types";
import { PanelResizeHandle, usePanelWidth } from "./PanelResizeHandle";
import { ChatPanel } from "./ChatPanel";
import { ChecklistPanel } from "./ChecklistPanel";
import { LooksDifferentPanel } from "./LooksDifferentPanel";
import { usePreviewScan } from "./usePreviewScan";
import { useChecklist } from "./useChecklist";
import { usePrChat } from "./usePrChat";
import { DiffPanel, type DiffTargetMeta } from "./DiffPanel";
import { ReviewPanel } from "./ReviewPanel";
import { Segmented } from "./Segmented";
import { effectiveAssessment, worstAssessment } from "./review-visuals";
import { useReview } from "./useReview";
import { ApiView } from "./ApiView";
import { ApiChangesSection } from "./ApiChangesSection";
import { useApiCatalog } from "./useApiCatalog";
import { buildApiRows } from "./api-view-model";
import {
  DEFAULT_REVIEW_EFFORT,
  reviewTargetLabel,
  type ReviewEffort,
} from "./types";
import type {
  DiffImpactResponseDTO,
  GraphResponseDTO,
  Assessment,
  ReviewTargetDTO,
} from "./types";

type GraphViewMode = "app" | "api" | "pr";

/** The views share one grid cell; the inactive one stays laid out but can't be seen, clicked or focused. */
function viewLayerClass(active: boolean): string {
  return cn("col-start-1 row-start-1 min-w-0", active ? "relative z-10" : "pointer-events-none opacity-0");
}
const VIEW_STORAGE_KEY = "graphreview.graph.view";
const APP_LEVEL_STORAGE_KEY = "graphreview.appmap.level";
const REVIEW_EXPANDED_STORAGE_KEY = "graphreview.review.expanded";
const PR_MODE_STORAGE_KEY = "graphreview.prmap.mode";
/** Functions and cards hidden on the Functions view, per repo and target. */
const hiddenFunctionsKey = (repoId: string, target: ReviewTargetDTO) => `graphreview.prmap.hidden.${repoId}.${reviewTargetLabel(target)}`;

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
  /** The component graph — only its node names are used now (the dock and inspector label components with them). */
  const [graph, setGraph] = useState<GraphResponseDTO | null>(null);
  const [diffResult, setDiffResult] = useState<DiffImpactResponseDTO | null>(null);
  /** What the current impact result was a check *of* — `null` for "paste paths" (no diff to review) and before any check. Drives the whole review flow below. */
  const [reviewTarget, setReviewTarget] = useState<ReviewTargetDTO | null>(null);
  /**
   * Bumped to re-fetch the component graph and the App map without
   * remounting anything — when an analysis finishes. Never read by the
   * effects it retriggers.
   */
  const [graphNonce, setGraphNonce] = useState(0);

  const [reviewEffort, setReviewEffort] = useState<ReviewEffort>(DEFAULT_REVIEW_EFFORT);
  /** Whether the selected target reviews itself — open PRs and branch comparisons only (see DiffPanel's `DiffTargetMeta`). */
  const [autoReview, setAutoReview] = useState(true);
  const review = useReview(repoId, reviewTarget, reviewEffort, autoReview);
  // A cancelled review doesn't hand over to the checklist's automatic AI items.
  const checklist = useChecklist(repoId, reviewTarget, review.state, autoReview && !review.cancelled);
  const chat = usePrChat(repoId, reviewTarget);
  const previewScan = usePreviewScan(repoId, reviewTarget);
  /** The target's base vs head: structure change and call graph (static analysis, no model). */
  const targetGraph = useTargetGraph(repoId, reviewTarget);
  /** The PR map shows areas (files) or opens them into functions — remembered per browser. */
  const [prMode, setPrModeState] = useState<PrMapMode>("files");
  const [selectedFunction, setSelectedFunction] = useState<string | null>(null);
  const setPrMode = useCallback((mode: PrMapMode) => {
    setPrModeState(mode);
    setSelectedFunction(null);
    try {
      window.localStorage.setItem(PR_MODE_STORAGE_KEY, mode);
    } catch {
      /* ignored */
    }
  }, []);
  /** The view last chosen — remembered per browser, `pr` by default. With no diff selected, `pr` falls back to the App map. */
  const [preferredView, setPreferredViewState] = useState<GraphViewMode>("pr");
  const [appLevel, setAppLevelState] = useState<AppMapLevel>("architecture");
  /** The review dock took the whole column (map folded away) — remembered per browser. */
  const [reviewExpanded, setReviewExpandedState] = useState(false);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
      // A stored "repo" (the removed Repo view) falls back to the default.
      if (stored === "pr" || stored === "app" || stored === "api") setPreferredViewState(stored);
      const level = window.localStorage.getItem(APP_LEVEL_STORAGE_KEY);
      if (isAppMapLevel(level)) setAppLevelState(level);
      if (window.localStorage.getItem(REVIEW_EXPANDED_STORAGE_KEY) === "1") setReviewExpandedState(true);
      const storedMode = window.localStorage.getItem(PR_MODE_STORAGE_KEY);
      if (storedMode === "functions") setPrModeState(storedMode);
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
  /** The map is folded away only while there is a review to give the room to. */
  const mapFolded = reviewExpanded && reviewTarget !== null;
  const toggleReviewExpanded = useCallback(() => {
    setReviewExpandedState((expanded) => {
      try {
        window.localStorage.setItem(REVIEW_EXPANDED_STORAGE_KEY, expanded ? "0" : "1");
      } catch {
        /* ignored */
      }
      return !expanded;
    });
  }, []);
  // Every file in every list opens the one file viewer (FileDiffModal) —
  // with a diff selected, a changed file shows its diff and the rest show
  // whole; with none, every file shows as analyzed. Lists about the change
  // (the dock's Files tab, an area's most-changed files) open on the diff;
  // the rest (the explainer's files, chat) on the
  // whole file, its changed lines marked.
  const [openFile, setOpenFile] = useState<{ path: string; component?: string; tab?: "diff" | "file"; line?: number } | null>(null);
  const openFilePath = useCallback((path: string) => setOpenFile({ path }), []);
  const openFileAtLine = useCallback((path: string, line?: number) => setOpenFile({ path, line }), []);
  const openFileView = useCallback((path: string) => setOpenFile({ path, tab: "file" }), []);
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

  // Repo context: the header/defaults, and the analysis status. While an
  // analysis is running (`analyzing`, or `stale` = refreshing an existing
  // graph) the status is re-read every few seconds — a cheap read of the job
  // queue, no git call — and the moment it finishes (or the analyzed commit
  // changes) the graph and the App map are fetched again and the server-
  // rendered header is refreshed. Without this the tab kept showing the old
  // map until a manual reload. Fails silently: the
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

  // The component graph, for component names. An unanalyzed repo or an
  // unreadable database just leaves names unresolved (ids show instead) —
  // the App map has its own "not analyzed yet" state.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/repos/${repoId}/graph`)
      .then(async (res) => (res.ok ? ((await res.json()) as GraphResponseDTO) : null))
      .then((data) => {
        if (!cancelled) setGraph(data);
      })
      .catch(() => {
        if (!cancelled) setGraph(null);
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


  // The PR map follows the diff selection: the review target when there is
  // one, the pasted paths otherwise. Keyed on the review's state so the
  // cards pick up the AI grouping the moment the review job stores it.
  const prRequest = useMemo<PrMapRequestDTO | null>(() => {
    if (!diffResult) return null;
    if (reviewTarget) return reviewTarget;
    return { filePaths: [...diffResult.touchedFiles, ...diffResult.unmatchedFiles] };
  }, [diffResult, reviewTarget]);
  const prMap = usePrMap(repoId, prRequest, review.state);
  /** The PR map's cards as areas, with their findings — one object for the canvas, the dock and the inspector. */
  const prAreas = useMemo(() => buildPrAreas(prMap.map, review.findings), [prMap.map, review.findings]);
  /** What the reviewer took off the Functions view (the eyes on rows and cards) — remembered per target in this browser. */
  const [hiddenFunctions, setHiddenFunctions] = useState<HiddenFunctions>(NOTHING_HIDDEN);
  useEffect(() => {
    setSelectedFunction(null);
    let restored = NOTHING_HIDDEN;
    if (reviewTarget) {
      try {
        const raw = window.localStorage.getItem(hiddenFunctionsKey(repoId, reviewTarget));
        const parsed = raw ? (JSON.parse(raw) as { functions?: string[]; cards?: string[] }) : null;
        if (parsed) restored = { functions: new Set(parsed.functions ?? []), cards: new Set(parsed.cards ?? []) };
      } catch {
        /* storage unavailable or unreadable — start with nothing hidden */
      }
    }
    setHiddenFunctions(restored);
  }, [repoId, reviewTarget]);
  const updateHidden = useCallback(
    (next: HiddenFunctions) => {
      setHiddenFunctions(next);
      if (!reviewTarget) return;
      try {
        const key = hiddenFunctionsKey(repoId, reviewTarget);
        if (next.functions.size === 0 && next.cards.size === 0) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, JSON.stringify({ functions: [...next.functions], cards: [...next.cards] }));
      } catch {
        /* ignored */
      }
    },
    [repoId, reviewTarget]
  );
  const hideFunction = useCallback(
    (id: string) => {
      updateHidden({ functions: new Set([...hiddenFunctions.functions, id]), cards: hiddenFunctions.cards });
      setSelectedFunction((current) => (current === id ? null : current));
    },
    [hiddenFunctions, updateHidden]
  );
  const hideFunctionCard = useCallback(
    (cardId: string) => updateHidden({ functions: hiddenFunctions.functions, cards: new Set([...hiddenFunctions.cards, cardId]) }),
    [hiddenFunctions, updateHidden]
  );
  const showHiddenFunctions = useCallback(() => updateHidden(NOTHING_HIDDEN), [updateHidden]);
  const functionView = useMemo(
    () => buildFunctionView(prMap.map, targetGraph.graph?.data, hiddenFunctions),
    [prMap.map, targetGraph.graph, hiddenFunctions]
  );
  // A selected function the reviewer just hid (or that a hidden card took with it) is deselected.
  useEffect(() => {
    if (selectedFunction && functionView && !functionView.cardOf.has(selectedFunction)) setSelectedFunction(null);
  }, [selectedFunction, functionView]);
  /** The area (PR map card) the PR view is focused on, and optionally one of its components — they scope the dock. */
  const [prArea, setPrArea] = useState<string | null>(null);
  const [prAreaComponent, setPrAreaComponent] = useState<string | null>(null);
  const selectPrArea = useCallback((cardId: string | null) => {
    setPrArea(cardId);
    setPrAreaComponent(null);
  }, []);
  useEffect(() => selectPrArea(null), [prRequest, selectPrArea]);
  // A refreshed map (the review's grouping arriving) has new card ids.
  useEffect(() => {
    if (prArea && prMap.map && !prMap.map.nodes.some((n) => n.id === prArea)) selectPrArea(null);
  }, [prArea, prMap.map, selectPrArea]);
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
  /** `pr` with no diff selected falls back to the App map. */
  const view: GraphViewMode = preferredView === "pr" && !prRequest ? "app" : preferredView;

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
  // A connection row hovered in the app-map panel; its line is lit on the map.
  const [appHoveredLink, setAppHoveredLink] = useState<string | null>(null);
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
   * Where every module link goes (a module in the explainer, a chat chip, a
   * finding's component, an area's "App map" button): the App map at module
   * level with that module's card selected, so its explainer opens. The card
   * is the one place a module is explained.
   */
  const showInAppMap = useCallback(
    (componentId: string) => {
      setAppLevel("modules");
      setAppSelection({ kind: "card", id: `mod:${componentId}` });
      setPreferredView("app");
    },
    [setAppLevel, setPreferredView]
  );
  const selectComponentLink = useCallback(
    (componentId: string | null) => {
      if (componentId) showInAppMap(componentId);
    },
    [showInAppMap]
  );
  const showAppPanel = view === "app" && appSelection !== null && appMap.map !== null;

  // --- API (DESIGN.md §6.11) ------------------------------------------------
  /** Mounted (and fetching) from the first time the view is opened, or an endpoint is. */
  const [apiMounted, setApiMounted] = useState(false);
  useEffect(() => {
    if (view === "api") setApiMounted(true);
  }, [view]);
  const apiCatalog = useApiCatalog(repoId, apiMounted, graphNonce);
  const apiChange = reviewTarget ? targetGraph.graph?.data?.api : undefined;
  const apiRows = useMemo(() => buildApiRows(apiCatalog.catalog, apiChange), [apiCatalog.catalog, apiChange]);
  /** An endpoint asked for from the left column — the API view opens it and scrolls to it. */
  const [apiFocus, setApiFocus] = useState<{ id: string } | null>(null);
  /** With a diff selected the API view lists only its API changes; "All endpoints" shows the whole catalog with them marked. */
  const [apiChangedOnly, setApiChangedOnly] = useState(true);
  useEffect(() => setApiFocus(null), [repoId]);
  useEffect(() => setApiChangedOnly(true), [reviewTarget]);
  /** Every endpoint link (the left column's API section) opens the API view at it. */
  const openEndpoint = useCallback(
    (endpointId: string) => {
      setApiMounted(true);
      setApiFocus({ id: endpointId });
      setPreferredView("api");
    },
    [setPreferredView]
  );
  /** The API view takes the whole column: no review dock under it, nothing folded. */
  const apiFull = view === "api";

  useEffect(() => {
    setOpenFile(null);
  }, [prRequest]);


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

  /** On the PR view the inspector explains the selected area, or lists them all. */
  const showPrPanel = view === "pr" && prMap.map !== null;
  const selectedPrArea = prArea ? prAreas.areas.get(prArea) : undefined;
  const selectedFn =
    view === "pr" && prMode === "functions" && selectedFunction ? functionView?.functionById.get(selectedFunction) : undefined;
  const hasInspector = showAppPanel || showPrPanel;
  const chatFocus =
    showPrPanel && prAreaComponent
      ? { id: prAreaComponent, name: componentNameById(prAreaComponent) ?? prAreaComponent }
      : null;

  // The view switch leads each view's own toolbar (see view-chrome.ts), so
  // the switch and the view's controls are one bar rather than two rows.
  // PR is only there while a diff is selected.
  const viewSwitch = (
    <>
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
        { value: "api" as const, label: "API", title: "Every endpoint the app exposes — with a diff selected, its changes to the API" },
        ...(prRequest ? [{ value: "pr" as const, label: "PR", title: "Only what this diff touches" }] : []),
      ]}
    />
    {/* Sets the view switch apart from the view's own controls after it. */}
    <span className="h-5 w-px shrink-0 bg-border" aria-hidden />
    </>
  );

  return (
    // `data-wide-shell` opts this tab out of the repo shell's `max-w-6xl`
    // cap — see app/repo/[repoId]/layout.tsx for the mechanism and why.
    <div ref={rootRef} data-wide-shell className="flex flex-col lg:h-(--tab-h) lg:flex-row lg:overflow-hidden">
      <aside
        className="relative w-full shrink-0 border-border bg-card lg:h-full lg:w-(--panel-w) lg:border-r"
        style={{ "--panel-w": `${leftWidth}px` } as React.CSSProperties}
      >
        <PanelResizeHandle edge="right" width={leftWidth} onResize={setLeftWidth} label="Resize diff panel" />
        <div className="px-4 pt-3 pb-4 lg:h-full lg:overflow-y-auto lg:pb-6">
          <DiffPanel
            repoId={repoId}
            defaultBranch={repo?.defaultBranch}
            lastAnalyzedSha={repo?.lastAnalyzedSha}
            initialPrNumber={initialPrNumber}
            initialBaseRef={initialBaseRef}
            initialHeadRef={initialHeadRef}
            onResult={handleDiffResult}
            lineStats={lineStats}
          >
            {reviewTarget && <ChecklistPanel repoId={repoId} checklist={checklist} />}
            {reviewTarget && <ApiChangesSection change={apiChange} pending={targetGraph.pending} onOpen={openEndpoint} />}
            {reviewTarget && (
              <LooksDifferentPanel
                scan={previewScan}
                onOpen={(path, component) => setOpenFile({ path, component })}
              />
            )}
          </DiffPanel>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:h-full lg:overflow-hidden">
        {/* The two views share this one fixed-height cell; each is a flex
            column whose canvas takes whatever its own toolbar leaves. With a
            review under it the map section gets half the tab (the dock has a
            tab bar and column headers to fit), without one all of it. The
            view switch sits in each view's toolbar. The review's Expand
            folds it to nothing (the canvases skip a zero size and refit when
            it comes back), so the findings get the whole column. */}
        <div
          className={cn("grid shrink-0 grid-rows-[minmax(0,1fr)] transition-[height] duration-200", mapFolded && !apiFull && "overflow-hidden")}
          style={{
            height: apiFull
              ? "var(--tab-h, 100vh)"
              : mapFolded
              ? 0
              : reviewTarget
                ? "calc(var(--tab-h, 100vh) * 0.5)"
                : "var(--tab-h, 100vh)",
          }}
          inert={mapFolded && !apiFull}
        >
        {appMounted && (
          <div className={viewLayerClass(view === "app")} inert={view !== "app"}>
            <AppMapView
              className="flex h-full flex-col"
              leading={viewSwitch}
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
              focusModuleId={prAreaComponent}
              hoveredLink={appHoveredLink}
            />
          </div>
        )}
        {apiMounted && (
          <div className={viewLayerClass(view === "api")} inert={view !== "api"}>
            <ApiView
              className="flex h-full flex-col"
              leading={viewSwitch}
              catalog={apiCatalog.catalog}
              rows={apiRows}
              loading={apiCatalog.loading}
              error={apiCatalog.error}
              change={apiChange}
              changePending={Boolean(reviewTarget) && targetGraph.pending}
              changedOnly={apiChangedOnly}
              onChangedOnlyChange={setApiChangedOnly}
              focus={apiFocus}
              infer={apiCatalog}
              onOpenFile={openFileAtLine}
            />
          </div>
        )}
        {prRequest && (
          <div className={viewLayerClass(view === "pr")} inert={view !== "pr"}>
          <PrMapCanvas
            className="flex h-full flex-col"
            leading={viewSwitch}
            map={prMap.map}
            loading={prMap.loading}
            error={prMap.error}
            areas={prAreas}
            selectedCardId={prArea}
            onSelectCard={selectPrArea}
            selectedComponentId={prAreaComponent}
            reviewPending={review.state === "queued" || review.state === "running"}
            mode={reviewTarget ? prMode : "files"}
            onModeChange={reviewTarget ? setPrMode : undefined}
            targetGraph={reviewTarget ? targetGraph : undefined}
            functionView={functionView}
            selectedFunctionId={selectedFunction}
            onSelectFunction={setSelectedFunction}
            onHideFunction={hideFunction}
            onHideCard={hideFunctionCard}
            onShowHidden={showHiddenFunctions}
          />
          </div>
        )}
        </div>

        <FileDiffModal
          repoId={repoId}
          target={reviewTarget}
          finding={openFile ? { filePath: openFile.path, ...(openFile.line ? { lineRange: String(openFile.line) } : {}) } : null}
          initialComponent={openFile?.component}
          initialTab={openFile?.tab}
          onClose={() => setOpenFile(null)}
        />

        {/* Under the graph, full width: the AI review, exceptions first —
            see ReviewPanel's header for why it lives here rather than in a
            sidebar. The checklist sits in the diff summary on the left. */}
        {reviewTarget && !apiFull && (
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
            onRetryFailed={review.retryFailed}
            cancelled={review.cancelled}
            cancelling={review.cancelling}
            canCancel={review.canCancel}
            onCancel={review.cancel}
            onSelectComponent={selectComponentLink}
            onSetResolved={review.setResolved}
            effort={reviewEffort}
            onEffortChange={setReviewEffort}
            expanded={reviewExpanded}
            onToggleExpanded={toggleReviewExpanded}
            map={prMap.map}
            areas={prAreas}
            scopeAreaId={prArea}
            scopeComponentId={prAreaComponent}
            onClearScope={() => selectPrArea(null)}
            componentName={componentNameById}
            onOpenFile={openFilePath}
          />
        )}
      </div>

      {/* The right column, flush against the right edge, full height: the
          inspector (whatever is selected) on top, the chat under it. It is
          always there — with no diff selected the chat answers questions
          about the repo itself. */}
      <aside
          className="relative flex w-full shrink-0 flex-col border-t border-border bg-card lg:h-full lg:w-(--panel-w) lg:border-t-0 lg:border-l"
          style={{ "--panel-w": `${chatWidth}px` } as React.CSSProperties}
        >
          <PanelResizeHandle edge="left" width={chatWidth} onResize={setChatWidth} label="Resize right column" />
          {hasInspector && (
            <div className="max-h-[58%] min-h-0 shrink-0 space-y-3 overflow-y-auto border-b border-border">
              {showAppPanel && (
                <div className="px-3 py-3">
                  <AppMapPanel
                    map={appMap.map!}
                    selection={appSelection!}
                    changedFiles={changedFiles}
                    fileMarkers={fileMarkers}
                    onSelect={setAppSelection}
                    onSelectModule={showInAppMap}
                    onSelectFile={openFileView}
                    onHoverEdge={setAppHoveredLink}
                  />
                </div>
              )}
              {showPrPanel && selectedFn && functionView ? (
                <FunctionPanel
                  key={selectedFn.id}
                  fn={selectedFn}
                  view={functionView}
                  onSelectFunction={setSelectedFunction}
                  onHide={hideFunction}
                  onOpenFile={openFileAtLine}
                  onClose={() => setSelectedFunction(null)}
                />
              ) : (
              showPrPanel &&
                (selectedPrArea ? (
                  <PrAreaPanel
                    key={selectedPrArea.node.id}
                    area={selectedPrArea}
                    componentName={componentNameById}
                    selectedComponentId={prAreaComponent}
                    onSelectComponent={setPrAreaComponent}
                    onOpenFile={openFilePath}
                    onShowInAppMap={showInAppMap}
                    onClose={() => selectPrArea(null)}
                  />
                ) : (
                  <PrAreaList areas={prAreas} onSelect={selectPrArea} />
                ))
              )}
            </div>
          )}
          <div className="min-h-0 flex-1">
              <ChatPanel
                chat={chat}
                targetLabel={reviewTarget ? reviewTargetLabel(reviewTarget) : null}
                repoName={repo?.name}
                focus={chatFocus}
                componentName={componentNameById}
                changedFiles={chatChangedFiles}
                onSelectComponent={showInAppMap}
                onOpenFile={openFileView}
              />
          </div>
      </aside>
    </div>
  );
}
