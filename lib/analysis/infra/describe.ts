/**
 * The infra catalog and change in words, for the places that hand them to
 * a model or an agent: the review's per-component context and intent check,
 * the PR chat and the MCP server. One line per resource or link delta.
 */
import { isUnder } from "./link";
import type { InfraCatalog, InfraChange, InfraChangeEntry, InfraFinding, InfraResource, InfraTool } from "./types";

export const TOOL_LABELS: Record<InfraTool, string> = { terraform: "Terraform", nomad: "Nomad", kubernetes: "k8s", helm: "Helm", docker: "Docker" };

/** "Terraform aws_db_instance module.db.aws_db_instance.main", "Nomad task api/web/server", "k8s Deployment/api". */
export function infraResourceLabel(r: Pick<InfraResource, "tool" | "kind" | "address" | "category">): string {
  if (r.tool === "kubernetes" || r.tool === "helm") return `${TOOL_LABELS[r.tool]} ${r.address}`;
  if (r.tool === "terraform" && (r.category === "resource" || r.category === "data")) return `Terraform ${r.address}`;
  return `${TOOL_LABELS[r.tool]} ${r.kind.replace(/ \(.*\)$/, "")} ${r.address}`;
}

function tags(r: InfraResource): string {
  const t: string[] = [];
  if (r.stateful) t.push("stateful");
  if (r.templated) t.push("templated");
  if (r.external) t.push("external");
  if (r.patched) t.push("patched");
  if (r.conditional) t.push("conditional");
  return t.length ? ` [${t.join(", ")}]` : "";
}

/** "update k8s Deployment/api: spec.replicas 2 → 3; image a:1 → a:2 (infra/k8s/api.yaml:1)". */
export function describeInfraChangeEntry(c: InfraChangeEntry, maxDeltas = 8): string {
  const r = c.resource;
  const at = ` (${r.file}:${r.line})`;
  const head = `${c.action} ${infraResourceLabel(r)}${tags(r)}`;
  if (c.action === "moved") return `${head} — moved from ${c.movedFrom}${c.movedVia ? ` via ${c.movedVia}` : ""}${at}`;
  if (c.action === "version") return `${head} — version ${c.version?.before ?? "?"} → ${c.version?.after ?? "?"}${at}`;
  if (c.action !== "update") return `${head}${at}`;
  const parts = c.deltas.slice(0, maxDeltas).map((d) => {
    const v = d.before !== undefined && d.after !== undefined ? `${d.before} → ${d.after}` : d.after !== undefined ? `added ${d.after}` : `removed ${d.before}`;
    return `${d.name} ${v}${d.forceNew ? " [may force replacement]" : ""}`;
  });
  if (c.deltas.length > maxDeltas) parts.push(`+${c.deltas.length - maxDeltas} more`);
  return `${head}: ${parts.join("; ")}${at}`;
}

export function infraChangeSummary(change: InfraChange): string {
  const { create, destroy, update, moved, version } = change.counts;
  if (change.changes.length === 0 && change.links.length === 0) return `No infrastructure change (${change.total} resources).`;
  return `${create} to create, ${destroy} to destroy, ${update} to update, ${moved} moved, ${version} version change(s) — of ${change.total} resources; ${change.findings.length} certain finding(s).`;
}

export function describeInfraFinding(f: InfraFinding): string {
  return `${f.summary} (${f.file}${f.line ? `:${f.line}` : ""})`;
}

/** The plan, findings first, then link deltas. */
export function describeInfraChange(change: InfraChange, max = 25): string[] {
  const lines = [infraChangeSummary(change)];
  for (const c of change.changes.slice(0, max)) lines.push(describeInfraChangeEntry(c));
  if (change.changes.length > max) lines.push(`(${change.changes.length - max} more resource changes)`);
  if (change.links.length) {
    lines.push("Links between the infrastructure and the code that changed:");
    for (const l of change.links.slice(0, 15)) lines.push(`${l.kind}: ${l.text}`);
  }
  return lines;
}

/** Workloads whose resolved deploy link ships any of `paths`. */
export function workloadsDeploying(catalog: InfraCatalog | undefined, paths: ReadonlySet<string> | readonly string[]): string[] {
  if (!catalog) return [];
  const list = [...paths];
  const ids = new Set<string>();
  for (const d of catalog.links.deploys) if (d.resolved && list.some((p) => d.folders.some((f) => isUnder(p, f)))) ids.add(d.resource);
  return [...ids];
}

/**
 * The infra context of one component's review: changes to the infra files
 * in it, and to the workloads that deploy its code, with their link deltas.
 */
export function infraChangesTouching(change: InfraChange, head: InfraCatalog | undefined, paths: ReadonlySet<string>): { entries: InfraChangeEntry[]; links: string[]; findings: InfraFinding[] } {
  const deploying = new Set(workloadsDeploying(head, paths));
  // A workload's rows: the task / workload itself and, for Nomad, its group and job.
  const related = (r: InfraResource) => deploying.has(r.id) || [...deploying].some((id) => id.startsWith(`${r.id}/`));
  const entries = change.changes.filter((c) => paths.has(c.resource.file) || (c.before && paths.has(c.before.file)) || related(c.resource));
  const ids = new Set(entries.map((c) => c.id));
  const links = change.links.filter((l) => deploying.has(l.resource) || ids.has(l.resource) || l.files?.some((f) => paths.has(f))).map((l) => `${l.kind}: ${l.text}`);
  const findings = change.findings.filter((f) => ids.has(f.resource) || paths.has(f.file) || deploying.has(f.resource));
  return { entries, links, findings };
}

/** "Nomad job api · k8s Deployment/api" for an App map card's files. */
export function deployedAsLabels(catalog: InfraCatalog, paths: readonly string[]): string[] {
  const ids = workloadsDeploying(catalog, paths);
  const byId = new Map(catalog.resources.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is InfraResource => Boolean(r)).map(infraResourceLabel);
}

/** Rows matching a text query (address, kind, file, tool, stack), for `list_infra`. */
export function filterInfra(catalog: InfraCatalog, query?: string, tool?: InfraTool): InfraResource[] {
  const q = query?.trim().toLowerCase();
  return catalog.resources.filter(
    (r) => (!tool || r.tool === tool) && (!q || [r.address, r.kind, r.file, r.tool, r.stack, r.source ?? ""].some((t) => t.toLowerCase().includes(q)))
  );
}

/** One line per row: label, tags, version, file:line, and for a workload what it runs and what deploys it. */
export function describeInfraResource(r: InfraResource, catalog?: InfraCatalog): string {
  const parts = [`${infraResourceLabel(r)}${tags(r)}`];
  if (r.count) parts.push(`×${r.count}`);
  if (r.version) parts.push(`version ${r.version}`);
  if (r.workload?.images.length) parts.push(`image ${r.workload.images.join(", ")}`);
  const deploy = catalog?.links.deploys.find((d) => d.resource === r.id);
  if (deploy) parts.push(deploy.resolved ? `ships ${deploy.folders.join(", ") || "(repo root)"} (${deploy.via})` : `code not linked: ${deploy.via}`);
  const env = catalog?.links.env.find((l) => l.resource === r.id);
  if (env?.readNotSet.length) parts.push(`reads but not set: ${env.readNotSet.map((x) => x.name).join(", ")}`);
  for (const route of r.workload?.routes ?? []) parts.push(`route ${route.host ?? ""}${route.path}${route.auth?.length ? ` (auth ${route.auth.join(", ")})` : ""}`);
  parts.push(`${r.file}:${r.line}`);
  return parts.join("; ");
}
