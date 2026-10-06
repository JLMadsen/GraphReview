"use client";

// The App map's explainer (DESIGN.md §6.5), shown in the Graph tab's right
// column when a card or a connection is selected. This is where the map
// "explains itself": the AI explanation, the files to open first and why,
// which layers the card spans, every connection in and out with its verb and
// what flows along it, and the modules behind the card. Everything is a link
// back into the map (another card) or the Repo view (a module).

// The cards themselves are compact (name, description, counts), so this is
// also where a card's files live — review-flagged and changed ones first,
// with a verdict glyph and a git-style M.

import { ArrowRight, X } from "lucide-react";
import { LayerBar } from "./AppMapCard";
import { AssessmentGlyph } from "./PrMapNode";
import { Spark } from "./Spark";
import {
  APP_LAYERS,
  layerTint,
  type AppMapEdgeDTO,
  type AppMapLevel,
  type AppMapNodeDTO,
  type AppMapResponseDTO,
} from "./app-map-types";
import type { Assessment } from "./types";

export type AppMapSelection = { kind: "card"; id: string } | { kind: "edge"; source: string; target: string };

export interface AppMapPanelProps {
  map: AppMapResponseDTO;
  selection: AppMapSelection;
  changedFiles?: ReadonlySet<string>;
  /** Worst review verdict per file path. */
  fileMarkers?: ReadonlyMap<string, Assessment>;
  onSelect: (selection: AppMapSelection | null) => void;
  onSelectModule: (moduleId: string) => void;
  onSelectFile: (path: string) => void;
}

const LEVEL_NOUN: Record<AppMapLevel, string> = {
  architecture: "Layer",
  features: "Feature",
  modules: "Module",
};

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-3 border-t border-border pt-2.5">
      <h3 className="mb-1.5 text-[11px] font-medium text-muted-foreground">{title}</h3>
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
    <li className="py-1">
      <div className="flex items-center gap-1.5 text-[11px]">
        <button
          type="button"
          onClick={onOpenEdge}
          className="shrink-0 font-mono text-muted-foreground hover:text-foreground hover:underline"
          title="Show this connection"
        >
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

export function AppMapPanel({
  map,
  selection,
  changedFiles,
  fileMarkers,
  onSelect,
  onSelectModule,
  onSelectFile,
}: AppMapPanelProps) {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));

  if (selection.kind === "edge") {
    const edge = map.edges.find((e) => e.source === selection.source && e.target === selection.target);
    const from = byId.get(selection.source);
    const to = byId.get(selection.target);
    if (!edge || !from || !to) return null;
    const back = map.edges.find((e) => e.source === selection.target && e.target === selection.source);
    return (
      <div>
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">Connection</p>
          <CloseButton onClick={() => onSelect(null)} />
        </div>
        <p className="mt-0.5 flex flex-wrap items-baseline gap-1.5 text-sm font-medium">
          <button type="button" className="hover:underline" onClick={() => onSelect({ kind: "card", id: from.id })}>{from.name}</button>
          <span className="font-mono text-[11px] text-muted-foreground">{edge.label}</span>
          <button type="button" className="hover:underline" onClick={() => onSelect({ kind: "card", id: to.id })}>{to.name}</button>
        </p>
        {edge.explanation ? (
          <p className="mt-2 text-xs leading-relaxed">{edge.explanation}</p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            Derived from {edge.weight} import{edge.weight === 1 ? "" : "s"}. “Describe” on the map toolbar adds what flows along it.
          </p>
        )}
        <Section title={`Imports behind it (${edge.weight}${edge.weight > edge.samples.length ? `, showing ${edge.samples.length}` : ""})`}>
          <ul className="space-y-1.5">
            {edge.samples.map((s) => (
              <li key={`${s.from}->${s.to}`} className="font-mono text-[11px]">
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
            <button
              type="button"
              className="text-foreground underline-offset-2 hover:underline"
              onClick={() => onSelect({ kind: "edge", source: back.source, target: back.target })}
            >
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
  const layer = APP_LAYERS[node.layer];
  const keyRole = new Map(node.keyFiles.map((k) => [k.path, k.role]));
  // Files worth a look first: flagged by the review, then changed, then the key files, then the rest.
  const rank = (f: string) =>
    (fileMarkers?.has(f) && fileMarkers.get(f) !== "ok" ? 0 : 4) +
    (changedFiles?.has(f) ? 0 : 2) +
    (keyRole.has(f) ? 0 : 1);
  const files = [...node.files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  return (
    <div>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-2.5 w-[3px] rounded-sm" style={{ backgroundColor: layerTint(node.layer) }} />
            {LEVEL_NOUN[map.level]}
            {map.level !== "architecture" && ` · mostly ${layer.name}`}
          </p>
          <p className="mt-0.5 text-sm font-medium">{node.name}</p>
        </div>
        <CloseButton onClick={() => onSelect(null)} />
      </div>
      {node.description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{node.description}</p>}

      {node.explanation ? (
        <Section title={<>How it works <Spark className="ml-0.5" /></>}>
          <p className="text-xs leading-relaxed whitespace-pre-line">{node.explanation}</p>
        </Section>
      ) : (
        <p className="mt-3 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
          Not described yet — “Describe” on the map toolbar writes what this {LEVEL_NOUN[map.level].toLowerCase()} does, how it
          works and why it connects where it does.
        </p>
      )}

      <Section title={`Files (${node.files.length})`}>
        <ul className="max-h-72 overflow-y-auto pr-1">
          {files.map((f) => {
            const role = keyRole.get(f);
            const intent = fileMarkers?.get(f);
            return (
              <li key={f}>
                <button
                  type="button"
                  onClick={() => onSelectFile(f)}
                  className="w-full rounded-sm px-1 py-0.5 text-left hover:bg-secondary"
                  title={`${f} — open the file`}
                >
                  <span className="flex items-center gap-1.5 font-mono text-[11px]">
                    <span className="min-w-0 flex-1 truncate">{f}</span>
                    {role && <span className="shrink-0 text-muted-foreground">key</span>}
                    {intent && <AssessmentGlyph intent={intent} />}
                    {changedFiles?.has(f) && (
                      <span className="w-2.5 shrink-0 text-center font-medium text-warning" title="Changed in the selected diff">
                        M
                      </span>
                    )}
                  </span>
                  {role && <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{role}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </Section>

      {outgoing.length > 0 && (
        <Section title={`Depends on (${outgoing.length})`}>
          <ul>
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
          <ul>
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

      {map.level !== "architecture" && node.layers.length > 1 && (
        <Section title="Spans layers">
          <LayerBar layers={node.layers} />
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {node.layers.map((l) => (
              <li key={l.layer} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <span className="h-2.5 w-[3px] rounded-sm" style={{ backgroundColor: layerTint(l.layer) }} />
                {APP_LAYERS[l.layer].name} <span className="font-mono">{l.files}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {map.level !== "modules" && node.modules.length > 0 && (
        <Section title={`Modules (${node.modules.length})`}>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {node.modules.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onSelectModule(m.id)}
                  className="text-[11px] underline-offset-2 hover:underline"
                  title={`${m.name} — ${m.files} file${m.files === 1 ? "" : "s"} on this card`}
                >
                  {m.name} <span className="font-mono text-muted-foreground">{m.files}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
      aria-label="Close"
    >
      <X className="size-3.5" />
    </button>
  );
}
