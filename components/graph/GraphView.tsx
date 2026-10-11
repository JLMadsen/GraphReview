"use client";

// Client-side orchestrator for the Graph tab. Everything fetches
// client-side (rather than the server page doing it) so a missing endpoint or
// an unreadable database degrades gracefully in the browser instead of
// failing the page render.
//
// Six views share the canvas slot (DESIGN.md §6.4, §6.5, §6.11–§6.14):
//   - **App map** (`AppMapView`) — the whole codebase as cards, at an
//     architecture, feature or module level of detail, carrying the diff's
//     changes and the review's verdicts. The default with no diff selected.
//   - **API** (`ApiView`) — every endpoint the app exposes, like an OpenAPI
//     page, each opening in place; with a diff selected, its API changes
//     with before / after payloads. It takes the whole column (the review
//     dock stays with the PR view).
//   - **Infra** (`InfraView`) — the infrastructure as code (Terraform, Nomad,
//     Kubernetes, Helm, Dockerfiles), a list like the API view; with a diff
//     selected, its plan-style infra changes. Also the whole column.
//   - **Data** (`DataView`) — the database schema (§6.13): an ER canvas of
//     the tables (its explainer in the right column) or a list whose rows
//     open in place; with a diff selected, its schema change. Also the whole
//     column.
//   - **Files** (`FilesView`) — the repo as files, like a code host shows
//     it: a folder tree, folder listings with their README, files with line
//     numbers; with a diff selected, the files it touches marked. Also the
//     whole column.
//   - **PR** (`PrMapCanvas`) — only what the diff touches, as area cards.
// The full-column views (API, Infra, Data, Files) are `LIST_VIEWS`; a new
// catalog's view is one more entry there and in `VIEW_OPTIONS`.
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
import { cn } from "cn";
import { FileDiffModal } from "./FileDiffModal";
import { PrMapCanvas, type PrMapMode } from "./PrMapCanvas";
import { FunctionPanel } from "./FunctionPanel";
import { useTargetGraph } from "./useTargetGraph";
import { PrAreaList, PrAreaPanel } from "./PrAreaPanel";
import { buildPrAreas } from "./pr-areas";
import { usePrMap } from "./usePrMap";
import type { PrMapRequestDTO } from "./pr-map-types";
import { AppMapView } from "./AppMapView";
import { AppMapPanel } from "./AppMapPanel";
import { PanelResizeHandle, usePanelWidth } from "./PanelResizeHandle";
import { ChatPanel } from "./ChatPanel";
import type { ChatActionDTO } from "./chat-types";
import { ChecklistPanel } from "./ChecklistPanel";
import { LooksDifferentPanel } from "./LooksDifferentPanel";
import { usePreviewScan } from "./usePreviewScan";
import { useChecklist } from "./useChecklist";
import { usePrChat } from "./usePrChat";
import { DiffPanel, type DiffTargetMeta } from "./DiffPanel";
import { ReviewPanel } from "./ReviewPanel";
import { Segmented } from "./Segmented";
import { effectiveAssessment, worstAssessment } from "./review-visuals";
import type { FindingBucket } from "./pr-areas";
import { useReview } from "./useReview";
import { ApiView } from "./ApiView";
import { ApiChangesSection } from "./ApiChangesSection";
import { InfraView } from "./InfraView";
import { InfraChangesSection } from "./InfraChangesSection";
import { DataView } from "./DataView";
import { DbTableDetail } from "./DbTableDetail";
import { SchemaChangesSection } from "./SchemaChangesSection";
import { FilesView } from "./FilesView";
import { useRepoTree } from "./useRepoTree";
import { useRepoContext, useTabHeight } from "./graph-view/useRepoContext";
import { useLazyMount, useStoredState } from "./graph-view/view-state";
import { usePrAreaSelection, usePrFunctions } from "./graph-view/usePrMapSelection";
import { useApiViewState, useAppMapViewState, useDataViewState, useInfraViewState } from "./graph-view/useCatalogViews";
import {
  DEFAULT_REVIEW_EFFORT,
  reviewTargetLabel,
  type ReviewEffort,
} from "./types";
import type {
  DiffImpactResponseDTO,
  Assessment,
  FindingCategory,
  ReviewTargetDTO,
} from "./types";

