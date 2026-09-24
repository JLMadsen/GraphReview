"use client";

// Client-side orchestrator for the Graph tab: fetches the
// component graph and optional repo context, hosts the diff-selection
// sidebar, and feeds diff-impact results into GraphCanvas for touched-node
// highlighting. Everything fetches client-side (rather than the server
// page doing it) so a missing/not-yet-built `/api/repos/[repoId]` repo
// endpoint or an unreachable Neo4j degrades gracefully in the browser
// instead of failing the page render.
//
// It is also where the v2 AI review is hung off the diff flow:
// `DiffPanel` reports *what* was checked alongside the impact result, that
// target drives `useReview` (auto-run + polling), and the resulting findings
// fan out to three places — marker halos on the canvas, the full dock below
// it, and the selected component's own panel in the sidebar.

import { useCallback, useEffect, useMemo, useState } from "react";
import { FlaskConical, GitBranch, LoaderCircle } from "lucide-react";
import { GraphCanvas } from "./GraphCanvas";
import { PanelResizeHandle, usePanelWidth } from "./PanelResizeHandle";
import { ComponentFilesPanel } from "./ComponentFilesPanel";
import { MergesControl, MergeSuggestionsPanel } from "./MergeSuggestions";
import { DiffPanel } from "./DiffPanel";
import { ReviewPanel } from "./ReviewPanel";
import { buildReviewMarkers } from "./review-visuals";
import { SAMPLE_EDGES, SAMPLE_NODES } from "./sample-data";
import { useLabels } from "./useLabels";
import { useMerges } from "./useMerges";
import { useReview } from "./useReview";
import {
  DEFAULT_REVIEW_EFFORT,
  type ReviewEffort,
} from "./types";
import type {
  AddedComponentDTO,
  DiffImpactResponseDTO,
  GraphNodeDTO,
  GraphResponseDTO,
  ReviewTargetDTO,
} from "./types";

