// One object for the places the infrastructure shows (DESIGN.md §6.12): the
// Infra view's list and rows, the left column's Infra section, and the App
// map explainer's "Deployed as". Rows are the analysed commit's catalog with
// the selected diff's plan laid over it — created, updated, moved and
// version-changed resources as they are at the head, destroyed ones kept
// and marked.

import type { InfraAction, InfraCatalog, InfraChange, InfraChangeEntry, InfraFinding, InfraResource, InfraTool } from "./infra-types";

export interface InfraRow {
  resource: InfraResource;
  change?: InfraChangeEntry;
  findings: InfraFinding[];
}

export function buildInfraRows(catalog: InfraCatalog | null, change: InfraChange | undefined): InfraRow[] {
  const rows = new Map<string, InfraRow>();
  for (const resource of catalog?.resources ?? []) rows.set(resource.id, { resource, findings: [] });
  const findingsByKey = new Map((change?.findings ?? []).map((f) => [f.key, f]));
  for (const c of change?.changes ?? []) {
    const findings = (c.findings ?? []).map((k) => findingsByKey.get(k)).filter((f): f is InfraFinding => Boolean(f));
    rows.set(c.id, { resource: c.resource, change: c, findings });
    if (c.before && c.before.id !== c.id) rows.delete(c.before.id);
  }
  // A finding about an unchanged resource (code that now reads an env var its workload doesn't set).
  for (const f of change?.findings ?? []) {
    const row = rows.get(f.resource);
    if (row && !row.findings.some((x) => x.key === f.key)) row.findings.push(f);
  }
  return [...rows.values()];
}

export const TOOL_LABELS: Record<InfraTool, string> = { terraform: "Terraform", nomad: "Nomad", kubernetes: "Kubernetes", helm: "Helm", docker: "Docker" };

/** Plan words. Status colours only for create / destroy / update; moved and version stay quiet. */
export const ACTION_STYLES: Record<InfraAction, { word: string; mark: string; className: string; title: string }> = {
  create: { word: "create", mark: "+", className: "text-success", title: "This change adds the resource" },
  destroy: { word: "destroy", mark: "−", className: "text-destructive", title: "This change removes the resource — applying it destroys it" },
  update: { word: "update", mark: "~", className: "text-warning", title: "Its attributes change (replace vs update in place isn't predicted)" },
  moved: { word: "moved", mark: "→", className: "text-muted-foreground", title: "The same resource at a new address or path" },
  version: { word: "version", mark: "~", className: "text-warning", title: "Its version changes (module, provider, chart, base image)" },
};

export const ACTION_ORDER: Record<InfraAction, number> = { destroy: 0, moved: 1, update: 2, version: 3, create: 4 };

/** Ids of the rows that reference each row. */
export function referencedBy(catalog: InfraCatalog | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of catalog?.resources ?? []) for (const ref of r.refs) (out.get(ref) ?? out.set(ref, []).get(ref)!).push(r.id);
  return out;
}

export const isUnder = (file: string, folder: string) => folder === "" || file === folder || file.startsWith(`${folder}/`);

/** "Nomad task api/web/server", "Kubernetes Deployment/web". */
export function resourceLabel(r: Pick<InfraResource, "tool" | "kind" | "address" | "category">): string {
  if (r.tool === "kubernetes" || r.tool === "helm") return `${TOOL_LABELS[r.tool]} ${r.address}`;
  if (r.tool === "terraform" && (r.category === "resource" || r.category === "data")) return r.address;
  return `${TOOL_LABELS[r.tool]} ${r.kind.replace(/ \(.*\)$/, "")} ${r.address}`;
}

/** The workloads whose resolved deploy link ships any of `files` — for the App map explainer. */
export function deployedAs(catalog: InfraCatalog | null, files: readonly string[]): Array<{ resource: InfraResource; via: string; dockerfile?: string }> {
  if (!catalog) return [];
  const byId = new Map(catalog.resources.map((r) => [r.id, r]));
  const out: Array<{ resource: InfraResource; via: string; dockerfile?: string }> = [];
  for (const d of catalog.links.deploys) {
    if (!d.resolved || out.some((o) => o.resource.id === d.resource)) continue;
    if (!files.some((f) => d.folders.some((folder) => isUnder(f, folder)))) continue;
    const r = byId.get(d.resource);
    if (r) out.push({ resource: r, via: d.via, ...(d.dockerfile ? { dockerfile: d.dockerfile } : {}) });
  }
  return out;
}

/**
 * Auth in front of endpoints that only the infrastructure shows (a Traefik
 * forwardauth middleware, an ingress auth annotation) — for the API view,
 * where the code showed none (DESIGN.md §6.11's gateway limit).
 */
export function gatewayAuth(catalog: InfraCatalog | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const route of catalog?.links.routes ?? []) {
    if (!route.auth?.length) continue;
    for (const id of route.endpoints) out.set(id, [...new Set([...(out.get(id) ?? []), ...route.auth])]);
  }
  return out;
}
