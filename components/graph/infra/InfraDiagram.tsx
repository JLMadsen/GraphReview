"use client";

// The Infra view's Diagram (DESIGN.md §6.16): the whiteboard picture — ways
// in on the left, the programs that run in the middle, what holds data on
// the right, the platform stacks underneath — with the selected diff painted
// on (added green, removed red and dashed, changed amber, findings ⚠).
// Edges are only the certain ones `buildInfraTopology` finds; they are drawn
// in an SVG over the columns from the nodes' measured boxes.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Database, Globe, Layers, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { ASSESSMENT_VISUALS } from "../review-visuals";
import { ToolIcon } from "../InfraView";
import { entryId, touchedNeighbourhood, type InfraTopology, type NodeState, type TopoNode } from "../infra-topology";

/** Past this many programs the diagram stops drawing and asks for a search. */
const MAX_WORKLOADS = 80;

const STATE_CLASS: Record<NodeState, string> = {
  same: "border-border",
  create: "border-success/70 bg-success/5",
  destroy: "border-destructive/70 border-dashed bg-destructive/5",
  update: "border-border border-l-[3px] border-l-warning",
  version: "border-border border-l-[3px] border-l-warning",
  moved: "border-border",
};

const STATE_WORD: Partial<Record<NodeState, [string, string]>> = {
  create: ["added", "text-success"],
  destroy: ["removed", "text-destructive"],
  update: ["changed", "text-warning"],
  version: ["new version", "text-warning"],
  moved: ["moved", "text-muted-foreground"],
};

export interface InfraDiagramProps {
  topo: InfraTopology;
  /** Only what the diff touches and its neighbours. */
  changedOnly: boolean;
  query: string;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** An entry's route clicked: follow it in Requests. */
  onOpenRoute: (host: string, path: string, workload: string) => void;
}

