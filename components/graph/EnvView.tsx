"use client";

// The Graph tab's Env view (DESIGN.md §6.15): every env var name the
// analysed commit reads, declares or sets, as a matrix — a row per name
// (grouped by prefix or by the folder that reads it), a column per
// environment or target that sets anything (`.env.example`, `.env`,
// `.env.production`, Compose services, CI jobs, framework config,
// workloads), the committed value in each cell. The columns scroll sideways
// under a sticky name column. A row opens in place on its reads,
// declarations, sets and the infra that sets it.
//
// With a diff selected the view opens on "Env changes": one entry per name
// the diff touches, findings first, its changed cells as before → after.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Eye, EyeOff, Lock, LoaderCircle, Search, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { Segmented } from "./Segmented";
import { VIEW_TOOLBAR } from "./view-chrome";
import { ASSESSMENT_VISUALS } from "./review-visuals";
import { useStoredState } from "./graph-view/view-state";
import { ROW_TAGS, TAG_STYLES, cellOf, inScope, moduleOf } from "./env-view-model";
import type { EnvCatalogResponseDTO, EnvChange, EnvChangeEntry, EnvFinding, EnvSet, EnvTag, EnvTarget, EnvVar } from "./env-types";

type GroupBy = "prefix" | "folder";

const HIDE_VALUES_KEY = "graphreview:env:hideValues";
const GROUP_KEY = "graphreview:env:groupBy";

/** In "Env changes", entries open with their cells — up to this many. */
const AUTO_OPEN = 8;

export interface EnvViewProps {
  catalog: EnvCatalogResponseDTO | null;
  loading: boolean;
  error: string | null;
  /** The selected diff's env change, when there is one. */
  change?: EnvChange;
  changePending?: boolean;
  changedOnly: boolean;
  onChangedOnlyChange: (value: boolean) => void;
  /** A name opened from elsewhere (the left column). A new object each time. */
  focus: { id: string } | null;
  onOpenFile: (path: string, line?: number) => void;
  onOpenInfra?: (resourceId: string) => void;
  /** A "Read by" chip's component: shown on the map. */
  onOpenComponent?: (componentId: string) => void;
  className?: string;
}

/** The deepest folder holding both. */
function commonFolder(a: string, b: string): string {
  const x = a.split("/");
  const y = b.split("/");
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return x.slice(0, i).join("/");
}

