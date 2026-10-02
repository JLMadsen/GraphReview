"use client";

// The Graph tab's App map view (DESIGN.md §6.5): the whole codebase drawn
// like the PR map, at one of three levels of detail — Architecture (layers),
// Features (capabilities across folders) and Modules — on the shared
// `CardFlow` canvas. The toolbar switches levels, searches cards and files,
// and runs the on-demand AI pass that regroups and explains the current
// level. With a diff selected, cards show what it changed and — once the
// review has run — the worst verdict of their findings; a component selected
// elsewhere (chat chip, review dock, PR map) rings the cards that hold it.
// The explainer for a selected card or connection lives in GraphView's
// right column (`AppMapPanel`), so the canvas keeps its width.

import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, Search, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { APP_CARD_WIDTH, AppMapCard } from "./AppMapCard";
import { Segmented } from "./Segmented";
import { Spark } from "./Spark";
import { CardFlow, DEFAULT_ELK_OPTIONS, linkId, type CardFlowLink } from "./CardFlow";
import type { PrCardMarker } from "./PrMapNode";
import { effectiveAssessment, worstAssessment } from "./review-visuals";
import type { FindingDTO, Assessment } from "./types";
import type { AppMapSelection } from "./AppMapPanel";
import type { UseAppMapJobResult } from "./useAppMap";
import {
  APP_LAYERS,
  APP_LAYER_ORDER,
  APP_MAP_LEVELS,
  layerTint,
  type AppMapLevel,
  type AppMapResponseDTO,
} from "./app-map-types";
import { formatAgo } from "./label-types";

// Cards are compact now, so a squarer layout fills the canvas instead of
// leaving a thin strip across its middle.
const HIGHLIGHT_STORAGE_KEY = "graphreview.appmap.highlight";
const ELK_OPTIONS = { ...DEFAULT_ELK_OPTIONS, "elk.aspectRatio": "1.5" };
/** Connections drawn by default, per card — beyond that only the strongest show (plus the selected card's). */
const EDGES_PER_CARD = 1.5;
const MIN_EDGE_BUDGET = 16;

export interface AppMapViewProps {
  map: AppMapResponseDTO | null;
  loading: boolean;
  error: string | null;
  level: AppMapLevel;
  onLevelChange: (level: AppMapLevel) => void;
  job: UseAppMapJobResult;
  selection: AppMapSelection | null;
  onSelect: (selection: AppMapSelection | null) => void;
  changedFiles?: ReadonlySet<string>;
  /** The current review's findings — rolled up onto the cards holding their files. */
  findings?: FindingDTO[];
  /** The component selected elsewhere; the cards holding it are ringed. */
  focusModuleId?: string | null;
  className?: string;
}

