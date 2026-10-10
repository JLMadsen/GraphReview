"use client";

// One resource opened in place in the Infra view (DESIGN.md §6.12): what the
// change does to it (the plan's before / after table, its findings), its
// attributes with the values per environment where they differ, what it
// references and what references it, its links to the code — the image and
// the code it ships, env vars set against read, routes onto endpoints,
// ports — and the file:line it is declared at.

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { DiffTable, type FieldRow } from "./ApiEndpointDetail";
import { ASSESSMENT_VISUALS } from "./review-visuals";
import type { InfraCatalog, InfraResource } from "./infra-types";
import { resourceLabel, type InfraRow } from "./infra-view-model";

export interface InfraResourceDetailProps {
  row: InfraRow;
  catalog: InfraCatalog | null;
  /** The environment filter; `null` shows every environment's values. */
  environment: string | null;
  resourcesById: ReadonlyMap<string, InfraResource>;
  referencedBy: readonly string[];
  /** An endpoint id → "GET /orders/{id}". */
  endpointLabel: (id: string) => string;
  onFocus: (resourceId: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onOpenEndpoint?: (endpointId: string) => void;
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-[11px] font-medium text-muted-foreground">{children}</p>;
}

const MAX_ENV_COLUMNS = 4;

function AttributesTable({ r, environment }: { r: InfraResource; environment: string | null }) {
  const [all, setAll] = useState(false);
  const envs = Object.keys(r.envValues ?? {}).filter((e) => !environment || e === environment).slice(0, MAX_ENV_COLUMNS);
  const envValue = (env: string, name: string) => r.envValues?.[env]?.find((a) => a.name === name)?.value;
  // Values an environment sets that the default doesn't list (an overlay's image, a tfvars value).
  const names = [...new Set([...r.attributes.map((a) => a.name), ...envs.flatMap((e) => (r.envValues?.[e] ?? []).map((a) => a.name))])];
  const shown = all ? names : names.slice(0, 14);
  if (names.length === 0) return null;
  return (
    <div>
      <Label>Attributes</Label>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full table-fixed font-mono text-[11px]">
          {envs.length > 0 && (
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left text-[10px] text-muted-foreground">
                <th className="w-[30%] px-2 py-1 font-normal">attribute</th>
                <th className="px-2 py-1 font-normal">default</th>
                {envs.map((e) => (
                  <th key={e} className="px-2 py-1 font-normal text-foreground/80">
                    {e}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {shown.map((name) => {
              const value = r.attributes.find((a) => a.name === name)?.value;
              return (
                <tr key={name} className="border-b border-border/50 last:border-0">
                  <td className={cn("truncate px-2 py-0.5 align-top", envs.length === 0 && "w-[34%]")} title={name}>
                    {name}
                  </td>
                  <td className="px-2 py-0.5 break-all text-muted-foreground">{value ?? <span className="text-muted-foreground/50">—</span>}</td>
                  {envs.map((e) => {
                    const v = envValue(e, name);
                    return (
                      <td key={e} className={cn("px-2 py-0.5 break-all", v !== undefined && v !== value && "bg-warning/10")}>
                        {v ?? ""}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {names.length > 14 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-[11px] text-muted-foreground hover:text-foreground">
          {all ? "show fewer" : `${names.length - 14} more`}
        </button>
      )}
    </div>
  );
}

function RefList({ title, ids, resourcesById, onFocus }: { title: string; ids: readonly string[]; resourcesById: ReadonlyMap<string, InfraResource>; onFocus: (id: string) => void }) {
  if (ids.length === 0) return null;
  return (
    <div className="min-w-0">
      <Label>
        {title} <span className="font-mono">{ids.length}</span>
      </Label>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {ids.slice(0, 24).map((id) => {
          const r = resourcesById.get(id);
          return (
            <li key={id}>
              <button type="button" onClick={() => onFocus(id)} className="hover:underline" title={r ? `${resourceLabel(r)} — ${r.file}:${r.line}` : id}>
                {r?.address ?? id.split(":").pop()}
              </button>
            </li>
          );
        })}
        {ids.length > 24 && <li className="text-muted-foreground">+{ids.length - 24} more</li>}
      </ul>
    </div>
  );
}

/** Deploys, env, routes and ports of a workload. */
function CodeLinks({
  r,
  catalog,
  endpointLabel,
  onOpenFile,
  onOpenEndpoint,
}: {
  r: InfraResource;
  catalog: InfraCatalog | null;
  endpointLabel: (id: string) => string;
  onOpenFile: (path: string, line?: number) => void;
  onOpenEndpoint?: (id: string) => void;
}) {
  if (!catalog || !r.workload) return null;
  const deploys = catalog.links.deploys.filter((d) => d.resource === r.id);
  const env = catalog.links.env.find((l) => l.resource === r.id);
  const routes = catalog.links.routes.filter((l) => l.resource === r.id);
  const port = catalog.links.ports.find((p) => p.resource === r.id);
  return (
    <div className="space-y-2">
      <Label>Code links</Label>
      <ul className="space-y-1 text-[11px]">
        {deploys.map((d, i) => (
          <li key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className="w-14 shrink-0 text-muted-foreground">deploys</span>
            {d.image && <span className="font-mono">{d.image}</span>}
            {d.resolved ? (
              <>
                {d.dockerfile && (
                  <>
                    <span className="text-muted-foreground">←</span>
                    <button type="button" onClick={() => onOpenFile(d.dockerfile!)} className="font-mono hover:underline">
                      {d.dockerfile}
                    </button>
                  </>
                )}
                <span className="text-muted-foreground">ships</span>
                <span className="font-mono">{d.folders.map((f) => f || "(repo root)").join(", ")}</span>
                <span className="text-muted-foreground/80">({d.via})</span>
              </>
            ) : (
              <span className="text-muted-foreground">not linked to code — {d.via}</span>
            )}
          </li>
        ))}
        {env && (
          <li className="flex min-w-0 items-baseline gap-x-1.5">
            <span className="w-14 shrink-0 text-muted-foreground">env</span>
            <span className="min-w-0 space-y-0.5">
              <span className="block">
                sets <span className="font-mono">{env.set.length}</span>
                {env.maybe.length > 0 && <span className="text-muted-foreground"> · may set more: {env.maybe.join(", ")}</span>}
              </span>
              {env.readNotSet.length > 0 && (
                <span className="block" style={{ color: ASSESSMENT_VISUALS.concern.text }}>
                  read but not set:{" "}
                  {env.readNotSet.map((x, i) => (
                    <span key={x.name}>
                      {i > 0 && ", "}
                      <button type="button" onClick={() => onOpenFile(x.file, x.line)} className="font-mono hover:underline" title={`${x.file}:${x.line}`}>
                        {x.name}
                      </button>
                    </span>
                  ))}
                </span>
              )}
              {env.setNotRead.length > 0 && (
                <span className="block text-muted-foreground">
                  set but not read by the code it ships: <span className="font-mono">{env.setNotRead.join(", ")}</span>
                </span>
              )}
            </span>
          </li>
        )}
        {routes.map((route, i) => (
          <li key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className="w-14 shrink-0 text-muted-foreground">route</span>
            <span className="font-mono">
              {route.host ?? ""}
              {route.path}
            </span>
            <span className="text-muted-foreground">{route.via}</span>
            {route.auth?.length ? <span className="text-muted-foreground">· auth {route.auth.join(", ")}</span> : null}
            <span className="text-muted-foreground">→</span>
            {route.endpoints.length === 0 ? (
              <span className="text-muted-foreground">no endpoint found under it</span>
            ) : (
              route.endpoints.slice(0, 6).map((id) => (
                <button key={id} type="button" onClick={() => onOpenEndpoint?.(id)} className="font-mono hover:underline">
                  {endpointLabel(id)}
                </button>
              ))
            )}
            {route.endpoints.length > 6 && <span className="text-muted-foreground">+{route.endpoints.length - 6}</span>}
          </li>
        ))}
        {port && (
          <li className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className="w-14 shrink-0 text-muted-foreground">port</span>
            <span className="font-mono">{port.declared}</span>
            <span className="text-muted-foreground">{port.match ? "= the code's listen port" : `≠ the code listens on`}</span>
            {!port.match && <span className="font-mono text-warning">{port.listen}</span>}
            {port.file && (
              <button type="button" onClick={() => onOpenFile(port.file!, port.line)} className="font-mono text-muted-foreground hover:text-foreground hover:underline">
                {port.file}:{port.line}
              </button>
            )}
          </li>
        )}
        {deploys.length === 0 && !env && routes.length === 0 && !port && <li className="text-muted-foreground">No link to the app&apos;s code found.</li>}
      </ul>
    </div>
  );
}

export function InfraResourceDetail({ row, catalog, environment, resourcesById, referencedBy, endpointLabel, onFocus, onOpenFile, onOpenEndpoint }: InfraResourceDetailProps) {
  const r = row.resource;
  const c = row.change;
  const deltaRows: FieldRow[] = (c?.deltas ?? []).map((d) => ({
    name: `${d.name}${d.forceNew ? " !" : ""}`,
    before: d.before,
    after: d.after,
    state: d.before === undefined ? "added" : d.after === undefined ? "removed" : "changed",
  }));
  const concern = ASSESSMENT_VISUALS.concern;
  return (
    <div className="@container space-y-3 border-b border-border bg-card/60 px-4 pt-2 pb-3 pl-[2.75rem]">
      {row.findings.map((f) => (
        <div key={f.key} className="text-[11px]">
          <p className="flex items-start gap-1.5 font-medium" style={{ color: concern.text }}>
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            {f.summary}
          </p>
          <p className="mt-0.5 pl-5 leading-relaxed text-muted-foreground">{f.rationale}</p>
        </div>
      ))}
      {c?.action === "destroy" && <p className="text-[11px] text-destructive">This diff removes it — applying the change destroys it{r.stateful ? ", and the data in it" : ""}.</p>}
      {c?.action === "create" && <p className="text-[11px] text-success">This diff adds it.</p>}
      {c?.action === "moved" && (
        <p className="text-[11px] text-muted-foreground">
          Moved from <span className="font-mono text-foreground">{c.movedFrom}</span>
          {c.movedVia ? ` — ${c.movedVia}` : ""}.
        </p>
      )}
      {c?.action === "version" && (
        <p className="font-mono text-[11px]">
          <span className="text-muted-foreground">version </span>
          <span className="text-destructive line-through decoration-destructive/50">{c.version?.before ?? "none"}</span>
          <span className="text-muted-foreground"> → </span>
          <span className="text-success">{c.version?.after ?? "none"}</span>
        </p>
      )}
      {deltaRows.length > 0 && (
        <div>
          <Label>
            Changes <span className="font-mono">{deltaRows.length}</span>
            {c?.replace && <span className="ml-2 text-warning">an attribute marked ! usually makes the provider replace the resource</span>}
          </Label>
          <DiffTable rows={deltaRows} first="attribute" />
        </div>
      )}

      <AttributesTable r={r} environment={environment} />

      <CodeLinks r={r} catalog={catalog} endpointLabel={endpointLabel} onOpenFile={onOpenFile} onOpenEndpoint={onOpenEndpoint} />

      {(r.refs.length > 0 || referencedBy.length > 0) && (
        <div className="grid gap-3 @3xl:grid-cols-2">
          <RefList title="References" ids={r.refs} resourcesById={resourcesById} onFocus={onFocus} />
          <RefList title="Referenced by" ids={referencedBy} resourcesById={resourcesById} onFocus={onFocus} />
        </div>
      )}

      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[11px]">
        <button type="button" onClick={() => onOpenFile(r.file, r.line)} className="min-w-0 truncate font-mono hover:underline" title="Open the file">
          {r.file}:{r.line}
        </button>
        {r.source && (
          <span className="min-w-0 truncate font-mono" title={r.source}>
            <span className="text-muted-foreground">source </span>
            {r.source}
          </span>
        )}
        {r.version && (
          <span className="font-mono">
            <span className="text-muted-foreground">version </span>
            {r.version}
          </span>
        )}
        {r.lifecycle?.preventDestroy && <span className="text-muted-foreground">prevent_destroy</span>}
        {r.lifecycle?.createBeforeDestroy && <span className="text-muted-foreground">create_before_destroy</span>}
        {r.lifecycle?.ignoreChanges?.length ? <span className="font-mono text-muted-foreground">ignore_changes {r.lifecycle.ignoreChanges.join(", ")}</span> : null}
        {r.workload?.secrets?.length ? <span className="font-mono text-muted-foreground">reads {r.workload.secrets.join(", ")}</span> : null}
        {r.templated && <span className="text-muted-foreground">templated — shown as written, never rendered</span>}
        {r.patched && <span className="text-muted-foreground">a Kustomize patch changes it that isn&apos;t applied here</span>}
      </div>
    </div>
  );
}