type GraphViewMode = "app" | "api" | "infra" | "data" | "files" | "pr";
/** Views that are a list taking the whole column (no review dock under them). */
const LIST_VIEWS: ReadonlySet<GraphViewMode> = new Set(["api", "infra", "data", "files"]);
const isGraphViewMode = (v: unknown): v is GraphViewMode =>
  v === "app" || v === "api" || v === "infra" || v === "data" || v === "files" || v === "pr";
/** The view switch, in order. PR only shows with a diff selected. */
const VIEW_OPTIONS: ReadonlyArray<{ value: GraphViewMode; label: string; title: string }> = [
  { value: "app", label: "App map", title: "The whole app as cards — by architecture, feature or module, with explanations" },
  { value: "api", label: "API", title: "Every endpoint the app exposes — with a diff selected, its changes to the API" },
  { value: "infra", label: "Infra", title: "The infrastructure as code — Terraform, Nomad, Kubernetes, Helm, Dockerfiles — with a diff selected, its plan" },
  { value: "data", label: "Data", title: "The database schema — tables from the migrations, schema files and ORM models, as an ER canvas or a list — with a diff selected, its schema change" },
  { value: "files", label: "Files", title: "The repo as files — folders, READMEs and code — with a diff selected, the files it touches marked" },
  { value: "pr", label: "PR", title: "Only what this diff touches" },
];

/** The views share one grid cell; the inactive one stays laid out but can't be seen, clicked or focused. */
function viewLayerClass(active: boolean): string {
  return cn("col-start-1 row-start-1 min-w-0", active ? "relative z-10" : "pointer-events-none opacity-0");
}
const VIEW_STORAGE_KEY = "graphreview.graph.view";
const REVIEW_EXPANDED_STORAGE_KEY = "graphreview.review.expanded";
const PR_MODE_STORAGE_KEY = "graphreview.prmap.mode";