export function AppMapView({
  map,
  loading,
  error,
  level,
  onLevelChange,
  job,
  selection,
  onSelect,
  changedFiles,
  findings,
  focusModuleId,
  className,
}: AppMapViewProps) {
  const [query, setQuery] = useState("");
  const [allEdges, setAllEdges] = useState(false);
  // With a diff selected, changed cards stand out and the rest fade; this
  // turns that off to see the whole map normally. Remembered per browser.
  const [highlight, setHighlightState] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(HIGHLIGHT_STORAGE_KEY) === "off") setHighlightState(false);
    } catch {
      /* keep the default */
    }
  }, []);
  const setHighlight = useCallback((on: boolean) => {
    setHighlightState(on);
    try {
      window.localStorage.setItem(HIGHLIGHT_STORAGE_KEY, on ? "on" : "off");
    } catch {
      /* ignored */
    }
  }, []);
  const hasDiff = Boolean(changedFiles && changedFiles.size > 0);

  const nodes = useMemo(() => map?.nodes ?? [], [map]);
  const cardIds = useMemo(() => nodes.map((n) => n.id), [nodes]);
  const allLinks = useMemo<CardFlowLink[]>(() => map?.edges ?? [], [map]);
  // A busy map draws only its strongest connections; the layout is computed
  // from those alone, so clicking a card (which adds its weaker ones) never
  // reshuffles the cards.
  const budget = Math.max(MIN_EDGE_BUDGET, Math.round(nodes.length * EDGES_PER_CARD));
  const strongLinks = useMemo(() => {
    if (allEdges || allLinks.length <= budget) return allLinks;
    const keep = new Set([...allLinks].sort((a, b) => b.weight - a.weight).slice(0, budget).map(linkId));
    return allLinks.filter((l) => keep.has(linkId(l)));
  }, [allLinks, allEdges, budget]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      nodes
        .filter((n) => n.name.toLowerCase().includes(q) || n.files.some((f) => f.toLowerCase().includes(q)))
        .map((n) => n.id)
    );
  }, [nodes, query]);

  // Every card holding the focused component — on the architecture level a
  // module can straddle several layers.
  const focused = useMemo(
    () =>
      new Set(focusModuleId ? nodes.filter((n) => n.modules.some((m) => m.id === focusModuleId)).map((n) => n.id) : []),
    [nodes, focusModuleId]
  );

  // Findings: one marker per card — the PR map's rule. A finding lands on the
  // card holding its file, else on the card holding most of its component.
  // (Per-file verdicts are listed in the explainer, not on the card.)
  const cardMarkers = useMemo(() => {
    const cardMarkers = new Map<string, PrCardMarker>();
    if (!findings || findings.length === 0) return cardMarkers;
    const cardOfFile = new Map<string, string>();
    for (const node of nodes) for (const file of node.files) cardOfFile.set(file, node.id);
    const cardOfComponent = (componentId: string): string | undefined => {
      let best: { id: string; files: number } | undefined;
      for (const node of nodes) {
        const files = node.modules.find((m) => m.id === componentId)?.files ?? 0;
        if (files > 0 && (!best || files > best.files)) best = { id: node.id, files };
      }
      return best?.id;
    };
    for (const finding of findings) {
      const intent: Assessment = effectiveAssessment(finding);
      const cardId = (finding.filePath && cardOfFile.get(finding.filePath)) || cardOfComponent(finding.componentId);
      if (!cardId) continue;
      const prev = cardMarkers.get(cardId);
      cardMarkers.set(cardId, { worst: prev ? worstAssessment(prev.worst, intent) : intent, count: (prev?.count ?? 0) + 1 });
    }
    return cardMarkers;
  }, [nodes, findings]);

  const highlighted = useMemo(() => {
    if (selection?.kind === "card") return new Set([selection.id]);
    return matches ?? focused;
  }, [selection, matches, focused]);
  const selectedLink = selection?.kind === "edge" ? linkId(selection) : null;
  const links = useMemo(() => {
    if (strongLinks.length === allLinks.length) return strongLinks;
    const shown = new Set(strongLinks.map(linkId));
    const focus = selection?.kind === "card" ? selection.id : null;
    const extra = allLinks.filter(
      (l) => !shown.has(linkId(l)) && (l.source === focus || l.target === focus || linkId(l) === selectedLink)
    );
    return extra.length > 0 ? [...strongLinks, ...extra] : strongLinks;
  }, [strongLinks, allLinks, selection, selectedLink]);

  const renderCard = useCallback(
    (id: string) => {
      const node = nodes.find((n) => n.id === id);
      if (!node) return null;
      return (
        <AppMapCard
          node={node}
          level={level}
          selected={selection?.kind === "card" && selection.id === id}
          focused={focused.has(id)}
          dimmed={Boolean(matches) && !matches!.has(id)}
          changedFiles={changedFiles}
          marker={cardMarkers.get(id)}
          highlightChanges={highlight}
        />
      );
    },
    [nodes, level, selection, focused, matches, changedFiles, cardMarkers, highlight]
  );

  const layoutKey = useMemo(
    () =>
      JSON.stringify([
        level,
        nodes.map((n) => [n.id, n.name, n.description, n.files.length, n.modules.length]),
        strongLinks.map((e) => [e.source, e.target]),
        // The status row (changed count, verdict) adds a line to a card.
        nodes.map((n) => Boolean(changedFiles && n.files.some((f) => changedFiles.has(f))) || cardMarkers.has(n.id)),
      ]),
    [level, nodes, strongLinks, changedFiles, cardMarkers]
  );

  const presentLayers = useMemo(() => {
    const seen = new Set(nodes.flatMap((n) => n.layers.map((l) => l.layer)));
    return APP_LAYER_ORDER.filter((l) => seen.has(l));
  }, [nodes]);


  return (
    <div className={className}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          label="Level of detail"
          value={level}
          onChange={onLevelChange}
          options={APP_MAP_LEVELS.map((opt) => ({
            value: opt.value,
            title: job.status?.generated[opt.value] ? `${opt.title} — described by the model` : opt.title,
            label: job.status?.generated[opt.value] ? (
              <>
                {opt.label}
                <Spark />
              </>
            ) : (
              opt.label
            ),
          }))}
        />

        <label className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a card or file…"
            className="h-[26px] w-48 rounded-md border border-border bg-transparent pr-6 pl-7 text-xs outline-none placeholder:text-muted-foreground focus:border-brand"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} className="absolute right-1.5 text-muted-foreground hover:text-foreground" aria-label="Clear search">
              <X className="size-3.5" />
            </button>
          )}
        </label>
        {matches && <span className="text-[11px] text-muted-foreground">{matches.size} match{matches.size === 1 ? "" : "es"}</span>}

        {hasDiff && (
          <button
            type="button"
            onClick={() => setHighlight(!highlight)}
            aria-pressed={highlight}
            className={cn(
              "flex h-[26px] items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors",
              highlight
                ? "border-warning/50 text-warning hover:bg-warning/10"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
            title={highlight ? "Show every card normally" : "Make the diff's cards stand out and fade the rest"}
          >
            <span className={cn("size-2 rounded-sm", highlight ? "bg-warning" : "border border-muted-foreground")} aria-hidden />
            Highlight changes
          </button>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {map && <SourceNote map={map} />}
          {loading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          <AiButton job={job} level={level} />
        </div>
      </div>

      {(job.notice || (map?.newFiles ?? 0) > 0) && (
        <p className="mb-2 flex items-start gap-1.5 text-[11px] text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {job.notice ??
            `${map!.newFiles} file${map!.newFiles === 1 ? " isn't" : "s aren't"} in the model's grouping (added since, or skipped) — placed by the heuristic. Describe again to include ${map!.newFiles === 1 ? "it" : "them"}.`}
        </p>
      )}

      <CardFlow
        cardIds={cardIds}
        cardWidth={APP_CARD_WIDTH}
        renderCard={renderCard}
        links={links}
        highlighted={highlighted}
        selectedLink={selectedLink}
        layoutKey={layoutKey}
        alwaysLabelEdges={level === "modules" ? 0 : 16}
        elkOptions={ELK_OPTIONS}
        onCardClick={(id) => onSelect(selection?.kind === "card" && selection.id === id ? null : { kind: "card", id })}
        onPaneClick={() => onSelect(null)}
        onLinkClick={(link) => onSelect({ kind: "edge", source: link.source, target: link.target })}
      >
        {!map && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            {error ? (
              <p className="flex max-w-md items-start gap-2 px-6 text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                {error}
              </p>
            ) : (
              <>
                <LoaderCircle className="size-5 animate-spin" aria-hidden />
                Building the app map…
              </>
            )}
          </div>
        )}
        {map && map.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            No analyzed files yet — the map appears once the repo has been analyzed.
          </div>
        )}
      </CardFlow>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {presentLayers.map((layer) => (
          <span key={layer} className="flex items-center gap-1" title={APP_LAYERS[layer].blurb}>
            <span className="h-2.5 w-[3px] rounded-sm" style={{ backgroundColor: layerTint(layer) }} />
            {APP_LAYERS[layer].name}
          </span>
        ))}
        {map && (
          <span className="ml-auto font-mono">
            {map.nodes.length} cards ·{" "}
            {strongLinks.length < allLinks.length || allEdges ? (
              <button
                type="button"
                onClick={() => setAllEdges((v) => !v)}
                className="underline-offset-2 hover:text-foreground hover:underline"
                title={
                  allEdges
                    ? "Show only the strongest connections"
                    : "Busy maps draw only their strongest connections, plus every connection of the selected card. Show all"
                }
              >
                {allEdges ? `${allLinks.length} links` : `${strongLinks.length}/${allLinks.length} links`}
              </button>
            ) : (
              `${allLinks.length} links`
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function SourceNote({ map }: { map: AppMapResponseDTO }) {
  if (map.source === "ai") {
    return (
      <span
        className="flex items-center gap-1 text-[11px] text-muted-foreground"
        title={map.model ? `Grouped and described by ${map.model}` : "Grouped and described by the model"}
      >
        <Spark /> described {formatAgo(map.generatedAt)}
      </span>
    );
  }
  // Modules are what the analysis found — nothing to say. The other two
  // levels are guesses until the model has grouped them, which is worth saying.
  if (map.level === "modules") return null;
  const how = map.level === "architecture" ? "Layers guessed from paths" : "Features guessed from shared names";
  return <span className="text-[11px] text-muted-foreground">{how}</span>;
}

function AiButton({ job, level }: { job: UseAppMapJobResult; level: AppMapLevel }) {
  const status = job.status;
  if (!status) return null;
  if (!status.aiConfigured) {
    return (
      <a href="/settings" className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
        Set up a model to describe this map
      </a>
    );
  }
  if (job.running) {
    const p = status.progress;
    const phase =
      !p || p.phase === "grouping"
        ? p?.level === "modules"
          ? "Preparing"
          : "Grouping"
        : p.phase === "explaining"
          ? `Explaining ${p.done}/${p.total}`
          : "Saving";
    const tokens = p ? p.promptTokens + p.completionTokens : 0;
    return (
      <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        {status.level && status.level !== level ? `${status.level}: ` : ""}
        {phase}
        {p && p.calls > 0 && (
          <span className="font-mono">
            · {p.calls} call{p.calls === 1 ? "" : "s"}
            {tokens > 0 ? ` · ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens` : ""}
          </span>
        )}
        <button type="button" onClick={job.cancel} className="rounded-sm border border-border px-1.5 py-0.5 hover:bg-secondary">
          Cancel
        </button>
      </span>
    );
  }
  const generated = status.generated[level];
  return (
    <button
      type="button"
      onClick={() => job.generate(level)}
      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary"
      title={
        level === "modules"
          ? "Have the model describe every module and its connections (a few model calls per 4 modules)"
          : `Have the model ${level === "features" ? "group the files into features" : "correct the layer of each file"} and describe every card and connection`
      }
    >
      <Spark className="text-[11px]" />
      {generated ? "Describe again" : level === "features" ? "Group features" : level === "architecture" ? "Describe layers" : "Describe modules"}
    </button>
  );
}