export function InfraDiagram({ topo, changedOnly, query, selected, onSelect, onOpenRoute }: InfraDiagramProps) {
  const q = query.trim().toLowerCase();
  const keep = useMemo(() => {
    const near = changedOnly ? touchedNeighbourhood(topo) : null;
    const match = (n: TopoNode) => !q || [n.label, n.sub, n.row.resource.file, n.row.resource.address].some((t) => t.toLowerCase().includes(q));
    return (n: TopoNode) => (!near || near.has(n.id)) && match(n);
  }, [topo, changedOnly, q]);

  const allWorkloads = topo.workloads.filter(keep);
  const workloads = allWorkloads.slice(0, MAX_WORKLOADS);
  const data = topo.data.filter(keep);
  const shownIds = new Set([...workloads, ...data].map((n) => n.id));
  const entries = topo.entries
    .map((e) => ({ ...e, routes: e.routes.filter((r) => shownIds.has(r.workload)) }))
    .filter((e) => e.routes.length > 0);
  const platform = topo.platform.filter((p) => !changedOnly || p.notable.length > 0);
  for (const e of entries) shownIds.add(entryId(e.host));
  const edges = topo.edges.filter((e) => shownIds.has(e.from) && shownIds.has(e.to));

  // Hover lights a node, its edges and its neighbours.
  const [hover, setHover] = useState<string | null>(null);
  const focus = hover ?? selected;
  const lit = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    for (const e of edges) {
      if (e.from === focus) s.add(e.to);
      if (e.to === focus) s.add(e.from);
    }
    return s;
  }, [focus, edges]);

  // Edge geometry from the nodes' boxes.
  const boxRef = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<Array<{ d: string; key: string; from: string; to: string; kind: string; bad: boolean }>>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const edgeKey = edges.map((e) => `${e.from}>${e.to}`).join("|");
  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const origin = box.getBoundingClientRect();
    const rect = (id: string) => box.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.getBoundingClientRect();
    const out: typeof paths = [];
    for (const e of edges) {
      const a = rect(e.from);
      const b = rect(e.to);
      if (!a || !b) continue;
      const target = [...topo.workloads, ...topo.data].find((n) => n.id === e.to);
      const bad = e.gone || target?.state === "destroy" || Boolean(target?.findings);
      let d: string;
      if (Math.abs(a.left - b.left) < 4) {
        // Same column (one program calling another): an arc out to the right.
        const x = a.right - origin.left;
        const y1 = a.top + a.height / 2 - origin.top;
        const y2 = b.top + b.height / 2 - origin.top;
        const bulge = 18 + Math.min(40, Math.abs(y2 - y1) / 6);
        d = `M${x} ${y1} C${x + bulge} ${y1} ${x + bulge} ${y2} ${x} ${y2}`;
      } else {
        const x1 = a.right - origin.left;
        const y1 = a.top + a.height / 2 - origin.top;
        const x2 = b.left - origin.left;
        const y2 = b.top + b.height / 2 - origin.top;
        const mid = (x1 + x2) / 2;
        d = `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
      }
      out.push({ d, key: `${e.from}>${e.to}`, from: e.from, to: e.to, kind: e.gone ? "gone" : e.kind, bad });
    }
    setPaths(out);
    setSize({ w: box.scrollWidth, h: box.scrollHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `edgeKey` stands for `edges`
  }, [edgeKey, topo]);
  useLayoutEffect(() => {
    measure();
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [measure]);

  if (workloads.length === 0 && data.length === 0 && platform.length === 0) {
    return (
      <p className="px-6 py-12 text-center text-sm text-muted-foreground">
        {changedOnly ? "This diff doesn't touch anything the diagram shows." : q ? "Nothing matches." : "No programs, data stores or stacks to draw."}
      </p>
    );
  }

  const nodeProps = (id: string) => ({
    "data-node": id,
    onMouseEnter: () => setHover(id),
    onMouseLeave: () => setHover(null),
  });
  const dim = (id: string) => lit !== null && !lit.has(id);

  const node = (n: TopoNode, icon?: React.ReactNode) => (
    <DiagramNode key={n.id} n={n} icon={icon} selected={selected === n.id} dimmed={dim(n.id)} onSelect={() => onSelect(selected === n.id ? null : n.id)} onHover={setHover} />
  );

  return (
    <div className="px-4 py-3">
      <div ref={boxRef} className="relative">
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={size.w} height={size.h} aria-hidden>
          <defs>
            <marker id="infra-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" className="fill-muted-foreground" />
            </marker>
            <marker id="infra-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" className="fill-destructive" />
            </marker>
          </defs>
          {paths.map((p) => ({ ...p, on: !focus || p.from === focus || p.to === focus })).map((p) => (
            <path
              key={p.key}
              d={p.d}
              fill="none"
              strokeWidth={p.on && lit ? 1.5 : 1}
              strokeDasharray={p.kind === "gone" ? "2 3" : p.kind === "uses" ? "4 3" : undefined}
              markerEnd={`url(#${p.bad ? "infra-arrow-bad" : "infra-arrow"})`}
              className={cn(p.bad ? "stroke-destructive" : "stroke-muted-foreground", !p.on && "opacity-15", p.on && !lit && "opacity-50")}
            />
          ))}
        </svg>

        <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,0.9fr)] gap-x-14">
          <Column title="Ways in" hint="Hosts and paths from Ingress, HTTPRoute and Traefik tags">
            {entries.length === 0 && <Empty>No routes from outside.</Empty>}
            {entries.map((e) => (
              <div key={e.host} {...nodeProps(entryId(e.host))} className={cn("rounded-md border bg-card/60 px-2.5 py-1.5 transition-opacity", STATE_CLASS[e.state ?? "same"], dim(entryId(e.host)) && "opacity-35")}>
                <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
                  <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 truncate font-mono">{e.host}</span>
                  {e.state && STATE_WORD[e.state] && <span className={cn("ml-auto shrink-0 text-[10px] font-normal", STATE_WORD[e.state]![1])}>{STATE_WORD[e.state]![0]}</span>}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {e.routes.slice(0, 6).map((r) => (
                    <li key={`${r.path}>${r.workload}`}>
                      <button
                        type="button"
                        onClick={() => onOpenRoute(e.host, r.path, r.workload)}
                        className="flex w-full min-w-0 items-center gap-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
                        title="Follow this route in Requests"
                      >
                        <span className="min-w-0 truncate font-mono">{r.path}</span>
                        {r.auth?.length ? <span className="shrink-0 text-[10px]">auth</span> : null}
                        {r.endpoints.length > 0 && <span className="ml-auto shrink-0 font-mono text-[10px]">{r.endpoints.length}</span>}
                      </button>
                    </li>
                  ))}
                  {e.routes.length > 6 && <li className="text-[11px] text-muted-foreground">+{e.routes.length - 6} more</li>}
                </ul>
              </div>
            ))}
          </Column>

          <Column title="Programs" hint="Kubernetes / Helm workloads and Nomad tasks">
            {workloads.length === 0 && <Empty>No workloads.</Empty>}
            {workloads.map((n) => node(n))}
            {allWorkloads.length > workloads.length && (
              <Empty>
                {allWorkloads.length - workloads.length} more — search to narrow.
              </Empty>
            )}
          </Column>

          <Column title="Data" hint="Resources that hold data: databases, buckets, disks, queues">
            {data.length === 0 && <Empty>Nothing that holds data.</Empty>}
            {data.map((n) => node(n, <Database className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />))}
          </Column>
        </div>
      </div>

      {platform.length > 0 && (
        <section className="mt-6">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Layers className="size-3.5" aria-hidden />
            Platform and builds
            <span className="font-normal">· Terraform stacks and Dockerfiles</span>
          </h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
            {platform.map((p) => (
              <div key={p.stack.id} className="rounded-md border border-border bg-card/40 px-2.5 py-1.5">
                <p className="flex min-w-0 items-center gap-1.5 text-xs">
                  <ToolIcon tool={p.stack.tool} />
                  <span className="min-w-0 truncate font-mono" title={p.stack.path}>
                    {p.stack.path}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground" title={`${p.resources} resources, ${p.stateful} holding data`}>
                    {p.resources}
                  </span>
                </p>
                {p.notable.length > 0 && (
                  <ul className="mt-1 space-y-1">
                    {p.notable.slice(0, 5).map((n) => (
                      <li key={n.id}>{node(n)}</li>
                    ))}
                    {p.notable.length > 5 && <li className="text-[11px] text-muted-foreground">+{p.notable.length - 5} more</li>}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>→ routes and calls (an env var naming a service)</span>
        <span>⇢ dashed: keeps data in</span>
        <span className="text-destructive">red dotted: a link this diff removes</span>
        <span className="text-success">added</span>
        <span className="text-destructive">removed</span>
        <span className="text-warning">changed</span>
        <span>Click a box for its detail</span>
      </p>
    </div>
  );
}

function DiagramNode({
  n,
  icon,
  selected,
  dimmed,
  onSelect,
  onHover,
}: {
  n: TopoNode;
  icon?: React.ReactNode;
  selected: boolean;
  dimmed: boolean;
  onSelect: () => void;
  onHover: (id: string | null) => void;
}) {
  const word = STATE_WORD[n.state];
  return (
    <button
      type="button"
      data-node={n.id}
      onMouseEnter={() => onHover(n.id)}
      onMouseLeave={() => onHover(null)}
      onClick={onSelect}
      title={`${n.row.resource.address}
${n.row.resource.file}:${n.row.resource.line}`}
      className={cn(
        "relative w-full rounded-md border bg-background px-2.5 py-1.5 text-left transition-opacity",
        STATE_CLASS[n.state],
        selected && "ring-2 ring-primary/60",
        dimmed && "opacity-35"
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {icon ?? <ToolIcon tool={n.row.resource.tool} />}
        <span className={cn("min-w-0 truncate text-xs font-medium", n.state === "destroy" && "line-through")}>{n.label}</span>
        {n.findings > 0 && <TriangleAlert className="ml-auto size-3.5 shrink-0" style={{ color: ASSESSMENT_VISUALS.concern.text }} aria-label={`${n.findings} finding(s)`} />}
      </span>
      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{n.sub}</span>
        {word && <span className={cn("ml-auto shrink-0", word[1])}>{word[0]}</span>}
      </span>
    </button>
  );
}

function Column({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1.5 text-[11px] font-medium text-muted-foreground" title={hint}>
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-muted-foreground">{children}</p>;
}