// A stored "repo" (the removed Repo view) falls back to the default.
const parseView = (raw: string | null) => (isGraphViewMode(raw) ? raw : undefined);
const parseExpanded = (raw: string | null) => (raw === "1" ? true : undefined);
const serializeExpanded = (expanded: boolean) => (expanded ? "1" : "0");
const parsePrMode = (raw: string | null): PrMapMode | undefined => (raw === "functions" ? "functions" : undefined);

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
  const { repo, graph, graphNonce } = useRepoContext(repoId);
  const [diffResult, setDiffResult] = useState<DiffImpactResponseDTO | null>(null);
  /** What the current impact result was a check *of* — `null` for "paste paths" (no diff to review) and before any check. Drives the whole review flow below. */
  const [reviewTarget, setReviewTarget] = useState<ReviewTargetDTO | null>(null);

  const [reviewEffort, setReviewEffort] = useState<ReviewEffort>(DEFAULT_REVIEW_EFFORT);
  /** Whether the selected target reviews itself — open PRs and branch comparisons only (see DiffPanel's `DiffTargetMeta`). */
  const [autoReview, setAutoReview] = useState(true);
  const review = useReview(repoId, reviewTarget, reviewEffort, autoReview);
  // A cancelled review doesn't hand over to the checklist's automatic AI items.
  const checklist = useChecklist(repoId, reviewTarget, review.state, autoReview && !review.cancelled);
  /** Applies what a chat answer did to the view — set below, once the view's own callbacks exist. */
  const chatActionsRef = useRef<(actions: ChatActionDTO[]) => void>(undefined);
  const handleChatActions = useCallback((actions: ChatActionDTO[]) => chatActionsRef.current?.(actions), []);
  const chat = usePrChat(repoId, reviewTarget, handleChatActions);
  const previewScan = usePreviewScan(repoId, reviewTarget);
  /** The target's base vs head: structure change and call graph (static analysis, no model). */
  const targetGraph = useTargetGraph(repoId, reviewTarget);
  const targetData = reviewTarget ? targetGraph.graph?.data : undefined;
  /** The view last chosen — remembered per browser, `pr` by default. With no diff selected, `pr` falls back to the App map. */
  const [preferredView, setPreferredView] = useStoredState<GraphViewMode>(VIEW_STORAGE_KEY, "pr", parseView);
  /** The review dock took the whole column (map folded away) — remembered per browser. */
  const [reviewExpanded, setReviewExpanded] = useStoredState(REVIEW_EXPANDED_STORAGE_KEY, false, parseExpanded, serializeExpanded);
  /** The map is folded away only while there is a review to give the room to. */
  const mapFolded = reviewExpanded && reviewTarget !== null;
  const toggleReviewExpanded = useCallback(() => setReviewExpanded(!reviewExpanded), [reviewExpanded, setReviewExpanded]);
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
  /** A changed file's diff, in the shared file viewer. */
  const openFileDiff = useCallback((path: string) => setOpenFile({ path, tab: "diff" }), []);
  const [leftWidth, setLeftWidth] = usePanelWidth("graphreview.panel.diff", 236, 200, 480);
  const [chatWidth, setChatWidth] = usePanelWidth("graphreview.panel.chat", 380, 300, 720);
  const rootRef = useRef<HTMLDivElement>(null);
  useTabHeight(rootRef);

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

  // --- PR map (DESIGN.md §6.4) ----------------------------------------------
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
  const { prArea, prAreaComponent, setPrAreaComponent, selectPrArea } = usePrAreaSelection(prRequest, prMap.map);
  const { functionView, selectedFunction, setSelectedFunction, hideFunction, hideFunctionCard, showHiddenFunctions } =
    usePrFunctions(repoId, reviewTarget, prMap.map, targetGraph);
  /** The PR map shows areas (files) or opens them into functions — remembered per browser. */
  const [prMode, storePrMode] = useStoredState<PrMapMode>(PR_MODE_STORAGE_KEY, "files", parsePrMode);
  const setPrMode = useCallback(
    (mode: PrMapMode) => {
      storePrMode(mode);
      setSelectedFunction(null);
    },
    [storePrMode, setSelectedFunction]
  );
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

  // --- The catalog views. Each mounts (and fetches) from the first time it,
  // or something in it, is opened; some load early because another view reads them.
  const [appMounted] = useLazyMount(view === "app");
  const [apiMounted, mountApi] = useLazyMount(view === "api");
  const [infraMounted, mountInfra] = useLazyMount(view === "infra");
  const [dataMounted, mountData] = useLazyMount(view === "data");
  const [filesMounted] = useLazyMount(view === "files");

  // App map (DESIGN.md §6.5)
  const {
    level: appLevel,
    setLevel: setAppLevel,
    map: appMap,
    job: appJob,
    cardActions: appCardActions,
    selection: appSelection,
    setSelection: setAppSelection,
    hoveredLink: appHoveredLink,
    setHoveredLink: setAppHoveredLink,
  } = useAppMapViewState(repoId, appMounted, graphNonce);
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
    [setAppLevel, setAppSelection, setPreferredView]
  );
  const selectComponentLink = useCallback(
    (componentId: string | null) => {
      if (componentId) showInAppMap(componentId);
    },
    [showInAppMap]
  );
  const showAppPanel = view === "app" && appSelection !== null && appMap.map !== null;

  // API (DESIGN.md §6.11)
  const {
    catalog: apiCatalog,
    change: apiChange,
    rows: apiRows,
    focus: apiFocus,
    setFocus: setApiFocus,
    changedOnly: apiChangedOnly,
    setChangedOnly: setApiChangedOnly,
    endpointLabel,
  } = useApiViewState(repoId, apiMounted, graphNonce, reviewTarget, targetData);
  /** Every endpoint link (the left column's API section) opens the API view at it. */
  const openEndpoint = useCallback(
    (endpointId: string) => {
      mountApi();
      setApiFocus({ id: endpointId });
      setPreferredView("api");
    },
    [mountApi, setApiFocus, setPreferredView]
  );

  // Infra (DESIGN.md §6.12) — also read for the App map's explainer and the API view's gateway auth.
  const {
    catalog: infraCatalog,
    change: infraChange,
    rows: infraRows,
    endpointGatewayAuth,
    focus: infraFocus,
    setFocus: setInfraFocus,
    changedOnly: infraChangedOnly,
    setChangedOnly: setInfraChangedOnly,
  } = useInfraViewState(repoId, infraMounted || appMounted || apiMounted, graphNonce, reviewTarget, targetData);
  /** Every resource link (the left column's Infra section) opens the Infra view at it. */
  const openInfraResource = useCallback(
    (resourceId: string) => {
      mountInfra();
      setInfraFocus({ id: resourceId });
      setPreferredView("infra");
    },
    [mountInfra, setInfraFocus, setPreferredView]
  );

  // Data (DESIGN.md §6.13) — also read for the API explainer's "touches" and the PR map's ⛁ badges.
  const {
    schema: dbSchema,
    change: dbChange,
    rows: dbRows,
    tablesById: dbTablesById,
    endpointTables,
    fileTableNames,
    focus: dataFocus,
    setFocus: setDataFocus,
    changedOnly: dataChangedOnly,
    setChangedOnly: setDataChangedOnly,
    selected: dataSelected,
    setSelected: setDataSelected,
    selectedRow: selectedDbRow,
    mode: dataMode,
    setMode: setDataMode,
  } = useDataViewState(repoId, dataMounted || apiMounted || Boolean(prRequest), graphNonce, reviewTarget, targetData);
  /** Every table link (the left column's Schema section, an endpoint's "touches") opens the Data view at it. */
  const openTable = useCallback(
    (tableId: string) => {
      mountData();
      setDataFocus({ id: tableId });
      setPreferredView("data");
    },
    [mountData, setDataFocus, setPreferredView]
  );
  const showDataPanel = view === "data" && dataMode === "canvas" && selectedDbRow !== undefined;

  // Files (DESIGN.md §6.14)
  const repoTree = useRepoTree(repoId, filesMounted, graphNonce);

  /** The list views take the whole column: no review dock under them, nothing folded. */
  const apiFull = LIST_VIEWS.has(view);

  useEffect(() => {
    setOpenFile(null);
  }, [prRequest]);

  // --- What chat answers do to the view (DESIGN.md §6.7) --------------------
  /** Components a chat answer highlighted — ringed on the App map until the next answer. */
  const [chatHighlight, setChatHighlight] = useState<string[] | null>(null);
  useEffect(() => setChatHighlight(null), [repoId, reviewTarget]);
  /** The findings filter a chat answer set; the nonce lets the same filter be applied again. */
  const [reviewFilter, setReviewFilter] = useState<{ nonce: number; buckets?: FindingBucket[]; category?: FindingCategory } | null>(null);
  const applyChatAction = useCallback(
    (action: ChatActionDTO) => {
      if (action.kind === "highlight") {
        // On the Modules level each component is one card, so the ringed set reads as the path it is.
        setAppLevel("modules");
        setChatHighlight(action.componentIds);
        setPreferredView("app");
        return;
      }
      if (action.kind === "filter") {
        if (!reviewTarget) return;
        setReviewFilter({ nonce: Date.now(), buckets: action.buckets, category: action.category as FindingCategory | undefined });
        if (action.componentId) {
          const card = prMap.map?.nodes.find((n) => n.files.length > 0 && n.componentIds.includes(action.componentId!));
          selectPrArea(card?.id ?? null);
          setPrAreaComponent(action.componentId);
        }
        // The findings list sits under the maps, not under the list views.
        if (LIST_VIEWS.has(view)) setPreferredView(prRequest ? "pr" : "app");
        return;
      }
      switch (action.target) {
        case "component":
          showInAppMap(action.id);
          break;
        case "file":
          setOpenFile({ path: action.id, tab: changedFiles?.has(action.id) && !action.line ? "diff" : "file", ...(action.line ? { line: action.line } : {}) });
          break;
        case "endpoint":
          setApiChangedOnly(false);
          openEndpoint(action.id);
          break;
        case "table":
          setDataChangedOnly(false);
          openTable(action.id);
          setDataSelected(action.id);
          break;
        case "infra":
          setInfraChangedOnly(false);
          openInfraResource(action.id);
          break;
        case "area":
          if (!prRequest) break;
          setPreferredView("pr");
          selectPrArea(action.id);
          break;
        case "function":
          if (!reviewTarget) break;
          setPreferredView("pr");
          setPrMode("functions");
          setSelectedFunction(action.id);
          break;
      }
    },
    [
      reviewTarget,
      prMap.map,
      view,
      prRequest,
      changedFiles,
      setAppLevel,
      setPreferredView,
      showInAppMap,
      openEndpoint,
      openTable,
      openInfraResource,
      selectPrArea,
      setPrAreaComponent,
      setPrMode,
      setSelectedFunction,
      setApiChangedOnly,
      setDataChangedOnly,
      setDataSelected,
      setInfraChangedOnly,
    ]
  );
  // Every live answer drops the last one's highlight, then applies its own
  // actions in order — the last view change wins.
  useEffect(() => {
    chatActionsRef.current = (actions) => {
      setChatHighlight(null);
      actions.forEach(applyChatAction);
    };
  }, [applyChatAction]);

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
  const hasInspector = showAppPanel || showPrPanel || showDataPanel;
  const chatFocus =
    showPrPanel && prAreaComponent
      ? { id: prAreaComponent, name: componentNameById(prAreaComponent) ?? prAreaComponent }
      : null;

  // The view switch leads each view's own toolbar (see view-chrome.ts), so
  // the switch and the view's controls are one bar rather than two rows.
  // PR is only there while a diff is selected.
  const viewSwitch = (
    <>
    <Segmented label="Graph view" value={view} onChange={setPreferredView} options={VIEW_OPTIONS.filter((o) => o.value !== "pr" || prRequest)} />
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
            {/* What the diff does to each catalog — each section shows only when the diff changed it. */}
            {reviewTarget && <ApiChangesSection change={apiChange} onOpen={openEndpoint} />}
            {reviewTarget && <InfraChangesSection change={infraChange} onOpen={openInfraResource} />}
            {reviewTarget && <SchemaChangesSection change={dbChange} onOpen={openTable} />}
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
              cardActions={appCardActions}
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
              highlightModuleIds={chatHighlight}
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
              gatewayAuth={endpointGatewayAuth}
              touches={endpointTables}
              onOpenTable={openTable}
              onOpenFile={openFileAtLine}
            />
          </div>
        )}
        {infraMounted && (
          <div className={viewLayerClass(view === "infra")} inert={view !== "infra"}>
            <InfraView
              className="flex h-full flex-col"
              leading={viewSwitch}
              catalog={infraCatalog.catalog}
              rows={infraRows}
              loading={infraCatalog.loading}
              error={infraCatalog.error}
              change={infraChange}
              changePending={Boolean(reviewTarget) && targetGraph.pending}
              changedOnly={infraChangedOnly}
              onChangedOnlyChange={setInfraChangedOnly}
              focus={infraFocus}
              endpointLabel={endpointLabel}
              onOpenEndpoint={openEndpoint}
              onOpenFile={openFileAtLine}
            />
          </div>
        )}
        {dataMounted && (
          <div className={viewLayerClass(view === "data")} inert={view !== "data"}>
            <DataView
              className="flex h-full flex-col"
              leading={viewSwitch}
              schema={dbSchema.schema}
              rows={dbRows}
              loading={dbSchema.loading}
              error={dbSchema.error}
              change={dbChange}
              changePending={Boolean(reviewTarget) && targetGraph.pending}
              changedOnly={dataChangedOnly}
              onChangedOnlyChange={setDataChangedOnly}
              mode={dataMode}
              onModeChange={setDataMode}
              selectedId={dataSelected}
              onSelect={setDataSelected}
              focus={dataFocus}
              onOpenFile={openFileAtLine}
              onOpenEndpoint={openEndpoint}
              repoId={repoId}
              onReload={dbSchema.reload}
            />
          </div>
        )}
        {filesMounted && (
          <div className={viewLayerClass(view === "files")} inert={view !== "files"}>
            <FilesView
              className="flex h-full flex-col"
              leading={viewSwitch}
              repoId={repoId}
              repoName={repo?.name}
              tree={repoTree.tree}
              loading={repoTree.loading}
              error={repoTree.error}
              changedFiles={changedFiles}
              onOpenDiff={openFileDiff}
              active={view === "files"}
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
            tablesByFile={fileTableNames}
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
            filterRequest={reviewFilter}
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
                    infra={infraCatalog.catalog}
                    onOpenInfra={openInfraResource}
                    cardActions={appCardActions}
                    aiConfigured={Boolean(appJob.status?.aiConfigured)}
                  />
                </div>
              )}
              {showDataPanel && selectedDbRow && (
                <div className="px-3 py-3">
                  <DbTableDetail
                    key={selectedDbRow.table.id}
                    row={selectedDbRow}
                    db={dbSchema.schema?.databases.find((d) => d.id === selectedDbRow.table.database)}
                    tablesById={dbTablesById}
                    change={dbChange}
                    onFocusTable={(id) => setDataFocus({ id })}
                    onOpenFile={openFileAtLine}
                    onOpenEndpoint={openEndpoint}
                    onClose={() => setDataSelected(null)}
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
                onApplyAction={applyChatAction}
              />
          </div>
      </aside>
    </div>
  );
}