/** Trimmed shape of `GET /api/repos/[repoId]` — see this repo's task brief. Only the fields this view needs. */
interface RepoContext {
  name: string;
  defaultBranch?: string;
}

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
  const review = useReview(repoId, reviewTarget, reviewEffort);
  const handleLabelsCompleted = useCallback(() => setGraphNonce((n) => n + 1), []);
  const labels = useLabels(repoId, handleLabelsCompleted);
  // Feature merges (DESIGN.md §6.3). Every accept/unmerge/rename changes the
  // module tier server-side, so it refetches the graph the same way a
  // finished labeling run does; the suggestions list follows `graphNonce`.
  const merges = useMerges(repoId, graphNonce, handleLabelsCompleted);
  const [mergesOpen, setMergesOpen] = useState(false);
  const [previewIds, setPreviewIds] = useState<string[] | null>(null);
  const [leftWidth, setLeftWidth] = usePanelWidth("graphreview.panel.diff", 288, 240, 560);
  const [rightWidth, setRightWidth] = usePanelWidth("graphreview.panel.files", 320, 260, 720);

  // A selection is only meaningful against the graph it was made in — but a
  // *re-fetch* of the same repo's graph (a finished labeling run) keeps the
  // same module ids, so it deliberately doesn't clear the selection.
  useEffect(() => {
    setSelectedNodeId(null);
  }, [repoId]);

  useEffect(() => {
    let cancelled = false;
    // Repo context is a nice-to-have header/default — fail silently if the
    // endpoint 404s (not built yet) or errors (no live Neo4j in dev).
    fetch(`/api/repos/${repoId}`)
      .then((res) => (res.ok ? (res.json() as Promise<RepoContext>) : null))
      .then((data) => {
        if (!cancelled && data) setRepo(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repoId]);

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
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // No live Neo4j / repo not analyzed yet — show sample data rather
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
    (result: DiffImpactResponseDTO | null, target: ReviewTargetDTO | null) => {
      setDiffResult(result);
      setReviewTarget(target);
    },
    []
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

  const selectedFindings = useMemo(
    () =>
      selectedNodeId
        ? review.findings.filter((f) => f.componentId === selectedNodeId)
        : [],
    [review.findings, selectedNodeId]
  );

  return (
    // `data-wide-shell` opts this tab out of the repo shell's `max-w-6xl`
    // cap — see app/repo/[repoId]/layout.tsx for the mechanism and why.
    <div data-wide-shell className="flex flex-col gap-4 lg:flex-row">
      <aside
        className="relative w-full shrink-0 border-border pb-4 lg:w-(--panel-w) lg:border-r lg:pr-4 lg:pb-0"
        style={{ "--panel-w": `${leftWidth}px` } as React.CSSProperties}
      >
        <PanelResizeHandle
          edge="right"
          width={leftWidth}
          onResize={setLeftWidth}
          label="Resize diff panel"
        />
        {/* Sticks alongside a tall canvas instead of scrolling away from it.
            Diff selection comes first so it's the top of the leftmost
            column, with the repo card below it. */}
        <div className="space-y-3 lg:sticky lg:top-4">
          <DiffPanel
            repoId={repoId}
            defaultBranch={repo?.defaultBranch}
            initialPrNumber={initialPrNumber}
            initialBaseRef={initialBaseRef}
            initialHeadRef={initialHeadRef}
            onResult={handleDiffResult}
            onAddedComponents={handleAddedComponents}
          />
          {repo && (
            <div className="rounded-lg bg-card px-3 py-2 ring-1 ring-border">
              <p className="truncate text-xs font-semibold tracking-tight">
                {repo.name}
              </p>
              {repo.defaultBranch && (
                <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <GitBranch className="size-3 shrink-0" aria-hidden />
                  <span className="truncate font-mono">{repo.defaultBranch}</span>
                </p>
              )}
            </div>
          )}
        </div>
      </aside>

      <div className="min-w-0 flex-1 space-y-3">
        {usingSample && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning">
            <FlaskConical className="mt-px size-3.5 shrink-0" aria-hidden />
            <p>
              <span className="font-medium">Showing sample data</span> — this
              repo has no analyzed component graph yet
              {loadError ? ` (${loadError})` : ""}.
            </p>
          </div>
        )}
        {graph ? (
          <GraphCanvas
            nodes={canvasNodes}
            edges={graph.edges}
            touchedComponentIds={diffResult?.touchedComponentIds}
            addedComponentIds={addedComponentIds}
            selectedNodeId={selectedNodeId}
            onSelectNode={handleSelectNode}
            reviewMarkers={reviewMarkers}
            // No labeling control over sample data: those component ids
            // don't exist in Neo4j, so there is nothing to label.
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
          <div className="flex h-96 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-canvas">
            <LoaderCircle
              className="size-5 animate-spin text-muted-foreground"
              aria-hidden
            />
            <p className="text-sm text-muted-foreground">Loading graph…</p>
          </div>
        )}

        {/* The review dock — see ReviewPanel's header for why it lives here
            rather than in the sidebar. It renders nothing without a target,
            so the Paste-paths flow is untouched. */}
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
          onSelectComponent={handleSelectNode}
          onSetResolved={review.setResolved}
          effort={reviewEffort}
          onEffortChange={setReviewEffort}
        />
      </div>

      {(selectedNode || (mergesOpen && !usingSample)) && (
        // To the right of the graph rather than the left sidebar: clicking a
        // node shouldn't take the diff controls away, and this keeps the
        // canvas the visual center. `key` forces a fresh fetch/state when
        // the selection moves to another node.
        <aside
          className="relative w-full shrink-0 border-border pt-4 lg:w-(--panel-w) lg:border-l lg:pt-0 lg:pl-4"
          style={{ "--panel-w": `${rightWidth}px` } as React.CSSProperties}
        >
          <PanelResizeHandle
            edge="left"
            width={rightWidth}
            onResize={setRightWidth}
            label="Resize component panel"
          />
          <div className="space-y-3 lg:sticky lg:top-4">
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
        </aside>
      )}
    </div>
  );
}
