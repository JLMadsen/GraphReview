"use client";

// The App map's explainer (DESIGN.md §6.5), shown in the Graph tab's right
// column when a card or a connection is selected. This is where the map
// "explains itself": the AI explanation, the files to open first and why,
// which layers the card spans, every connection in and out with its verb and
// what flows along it, and the modules behind the card. Everything is a link
// back into the map (another card) or the Repo view (a module).

import { ArrowRight, Boxes, FileCode2, Sparkles, Star, X } from "lucide-react";
import { cn } from "cn";
import { LayerBar } from "./AppMapCard";
import { APP_LAYERS, type AppMapEdgeDTO, type AppMapLevel, type AppMapNodeDTO, type AppMapResponseDTO } from "./app-map-types";

export type AppMapSelection = { kind: "card"; id: string } | { kind: "edge"; source: string; target: string };

export interface AppMapPanelProps {
  map: AppMapResponseDTO;
  selection: AppMapSelection;
  changedFiles?: ReadonlySet<string>;
  onSelect: (selection: AppMapSelection | null) => void;
  onSelectModule: (moduleId: string) => void;
  onSelectFile: (path: string) => void;
}

const LEVEL_NOUN: Record<AppMapLevel, string> = {
  architecture: "Layer",
  features: "Feature",
  modules: "Module",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function ConnectionRow({
  edge,
  other,
  direction,
  onOpen,
  onOpenEdge,
}: {
  edge: AppMapEdgeDTO;
  other: AppMapNodeDTO | undefined;
  direction: "out" | "in";
  onOpen: () => void;
  onOpenEdge: () => void;
}) {
  return (
    <li className="rounded-md bg-muted/60 px-2 py-1.5 ring-1 ring-border/50">
      <div className="flex items-center gap-1.5 text-[11px]">
        <button type="button" onClick={onOpenEdge} className="shrink-0 font-medium text-brand hover:underline" title="Show this connection">
          {direction === "out" ? edge.label : `${edge.label} ←`}
        </button>
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
          title={`Go to ${other?.name ?? ""}`}
        >
          {other?.name ?? "?"}
        </button>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground" title="File-level imports behind this connection">
          ×{edge.weight}
        </span>
      </div>
      {edge.explanation && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{edge.explanation}</p>}
    </li>
  );
}

export function AppMapPanel({ map, selection, changedFiles, onSelect, onSelectModule, onSelectFile }: AppMapPanelProps) {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));

  if (selection.kind === "edge") {
    const edge = map.edges.find((e) => e.source === selection.source && e.target === selection.target);
    const from = byId.get(selection.source);
    const to = byId.get(selection.target);
    if (!edge || !from || !to) return null;
    const back = map.edges.find((e) => e.source === selection.target && e.target === selection.source);
    return (
      <div className="rounded-xl bg-card p-3 ring-1 ring-border">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Connection</p>
          <button type="button" onClick={() => onSelect(null)} className="rounded p-0.5 text-muted-foreground hover:bg-secondary" aria-label="Close">
            <X className="size-3.5" />
          </button>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm font-semibold tracking-tight">
          <button type="button" className="hover:underline" onClick={() => onSelect({ kind: "card", id: from.id })}>{from.name}</button>
          <span className="rounded bg-brand-muted px-1.5 py-0.5 text-[11px] font-medium text-brand">{edge.label}</span>
          <button type="button" className="hover:underline" onClick={() => onSelect({ kind: "card", id: to.id })}>{to.name}</button>
        </p>
        {edge.explanation ? (
          <p className="mt-2 text-xs leading-relaxed">{edge.explanation}</p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            Derived from {edge.weight} import{edge.weight === 1 ? "" : "s"}. Run “Explain with AI” to get what flows along it.
          </p>
        )}
        <Section title={`Imports behind it (${edge.weight}${edge.weight > edge.samples.length ? `, showing ${edge.samples.length}` : ""})`}>
          <ul className="space-y-1">
            {edge.samples.map((s) => (
              <li key={`${s.from}->${s.to}`} className="rounded-md bg-muted/60 px-2 py-1 font-mono text-[10.5px] ring-1 ring-border/50">
                <button type="button" className="block max-w-full truncate hover:underline" onClick={() => onSelectFile(s.from)} title={s.from}>
                  {s.from}
                </button>
                <span className="flex items-center gap-1 text-muted-foreground">
                  <ArrowRight className="size-3 shrink-0" />
                  <button type="button" className="min-w-0 truncate hover:underline" onClick={() => onSelectFile(s.to)} title={s.to}>
                    {s.to}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </Section>
        {back && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            It goes both ways:{" "}
            <button type="button" className="text-brand hover:underline" onClick={() => onSelect({ kind: "edge", source: back.source, target: back.target })}>
              {to.name} {back.label} {from.name}
            </button>{" "}
            (×{back.weight}).
          </p>
        )}
      </div>
    );
  }

  const node = byId.get(selection.id);
  if (!node) return null;
  const outgoing = map.edges.filter((e) => e.source === node.id).sort((a, b) => b.weight - a.weight);
  const incoming = map.edges.filter((e) => e.target === node.id).sort((a, b) => b.weight - a.weight);
  const changed = changedFiles ? node.files.filter((f) => changedFiles.has(f)) : [];
  const layer = APP_LAYERS[node.layer];

  return (
    <div className="rounded-xl bg-card p-3 ring-1 ring-border">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            <span className="size-2 rounded-full" style={{ backgroundColor: layer.color }} />
            {LEVEL_NOUN[map.level]}
            {map.level !== "architecture" && ` · mostly ${layer.name}`}
          </p>
          <p className="mt-0.5 text-sm font-semibold tracking-tight">{node.name}</p>
        </div>
        <button type="button" onClick={() => onSelect(null)} className="rounded p-0.5 text-muted-foreground hover:bg-secondary" aria-label="Close">
          <X className="size-3.5" />
        </button>
      </div>
      {node.description && <p className="mt-1 text-xs text-muted-foreground">{node.description}</p>}

      {node.explanation ? (
        <div className="mt-3 rounded-lg bg-brand-muted/50 p-2.5 ring-1 ring-brand/15">
          <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold tracking-wide text-brand uppercase">
            <Sparkles className="size-3" /> How it works
          </p>
          <p className="text-xs leading-relaxed whitespace-pre-line">{node.explanation}</p>
        </div>
      ) : (
        <p className="mt-3 rounded-lg bg-muted/60 p-2.5 text-[11px] text-muted-foreground ring-1 ring-border/50">
          No explanation yet — “Explain with AI” writes what this {LEVEL_NOUN[map.level].toLowerCase()} does, how it works and why it connects where it does.
        </p>
      )}

      {changed.length > 0 && (
        <Section title={`Changed in the selected diff (${changed.length})`}>
          <ul className="space-y-0.5">
            {changed.slice(0, 8).map((f) => (
              <li key={f}>
                <button type="button" onClick={() => onSelectFile(f)} className="block max-w-full truncate font-mono text-[11px] text-warning hover:underline" title={f}>
                  {f}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {node.keyFiles.length > 0 && (
        <Section title="Start here">
          <ul className="space-y-1">
            {node.keyFiles.map((k) => (
              <li key={k.path}>
                <button
                  type="button"
                  onClick={() => onSelectFile(k.path)}
                  className="w-full rounded-md px-1.5 py-1 text-left transition-colors hover:bg-secondary"
                  title={`${k.path} — open its module`}
                >
                  <span className="flex items-center gap-1.5 font-mono text-[11px]">
                    <Star className="size-3 shrink-0 fill-current text-warning" />
                    <span className="truncate">{k.path}</span>
                  </span>
                  <span className="mt-0.5 block pl-[18px] text-[11px] leading-snug text-muted-foreground">{k.role}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {map.level !== "architecture" && node.layers.length > 0 && (
        <Section title="Spans layers">
          <LayerBar layers={node.layers} />
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {node.layers.map((l) => (
              <li key={l.layer} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <span className="size-2 rounded-full" style={{ backgroundColor: APP_LAYERS[l.layer].color }} />
                {APP_LAYERS[l.layer].name} <span className="font-mono">{l.files}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {outgoing.length > 0 && (
        <Section title={`Depends on (${outgoing.length})`}>
          <ul className="space-y-1">
            {outgoing.map((e) => (
              <ConnectionRow
                key={e.target}
                edge={e}
                other={byId.get(e.target)}
                direction="out"
                onOpen={() => onSelect({ kind: "card", id: e.target })}
                onOpenEdge={() => onSelect({ kind: "edge", source: e.source, target: e.target })}
              />
            ))}
          </ul>
        </Section>
      )}
      {incoming.length > 0 && (
        <Section title={`Used by (${incoming.length})`}>
          <ul className="space-y-1">
            {incoming.map((e) => (
              <ConnectionRow
                key={e.source}
                edge={e}
                other={byId.get(e.source)}
                direction="in"
                onOpen={() => onSelect({ kind: "card", id: e.source })}
                onOpenEdge={() => onSelect({ kind: "edge", source: e.source, target: e.target })}
              />
            ))}
          </ul>
        </Section>
      )}

      {map.level !== "modules" && node.modules.length > 0 && (
        <Section title={`Modules (${node.modules.length})`}>
          <ul className="flex flex-wrap gap-1">
            {node.modules.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onSelectModule(m.id)}
                  className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] ring-1 ring-border/60 hover:bg-secondary"
                  title={`${m.name} — ${m.files} file${m.files === 1 ? "" : "s"} on this card`}
                >
                  <Boxes className="size-3 text-muted-foreground" /> {m.name}
                  <span className="font-mono text-[10px] text-muted-foreground">{m.files}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`All files (${node.files.length})`}>
        <ul className={cn("max-h-56 space-y-0.5 overflow-y-auto pr-1")}>
          {node.files.map((f) => (
            <li key={f}>
              <button
                type="button"
                onClick={() => onSelectFile(f)}
                className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left font-mono text-[10.5px] hover:bg-secondary"
                title={f}
              >
                <FileCode2 className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{f}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
