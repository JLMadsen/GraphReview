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
//   - **Env** (`EnvView`) — every env var name (§6.15) as a matrix of names
//     by environment, the committed value in each cell; with a diff
//     selected, its env changes. Also the whole column.
//   - **Files** (`FilesView`) — the repo as files, like a code host shows
//     it: a folder tree, folder listings with their README, files with line
//     numbers; with a diff selected, the files it touches marked. Also the
//     whole column.
//   - **PR** (`PrMapCanvas`) — only what the diff touches, as area cards.
//   - **Tests** (`TestsView`) — the test inventory, what code a test reaches
//     and committed coverage (§6.22); with a diff selected, what it does to
//     its tests and the AI test plan. Also the whole column.
//   - **Stats** (`StatsGraphView`) — numbers about the repo itself (§6.19):
//     lines per language, contributors, a timeline. Also the whole column.
// The selected view is mirrored into `?view=` (§6.25), so it can be linked
// and Back/Forward switch views; the last choice is the default without it.
// The full-column views (API, Infra, Data, Env, Files, Tests, Stats) are `LIST_VIEWS`; a new
// catalog's view is one more entry there and in `VIEW_OPTIONS`.
// Both stay mounted once opened, stacked in one grid cell with the inactive
// one transparent and `inert`, so each keeps its layout and zoom. (Not
// `visibility: hidden`: React Flow sets `visibility: visible` inline on its
// nodes, which pokes straight through it.) Every module link — the
// explainer's modules, a finding's component, an area's "App map" button —
// opens that module's card on the App map (`showInAppMap`). Chat is the
// exception (`showComponent`): a component the selected change touches opens
// its area on the PR map, any other one its card on the App map at the
// level the reviewer is on.
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

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "cn";
import { FileDiffModal } from "./FileDiffModal";
import { AllFilesReader } from "./AllFilesReader";
import { PrMapCanvas, type PrMapMode } from "./PrMapCanvas";
import { FunctionPanel } from "./FunctionPanel";
import { useTargetGraph } from "./useTargetGraph";
import { PrAreaPanel } from "./PrAreaPanel";
import { buildPrAreas } from "./pr-areas";
import { usePrMap } from "./usePrMap";
import type { PrMapRequestDTO } from "./pr-map-types";
import { AppMapView } from "./AppMapView";
import { AppMapPanel } from "./AppMapPanel";
import { PanelFoldedRail, PanelResizeHandle, usePanelCollapsed, usePanelWidth } from "./PanelResizeHandle";
import { ChatPanel } from "./ChatPanel";
import type { ChatActionDTO } from "./chat-types";
import { ChecklistPanel } from "./ChecklistPanel";
import { LooksDifferentPanel } from "./LooksDifferentPanel";
import { usePreviewScan } from "./usePreviewScan";
import { useChecklist } from "./useChecklist";
import { usePrChat } from "./usePrChat";
import { DiffPanel, type DiffTargetMeta } from "./DiffPanel";
import { ReviewPanel } from "./ReviewPanel";
import { effectiveAssessment, worstAssessment } from "./review-visuals";
import type { FindingBucket } from "./pr-areas";
import { useReview } from "./useReview";
import { ApiView } from "./ApiView";
import { ApiChangesSection } from "./ApiChangesSection";
import { InfraView, type InfraMode } from "./InfraView";

const NO_ENDPOINTS: never[] = [];
import { InfraChangesSection } from "./InfraChangesSection";
import { DataView } from "./DataView";
import { DbTableDetail } from "./DbTableDetail";
import { SchemaChangesSection } from "./SchemaChangesSection";
import { EnvView } from "./EnvView";
import { EnvChangesSection } from "./EnvChangesSection";
import { FilesView } from "./FilesView";
import { TestsView } from "./TestsView";
import { useTestsView } from "./useTestsView";
import { useRepoTree } from "./useRepoTree";
import { registerGraphHandler, setGraphContext, takePendingGraphRequest, type DiffPickMode, type GraphRequest } from "@/components/palette/bus";
import { useRepoContext, useTabHeight } from "./graph-view/useRepoContext";
import { useLazyMount, useStoredState, useUrlState } from "./graph-view/view-state";
import { StatsGraphView } from "@/components/stats/StatsGraphView";
import { usePrAreaSelection, usePrFunctions } from "./graph-view/usePrMapSelection";
import { useApiViewState, useAppMapViewState, useDataViewState, useEnvViewState, useInfraViewState } from "./graph-view/useCatalogViews";
import {
  DEFAULT_REVIEW_EFFORT,
  reviewTargetLabel,
  type ReviewEffort,
} from "./types";
import type {
  DiffImpactResponseDTO,
  Assessment,
  FindingCategory,
  FindingDTO,
  ReviewTargetDTO,
} from "./types";

