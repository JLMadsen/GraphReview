"use client";

// The PR map's Endpoints mode (DESIGN.md §6.11): every endpoint the diff
// touches as a card on the left — new, removed, changed or reached — drawn
// into the area cards that hold its handler ("handled in") or the changed
// code it calls ("reaches fn"). Answers "which parts of the API does this
// PR affect, and through what?" at a glance. Clicking an endpoint opens it
// in the right column; clicking an area selects it, as in Files mode.

import { useCallback, useMemo } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "cn";
import { CardFlow, type CardFlowLink } from "./CardFlow";
import { PR_CARD_WIDTH, PrMapCard } from "./PrMapNode";
import { EndpointPath, MethodBadge } from "./ApiView";
import { CHANGE_STYLES, areasOfChange } from "./api-view-model";
import type { ApiChange, EndpointChange } from "./api-types";
import type { PrAreas } from "./pr-areas";
import type { PrMapResponseDTO } from "./pr-map-types";
import { VIEW_CANVAS } from "./view-chrome";

const EP = "ep:";

function EndpointCard({ change, selected, dimmed }: { change: EndpointChange; selected: boolean; dimmed: boolean }) {
  const style = CHANGE_STYLES[change.status];
  const e = change.endpoint;
  return (
    <div
      style={{ width: PR_CARD_WIDTH }}
      className={cn(
        "rounded-md border bg-card px-3 py-2 text-left transition-[opacity,border-color,box-shadow]",
        change.breaking ? "border-destructive/50" : "border-foreground/14",
        selected && "border-brand shadow-[0_0_0_4px_color-mix(in_oklab,var(--brand)_18%,transparent)]",
        dimmed && !selected && "opacity-50"
      )}
    >
      <p className="amc-desc flex items-center gap-1.5 font-mono text-[10px]">
        <span className={style.className}>{style.word}</span>
        {change.breaking && <span className="text-destructive">· breaking</span>}
        {e.internal && <span className="text-muted-foreground">· internal</span>}
      </p>
      <p className="amc-name mt-0.5 flex min-w-0 items-baseline gap-1.5">
        <MethodBadge method={e.method} />
        <EndpointPath path={e.path} partial={e.partial} className={cn("text-[12px]", change.status === "removed" && "line-through")} />
      </p>
      {change.deltas.length > 0 && (
        <p className="amc-status mt-0.5 truncate text-[11px] text-muted-foreground">{[...new Set(change.deltas.map((d) => d.aspect))].join(", ")}</p>
      )}
    </div>
  );
}

export function EndpointMapCanvas({
  map,
  areas,
  change,
  pending,
  selectedEndpointId,
  onSelectEndpoint,
  selectedCardId,
  onSelectCard,
}: {
  map: PrMapResponseDTO | null;
  areas: PrAreas;
  change: ApiChange | undefined;
  pending: boolean;
  selectedEndpointId: string | null;
  onSelectEndpoint: (id: string | null) => void;
  selectedCardId: string | null;
  onSelectCard: (id: string | null) => void;
}) {
  const { cardIds, links, changeById } = useMemo(() => {
    const changeById = new Map<string, EndpointChange>();
    const links: CardFlowLink[] = [];
    const areaIds = new Set<string>();
    if (map && change) {
      for (const c of change.changes) {
        changeById.set(`${EP}${c.id}`, c);
        for (const { areaId, via, fn } of areasOfChange(map, c)) {
          areaIds.add(areaId);
          links.push({ source: `${EP}${c.id}`, target: areaId, label: via === "handler" ? "handled in" : `reaches ${fn?.split(".").pop() ?? ""}`, weight: 1, tone: via === "handler" && c.status === "added" ? "new" : undefined });
        }
      }
    }
    const areaOrder = map?.nodes.filter((n) => areaIds.has(n.id)).map((n) => n.id) ?? [];
    return { cardIds: [...changeById.keys(), ...areaOrder], links, changeById };
  }, [map, change]);

  const highlighted = useMemo(() => {
    const out = new Set<string>();
    if (selectedEndpointId) {
      out.add(`${EP}${selectedEndpointId}`);
      for (const l of links) if (l.source === `${EP}${selectedEndpointId}`) out.add(l.target);
    } else if (selectedCardId) {
      out.add(selectedCardId);
      for (const l of links) if (l.target === selectedCardId) out.add(l.source);
    }
    return out;
  }, [selectedEndpointId, selectedCardId, links]);
  const focused = Boolean(selectedEndpointId || selectedCardId);

  const renderCard = useCallback(
    (id: string) => {
      const c = changeById.get(id);
      if (c) return <EndpointCard change={c} selected={c.id === selectedEndpointId} dimmed={focused && !highlighted.has(id)} />;
      const node = map?.nodes.find((n) => n.id === id);
      return node ? <PrMapCard node={node} area={areas.areas.get(id)} selected={id === selectedCardId} dimmed={focused && !highlighted.has(id)} /> : null;
    },
    [changeById, map, areas, selectedEndpointId, selectedCardId, focused, highlighted]
  );
  const layoutKey = useMemo(() => JSON.stringify([cardIds, links.map((l) => [l.source, l.target])]), [cardIds, links]);

  return (
    <CardFlow
      className={VIEW_CANVAS}
      cardIds={cardIds}
      cardWidth={PR_CARD_WIDTH}
      renderCard={renderCard}
      links={links}
      highlighted={highlighted}
      layoutKey={layoutKey}
      onCardClick={(id) => {
        if (id.startsWith(EP)) {
          const endpointId = id.slice(EP.length);
          onSelectEndpoint(endpointId === selectedEndpointId ? null : endpointId);
        } else onSelectCard(id === selectedCardId ? null : id);
      }}
      onPaneClick={() => {
        onSelectEndpoint(null);
        onSelectCard(null);
      }}
    >
      {!change && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          {pending ? (
            <>
              <LoaderCircle className="size-4 animate-spin" aria-hidden /> Comparing the API of base and head…
            </>
          ) : (
            "The API comparison isn't available for this diff."
          )}
        </div>
      )}
      {change && change.changes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
          This diff touches none of the {change.total} endpoint{change.total === 1 ? "" : "s"} — no handler changed, and none calls changed code.
        </div>
      )}
    </CardFlow>
  );
}
