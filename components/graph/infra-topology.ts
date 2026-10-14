// The Infra view's Diagram and Requests sub-views (DESIGN.md §6.16): the
// catalog reshaped as "what talks to what" — the ways in (routes, by host),
// the programs that run (workloads), the things that hold data, and the
// platform stacks around them — with the selected diff's plan laid over it.
//
// Edges carry how they were found, and only certain ones are drawn:
//   route    a route's workload (`workload.routes`, Ingress/HTTPRoute → Service → workload)
//   uses     a workload's refs to a stateful resource (a PVC, a volume), directly or through one Service
//   calls    a workload's env value names another workload's Service, Nomad service or workload
//            (`CART_ADDR=cartservice:7070`), or a stateful one (`REDIS_ADDR=redis-cart:6379`)
// Nothing is evaluated; Terraform outputs wired into Kubernetes by a CI step stay unlinked.

import type { InfraCatalog, InfraResource, InfraRouteLink, InfraStack } from "./infra-types";
import type { InfraRow } from "./infra-view-model";

export type NodeState = "same" | "create" | "destroy" | "update" | "moved" | "version";

export interface TopoNode {
  id: string;
  row: InfraRow;
  label: string;
  /** Second line: copies, image, tool. */
  sub: string;
  state: NodeState;
  findings: number;
}

export interface TopoEntry {
  /** `shop.example.com`, or `(any host)`. */
  host: string;
  routes: Array<InfraRouteLink & { workload: string }>;
  /** What the diff does to the resource that makes it a way in (a LoadBalancer / NodePort Service). */
  state?: NodeState;
}

export interface TopoEdge {
  from: string;
  to: string;
  kind: "route" | "uses" | "calls";
  /** Why it is drawn: `env CART_ADDR`, `volume`, `Ingress web`. */
  via: string;
  /** The diff removes it: the workload's base version had it, its head doesn't. */
  gone?: true;
}

export interface TopoPlatform {
  stack: InfraStack;
  resources: number;
  stateful: number;
  /** Its changed resources and those with findings, for the diagram's stack card. */
  notable: TopoNode[];
}

export interface InfraTopology {
  entries: TopoEntry[];
  workloads: TopoNode[];
  data: TopoNode[];
  platform: TopoPlatform[];
  edges: TopoEdge[];
}

export const entryId = (host: string) => `entry:${host}`;
const ANY_HOST = "(any host)";

export function nodeState(row: InfraRow): NodeState {
  return row.change?.action ?? "same";
}

