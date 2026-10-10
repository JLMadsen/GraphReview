"use client";

// The Graph tab's Infra view (DESIGN.md §6.12): the infrastructure the
// analysed commit declares — Terraform / OpenTofu, Nomad, Kubernetes
// (manifests, Kustomize), Helm and Dockerfiles — as a list whose rows open in
// place (`InfraResourceDetail`), like the API view. No canvas.
//
// With a diff selected the view opens on "Infra changes": the plan, findings
// first, then destroy → moved → update → version → create, the changed rows
// already open (up to 8). "All resources" groups the whole catalog by stack →
// module / job / chart, with the changes marked. Tool and environment
// filters and a search sit on the right of the toolbar.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Anchor, Blocks, ChevronRight, Container, LoaderCircle, Search, Server, Ship, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { Segmented } from "./Segmented";
import { VIEW_TOOLBAR } from "./view-chrome";
import { InfraResourceDetail } from "./InfraResourceDetail";
import { ASSESSMENT_VISUALS } from "./review-visuals";
import { ACTION_ORDER, ACTION_STYLES, TOOL_LABELS, referencedBy, type InfraRow } from "./infra-view-model";
import type { InfraCatalogResponseDTO, InfraChange, InfraResource, InfraStack, InfraTool } from "./infra-types";

/** In "Infra changes", changed rows open on their plan — up to this many. */
const AUTO_OPEN = 8;

const TOOL_ICONS: Record<InfraTool, React.ComponentType<{ className?: string }>> = {
  terraform: Blocks,
  nomad: Server,
  kubernetes: Ship,
  helm: Anchor,
  docker: Container,
};

export function ToolIcon({ tool, className }: { tool: InfraTool; className?: string }) {
  const Icon = TOOL_ICONS[tool];
  return (
    <span title={TOOL_LABELS[tool]} className="inline-flex shrink-0">
      <Icon className={cn("size-3.5 text-muted-foreground", className)} aria-hidden />
    </span>
  );
}

export interface InfraViewProps {
  catalog: InfraCatalogResponseDTO | null;
  rows: InfraRow[];
  loading: boolean;
  error: string | null;
  /** The selected diff's infra change, when there is one. */
  change?: InfraChange;
  /** The comparison is still running. */
  changePending?: boolean;
  changedOnly: boolean;
  onChangedOnlyChange: (value: boolean) => void;
  /** A resource opened from elsewhere (the left column) — opened and scrolled to. A new object each time. */
  focus: { id: string } | null;
  /** An endpoint id → "GET /orders/{id}". */
  endpointLabel: (id: string) => string;
  onOpenEndpoint?: (endpointId: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  leading?: React.ReactNode;
  className?: string;
}

export function InfraView({
  catalog,
  rows,
  loading,
  error,
  change,
  changePending,
  changedOnly,
  onChangedOnlyChange,
  focus,
  endpointLabel,
  onOpenEndpoint,
  onOpenFile,
  leading,
  className,
}: InfraViewProps) {
  const [query, setQuery] = useState("");
  const [tool, setTool] = useState<"all" | InfraTool>("all");
  const [environment, setEnvironment] = useState<string | null>(null);
  const showChanges = Boolean(change) && changedOnly;

  const stacksById = useMemo(() => new Map((catalog?.stacks ?? []).map((s) => [s.id, s])), [catalog]);
  const resourcesById = useMemo(() => new Map(rows.map((r) => [r.resource.id, r.resource])), [rows]);
  const refBy = useMemo(() => referencedBy(catalog), [catalog]);
  const tools = useMemo(() => [...new Set(rows.map((r) => r.resource.tool))], [rows]);
  const environments = useMemo(() => [...new Set((catalog?.stacks ?? []).flatMap((s) => s.environments))].sort(), [catalog]);
  useEffect(() => {
    if (environment && !environments.includes(environment)) setEnvironment(null);
  }, [environment, environments]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter((row) => {
      const r = row.resource;
      if (showChanges && !row.change && row.findings.length === 0) return false;
      if (tool !== "all" && r.tool !== tool) return false;
      if (environment && !(stacksById.get(r.stack)?.environments.includes(environment) ?? false)) return false;
      if (!q) return true;
      return [r.address, r.kind, r.file, r.stack, r.group, r.source ?? "", r.version ?? ""].some((t) => t.toLowerCase().includes(q));
    });
    if (showChanges) {
      list.sort(
        (a, b) =>
          Number(b.findings.length > 0) - Number(a.findings.length > 0) ||
          (a.change ? ACTION_ORDER[a.change.action] : -1) - (b.change ? ACTION_ORDER[b.change.action] : -1) ||
          a.resource.stack.localeCompare(b.resource.stack) ||
          a.resource.address.localeCompare(b.resource.address)
      );
    }
    return list;
  }, [rows, query, tool, environment, stacksById, showChanges]);

