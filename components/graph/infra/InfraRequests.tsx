"use client";

// The Infra view's Requests (DESIGN.md §6.16): pick a way in — a host and
// path, or one endpoint under it — and follow it hop by hop: DNS, the route,
// the program that runs it, the Dockerfile and code it ships, the settings
// that code needs, the services it calls and where it keeps data. Each hop
// names the file that sets it up, and the selected diff is painted on.

import { useEffect, useMemo } from "react";
import { ArrowRight, Boxes, CircleAlert, Code, Container, Database, DoorOpen, Globe, Server, Variable } from "lucide-react";
import { cn } from "cn";
import { buildJourney, type InfraTopology, type JourneyEndpoint, type JourneyHop } from "../infra-topology";
import type { InfraRow } from "../infra-view-model";
import type { InfraCatalog, InfraRouteLink } from "../infra-types";

export interface RouteRef {
  host: string;
  path: string;
  workload: string;
  /** An endpoint under the route, to narrow the code hop. */
  endpoint?: string;
}

export interface InfraRequestsProps {
  topo: InfraTopology;
  catalog: InfraCatalog | null;
  rows: InfraRow[];
  endpoints: JourneyEndpoint[];
  changedOnly: boolean;
  query: string;
  route: RouteRef | null;
  onRouteChange: (route: RouteRef) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onOpenFile: (path: string, line?: number) => void;
}

type Route = InfraRouteLink & { workload: string; host: string };

const ICONS: Record<JourneyHop["kind"], React.ComponentType<{ className?: string }>> = {
  dns: Globe,
  route: DoorOpen,
  workload: Server,
  build: Container,
  code: Code,
  env: Variable,
  calls: Boxes,
  data: Database,
};

const TONE = {
  plain: { dot: "bg-secondary text-muted-foreground", text: "" },
  good: { dot: "bg-success/15 text-success", text: "" },
  warn: { dot: "bg-warning/15 text-warning", text: "text-warning" },
  bad: { dot: "bg-destructive/15 text-destructive", text: "text-destructive" },
} as const;

const STATE_WORD: Record<string, string> = { create: "added", destroy: "removed", update: "changed", version: "new version", moved: "moved" };