function shortName(r: InfraResource): string {
  if (r.tool === "nomad") return r.address;
  return r.name || r.address.replace(/^.*\//, "");
}

function workloadSub(r: InfraResource): string {
  const parts: string[] = [];
  if (r.count !== undefined) parts.push(r.count === "1" ? "1 copy" : `${r.count === "?" ? "?" : r.count} copies`);
  const img = r.workload?.images[0];
  if (img) parts.push(img.replace(/^.*\//, "").replace(/@sha256:([0-9a-f]{8})[0-9a-f]*/, "@$1"));
  return parts.join(" · ") || r.kind;
}

/** Host part of an env value: `http://cart:7070/x` → `cart`, `redis-cart.default.svc:6379` → `redis-cart`. */
export function envHost(value: string): string | undefined {
  const m = value.trim().match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([a-z0-9][a-z0-9-]*)(?:\.[a-z0-9.-]+)?(?::\d+)?(?:\/.*)?$/i);
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * Stacks that declare programs — one repo often declares the same ones
 * several times (plain manifests, a Kustomize base, a Helm chart), so the
 * diagram shows one set at a time. Ordered: touched by the diff, then
 * not templated (a Helm chart's links can't be read before it's rendered),
 * then most programs.
 */
export function deploySets(rows: InfraRow[]): Array<{ stack: string; workloads: number; touched: boolean; templated: boolean }> {
  const by = new Map<string, { stack: string; workloads: number; touched: boolean; templated: boolean }>();
  for (const r of rows) {
    if (!r.resource.workload) continue;
    const e = by.get(r.resource.stack) ?? by.set(r.resource.stack, { stack: r.resource.stack, workloads: 0, touched: false, templated: true }).get(r.resource.stack)!;
    e.workloads++;
    if (!r.resource.templated) e.templated = false;
    if (r.change || r.findings.length) e.touched = true;
  }
  return [...by.values()].sort(
    (a, b) => Number(b.touched) - Number(a.touched) || Number(a.templated) - Number(b.templated) || b.workloads - a.workloads || a.stack.localeCompare(b.stack)
  );
}

/** `deploySet`: only the programs (and their routes) of that stack; null for all of them. */
export function buildInfraTopology(catalog: InfraCatalog | null, rows: InfraRow[], deploySet: string | null = null): InfraTopology {
  const byId = new Map(rows.map((r) => [r.resource.id, r]));
  const node = (row: InfraRow, sub?: string): TopoNode => ({
    id: row.resource.id,
    row,
    label: shortName(row.resource),
    sub: sub ?? workloadSub(row.resource),
    state: nodeState(row),
    findings: row.findings.length,
  });

  const workloadRows = rows.filter((r) => r.resource.workload && (!deploySet || r.resource.stack === deploySet));
  const otherSets = new Set(rows.filter((r) => r.resource.workload && deploySet && r.resource.stack !== deploySet).map((r) => r.resource.stack));
  const workloads = workloadRows.map((r) => node(r));
  const workloadIds = new Set(workloads.map((w) => w.id));

  const dataRows = rows.filter((r) => r.resource.stateful && !r.resource.external && !r.resource.workload && !otherSets.has(r.resource.stack));
  const data = dataRows.map((r) => node(r, `${r.resource.kind}${r.resource.tool === "terraform" ? "" : ` · ${r.resource.tool}`}`));
  const dataIds = new Set(data.map((d) => d.id));

  const edges: TopoEdge[] = [];
  const seen = new Set<string>();
  const edge = (e: TopoEdge) => {
    const key = `${e.from}>${e.to}`;
    if (e.from === e.to || seen.has(key)) return;
    seen.add(key);
    edges.push(e);
  };

  // Ways in: the catalog's route links (they carry endpoints), else the workload's own routes.
  const hosts = new Map<string, TopoEntry>();
  const addRoute = (route: InfraRouteLink, workload: string) => {
    const host = route.host || ANY_HOST;
    const entry = hosts.get(host) ?? hosts.set(host, { host, routes: [] }).get(host)!;
    if (!entry.routes.some((x) => x.path === route.path && x.workload === workload)) entry.routes.push({ ...route, workload });
    edge({ from: entryId(host), to: workload, kind: "route", via: route.via });
  };
  for (const link of catalog?.links.routes ?? []) if (workloadIds.has(link.resource)) addRoute(link, link.resource);
  for (const w of workloadRows) {
    for (const route of w.resource.workload!.routes) {
      if (!(catalog?.links.routes ?? []).some((l) => l.resource === w.resource.id && l.path === route.path && l.host === route.host)) {
        addRoute({ resource: w.resource.id, path: route.path, via: route.via, endpoints: [], ...(route.host ? { host: route.host } : {}), ...(route.auth ? { auth: route.auth } : {}) }, w.resource.id);
      }
    }
  }
  // A Service of type LoadBalancer / NodePort is a way in too, with no host or path.
  for (const r of rows) {
    const res = r.resource;
    const type = res.category === "service" ? res.attributes.find((a) => a.name === "spec.type")?.value : undefined;
    if (type !== "LoadBalancer" && type !== "NodePort") continue;
    for (const target of res.refs.filter((id) => workloadIds.has(id))) {
      addRoute({ resource: target, host: `${type} ${res.name}`, path: "/", via: `Service ${res.name} (${type})`, endpoints: catalog?.links.routes.find((l) => l.resource === target)?.endpoints ?? [] }, target);
      const state = nodeState(r);
      if (state !== "same") hosts.get(`${type} ${res.name}`)!.state = state;
    }
  }
  const entries = [...hosts.values()].sort((a, b) => Number(a.host === ANY_HOST) - Number(b.host === ANY_HOST) || a.host.localeCompare(b.host));

  // Names other workloads reach a workload or a data store by: the workload's own name, the Services that select it.
  const reachBy = new Map<string, string>();
  const nameFor = (name: string, target: string) => {
    const key = name.toLowerCase();
    if (!reachBy.has(key)) reachBy.set(key, target);
  };
  for (const r of rows) {
    const res = r.resource;
    if (res.category === "service" && !otherSets.has(res.stack)) {
      const target = res.refs.find((id) => workloadIds.has(id) || dataIds.has(id));
      if (target) nameFor(res.name, target);
    }
  }
  for (const w of workloadRows) {
    nameFor(w.resource.name, w.resource.id);
    if (w.resource.tool === "nomad") {
      // Nomad services are named in the task's attributes (`service.<name>.…`) — the task name stands in for them.
      for (const a of w.resource.attributes) {
        const m = a.name.match(/^service\.([^.]+)\./);
        if (m) nameFor(m[1], w.resource.id);
      }
    }
  }
  for (const d of dataRows) nameFor(d.resource.name, d.resource.id);

  for (const w of workloadRows) {
    const res = w.resource;
    // uses: refs to stateful resources, directly or one hop through a Service.
    for (const ref of res.refs) {
      if (dataIds.has(ref)) edge({ from: res.id, to: ref, kind: "uses", via: byId.get(ref)?.resource.kind ?? "ref" });
    }
    // calls: env values that name another workload or a data store.
    for (const [name, value] of Object.entries(res.workload!.env)) {
      const host = envHost(value);
      const target = host ? reachBy.get(host) : undefined;
      if (target && target !== res.id) edge({ from: res.id, to: target, kind: dataIds.has(target) ? "uses" : "calls", via: `env ${name}` });
    }
  }
  // Links the diff removes: env values the workload's base version had that its head no longer does.
  for (const w of workloadRows) {
    const before = w.change?.before?.workload?.env;
    if (!before) continue;
    for (const [name, value] of Object.entries(before)) {
      if (w.resource.workload!.env[name] === value) continue;
      const host = envHost(value);
      const target = host ? reachBy.get(host) : undefined;
      if (target && target !== w.resource.id && !seen.has(`${w.resource.id}>${target}`)) {
        edge({ from: w.resource.id, to: target, kind: dataIds.has(target) ? "uses" : "calls", via: `env ${name} — no longer set`, gone: true });
      }
    }
  }

  // Platform: Terraform stacks, and Dockerfiles the diff changes.
  const shown = new Set([...workloadIds, ...dataIds]);
  const platform: TopoPlatform[] = [];
  const stacks = new Map((catalog?.stacks ?? []).map((s) => [s.id, s]));
  const byStack = new Map<string, InfraRow[]>();
  for (const r of rows) (byStack.get(r.resource.stack) ?? byStack.set(r.resource.stack, []).get(r.resource.stack)!).push(r);
  for (const [stackId, list] of byStack) {
    const stack = stacks.get(stackId) ?? { id: stackId, tool: list[0].resource.tool, path: stackId.replace(/^[a-z0-9]+:/, ""), name: stackId, kind: "", environments: [] };
    if (stack.tool !== "terraform" && stack.tool !== "docker") continue;
    const notable = list.filter((r) => !shown.has(r.resource.id) && (r.change || r.findings.length) && r.resource.category !== "image").map((r) => node(r, r.resource.kind));
    // Dockerfiles are the programs' builds: a card only when the diff touches one.
    if (stack.tool === "docker" && notable.length === 0) continue;
    platform.push({ stack, resources: list.length, stateful: list.filter((r) => r.resource.stateful).length, notable });
  }
  platform.sort((a, b) => Number(b.notable.length > 0) - Number(a.notable.length > 0) || a.stack.tool.localeCompare(b.stack.tool) || a.stack.path.localeCompare(b.stack.path));

  const byLabel = (a: TopoNode, b: TopoNode) => a.label.localeCompare(b.label);
  return { entries, workloads: workloads.sort(byLabel), data: data.sort(byLabel), platform, edges };
}

/** The nodes a diff touches, plus their direct neighbours — the diagram's "only what changed". */
export function touchedNeighbourhood(topo: InfraTopology): Set<string> {
  const hit = new Set<string>();
  for (const n of [...topo.workloads, ...topo.data]) if (n.state !== "same" || n.findings) hit.add(n.id);
  // A changed way in (a new LoadBalancer Service) keeps the programs it reaches.
  for (const e of topo.entries) if (e.state && e.state !== "same") hit.add(entryId(e.host));
  const out = new Set(hit);
  for (const e of topo.edges) {
    if (hit.has(e.from)) out.add(e.to);
    if (hit.has(e.to)) out.add(e.from);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Requests: one way in, followed hop by hop
// ---------------------------------------------------------------------------

export interface JourneyHop {
  kind: "dns" | "route" | "workload" | "build" | "code" | "env" | "calls" | "data";
  title: string;
  detail?: string;
  tone: "plain" | "good" | "warn" | "bad";
  /** A resource the hop is about — opens its detail. */
  resource?: string;
  file?: string;
  line?: number;
  state?: NodeState;
  /** For `calls` / `data`: one hop per target. */
  children?: JourneyHop[];
}

export interface JourneyEndpoint {
  id: string;
  method: string;
  path: string;
  handler?: { file: string; startLine: number; name: string };
}

const hopState = (row: InfraRow | undefined): Pick<JourneyHop, "state" | "tone"> => {
  const state = row ? nodeState(row) : "same";
  return { state, tone: row?.findings.length || state === "destroy" ? "bad" : state === "same" || state === "moved" ? "plain" : "warn" };
};

/**
 * Follow a route to its workload, the code it runs and what that code
 * needs. `endpoint` narrows the code hop to one handler.
 */
export function buildJourney(
  topo: InfraTopology,
  catalog: InfraCatalog | null,
  rows: InfraRow[],
  route: InfraRouteLink & { workload: string },
  endpoint?: JourneyEndpoint
): JourneyHop[] {
  const byId = new Map(rows.map((r) => [r.resource.id, r]));
  const hops: JourneyHop[] = [];
  const wRow = byId.get(route.workload);
  const w = wRow?.resource;

  const publicService = route.host?.match(/^(LoadBalancer|NodePort) (.+)$/);
  // DNS: a Terraform record whose attributes name the host.
  if (route.host && !publicService) {
    const dns = rows.find(
      (r) => r.resource.tool === "terraform" && r.resource.category === "resource" && /(dns|record)/.test(r.resource.kind) && r.resource.attributes.some((a) => a.value.replace(/\.$/, "").includes(route.host!))
    );
    if (dns) hops.push({ kind: "dns", title: `${route.host} points here`, detail: dns.resource.address, resource: dns.resource.id, file: dns.resource.file, line: dns.resource.line, ...hopState(dns) });
  }

  const viaName = route.via.replace(/ \(.*\)$/, "");
  const routeRes = rows.find(
    (r) => (r.resource.category === "route" || r.resource.category === "service") && r.resource.stack === wRow?.resource.stack && viaName.endsWith(` ${r.resource.name}`)
  );
  hops.push({
    kind: "route",
    title: publicService
      ? `Traffic comes in at ${publicService[1] === "LoadBalancer" ? "a public load balancer address" : "a port on every machine"} (Service ${publicService[2]})`
      : `${route.host ?? "Any host"}${route.path} comes in through ${route.via}`,
    detail: route.auth?.length ? `Behind ${route.auth.join(", ")}.` : "No auth on the route itself.",
    ...(routeRes ? { resource: routeRes.resource.id, file: routeRes.resource.file, line: routeRes.resource.line } : {}),
    ...hopState(routeRes),
  });

  if (!w || !wRow) return hops;
  const port = catalog?.links.ports.find((p) => p.resource === w.id);
  hops.push({
    kind: "workload",
    title: `${shortName(w)} runs it${w.count !== undefined ? ` — ${w.count === "1" ? "1 copy" : `${w.count} copies`}` : ""}`,
    detail: port
      ? port.listen === undefined
        ? `Traffic goes to port ${port.declared}.`
        : port.match
          ? `Port ${port.declared}, and the code listens on ${port.listen}.`
          : `Port ${port.declared}, but the code listens on ${port.listen} (${port.file}:${port.line}).`
      : `${w.kind} in ${w.file}.`,
    resource: w.id,
    file: w.file,
    line: w.line,
    ...hopState(wRow),
    ...(port && port.listen !== undefined && !port.match ? { tone: "warn" as const } : {}),
  });

  const deploy = catalog?.links.deploys.find((d) => d.resource === w.id);
  if (deploy?.resolved) {
    const stage = deploy.dockerfile ? rows.find((r) => r.resource.tool === "docker" && r.resource.file === deploy.dockerfile && r.change) : undefined;
    hops.push({
      kind: "build",
      title: `Built from ${deploy.dockerfile ?? deploy.folders.join(", ")}`,
      detail: `Ships the code in ${deploy.folders.map((f) => f || "the repo root").join(", ")} · linked by ${deploy.via}.`,
      ...(deploy.dockerfile ? { file: deploy.dockerfile, line: 1 } : {}),
      ...(stage ? { resource: stage.resource.id, ...hopState(stage) } : { tone: "plain" as const }),
    });
  } else {
    hops.push({ kind: "build", title: "Which code runs here couldn't be told", detail: deploy?.via ?? "No image to follow.", tone: "warn" });
  }

  if (endpoint?.handler) {
    hops.push({ kind: "code", title: `${endpoint.method} ${endpoint.path} is handled by ${endpoint.handler.name}`, file: endpoint.handler.file, line: endpoint.handler.startLine, tone: "plain" });
  } else if (route.endpoints.length) {
    hops.push({ kind: "code", title: `Serves ${route.endpoints.length} endpoint${route.endpoints.length === 1 ? "" : "s"} under ${route.path}`, tone: "plain" });
  }

  const env = catalog?.links.env.find((e) => e.resource === w.id);
  if (env) {
    if (env.readNotSet.length) {
      const first = env.readNotSet[0];
      hops.push({ kind: "env", title: `Needs ${env.readNotSet.map((e) => e.name).join(", ")} — nothing sets ${env.readNotSet.length === 1 ? "it" : "them"}`, file: first.file, line: first.line, tone: "bad" });
    } else if (env.set.length) {
      hops.push({ kind: "env", title: `Gets the ${env.set.length} setting${env.set.length === 1 ? "" : "s"} its code reads`, detail: env.maybe.length ? `Some may come from ${env.maybe.join(", ")}.` : undefined, tone: "good" });
    }
  }
  for (const f of wRow.findings) if (f.rule === "env-unset" && !hops.some((h) => h.kind === "env" && h.tone === "bad")) hops.push({ kind: "env", title: f.summary, file: f.file, line: f.line, tone: "bad" });

  const nodes = new Map([...topo.workloads, ...topo.data].map((n) => [n.id, n]));
  const out = topo.edges.filter((e) => e.from === w.id && e.kind !== "route");
  const toHop = (e: TopoEdge): JourneyHop => {
    const n = nodes.get(e.to)!;
    const deeper = topo.edges.filter((x) => x.from === e.to && x.kind === "uses").map((x) => nodes.get(x.to)!).filter(Boolean);
    const st = hopState(n.row);
    return {
      kind: e.kind === "calls" ? "calls" : "data",
      title: `${n.label}${n.state === "destroy" ? " — removed by this change" : ""}`,
      detail: `${e.via}${deeper.length ? ` · which uses ${deeper.map((d) => d.label).join(", ")}` : ""}`,
      resource: n.id,
      file: n.row.resource.file,
      line: n.row.resource.line,
      ...st,
      ...(e.gone || deeper.some((d) => d.state === "destroy" || d.findings) ? { tone: "bad" as const } : {}),
    };
  };
  const calls = out.filter((e) => e.kind === "calls" && nodes.has(e.to)).map(toHop);
  const uses = out.filter((e) => e.kind === "uses" && nodes.has(e.to)).map(toHop);
  if (calls.length) hops.push({ kind: "calls", title: `Calls ${calls.length} other service${calls.length === 1 ? "" : "s"}`, tone: calls.some((c) => c.tone === "bad") ? "bad" : "plain", children: calls });
  if (uses.length) hops.push({ kind: "data", title: `Keeps data in ${uses.map((u) => u.title.replace(/ — .*$/, "")).join(", ")}`, tone: uses.some((c) => c.tone === "bad") ? "bad" : "plain", children: uses });
  return hops;
}