  // All resources: stack → group. Infra changes: one flat list.
  const sections = useMemo(() => {
    if (showChanges) return [{ stack: null as InfraStack | null, groups: [["", visible] as const] }];
    const byStack = new Map<string, Map<string, InfraRow[]>>();
    for (const row of visible) {
      const groups = byStack.get(row.resource.stack) ?? byStack.set(row.resource.stack, new Map()).get(row.resource.stack)!;
      (groups.get(row.resource.group) ?? groups.set(row.resource.group, []).get(row.resource.group)!).push(row);
    }
    return [...byStack].map(([id, groups]) => ({
      stack: stacksById.get(id) ?? ({ id, tool: "terraform", path: id, name: id, kind: "", environments: [] } as InfraStack),
      groups: [...groups],
    }));
  }, [visible, showChanges, stacksById]);

  // Which rows are open. Entering "Infra changes" opens the changed ones.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const changeKey = change ? change.changes.map((c) => `${c.action}:${c.id}`).join("|") : "";
  useEffect(() => {
    if (!showChanges || !change) return;
    const ordered = rows
      .filter((r) => r.findings.length > 0 || r.change?.action === "update" || r.change?.action === "moved" || r.change?.action === "version")
      .sort((a, b) => Number(b.findings.length > 0) - Number(a.findings.length > 0) || (a.change ? ACTION_ORDER[a.change.action] : -1) - (b.change ? ACTION_ORDER[b.change.action] : -1));
    setOpen(new Set(ordered.slice(0, AUTO_OPEN).map((r) => r.resource.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run per set of changes, not per object identity
  }, [showChanges, changeKey]);
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // A resource opened from the left column or a reference: open it and scroll to it.
  const listRef = useRef<HTMLDivElement>(null);
  const [localFocus, setLocalFocus] = useState<{ id: string } | null>(null);
  const target = localFocus ?? focus;
  useEffect(() => setLocalFocus(null), [focus]);
  useEffect(() => {
    if (!target) return;
    setOpen((s) => new Set(s).add(target.id));
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-resource="${CSS.escape(target.id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, [target]);
  const focusResource = (id: string) => {
    // A reference outside the current filter brings the whole catalog back.
    if (!visible.some((r) => r.resource.id === id)) {
      setQuery("");
      setTool("all");
      setEnvironment(null);
      if (showChanges) onChangedOnlyChange(false);
    }
    setLocalFocus({ id });
  };

  const total = catalog?.resources.length ?? 0;
  const changeCount = rows.filter((r) => r.change || r.findings.length > 0).length;

  return (
    <div className={className}>
      <div className={VIEW_TOOLBAR}>
        {leading}
        {change ? (
          <Segmented
            label="Show"
            size="xs"
            value={changedOnly ? "changes" : "all"}
            onChange={(v) => onChangedOnlyChange(v === "changes")}
            options={[
              {
                value: "changes" as const,
                label: (
                  <>
                    Infra changes <span className="font-mono text-muted-foreground">{changeCount}</span>
                  </>
                ),
                title: "What this diff does to the infrastructure, plan-style: create, destroy, update, moved, version",
              },
              {
                value: "all" as const,
                label: (
                  <>
                    All resources <span className="font-mono text-muted-foreground">{total}</span>
                  </>
                ),
                title: "Every resource, with this diff's changes marked",
              },
            ]}
          />
        ) : (
          catalog?.state === "ready" && <span className="font-mono text-[11px] text-muted-foreground">{total} resources</span>
        )}
        {changePending && !change && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" aria-hidden /> Comparing the infrastructure…
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {loading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          {tools.length > 1 && (
            <Segmented
              label="Tool"
              size="xs"
              value={tool}
              onChange={setTool}
              options={[{ value: "all" as const, label: "All" }, ...tools.map((t) => ({ value: t, label: TOOL_LABELS[t] }))]}
            />
          )}
          {environments.length > 0 && (
            <select
              value={environment ?? ""}
              onChange={(e) => setEnvironment(e.target.value || null)}
              aria-label="Environment"
              title="Show the stacks that have this environment, with its values"
              className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px] text-foreground"
            >
              <option value="">All environments</option>
              {environments.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          )}
          <label className="flex h-7 w-44 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs focus-within:border-foreground/30">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a resource…"
              aria-label="Find resources by address, kind or file"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear" className="text-muted-foreground hover:text-foreground">
                <X className="size-3" />
              </button>
            )}
          </label>
        </div>
      </div>

      <div ref={listRef} className="@container relative min-h-[220px] flex-1 overflow-y-auto bg-background">
        {error && !catalog && (
          <p className="flex items-start gap-2 px-6 py-8 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error}
          </p>
        )}
        {!catalog && !error && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading infrastructure…
          </div>
        )}
        {catalog?.state === "none" && (
          <p className="px-6 py-12 text-center text-sm text-muted-foreground">
            The infrastructure list is built during analysis — it appears once this repo&apos;s next analysis finishes.
          </p>
        )}
        {catalog?.state === "ready" && total === 0 && !change && (
          <div className="mx-auto max-w-lg px-6 py-12 text-sm text-muted-foreground">
            <p className="text-foreground">No infrastructure as code found.</p>
            <p className="mt-2 leading-relaxed">
              Looked for Terraform / OpenTofu (<span className="font-mono">.tf</span>, <span className="font-mono">.tfvars</span>), Nomad jobspecs,
              Kubernetes manifests and Kustomize, Helm charts and Dockerfiles. Docker Compose, Packer, CloudFormation, Pulumi and Ansible aren&apos;t read.
            </p>
          </div>
        )}
        {catalog?.state === "ready" && visible.length === 0 && (total > 0 || change) && (
          <p className="px-6 py-12 text-center text-sm text-muted-foreground">
            {showChanges && changeCount === 0
              ? "This diff doesn't change the infrastructure — no resource is created, destroyed, updated, moved or re-versioned."
              : "Nothing matches."}
          </p>
        )}

        {sections.map(({ stack, groups }) => (
          <section key={stack?.id ?? "changes"}>
            {stack && <StackHeader stack={stack} count={groups.reduce((n, [, list]) => n + list.length, 0)} />}
            {groups.map(([group, list]) => (
              <Fragment key={group || "flat"}>
                {stack && group && !/^\((root|base)\)$/.test(group) && (
                  <h4 className="border-b border-border/60 bg-background px-4 pt-2 pb-1 pl-[2.75rem] font-mono text-[11px] text-muted-foreground">
                    {group}
                    <span className="ml-2">{list.length}</span>
                  </h4>
                )}
                <ul>
                  {list.map((row) => {
                    const id = row.resource.id;
                    const isOpen = open.has(id);
                    return (
                      <li key={id} data-resource={id} className="scroll-mt-10">
                        <ResourceRow row={row} open={isOpen} flat={showChanges} onToggle={() => toggle(id)} />
                        {isOpen && (
                          <InfraResourceDetail
                            row={row}
                            catalog={catalog}
                            environment={environment}
                            resourcesById={resourcesById}
                            referencedBy={refBy.get(id) ?? []}
                            endpointLabel={endpointLabel}
                            onFocus={focusResource}
                            onOpenFile={onOpenFile}
                            onOpenEndpoint={onOpenEndpoint}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Fragment>
            ))}
          </section>
        ))}
        {showChanges && change && change.links.length > 0 && (
          <section className="border-t border-border px-4 py-3">
            <p className="mb-1 text-[11px] font-medium text-muted-foreground">Links to the code that changed</p>
            <ul className="space-y-0.5 text-[11px]">
              {change.links.map((l, i) => (
                <li key={i} className="flex items-baseline gap-2">
                  <span className="w-12 shrink-0 font-mono text-muted-foreground">{l.kind}</span>
                  <span className="min-w-0">{l.text}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function StackHeader({ stack, count }: { stack: InfraStack; count: number }) {
  return (
    <h3 className="sticky top-0 z-10 flex min-w-0 items-baseline gap-2 border-b border-border bg-background/95 px-4 pt-3 pb-1 text-xs font-semibold backdrop-blur">
      <ToolIcon tool={stack.tool} className="translate-y-0.5" />
      <span className="min-w-0 truncate font-mono" title={stack.path}>
        {stack.name}
      </span>
      <span className="text-[11px] font-normal text-muted-foreground">{stack.kind}</span>
      {stack.version && <span className="font-mono text-[11px] font-normal text-muted-foreground">v{stack.version}</span>}
      {stack.backend && <span className="text-[11px] font-normal text-muted-foreground">backend {stack.backend}</span>}
      {stack.environments.length > 0 && (
        <span className="min-w-0 truncate text-[11px] font-normal text-muted-foreground" title="Environments: tfvars files, Kustomize overlays, Helm values files">
          envs <span className="font-mono">{stack.environments.join(" · ")}</span>
        </span>
      )}
      <span className="ml-auto font-mono text-[11px] font-normal text-muted-foreground">{count}</span>
    </h3>
  );
}

function Tag({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span className={cn("shrink-0 rounded-[3px] border px-1.5 text-[10px] leading-4", className)} title={title}>
      {children}
    </span>
  );
}

const QUIET_TAG = "border-border text-muted-foreground";

function ResourceTags({ r }: { r: InfraResource }) {
  return (
    <>
      {r.count !== undefined && (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground" title={r.count === "?" ? "count / for_each / replicas that isn't a literal" : "count / replicas"}>
          ×{r.count}
        </span>
      )}
      {r.conditional && <Tag className={QUIET_TAG} title="Created only when a condition holds (count = cond ? 1 : 0)">conditional</Tag>}
      {r.templated && <Tag className={QUIET_TAG} title="Levant / nomad-pack / Helm template — shown as written, never rendered">templated</Tag>}
      {r.stateful && <Tag className={QUIET_TAG} title="Holds data: destroying it loses what is in it">stateful</Tag>}
      {r.external && <Tag className={QUIET_TAG} title="Not in the repo: a registry/git module, a base image or a chart dependency — not fetched">external</Tag>}
      {r.patched && <Tag className={QUIET_TAG} title="A Kustomize patch changes it that isn't applied here">patched</Tag>}
    </>
  );
}

function ResourceRow({ row, open, flat, onToggle }: { row: InfraRow; open: boolean; flat: boolean; onToggle: () => void }) {
  const r = row.resource;
  const action = row.change?.action;
  const style = action ? ACTION_STYLES[action] : null;
  const concern = ASSESSMENT_VISUALS.concern;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 border-b border-border/60 px-4 py-1.5 text-left transition-colors hover:bg-secondary/50",
        open && "bg-card/60",
        action === "destroy" && "opacity-75"
      )}
    >
      <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
      <ToolIcon tool={r.tool} />
      <span className="w-36 shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={r.kind}>
        {r.kind}
      </span>
      <span className={cn("min-w-0 truncate font-mono text-xs", action === "destroy" && "line-through")} title={`${r.address}\n${r.file}:${r.line}`}>
        {r.address}
      </span>
      {flat && <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground @xl:inline">{r.stack.replace(/^[a-z0-9]+:/, "")}</span>}
      {row.change?.action === "version" && (
        <span className="hidden shrink-0 font-mono text-[11px] @xl:inline">
          <span className="text-muted-foreground">{row.change.version?.before ?? "?"} → </span>
          {row.change.version?.after ?? "?"}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <ResourceTags r={r} />
        {style && (
          <Tag className={cn("border-current/40", style.className)} title={style.title}>
            {style.word}
          </Tag>
        )}
        {row.change?.replace && (
          <Tag className="border-warning/40 text-warning" title="An attribute on the force-new list changed: the provider likely replaces it">
            replace?
          </Tag>
        )}
        {row.findings.length > 0 && (
          <span className="flex items-center gap-0.5 text-[10px]" style={{ color: concern.text }} title={row.findings.map((f) => f.summary).join("\n")}>
            <TriangleAlert className="size-3" aria-hidden />
            {row.findings.length > 1 && <span className="font-mono">{row.findings.length}</span>}
          </span>
        )}
      </span>
    </button>
  );
}

export function InfraChangeCounts({ change, className }: { change: InfraChange; className?: string }) {
  const c = change.counts;
  const parts: Array<[string, string, string]> = [];
  if (c.create) parts.push([`+${c.create}`, "text-success", `${c.create} to create`]);
  if (c.destroy) parts.push([`−${c.destroy}`, "text-destructive", `${c.destroy} to destroy`]);
  if (c.update + c.version) parts.push([`~${c.update + c.version}`, "text-warning", `${c.update} to update, ${c.version} version change(s)`]);
  if (c.moved) parts.push([`→${c.moved}`, "text-muted-foreground", `${c.moved} moved`]);
  if (parts.length === 0) return <span className={cn("font-mono text-[11px] font-normal text-muted-foreground", className)}>none</span>;
  return (
    <span className={cn("flex items-center gap-1.5 font-mono text-[11px] font-normal", className)}>
      {parts.map(([text, tone, title]) => (
        <span key={title} className={tone} title={title}>
          {text}
        </span>
      ))}
      {c.findings > 0 && (
        <span style={{ color: ASSESSMENT_VISUALS.concern.text }} title={`${c.findings} certain finding(s)`}>
          · {c.findings} finding{c.findings === 1 ? "" : "s"}
        </span>
      )}
    </span>
  );
}