export function EnvView({ catalog, loading, error, change, changePending, changedOnly, onChangedOnlyChange, focus, onOpenFile, onOpenInfra, onOpenComponent, className }: EnvViewProps) {
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<ReadonlySet<EnvTag>>(new Set());
  const [scope, setScope] = useState<string | null>(null);
  const [hideValues, setHideValues] = useStoredState<boolean>(HIDE_VALUES_KEY, false, (raw) => (raw === null ? undefined : raw === "true"));
  const [groupBy, setGroupBy] = useStoredState<GroupBy>(GROUP_KEY, "prefix", (raw) => (raw === "prefix" || raw === "folder" ? raw : undefined));
  const showChanges = Boolean(change) && changedOnly;

  const vars = useMemo(() => catalog?.vars ?? [], [catalog]);
  const scopes = catalog?.scopes ?? [];
  const tagCounts = useMemo(() => {
    const counts = new Map<EnvTag, number>();
    for (const v of vars) for (const t of v.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return counts;
  }, [vars]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return vars.filter((v) => {
      if (!inScope(v, scope)) return false;
      if (tags.size && ![...tags].every((t) => v.tags.includes(t))) return false;
      if (!q) return true;
      return v.name.toLowerCase().includes(q) || v.sets.some((s) => s.value?.toLowerCase().includes(q) || s.file.toLowerCase().includes(q)) || v.reads.some((r) => r.file.toLowerCase().includes(q));
    });
  }, [vars, query, tags, scope]);

  // Columns: targets that set at least one visible name.
  const targets = useMemo(() => {
    const used = new Set(visible.flatMap((v) => v.sets.map((s) => s.target)));
    return (catalog?.targets ?? []).filter((t) => used.has(t.id));
  }, [catalog?.targets, visible]);

  const groups = useMemo(() => {
    const out = new Map<string, EnvVar[]>();
    for (const v of visible) {
      const key = v.tags.includes("platform") ? "Platform" : groupBy === "prefix" ? v.group || "Other" : moduleOf(v.reads[0]?.file ?? v.decls[0]?.file ?? v.sets[0]?.file ?? "");
      (out.get(key) ?? out.set(key, []).get(key)!).push(v);
    }
    const entries = [...out];
    // Named groups first, then "Other", platform last.
    entries.sort((a, b) => rankGroup(a[0]) - rankGroup(b[0]) || a[0].localeCompare(b[0]));
    return entries;
  }, [visible, groupBy]);

  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (name: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    setOpen((s) => new Set(s).add(focus.id));
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-env="${CSS.escape(focus.id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, [focus]);

  const total = vars.length;
  const changeCount = change?.changes.length ?? 0;

  return (
    <div className={className}>
      <div className={VIEW_TOOLBAR}>
        {change && (
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
                    Env changes <span className="font-mono text-muted-foreground">{changeCount}</span>
                  </>
                ),
                title: "What this diff does to the env vars: reads, declarations and values per environment added, removed or changed",
              },
              {
                value: "all" as const,
                label: (
                  <>
                    All variables <span className="font-mono text-muted-foreground">{total}</span>
                  </>
                ),
                title: "Every env var name, per environment",
              },
            ]}
          />
        )}
        {changePending && !change && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" aria-hidden /> Comparing env vars…
          </span>
        )}
        {!showChanges && scopes.length > 1 && (
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            Scope
            <select value={scope ?? ""} onChange={(e) => setScope(e.target.value === "" ? null : e.target.value)} className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground">
              <option value="">Whole repo</option>
              {scopes.map((s) => (
                <option key={s.root} value={s.root}>
                  {s.root || "(root)"}
                  {s.framework ? ` · ${s.framework}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {!showChanges && (
          <Segmented
            label="Group by"
            size="xs"
            value={groupBy}
            onChange={setGroupBy}
            options={[
              { value: "prefix" as const, label: "Prefix", title: "Group names by their shared prefix (DATABASE_*, NEXT_PUBLIC_*)" },
              { value: "folder" as const, label: "Folder", title: "Group names by the folder whose code reads them" },
            ]}
          />
        )}
        {/* The buttons first, the count after them. */}
        {!change && catalog?.state === "ready" && (
          <span className="font-mono text-[11px] text-muted-foreground">{total} variables</span>
        )}
        {!showChanges && (
          <div className="flex flex-wrap items-center gap-1">
            {ROW_TAGS.filter((t) => tagCounts.get(t)).map((t) => (
              <button
                key={t}
                type="button"
                title={TAG_STYLES[t].title}
                onClick={() =>
                  setTags((s) => {
                    const next = new Set(s);
                    if (next.has(t)) next.delete(t);
                    else next.add(t);
                    return next;
                  })
                }
                className={cn("rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap", TAG_STYLES[t].className, tags.has(t) ? "ring-1 ring-foreground/40" : "opacity-80 hover:opacity-100")}
              >
                {TAG_STYLES[t].label} <span className="font-mono">{tagCounts.get(t)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {loading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          <button
            type="button"
            onClick={() => setHideValues(!hideValues)}
            className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            title="Blur every value, for screen-sharing (remembered in this browser)"
            aria-pressed={hideValues}
          >
            {hideValues ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
            {hideValues ? "Values hidden" : "Hide values"}
          </button>
          <label className="flex h-7 w-44 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs focus-within:border-foreground/30">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a variable…"
              aria-label="Find env vars by name, value or file"
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

      <div ref={listRef} className="@container relative min-h-[220px] flex-1 overflow-auto bg-background">
        {error && !catalog && (
          <p className="flex items-start gap-2 px-6 py-8 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error}
          </p>
        )}
        {!catalog && !error && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading env vars…
          </div>
        )}
        {catalog?.state === "none" && (
          <p className="px-6 py-12 text-center text-sm text-muted-foreground">The env var list is built during analysis — it appears once this repo&apos;s next analysis finishes.</p>
        )}
        {catalog?.state === "ready" && total === 0 && !change && (
          <div className="mx-auto max-w-lg px-6 py-12 text-sm text-muted-foreground">
            <p className="text-foreground">No env vars found.</p>
            <p className="mt-2 leading-relaxed">
              Looked for reads in TS/JS, Python, Java/Kotlin and Go code; typed env schemas (t3-env, zod, envalid, pydantic, django-environ, Go struct tags);
              committed `.env*` files; GitHub Actions, GitLab CI and Jenkinsfiles; Docker Compose; next.config and vite.config; Prisma schemas; and the
              env of Nomad jobs, Kubernetes workloads and Dockerfiles.
            </p>
          </div>
        )}

        {showChanges && change ? (
          <EnvChangeList change={change} hideValues={hideValues} onOpenFile={onOpenFile} />
        ) : (
          catalog?.state === "ready" &&
          total > 0 && (
            <>
              {visible.length === 0 && <p className="px-6 py-12 text-center text-sm text-muted-foreground">Nothing matches.</p>}
              {visible.length > 0 && (
                <table className="min-w-full border-separate border-spacing-0 text-xs">
                  <thead>
                    <tr className="text-left text-[11px] text-muted-foreground">
                      <th className="sticky top-0 left-0 z-30 min-w-64 border-b border-border bg-background px-3 py-1.5 font-normal">Name</th>
                      <th className="sticky top-0 z-20 min-w-44 border-b border-border bg-background px-2 py-1.5 font-normal">Read by</th>
                      <th className="sticky top-0 z-20 min-w-28 border-b border-border bg-background px-2 py-1.5 font-normal">Declared</th>
                      {targets.map((t) => (
                        <th key={t.id} className="sticky top-0 z-20 min-w-32 border-b border-border bg-background px-2 py-1.5 font-normal whitespace-nowrap" title={`${t.kind} · ${t.files.join(", ")}`}>
                          {t.id}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map(([group, list]) => (
                      <Fragment key={group}>
                        <tr>
                          <td className="sticky left-0 z-10 border-b border-border bg-secondary/60 px-3 py-1 text-[11px] font-semibold text-muted-foreground">
                            {group}
                            <span className="ml-2 font-mono font-normal">{list.length}</span>
                          </td>
                          <td colSpan={2 + targets.length} className="border-b border-border bg-secondary/60" />
                        </tr>
                        {list.map((v) => (
                          <EnvRow
                            key={v.name}
                            v={v}
                            targets={targets}
                            scope={scope}
                            open={open.has(v.name)}
                            onToggle={() => toggle(v.name)}
                            hideValues={hideValues}
                            onOpenFile={onOpenFile}
                            onOpenInfra={onOpenInfra}
                            fileComponents={catalog?.fileComponents}
                            onOpenComponent={onOpenComponent}
                          />
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}

function rankGroup(g: string): number {
  return g === "Platform" ? 2 : g === "Other" ? 1 : 0;
}

function EnvRow({
  v,
  targets,
  scope,
  open,
  onToggle,
  hideValues,
  onOpenFile,
  onOpenInfra,
  fileComponents,
  onOpenComponent,
}: {
  v: EnvVar;
  targets: EnvTarget[];
  scope: string | null;
  open: boolean;
  onToggle: () => void;
  hideValues: boolean;
  onOpenFile: (path: string, line?: number) => void;
  onOpenInfra?: (resourceId: string) => void;
  fileComponents?: EnvCatalogResponseDTO["fileComponents"];
  onOpenComponent?: (componentId: string) => void;
}) {
  const platform = v.tags.includes("platform");
  /**
   * One chip per component reading it, with the folder its reading files
   * share; reads in no known component, one per two-level folder. Most reads first.
   */
  const readers = useMemo(() => {
    const m = new Map<string, { component?: { id: string; name: string }; folder: string; n: number }>();
    for (const r of v.reads) {
      if (r.host) continue;
      const component = fileComponents?.[r.file];
      const dir = r.file.includes("/") ? r.file.slice(0, r.file.lastIndexOf("/")) : "";
      const key = component?.id ?? `folder:${moduleOf(r.file)}`;
      const hit = m.get(key);
      if (!hit) m.set(key, { ...(component ? { component } : {}), folder: component ? dir : moduleOf(r.file), n: 1 });
      else {
        hit.n++;
        if (component) hit.folder = commonFolder(hit.folder, dir);
      }
    }
    return [...m].sort((a, b) => b[1].n - a[1].n);
  }, [v.reads, fileComponents]);
  const required = v.reads.some((r) => r.required);
  const fallback = v.reads.find((r) => r.fallback !== undefined)?.fallback;
  const decl = v.decls.find((d) => d.via !== "example");
  return (
    <>
      <tr data-env={v.name} className={cn("group scroll-mt-8 cursor-pointer", platform && "text-muted-foreground", open && "bg-secondary/30")} onClick={onToggle}>
        <td className={cn("sticky left-0 z-10 border-b border-border px-3 py-1.5 align-top", open ? "bg-secondary" : "bg-background group-hover:bg-secondary/50")}>
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
            <span className="font-mono">{v.name}</span>
            {v.tags
              .filter((t) => ROW_TAGS.includes(t))
              .map((t) => (
                <span key={t} className={cn("rounded px-1 text-[10px]", TAG_STYLES[t].className)} title={t === "client" && v.clientVia ? `Exposed to the browser: ${v.clientVia}` : TAG_STYLES[t].title}>
                  {TAG_STYLES[t].label}
                </span>
              ))}
          </div>
        </td>
        <td className="border-b border-border px-2 py-1.5 align-top">
          <div className="flex flex-wrap items-center gap-1">
            {readers.slice(0, 3).map(([key, { component, folder, n }]) => {
              const title = `${n} read(s) under ${folder || "(root)"}${component ? ` — component ${component.name}${onOpenComponent ? " (click to show it on the map)" : ""}` : ""}`;
              const body = (
                <>
                  {component && <span className="font-sans font-medium">{component.name}</span>}
                  {(!component || (folder || "(root)") !== component.name) && (
                    <span className={cn(component && "text-muted-foreground")}>{component ? ` · ${folder || "(root)"}` : folder}</span>
                  )}
                  {n > 1 ? ` ×${n}` : ""}
                </>
              );
              return component && onOpenComponent ? (
                <button
                  key={key}
                  type="button"
                  className="rounded bg-secondary px-1 text-left font-mono text-[10px] hover:bg-foreground/10"
                  title={title}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenComponent(component.id);
                  }}
                >
                  {body}
                </button>
              ) : (
                <span key={key} className="rounded bg-secondary px-1 font-mono text-[10px]" title={title}>
                  {body}
                </span>
              );
            })}
            {readers.length > 3 && <span className="text-[10px] text-muted-foreground">+{readers.length - 3}</span>}
            {required && <span className="text-[10px] text-muted-foreground" title="A read requires it (non-null, os.environ[…], or a throw guard)">✱</span>}
            {fallback !== undefined && (
              <span className={cn("max-w-28 truncate font-mono text-[10px] text-muted-foreground", hideValues && "blur-[3px]")} title={`Falls back to ${fallback}`}>
                ?? {fallback}
              </span>
            )}
            {readers.length === 0 && !v.reads.length && <span className="text-muted-foreground">—</span>}
          </div>
        </td>
        <td className="border-b border-border px-2 py-1.5 align-top font-mono text-[11px]">
          {decl ? (
            <span title={`${decl.via} · ${decl.file}:${decl.line}`}>
              {decl.type ?? decl.via}
              {decl.default !== undefined && <span className={cn("text-muted-foreground", hideValues && "blur-[3px]")}>={decl.default}</span>}
              {decl.optional && <span className="text-muted-foreground">?</span>}
            </span>
          ) : v.decls.length ? (
            <span className="text-muted-foreground" title="Only an example file names it">
              example
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        {targets.map((t) => (
          <td key={t.id} className="border-b border-border px-2 py-1.5 align-top">
            <Cell v={v} target={t} scope={scope} hideValues={hideValues} />
          </td>
        ))}
      </tr>
      {open && (
        <tr>
          <td colSpan={3 + targets.length} className="border-b border-border bg-secondary/20 p-0">
            {/* Pinned to the visible width, so the detail doesn't scroll away sideways with the columns. */}
            <div className="sticky left-0 w-[100cqw] max-w-full">
              <EnvVarDetail v={v} hideValues={hideValues} onOpenFile={onOpenFile} onOpenInfra={onOpenInfra} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Cell({ v, target, scope, hideValues }: { v: EnvVar; target: EnvTarget; scope: string | null; hideValues: boolean }) {
  const cell = cellOf(v, target, scope);
  if (cell.sets.length === 0) {
    if (cell.inherited) {
      return (
        <span className="text-[11px] text-muted-foreground" title={`Not in this file — the folder's .env gives it ${cell.inherited.value ?? ""}`}>
          ↳ default
        </span>
      );
    }
    return <span className="text-muted-foreground">—</span>;
  }
  const s = cell.sets[0];
  return (
    <span className="flex min-w-0 items-center gap-1">
      <SetValue name={v.name} set={s} hideValues={hideValues} />
      {cell.sets.length > 1 && (
        <span className="shrink-0 text-[10px] text-muted-foreground" title={cell.sets.slice(1).map((x) => `${x.file}: ${x.ref ?? x.value ?? ""}`).join("\n")}>
          +{cell.sets.length - 1}
        </span>
      )}
    </span>
  );
}

function SetValue({ name, set, hideValues, className }: { name: string; set: EnvSet; hideValues: boolean; className?: string }) {
  if (set.ref) {
    return (
      <span className={cn("flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground", className)} title={`${set.ref} — the value lives outside the repo (${set.file}:${set.line})`}>
        <Lock className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{set.ref}</span>
      </span>
    );
  }
  const value = set.value ?? "";
  return (
    <span
      className={cn("block max-w-64 truncate font-mono text-[11px]", value === "" && "text-muted-foreground italic", hideValues && "blur-[3px] select-none", className)}
      title={hideValues ? `${name} (hidden)` : `${value}\n${set.file}:${set.line}${set.interpolated ? " · interpolated" : ""}`}
    >
      {value === "" ? "empty" : value}
    </span>
  );
}

function EnvVarDetail({ v, hideValues, onOpenFile, onOpenInfra }: { v: EnvVar; hideValues: boolean; onOpenFile: (path: string, line?: number) => void; onOpenInfra?: (resourceId: string) => void }) {
  const fileLink = (file: string, line: number) => (
    <button type="button" onClick={() => onOpenFile(file, line)} className="font-mono text-[11px] hover:underline">
      {file}:{line}
    </button>
  );
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-3 px-6 py-3 text-xs @3xl:grid-cols-2" onClick={(e) => e.stopPropagation()}>
      <section>
        <h4 className="mb-1 text-[11px] text-muted-foreground">Reads · {v.reads.length}</h4>
        {v.reads.length === 0 && <p className="text-muted-foreground">Nothing reads it.</p>}
        <ul className="space-y-0.5">
          {v.reads.slice(0, 40).map((r, i) => (
            <li key={`${r.file}:${r.line}:${i}`} className="flex flex-wrap items-baseline gap-1.5">
              {fileLink(r.file, r.line)}
              {r.required && <span className="text-[10px] text-muted-foreground">required</span>}
              {r.fallback !== undefined && <span className={cn("font-mono text-[10px] text-muted-foreground", hideValues && "blur-[3px]")}>?? {r.fallback}</span>}
              {r.client && <span className={cn("rounded px-1 text-[10px]", TAG_STYLES.client.className)}>client code</span>}
              {r.host && <span className="text-[10px] text-muted-foreground">host env</span>}
              {r.gap && <span className={cn("rounded px-1 text-[10px]", TAG_STYLES[r.gap].className)}>{TAG_STYLES[r.gap].label}</span>}
            </li>
          ))}
          {v.reads.length > 40 && <li className="text-muted-foreground">{v.reads.length - 40} more</li>}
        </ul>
      </section>
      <section>
        <h4 className="mb-1 text-[11px] text-muted-foreground">Declared · {v.decls.length}</h4>
        {v.decls.length === 0 && <p className="text-muted-foreground">No schema or example names it.</p>}
        <ul className="space-y-0.5">
          {v.decls.map((d, i) => (
            <li key={`${d.file}:${d.line}:${i}`} className="flex flex-wrap items-baseline gap-1.5">
              {fileLink(d.file, d.line)}
              <span className="text-[11px]">{d.via}</span>
              {d.type && <span className="font-mono text-[11px] text-muted-foreground">{d.type}</span>}
              {d.default !== undefined && d.via !== "example" && <span className={cn("font-mono text-[11px] text-muted-foreground", hideValues && "blur-[3px]")}>default {d.default}</span>}
              {d.optional && <span className="text-[10px] text-muted-foreground">optional</span>}
              {d.client && <span className={cn("rounded px-1 text-[10px]", TAG_STYLES.client.className)}>client</span>}
              {d.description && <span className="text-[11px] text-muted-foreground">— {d.description}</span>}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4 className="mb-1 text-[11px] text-muted-foreground">Sets · {v.sets.length}</h4>
        {v.sets.length === 0 && <p className="text-muted-foreground">No committed source sets it.</p>}
        <ul className="space-y-0.5">
          {v.sets.map((s) => (
            <li key={s.id} className="flex min-w-0 flex-wrap items-baseline gap-1.5">
              <span className="font-mono text-[11px] text-muted-foreground">{s.target}</span>
              <SetValue name={v.name} set={s} hideValues={hideValues} className="max-w-96" />
              {fileLink(s.file, s.line)}
              {s.interpolated && <span className="text-[10px] text-muted-foreground">interpolated</span>}
              {s.scope.length > 0 && s.scope[0] !== "" && <span className="text-[10px] text-muted-foreground">reaches {s.scope.join(", ")}</span>}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4 className="mb-1 text-[11px] text-muted-foreground">Exposure</h4>
        <p>{v.clientVia ? <>Exposed to the browser — {v.clientVia}.</> : v.tags.includes("undefined-in-client") ? <>Read in client code without the client prefix: undefined in the browser.</> : <>Server only.</>}</p>
        {v.infra.length > 0 && (
          <>
            <h4 className="mt-2 mb-1 text-[11px] text-muted-foreground">Set by infrastructure</h4>
            <ul className="space-y-0.5">
              {v.infra.map((id) => (
                <li key={id}>
                  <button type="button" onClick={() => onOpenInfra?.(id)} className="font-mono text-[11px] text-sky-400 hover:underline" disabled={!onOpenInfra}>
                    {id} →
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Env changes
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<EnvChangeEntry["status"], { word: string; className: string }> = {
  new: { word: "new", className: "bg-success/15 text-success" },
  gone: { word: "gone", className: "bg-destructive/15 text-destructive" },
  changed: { word: "changed", className: "bg-warning/15 text-warning" },
};

function EnvChangeList({ change, hideValues, onOpenFile }: { change: EnvChange; hideValues: boolean; onOpenFile: (path: string, line?: number) => void }) {
  const findingsByKey = useMemo(() => new Map(change.findings.map((f) => [f.key, f])), [change.findings]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(change.changes.slice(0, AUTO_OPEN).map((c) => c.name)));
  if (change.changes.length === 0) {
    return <p className="px-6 py-12 text-center text-sm text-muted-foreground">This diff doesn&apos;t change any env var — no read, declaration or value was added, removed or changed.</p>;
  }
  return (
    <ul>
      {change.changes.map((c) => {
        const findings = (c.findings ?? []).map((k) => findingsByKey.get(k)).filter((f): f is EnvFinding => Boolean(f));
        const isOpen = open.has(c.name);
        const worst = findings.some((f) => f.assessment === "defect") ? "defect" : findings.length ? "concern" : undefined;
        return (
          <li key={c.name} data-env={c.name} className="scroll-mt-2 border-b border-border" style={worst ? { boxShadow: `inset 3px 0 0 ${ASSESSMENT_VISUALS[worst].color}` } : undefined}>
            <button
              type="button"
              onClick={() =>
                setOpen((s) => {
                  const next = new Set(s);
                  if (next.has(c.name)) next.delete(c.name);
                  else next.add(c.name);
                  return next;
                })
              }
              className="flex w-full flex-wrap items-center gap-1.5 px-4 py-2 text-left text-xs hover:bg-secondary/40"
            >
              <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} aria-hidden />
              {findings.map((f) => (
                <span key={f.key} className="rounded px-1 text-[10px]" style={{ color: ASSESSMENT_VISUALS[f.assessment].text, background: `${ASSESSMENT_VISUALS[f.assessment].color}22` }}>
                  {f.assessment}
                </span>
              ))}
              <span className="font-mono font-medium">{c.name}</span>
              <span className={cn("rounded px-1 text-[10px]", STATUS_STYLES[c.status].className)}>{STATUS_STYLES[c.status].word}</span>
              {c.newTags
                .filter((t) => ROW_TAGS.includes(t))
                .map((t) => (
                  <span key={t} className={cn("rounded px-1 text-[10px]", TAG_STYLES[t].className)} title={`Now ${TAG_STYLES[t].label}: ${TAG_STYLES[t].title}`}>
                    now {TAG_STYLES[t].label}
                  </span>
                ))}
            </button>
            {isOpen && (
              <div className="px-10 pb-3 text-xs">
                {findings.map((f) => (
                  <p key={f.key} className="mb-1.5 text-muted-foreground" title={f.rationale}>
                    {f.summary}{" "}
                    <button type="button" onClick={() => onOpenFile(f.file, f.line)} className="font-mono text-[11px] text-foreground hover:underline">
                      {f.file}
                      {f.line ? `:${f.line}` : ""}
                    </button>
                  </p>
                ))}
                <div className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                  {c.deltas.map((d, i) => (
                    <Fragment key={`${d.where}:${i}`}>
                      <span className="truncate text-muted-foreground">{d.where}</span>
                      <DeltaValue text={d.before} sign="−" hide={hideValues && d.where !== "read" && d.where !== "declared"} />
                      <DeltaValue
                        text={d.after}
                        sign="+"
                        hide={hideValues && d.where !== "read" && d.where !== "declared"}
                        onClick={d.file && d.after !== undefined ? () => onOpenFile(d.file!, d.line) : undefined}
                      />
                    </Fragment>
                  ))}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function DeltaValue({ text, sign, hide, onClick }: { text?: string; sign: "+" | "−"; hide: boolean; onClick?: () => void }) {
  if (text === undefined) return <span className="text-muted-foreground">—</span>;
  const content = (
    <span className={cn("block truncate font-mono text-[11px]", sign === "+" ? "text-success" : "text-destructive", hide && "blur-[3px] select-none")} title={hide ? undefined : text}>
      {sign} {text === "" ? "empty" : text}
    </span>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="min-w-0 text-left hover:underline">
      {content}
    </button>
  ) : (
    content
  );
}

export function EnvChangeCounts({ change, className }: { change: EnvChange; className?: string }) {
  const c = change.counts;
  const parts: Array<[string, string, string]> = [];
  if (c.new) parts.push([`+${c.new}`, "text-success", `${c.new} new`]);
  if (c.gone) parts.push([`−${c.gone}`, "text-destructive", `${c.gone} gone`]);
  if (c.changed) parts.push([`~${c.changed}`, "text-warning", `${c.changed} changed`]);
  if (parts.length === 0) return <span className={cn("font-mono text-[11px] font-normal text-muted-foreground", className)}>none</span>;
  return (
    <span className={cn("flex items-center gap-1.5 font-mono text-[11px] font-normal", className)}>
      {parts.map(([text, tone, title]) => (
        <span key={title} className={tone} title={title}>
          {text}
        </span>
      ))}
    </span>
  );
}