type GraphViewMode = "app" | "api" | "infra" | "data" | "env" | "files" | "pr" | "tests" | "stats";
/** Views that are a list taking the whole column (no review dock under them). */
const LIST_VIEWS: ReadonlySet<GraphViewMode> = new Set(["api", "infra", "data", "env", "files", "tests", "stats"]);
const isGraphViewMode = (v: unknown): v is GraphViewMode =>
  v === "app" || v === "api" || v === "infra" || v === "data" || v === "env" || v === "files" || v === "pr" || v === "tests" || v === "stats";
/** The view switch, in order. PR only shows with a diff selected. */
const VIEW_OPTIONS: ReadonlyArray<{ value: GraphViewMode; label: string; title: string }> = [
  { value: "app", label: "App map", title: "The whole app as cards — by architecture, feature or module, with explanations" },
  { value: "api", label: "API", title: "Every endpoint the app exposes — with a diff selected, its changes to the API" },
  { value: "infra", label: "Infra", title: "The infrastructure as code — Terraform, Nomad, Kubernetes, Helm, Dockerfiles — with a diff selected, its plan" },
  { value: "data", label: "Data", title: "The database schema — tables from the migrations, schema files and ORM models, as an ER canvas or a list — with a diff selected, its schema change" },
  { value: "env", label: "Env", title: "The env vars — every name the code reads, declares or sets, and its value per environment — with a diff selected, its env changes" },
  { value: "files", label: "Files", title: "The repo as files — folders, READMEs and code — with a diff selected, the files it touches marked" },
  { value: "pr", label: "PR", title: "Only what this diff touches" },
  { value: "tests", label: "Tests", title: "The tests — files by framework and kind, what code they reach, committed coverage — with a diff selected, what it does to its tests and the AI test plan" },
  { value: "stats", label: "Stats", title: "Lines of code per language, contributors, and a timeline of commits, lines and CI runs" },
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
  /** From the page's `?base=<ref>&head=<ref>` query params. */
  initialBaseRef?: string;
  initialHeadRef?: string;
}