export function InfraRequests({ topo, catalog, rows, endpoints, changedOnly, query, route, onRouteChange, selected, onSelect, onOpenFile }: InfraRequestsProps) {
  const routes = useMemo(() => topo.entries.flatMap((e) => e.routes.map((r) => ({ ...r, host: e.host }) as Route)), [topo]);
  const journeys = useMemo(() => new Map(routes.map((r) => [key(r), buildJourney(topo, catalog, rows, { ...r, host: r.host === "(any host)" ? undefined : r.host })])), [routes, topo, catalog, rows]);
  const endpointsById = useMemo(() => new Map(endpoints.map((e) => [e.id, e])), [endpoints]);

  const touched = (r: Route) => journeys.get(key(r))?.some((h) => h.tone !== "plain" && h.tone !== "good") ?? false;
  const q = query.trim().toLowerCase();
  const visible = routes.filter(
    (r) =>
      (!changedOnly || touched(r)) &&
      (!q || `${r.host}${r.path}`.toLowerCase().includes(q) || r.endpoints.some((id) => (endpointsById.get(id)?.path ?? id).toLowerCase().includes(q)))
  );

  const current = visible.find((r) => route && r.host === route.host && r.path === route.path && r.workload === route.workload) ?? visible[0] ?? null;
  useEffect(() => {
    if (current && (!route || route.host !== current.host || route.path !== current.path || route.workload !== current.workload)) {
      onRouteChange({ host: current.host, path: current.path, workload: current.workload });
    }
  }, [current, route, onRouteChange]);

  const endpoint = route?.endpoint ? endpointsById.get(route.endpoint) : undefined;
  const hops = useMemo(
    () => (current ? (endpoint ? buildJourney(topo, catalog, rows, { ...current, host: current.host === "(any host)" ? undefined : current.host }, endpoint) : journeys.get(key(current)) ?? []) : []),
    [current, endpoint, topo, catalog, rows, journeys]
  );

  if (routes.length === 0) {
    return (
      <p className="mx-auto max-w-md px-6 py-12 text-center text-sm text-muted-foreground">
        No ways in to follow: no Ingress, HTTPRoute or Traefik-tagged service points at a program here.
      </p>
    );
  }
  if (visible.length === 0) {
    return <p className="px-6 py-12 text-center text-sm text-muted-foreground">{changedOnly ? "This diff doesn't affect any request path." : "No routes match."}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Ways in" className="w-64 shrink-0 overflow-y-auto border-r border-border py-1.5">
        {visible.map((r) => {
          const active = current && key(current) === key(r);
          const bad = touched(r);
          return (
            <div key={key(r)}>
              <button
                type="button"
                onClick={() => onRouteChange({ host: r.host, path: r.path, workload: r.workload })}
                className={cn("flex w-full min-w-0 items-center gap-1.5 px-3 py-1 text-left hover:bg-secondary/50", active && !route?.endpoint && "bg-secondary")}
                title={`${r.host}${r.path} → ${r.via}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px]">{r.path}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">{r.host}</span>
                </span>
                {bad && <CircleAlert className="size-3 shrink-0 text-warning" aria-label="Affected by this diff" />}
                {r.endpoints.length > 0 && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{r.endpoints.length}</span>}
              </button>
              {active && r.endpoints.length > 0 && (
                <ul className="pb-1">
                  {r.endpoints.slice(0, 40).map((id) => {
                    const e = endpointsById.get(id);
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() => onRouteChange({ host: r.host, path: r.path, workload: r.workload, endpoint: route?.endpoint === id ? undefined : id })}
                          className={cn("block w-full truncate py-0.5 pr-3 pl-6 text-left font-mono text-[10px] text-muted-foreground hover:text-foreground", route?.endpoint === id && "bg-secondary text-foreground")}
                        >
                          {e ? `${e.method} ${e.path}` : id.replace(/^http /, "")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-4">
        {current && (
          <p className="mb-4 flex min-w-0 items-center gap-2 text-sm">
            <span className="font-medium">Following</span>
            <span className="min-w-0 truncate font-mono text-xs">
              {endpoint ? `${endpoint.method} ` : ""}
              {/^(LoadBalancer|NodePort) /.test(current.host)
                ? `${current.host}${endpoint ? ` ${endpoint.path}` : ""}`
                : `${current.host === "(any host)" ? "" : current.host}${endpoint ? endpoint.path : current.path}`}
            </span>
          </p>
        )}
        <ol>
          {hops.map((h, i) => (
            <Hop key={i} hop={h} last={i === hops.length - 1} selected={selected} onSelect={onSelect} onOpenFile={onOpenFile} />
          ))}
        </ol>
      </div>
    </div>
  );
}

const key = (r: { host: string; path: string; workload: string }) => `${r.host}${r.path}>${r.workload}`;

function Hop({
  hop,
  last,
  selected,
  onSelect,
  onOpenFile,
}: {
  hop: JourneyHop;
  last: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const Icon = ICONS[hop.kind];
  const tone = TONE[hop.tone];
  return (
    <li className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3 pb-4">
      {!last && <span className="absolute top-7 bottom-0 left-[13.5px] border-l border-border" aria-hidden />}
      <span className={cn("flex size-7 items-center justify-center rounded-full", tone.dot)}>
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 pt-1">
        <HopLine hop={hop} selected={selected} onSelect={onSelect} onOpenFile={onOpenFile} />
        {hop.children && (
          <ul className="mt-1.5 space-y-1.5">
            {hop.children.map((c, i) => (
              <li key={i} className="flex min-w-0 items-start gap-1.5">
                <ArrowRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <HopLine hop={c} selected={selected} onSelect={onSelect} onOpenFile={onOpenFile} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function HopLine({ hop, selected, onSelect, onOpenFile }: { hop: JourneyHop; selected: string | null; onSelect: (id: string | null) => void; onOpenFile: (path: string, line?: number) => void }) {
  const tone = TONE[hop.tone];
  const word = hop.state && hop.state !== "same" ? STATE_WORD[hop.state] : undefined;
  return (
    <div className="min-w-0">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        {hop.resource ? (
          <button
            type="button"
            onClick={() => onSelect(selected === hop.resource ? null : hop.resource!)}
            className={cn("text-left text-[13px] font-medium hover:underline", tone.text, selected === hop.resource && "underline")}
          >
            {hop.title}
          </button>
        ) : (
          <span className={cn("text-[13px] font-medium", tone.text)}>{hop.title}</span>
        )}
        {word && <span className={cn("text-[11px]", tone.text || "text-muted-foreground")}>{word}</span>}
        {hop.file && (
          <button type="button" onClick={() => onOpenFile(hop.file!, hop.line)} className="ml-auto font-mono text-[10px] text-muted-foreground hover:text-foreground">
            {hop.file}
            {hop.line ? `:${hop.line}` : ""}
          </button>
        )}
      </p>
      {hop.detail && <p className="text-xs text-muted-foreground">{hop.detail}</p>}
    </div>
  );
}
