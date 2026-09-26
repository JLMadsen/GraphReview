"use client";

// The Graph tab's App map view (DESIGN.md §6.5): the whole codebase drawn
// like the PR map, at one of three levels of detail — Architecture (layers),
// Features (capabilities across folders) and Modules — on the shared
// `CardFlow` canvas. The toolbar switches levels, searches cards and files,
// and runs the on-demand AI pass that regroups and explains the current
// level. The explainer for a selected card or connection lives in GraphView's
// right column (`AppMapPanel`), so the canvas keeps its width.

import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, Search, Sparkles, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { APP_CARD_WIDTH, AppMapCard } from "./AppMapCard";
import { CardFlow, DEFAULT_ELK_OPTIONS, linkId, type CardFlowLink } from "./CardFlow";
import type { AppMapSelection } from "./AppMapPanel";
import type { UseAppMapJobResult } from "./useAppMap";
import {
  APP_LAYERS,
  APP_LAYER_ORDER,
  APP_MAP_LEVELS,
  type AppMapLevel,
  type AppMapResponseDTO,
} from "./app-map-types";
import { formatAgo } from "./label-types";

const ELK_OPTIONS = { ...DEFAULT_ELK_OPTIONS, "elk.aspectRatio": "2.2" };
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
  onSelectModule: (moduleId: string) => void;
  onSelectFile: (path: string) => void;
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
  onSelectModule,
  onSelectFile,
  className,
}: AppMapViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [allEdges, setAllEdges] = useState(false);

  useEffect(() => setExpanded(new Set()), [level]);

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

  const highlighted = useMemo(() => {
    if (selection?.kind === "card") return new Set([selection.id]);
    return matches ?? new Set<string>();
  }, [selection, matches]);
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

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const renderCard = useCallback(
    (id: string) => {
      const node = nodes.find((n) => n.id === id);
      if (!node) return null;
      return (
        <AppMapCard
          node={node}
          level={level}
          selected={selection?.kind === "card" && selection.id === id}
          dimmed={Boolean(matches) && !matches!.has(id)}
          expanded={expanded.has(id)}
          changedFiles={changedFiles}
          onToggleExpand={() => toggleExpand(id)}
          onSelectModule={onSelectModule}
          onSelectFile={onSelectFile}
        />
      );
    },
    [nodes, level, selection, matches, expanded, changedFiles, toggleExpand, onSelectModule, onSelectFile]
  );

  const layoutKey = useMemo(
    () =>
      JSON.stringify([
        level,
        nodes.map((n) => [n.id, n.name, n.description, n.files.length, n.keyFiles.length, expanded.has(n.id), Boolean(n.explanation)]),
        strongLinks.map((e) => [e.source, e.target]),
        changedFiles?.size ?? 0,
      ]),
    [level, nodes, strongLinks, expanded, changedFiles]
  );

  const presentLayers = useMemo(() => {
    const seen = new Set(nodes.flatMap((n) => n.layers.map((l) => l.layer)));
    return APP_LAYER_ORDER.filter((l) => seen.has(l));
  }, [nodes]);

  const touchedCards = changedFiles && changedFiles.size > 0 ? nodes.filter((n) => n.files.some((f) => changedFiles.has(f))).length : 0;

  return (
    <div className={className}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex w-fit items-center gap-0.5 rounded-lg bg-muted p-[3px] ring-1 ring-border/60" role="group" aria-label="Level of detail">
          {APP_MAP_LEVELS.map((opt) => {
            const active = level === opt.value;
            const generated = job.status?.generated[opt.value];
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onLevelChange(opt.value)}
                aria-pressed={active}
                title={opt.title}
                className={cn(
                  "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  active ? "bg-elevated text-foreground shadow-sm ring-1 ring-border/60" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {opt.label}
                {generated && <Sparkles className="size-3 text-brand" aria-label="Explained by AI" />}
              </button>
            );
          })}
        </div>

        <label className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a card or file…"
            className="h-7 w-48 rounded-md bg-card pr-6 pl-7 text-xs ring-1 ring-border outline-none placeholder:text-muted-foreground focus:ring-brand"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} className="absolute right-1.5 text-muted-foreground hover:text-foreground" aria-label="Clear search">
              <X className="size-3.5" />
            </button>
          )}
        </label>
        {matches && <span className="text-[11px] text-muted-foreground">{matches.size} match{matches.size === 1 ? "" : "es"}</span>}

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
            `${map!.newFiles} file${map!.newFiles === 1 ? " isn't" : "s aren't"} in the AI grouping (added since, or skipped by the model) — placed by the heuristic. Re-run to include ${map!.newFiles === 1 ? "it" : "them"}.`}
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
            <span className="size-2 rounded-full" style={{ backgroundColor: APP_LAYERS[layer].color }} />
            {APP_LAYERS[layer].name}
          </span>
        ))}
        {map && (
          <span className="ml-auto">
            {map.totalFiles} files · {map.nodes.length} cards ·{" "}
            {strongLinks.length < allLinks.length || allEdges ? (
              <button
                type="button"
                onClick={() => setAllEdges((v) => !v)}
                className="underline-offset-2 hover:text-foreground hover:underline"
                title="Busy maps draw only their strongest connections, plus every connection of the selected card"
              >
                {allEdges
                  ? `all ${allLinks.length} connections (show strongest only)`
                  : `${strongLinks.length} strongest of ${allLinks.length} connections (show all)`}
              </button>
            ) : (
              `${allLinks.length} connections`
            )}
            {touchedCards > 0 && <span className="text-warning"> · diff touches {touchedCards}</span>}
            {" · "}click a card or an arrow to have it explained
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
        className="flex items-center gap-1 rounded-full bg-brand-muted px-2 py-0.5 text-[11px] font-medium text-brand"
        title={map.model ? `Grouped and explained by ${map.model}` : "Grouped and explained by AI"}
      >
        <Sparkles className="size-3" aria-hidden /> AI · {formatAgo(map.generatedAt) || "explained"}
      </span>
    );
  }
  const how =
    map.level === "architecture"
      ? "Layers guessed from paths"
      : map.level === "features"
        ? "Features guessed from shared names"
        : "Modules from the analysis";
  return <span className="text-[11px] text-muted-foreground">{how}</span>;
}

function AiButton({ job, level }: { job: UseAppMapJobResult; level: AppMapLevel }) {
  const status = job.status;
  if (!status) return null;
  if (!status.aiConfigured) {
    return (
      <a href="/settings" className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
        Configure AI to explain this map
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
        <LoaderCircle className="size-3.5 animate-spin text-brand" aria-hidden />
        {status.level && status.level !== level ? `${status.level}: ` : ""}
        {phase}
        {p && p.calls > 0 && (
          <span className="font-mono">
            · {p.calls} call{p.calls === 1 ? "" : "s"}
            {tokens > 0 ? ` · ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens` : ""}
          </span>
        )}
        <button type="button" onClick={job.cancel} className="rounded px-1.5 py-0.5 ring-1 ring-border hover:bg-secondary">
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
      className="flex items-center gap-1.5 rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-brand-foreground shadow-sm transition-opacity hover:opacity-90"
      title={
        level === "modules"
          ? "Explain every module and its connections (a few model calls per 4 modules)"
          : `Let the model ${level === "features" ? "group the files into features" : "correct the layer of each file"} and explain every card and connection`
      }
    >
      <Sparkles className="size-3.5" />
      {generated ? "Re-explain" : "Explain with AI"}
    </button>
  );
}