/** The file the shared viewer shows; `back` is the one a followed code link left. */
type OpenFileState = { path: string; component?: string; tab?: "diff" | "file" | "base" | "preview"; lines?: string; marks?: string[]; back?: OpenFileState };

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
  /** The right end of the view tabs, where the active view can put its controls (the PR map does). */
  const [tabsSlot, setTabsSlot] = useState<HTMLDivElement | null>(null);
  /** Whether the selected target reviews itself — open PRs and branch comparisons only (see DiffPanel's `DiffTargetMeta`). */
  const [autoReview, setAutoReview] = useState(true);
  const review = useReview(repoId, reviewTarget, reviewEffort, autoReview);
  /** Findings minus the suppressed ones (dismissed before as not a problem, DESIGN.md §6.21) — only the dock shows those, on request. */
  const shownFindings = useMemo(() => review.findings.filter((f) => !f.suppressed), [review.findings]);
  // A cancelled review doesn't hand over to the checklist's automatic AI items.
  const checklist = useChecklist(repoId, reviewTarget, review.state, autoReview && !review.cancelled);
  /** Applies what a chat answer did to the view — set below, once the view's own callbacks exist. */
  const chatActionsRef = useRef<(actions: ChatActionDTO[]) => void>(undefined);
  /**
   * When the reviewer last used the map, the lists or the file viewer (a
   * click, a scroll, a key). An answer to a question sent before that leaves
   * the screen alone — they have moved on — and only offers its chips.
   */
  const lastInteractionRef = useRef(0);
  const noteInteraction = useCallback(() => {
    lastInteractionRef.current = Date.now();
  }, []);
  const handleChatActions = useCallback((actions: ChatActionDTO[], sentAt: number) => {
    if (lastInteractionRef.current > sentAt) return false;
    chatActionsRef.current?.(actions);
    return true;
  }, []);
  const chat = usePrChat(repoId, reviewTarget, handleChatActions);
  const previewScan = usePreviewScan(repoId, reviewTarget);
  /** The target's base vs head: structure change and call graph (static analysis, no model). */
  const targetGraph = useTargetGraph(repoId, reviewTarget);
  const targetData = reviewTarget ? targetGraph.graph?.data : undefined;
  /** The view last chosen — remembered per browser, `pr` by default. With no diff selected, `pr` falls back to the App map. */
  // Also `?view=` in the URL (DESIGN.md §6.25), which wins over the stored choice.
  const { value: preferredView, set: setPreferredView, takeGivenAtLoad: viewGivenAtLoad } = useUrlState<GraphViewMode>(
    "view",
    VIEW_STORAGE_KEY,
    "pr",
    parseView
  );
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
  // A followed code link (DESIGN.md §6.28) keeps the file it came from in
  // `back`, for the viewer's Back button; any other open starts afresh.
  const [openFile, setOpenFile] = useState<OpenFileState | null>(null);
  const followCodeLink = useCallback(
    (path: string, line?: number, marks?: string[]) =>
      setOpenFile((from) => ({ path, ...(line ? { lines: String(line), tab: "file" as const } : {}), ...(marks?.length ? { marks } : {}), ...(from ? { back: from } : {}) })),
    []
  );
  const openFileBack = useCallback(() => setOpenFile((current) => current?.back ?? null), []);
  const openFilePath = useCallback((path: string) => setOpenFile({ path }), []);
  const openFileAtLine = useCallback((path: string, line?: number) => setOpenFile({ path, lines: line ? String(line) : undefined }), []);
  const openFileView = useCallback((path: string, lines?: string) => setOpenFile({ path, tab: "file", lines }), []);
  /** A changed file's diff, in the shared file viewer. */
  const openFileDiff = useCallback((path: string) => setOpenFile({ path, tab: "diff" }), []);
  const openFileDiffAt = useCallback((path: string, lines?: string) => setOpenFile({ path, tab: "diff", lines }), []);
  /** The all-files reader (DESIGN.md §6.24): where it starts, or `null` while closed. */
  const [readerStart, setReaderStart] = useState<{ path?: string; lineRange?: string } | null>(null);
  const openReader = useCallback((path?: string, lineRange?: string) => {
    setOpenFile(null);
    setReaderStart({ path, lineRange });
  }, []);
  const [leftWidth, setLeftWidth] = usePanelWidth("graphreview.panel.diff", 236, 200, 480);
  const [chatWidth, setChatWidth] = usePanelWidth("graphreview.panel.chat", 380, 300, 720);
  // Either side column folds to a slim rail so the map can have the room;
  // chat starts folded on windows too narrow for three columns.
  const [leftFolded, setLeftFolded] = usePanelCollapsed("graphreview.panel.diff.folded");
  const [chatFolded, setChatFolded] = usePanelCollapsed("graphreview.panel.chat.folded", 1200);
  /** The palette asked for the diff picker on a list (DiffPanel's `pickRequest`). */
  const [pickRequest, setPickRequest] = useState<{ mode: DiffPickMode; nonce: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The view tabs' ids and the one panel they control (the views' shared cell). */
  const tabIdBase = useId();
  const viewTabId = (v: GraphViewMode) => `${tabIdBase}-tab-${v}`;
  const viewPanelId = `${tabIdBase}-panel`;
  useTabHeight(rootRef);

  const handleDiffResult = useCallback(
    (result: DiffImpactResponseDTO | null, target: ReviewTargetDTO | null, meta: DiffTargetMeta) => {
      setDiffResult(result);
      setReviewTarget(target);
      setAutoReview(meta.autoReview);
      // Opening a PR or a comparison is about that change: show its map —
      // unless the page was opened on a view (`?view=`), on the first result.
      if (result && !viewGivenAtLoad()) setPreferredView("pr", "replace");
    },
    [setPreferredView, viewGivenAtLoad]
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
  const prAreas = useMemo(() => buildPrAreas(prMap.map, shownFindings), [prMap.map, shownFindings]);
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
  const [envMounted, mountEnv] = useLazyMount(view === "env");
  const [filesMounted] = useLazyMount(view === "files");
  const [testsMounted] = useLazyMount(view === "tests");
  const [statsMounted] = useLazyMount(view === "stats");

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
  } = useApiViewState(repoId, apiMounted || infraMounted, graphNonce, reviewTarget, targetData);
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

  // Env (DESIGN.md §6.15)
  const {
    catalog: envCatalog,
    change: envChange,
    focus: envFocus,
    setFocus: setEnvFocus,
    changedOnly: envChangedOnly,
    setChangedOnly: setEnvChangedOnly,
  } = useEnvViewState(repoId, envMounted, graphNonce, reviewTarget, targetData);
  /** Every env link (the left column's Env section) opens the Env view at that name. */
  const openEnvVar = useCallback(
    (name: string) => {
      mountEnv();
      setEnvChangedOnly(false);
      setEnvFocus({ id: name });
      setPreferredView("env");
    },
    [mountEnv, setEnvChangedOnly, setEnvFocus, setPreferredView]
  );

  // Tests (DESIGN.md §6.22)
  const tests = useTestsView(repoId, testsMounted, graphNonce, reviewTarget, review.state);

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
  /** A file a chat answer showed, for the Files view to open (at its line); the nonce lets the same file be shown again. */
  const [filesFocus, setFilesFocus] = useState<{ path: string; line?: number; nonce: number } | null>(null);
  /** The Infra view's sub-view a chat answer asked for. */
  const [infraModeRequest, setInfraModeRequest] = useState<{ mode: InfraMode } | null>(null);
  /** A finding a chat answer showed, for the review dock to list and make active. */
  const [findingFocus, setFindingFocus] = useState<{ findingId: string; nonce: number } | null>(null);
  /** A finding whose Ask was clicked, for the chat's input. */
  const [chatFinding, setChatFinding] = useState<{ id: string; summary: string; nonce: number } | null>(null);
  const askChatAbout = useCallback(
    (finding: FindingDTO) => {
      setChatFinding({ id: finding.id, summary: finding.summary, nonce: Date.now() });
      setChatFolded(false);
    },
    [setChatFolded]
  );
  /** The PR map's area holding most of a component's changed files, if the change touches it. */
  const prAreaOfComponent = useCallback(
    (componentId: string) => {
      let best: { id: string; files: number } | undefined;
      for (const node of prMap.map?.nodes ?? []) {
        if (node.files.length === 0 || !node.componentIds.includes(componentId)) continue;
        if (!best || node.files.length > best.files) best = { id: node.id, files: node.files.length };
      }
      return best?.id;
    },
    [prMap.map]
  );
  /**
   * Where a chat answer (or its component chip) shows a component: with a
   * change selected that touches it, its area on the PR map; otherwise the
   * App map at the level the reviewer is on — the module's card on Modules,
   * else every card holding it ringed and the one holding most of it selected.
   */
  const showComponent = useCallback(
    (componentId: string) => {
      const area = prRequest ? prAreaOfComponent(componentId) : undefined;
      if (area) {
        setPrMode("files");
        selectPrArea(area);
        setPrAreaComponent(componentId);
        setPreferredView("pr");
        return;
      }
      if (appLevel === "modules") {
        showInAppMap(componentId);
        return;
      }
      let best: { id: string; files: number } | undefined;
      for (const node of appMap.map?.nodes ?? []) {
        const files = node.modules.find((m) => m.id === componentId)?.files ?? 0;
        if (files > 0 && (!best || files > best.files)) best = { id: node.id, files };
      }
      setChatHighlight([componentId]);
      setAppSelection(best ? { kind: "card", id: best.id } : null);
      setPreferredView("app");
    },
    [prRequest, prAreaOfComponent, appLevel, appMap.map, showInAppMap, setPrMode, selectPrArea, setPrAreaComponent, setAppSelection, setPreferredView]
  );
  const applyChatAction = useCallback(
    (action: ChatActionDTO) => {
      if (action.kind === "highlight") {
        // Rings every card holding one of them, on whichever level the map is.
        // A change that touches every one of them shows the path on its own map.
        setChatHighlight(action.componentIds);
        if (prRequest && action.componentIds.every((id) => prAreaOfComponent(id))) {
          setPrMode("files");
          selectPrArea(null);
          setPreferredView("pr");
        } else {
          setAppSelection(null);
          setPreferredView("app");
        }
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
      if (action.kind === "view") {
        if (action.view === "pr" && !prRequest) return;
        switch (action.view) {
          case "app":
            if (action.level) setAppLevel(action.level);
            break;
          case "pr":
            if (action.mode === "files" || (action.mode === "functions" && reviewTarget)) setPrMode(action.mode);
            break;
          case "api":
            mountApi();
            if (action.changedOnly !== undefined) setApiChangedOnly(action.changedOnly);
            break;
          case "infra":
            mountInfra();
            if (action.mode) setInfraModeRequest({ mode: action.mode as InfraMode });
            if (action.changedOnly !== undefined) setInfraChangedOnly(action.changedOnly);
            break;
          case "data":
            mountData();
            if (action.mode === "canvas" || action.mode === "list") setDataMode(action.mode);
            if (action.changedOnly !== undefined) setDataChangedOnly(action.changedOnly);
            break;
          case "env":
            mountEnv();
            if (action.changedOnly !== undefined) setEnvChangedOnly(action.changedOnly);
            break;
        }
        setPreferredView(action.view);
        return;
      }
      if (action.kind === "file") {
        if (!reviewTarget) return;
        setOpenFile({ path: action.path, tab: action.tab, ...(action.lines ? { lines: action.lines } : {}), ...(action.symbol ? { component: action.symbol } : {}) });
        return;
      }
      switch (action.target) {
        case "finding":
          if (!reviewTarget) break;
          setFindingFocus({ findingId: action.id, nonce: Date.now() });
          if (reviewExpanded) break;
          // The findings list sits under the maps, not under the list views.
          if (LIST_VIEWS.has(view)) setPreferredView(prRequest ? "pr" : "app");
          break;
        case "component":
          showComponent(action.id);
          break;
        case "file":
          // A file the change touches opens in the file viewer (its diff, or the
          // changed version at the line) — the Files view shows the analysed
          // commit, where the change's line numbers don't hold. The rest open in
          // the Files view, at the line, marked.
          if (changedFiles?.has(action.id)) {
            setOpenFile({ path: action.id, tab: action.line ? "file" : "diff", ...(action.line ? { lines: String(action.line) } : {}) });
          } else {
            setFilesFocus({ path: action.id, ...(action.line ? { line: action.line } : {}), nonce: Date.now() });
            setPreferredView("files");
          }
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
        case "env":
          openEnvVar(action.id);
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
      prAreaOfComponent,
      setAppSelection,
      setPreferredView,
      showComponent,
      openEndpoint,
      openTable,
      openEnvVar,
      openInfraResource,
      selectPrArea,
      setPrAreaComponent,
      setPrMode,
      setSelectedFunction,
      setApiChangedOnly,
      setDataChangedOnly,
      setDataSelected,
      setInfraChangedOnly,
      setAppLevel,
      setDataMode,
      setEnvChangedOnly,
      mountApi,
      mountInfra,
      mountData,
      mountEnv,
      reviewExpanded,
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
    for (const f of shownFindings) {
      if (!f.filePath) continue;
      const prev = map.get(f.filePath);
      map.set(f.filePath, prev ? worstAssessment(prev, effectiveAssessment(f)) : effectiveAssessment(f));
    }
    return map;
  }, [shownFindings]);

  /** On the PR view the inspector explains the selected area or function; with nothing selected the chat has the column. */
  const selectedPrArea = prArea ? prAreas.areas.get(prArea) : undefined;
  const selectedFn =
    view === "pr" && prMode === "functions" && selectedFunction ? functionView?.functionById.get(selectedFunction) : undefined;
  const showPrPanel = view === "pr" && prMap.map !== null && Boolean((selectedFn && functionView) || selectedPrArea);
  const hasInspector = showAppPanel || showPrPanel || showDataPanel;
  const chatFocus =
    showPrPanel && prAreaComponent
      ? { id: prAreaComponent, name: componentNameById(prAreaComponent) ?? prAreaComponent }
      : null;

  /** What is on the screen, in a line, for the chat (DESIGN.md §6.7): the view, what is selected in it, an open file. */
  const chatScreen = useMemo(() => {
    const parts = [VIEW_OPTIONS.find((o) => o.value === view)?.label ?? view];
    if (view === "app") {
      parts[0] += ` by ${appLevel}`;
      const card = appSelection?.kind === "card" ? appMap.map?.nodes.find((n) => n.id === appSelection.id) : undefined;
      if (card) parts.push(`card "${card.name}" selected`);
    } else if (view === "pr") {
      parts[0] += prMode === "functions" ? " (functions)" : "";
      if (selectedFn) parts.push(`function ${selectedFn.qualified}() selected`);
      else if (selectedPrArea) parts.push(`area "${selectedPrArea.node.name}" selected`);
    } else if (view === "data") {
      parts[0] += ` (${dataMode})`;
      if (selectedDbRow) parts.push(`table ${selectedDbRow.table.name} selected`);
    }
    if (openFile) parts.push(`file viewer open on ${openFile.path}${openFile.lines ? `:${openFile.lines}` : ""} (${openFile.tab ?? "diff"})`);
    if (reviewTarget && mapFolded) parts.push("the findings list expanded");
    return parts.join("; ");
  }, [view, appLevel, appSelection, appMap.map, prMode, selectedFn, selectedPrArea, dataMode, selectedDbRow, openFile, reviewTarget, mapFolded]);

  // --- The command palette (DESIGN.md §6.18) ---------------------------------
  // It ranks by what is open here and shows things here through the same
  // actions the chat uses; a question it hands over goes to this chat.
  useEffect(() => {
    setGraphContext({
      repoId,
      target: reviewTarget,
      ...(reviewTarget
        ? { targetKey: "prNumber" in reviewTarget ? `pr:${reviewTarget.prNumber}` : `refs:${reviewTarget.baseRef}...${reviewTarget.headRef}` }
        : {}),
      touched: changedFiles ? [...changedFiles] : [],
    });
  }, [repoId, reviewTarget, changedFiles]);
  useEffect(() => () => setGraphContext(null), []);
  const runPaletteRequest = useCallback(
    (request: GraphRequest) => {
      if (request.kind === "ask") {
        // About the open review, or the whole repo with none open — as the chat itself.
        void chat.send(request.question, { screen: chatScreen });
        return;
      }
      if (request.kind === "pick") {
        setLeftFolded(false);
        setPickRequest({ mode: request.mode, nonce: Date.now() });
        return;
      }
      noteInteraction();
      setChatHighlight(null);
      applyChatAction(request.action);
    },
    [chat, chatScreen, noteInteraction, applyChatAction, setLeftFolded]
  );
  useEffect(() => registerGraphHandler(repoId, runPaletteRequest), [repoId, runPaletteRequest]);
  // A request left by the palette on another page: applied once it can be —
  // those about the change wait for it and its map.
  useEffect(() => {
    const request = takePendingGraphRequest(repoId, Boolean(reviewTarget && prMap.map), chat.ready && !chat.loading);
    if (request) runPaletteRequest(request);
  }, [repoId, reviewTarget, prMap.map, chat.ready, chat.loading, runPaletteRequest]);

  // The view switch is a row of tabs across the column; the active view's
  // own toolbar sits directly under it (view-chrome.ts), so a view's
  // controls always start at the same place, under the tabs rather than
  // after them. PR is only there while a diff is selected.
  // A tablist with roving focus: Tab reaches the selected tab only, the
  // arrow keys (and Home/End) move along the row and select as they go —
  // rewriting the history entry, so arrowing across doesn't fill Back.
  const visibleViews = VIEW_OPTIONS.filter((o) => o.value !== "pr" || prRequest);
  const onViewTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const at = visibleViews.findIndex((o) => o.value === view);
    const to =
      event.key === "ArrowRight" ? (at + 1) % visibleViews.length
      : event.key === "ArrowLeft" ? (at - 1 + visibleViews.length) % visibleViews.length
      : event.key === "Home" ? 0
      : event.key === "End" ? visibleViews.length - 1
      : -1;
    if (to < 0 || !(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") return;
    event.preventDefault();
    const next = visibleViews[to].value;
    setPreferredView(next, "replace");
    document.getElementById(viewTabId(next))?.focus();
  };
  const viewTabs = (
    <div role="tablist" aria-label="Graph view" onKeyDown={onViewTabKeyDown} className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-card px-3">
      {visibleViews.map((o) => {
        const active = o.value === view;
        return (
          <button
            key={o.value}
            id={viewTabId(o.value)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={viewPanelId}
            tabIndex={active ? 0 : -1}
            title={o.title}
            onClick={() => setPreferredView(o.value)}
            className={cn(
              "-mb-px border-b-2 px-3 pt-2 pb-1.5 text-xs font-medium whitespace-nowrap transition-colors",
              active ? "border-brand text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {o.label}
          </button>
        );
      })}
      <div ref={setTabsSlot} className="ml-auto flex shrink-0 items-center self-center pl-3" />
    </div>
  );

  return (
    // `data-wide-shell` opts this tab out of the repo shell's `max-w-6xl`
    // cap — see app/repo/[repoId]/layout.tsx for the mechanism and why.
    <div ref={rootRef} data-wide-shell className="flex flex-col lg:h-(--tab-h) lg:flex-row lg:overflow-hidden">
      <aside
        data-pane="left"
        onPointerDownCapture={noteInteraction}
        onKeyDownCapture={noteInteraction}
        className="relative w-full shrink-0 border-border bg-card lg:h-full lg:w-(--panel-w) lg:border-r"
        style={{ "--panel-w": leftFolded ? "0.75rem" : `${leftWidth}px` } as React.CSSProperties}
      >
        {leftFolded ? (
          <PanelFoldedRail edge="right" onUnfold={() => setLeftFolded(false)} label="the diff panel" />
        ) : (
          <PanelResizeHandle
            edge="right"
            width={leftWidth}
            onResize={setLeftWidth}
            label="Resize diff panel"
            onFold={() => setLeftFolded(true)}
            foldLabel="the diff panel"
          />
        )}
        <div className={cn("px-4 pt-3 pb-4 lg:h-full lg:overflow-y-auto lg:pb-6", leftFolded && "lg:hidden")}>
          <DiffPanel
            repoId={repoId}
            defaultBranch={repo?.defaultBranch}
            isLocal={repo?.provider === "local"}
            lastAnalyzedSha={repo?.lastAnalyzedSha}
            initialPrNumber={initialPrNumber}
            initialBaseRef={initialBaseRef}
            initialHeadRef={initialHeadRef}
            onResult={handleDiffResult}
            lineStats={lineStats}
            pickRequest={pickRequest}
          >
            {reviewTarget && <ChecklistPanel repoId={repoId} checklist={checklist} onOpenFile={openFileDiffAt} />}
            {/* What the diff does to each catalog — each section shows only when the diff changed it. */}
            {reviewTarget && <ApiChangesSection change={apiChange} onOpen={openEndpoint} />}
            {reviewTarget && <InfraChangesSection change={infraChange} onOpen={openInfraResource} />}
            {reviewTarget && <SchemaChangesSection change={dbChange} onOpen={openTable} />}
            {reviewTarget && <EnvChangesSection change={envChange} onOpen={openEnvVar} />}
            {reviewTarget && (
              <LooksDifferentPanel
                scan={previewScan}
                onOpen={(path, component) => setOpenFile({ path, component })}
              />
            )}
          </DiffPanel>
        </div>
      </aside>

      <div
        data-pane="center"
        className="flex min-w-0 flex-1 flex-col lg:h-full lg:overflow-hidden"
        onPointerDownCapture={noteInteraction}
        onWheelCapture={noteInteraction}
        onKeyDownCapture={noteInteraction}
      >
        {/* The two views share this one fixed-height cell; each is a flex
            column whose canvas takes whatever its own toolbar leaves. With a
            review under it the map section gets half the tab (the dock has a
            tab bar and column headers to fit), without one all of it. The
            view tabs run across the top, above whichever view is active. The review's Expand
            folds it to nothing (the canvases skip a zero size and refit when
            it comes back), so the findings get the whole column. */}
        <div
          data-pane-part="map"
          className={cn("flex shrink-0 flex-col transition-[height] duration-200", mapFolded && !apiFull && "overflow-hidden")}
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
        {viewTabs}
        <div role="tabpanel" id={viewPanelId} aria-labelledby={viewTabId(view)} className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)]">
        {appMounted && (
          <div className={viewLayerClass(view === "app")} inert={view !== "app"}>
            <AppMapView
              className="flex h-full flex-col"
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
              findings={shownFindings}
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
              repoId={repoId}
              diffTarget={reviewTarget}
              endpoints={apiCatalog.catalog?.endpoints ?? NO_ENDPOINTS}
              catalog={infraCatalog.catalog}
              rows={infraRows}
              loading={infraCatalog.loading}
              error={infraCatalog.error}
              change={infraChange}
              changePending={Boolean(reviewTarget) && targetGraph.pending}
              changedOnly={infraChangedOnly}
              onChangedOnlyChange={setInfraChangedOnly}
              focus={infraFocus}
              modeRequest={infraModeRequest}
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
        {envMounted && (
          <div className={viewLayerClass(view === "env")} inert={view !== "env"}>
            <EnvView
              className="flex h-full flex-col"
              catalog={envCatalog.catalog}
              loading={envCatalog.loading}
              error={envCatalog.error}
              change={envChange}
              changePending={Boolean(reviewTarget) && targetGraph.pending}
              changedOnly={envChangedOnly}
              onChangedOnlyChange={setEnvChangedOnly}
              focus={envFocus}
              onOpenFile={openFileAtLine}
              onOpenInfra={openInfraResource}
              onOpenComponent={showComponent}
            />
          </div>
        )}
        {filesMounted && (
          <div className={viewLayerClass(view === "files")} inert={view !== "files"}>
            <FilesView
              className="flex h-full flex-col"
              repoId={repoId}
              repoName={repo?.name}
              tree={repoTree.tree}
              loading={repoTree.loading}
              error={repoTree.error}
              changedFiles={changedFiles}
              onOpenDiff={openFileDiff}
              active={view === "files"}
              focus={filesFocus}
            />
          </div>
        )}
        {testsMounted && (
          <div className={viewLayerClass(view === "tests")} inert={view !== "tests"}>
            <TestsView
              className="flex h-full flex-col"
              catalog={tests.catalog}
              loading={tests.loading}
              error={tests.error}
              change={targetData?.tests}
              changePending={Boolean(reviewTarget) && targetGraph.pending}
              plan={tests.plan}
              headSha={reviewTarget ? targetGraph.graph?.headSha : undefined}
              hasTarget={Boolean(reviewTarget)}
              onOpenFile={openFileAtLine}
            />
          </div>
        )}
        {statsMounted && (
          <div className={viewLayerClass(view === "stats")} inert={view !== "stats"}>
            <StatsGraphView className="flex h-full flex-col" repoId={repoId} refreshKey={graphNonce} />
          </div>
        )}
        {prRequest && (
          <div className={viewLayerClass(view === "pr")} inert={view !== "pr"}>
          <PrMapCanvas
            className="flex h-full flex-col"
            map={prMap.map}
            loading={prMap.loading}
            error={prMap.error}
            areas={prAreas}
            selectedCardId={prArea}
            onSelectCard={selectPrArea}
            selectedComponentId={prAreaComponent}
            highlightComponentIds={chatHighlight}
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
            toolbarSlot={view === "pr" ? tabsSlot : null}
          />
          </div>
        )}
        </div>
        </div>

        <FileDiffModal
          repoId={repoId}
          target={reviewTarget}
          finding={openFile ? { filePath: openFile.path, ...(openFile.lines ? { lineRange: openFile.lines } : {}) } : null}
          initialComponent={openFile?.component}
          initialTab={openFile?.tab}
          onClose={() => setOpenFile(null)}
          onOpenReader={reviewTarget ? openReader : undefined}
          baseSha={reviewTarget ? targetGraph.graph?.baseSha : undefined}
          headSha={reviewTarget ? targetGraph.graph?.headSha : undefined}
          onNavigate={followCodeLink}
          back={openFile?.back ? { path: openFile.back.path, onBack: openFileBack } : undefined}
          markNames={openFile?.marks}
        />
        {reviewTarget && (
          <AllFilesReader
            repoId={repoId}
            target={reviewTarget}
            start={readerStart}
            onClose={() => setReaderStart(null)}
            baseSha={targetGraph.graph?.baseSha}
            headSha={targetGraph.graph?.headSha}
            onFollowLink={followCodeLink}
          />
        )}

        {/* Under the graph, full width: the AI review, exceptions first —
            see ReviewPanel's header for why it lives here rather than in a
            sidebar. The checklist sits in the diff summary on the left. */}
        {reviewTarget && !apiFull && (
          <ReviewPanel
            repoId={repoId}
            target={reviewTarget}
            onOpenReader={openReader}
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
            onDismiss={review.dismiss}
            onUnsuppress={review.unsuppress}
            effort={reviewEffort}
            onEffortChange={setReviewEffort}
            expanded={reviewExpanded}
            onToggleExpanded={toggleReviewExpanded}
            map={prMap.map}
            acceptanceCriteria={checklist.data?.items.find((i) => i.kind === "acceptance-criteria")?.criteria}
            areas={prAreas}
            scopeAreaId={prArea}
            scopeComponentId={prAreaComponent}
            onClearScope={() => selectPrArea(null)}
            filterRequest={reviewFilter}
            focusRequest={findingFocus}
            onAskChat={askChatAbout}
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
          data-pane="right"
          className="relative flex w-full shrink-0 flex-col border-t border-border bg-card lg:h-full lg:w-(--panel-w) lg:border-t-0 lg:border-l"
          style={{ "--panel-w": chatFolded ? "0.75rem" : `${chatWidth}px` } as React.CSSProperties}
        >
          {chatFolded ? (
            <PanelFoldedRail edge="left" onUnfold={() => setChatFolded(false)} label="the chat column" />
          ) : (
            <PanelResizeHandle
              edge="left"
              width={chatWidth}
              onResize={setChatWidth}
              label="Resize right column"
              onFold={() => setChatFolded(true)}
              foldLabel="the chat column"
            />
          )}
          {hasInspector && (
            <div data-pane-part="inspector" className={cn("max-h-[58%] min-h-0 shrink-0 space-y-3 overflow-y-auto border-b border-border", chatFolded && "lg:hidden")}>
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
                selectedPrArea && (
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
                )
              )}
            </div>
          )}
          <div data-pane-part="chat" className={cn("min-h-0 flex-1", chatFolded && "lg:hidden")}>
              <ChatPanel
                chat={chat}
                targetLabel={reviewTarget ? reviewTargetLabel(reviewTarget) : null}
                focus={chatFocus}
                componentName={componentNameById}
                changedFiles={chatChangedFiles}
                onSelectComponent={showComponent}
                onOpenFile={openFileView}
                onApplyAction={applyChatAction}
                screen={chatScreen}
                finding={chatFinding}
              />
          </div>
      </aside>
    </div>
  );
}
