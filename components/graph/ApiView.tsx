"use client";

// The Graph tab's API view (DESIGN.md §6.11): every endpoint the analysed
// commit exposes — HTTP routes, server actions (labelled internal: they are
// the app's own backend-for-frontend), tRPC procedures and GraphQL fields —
// read like an OpenAPI page. A row is method · path · summary; clicking it
// opens the endpoint in place (`ApiEndpointDetail`): parameters, request
// and response payloads, handler, auth and the functions it calls. Nothing
// needs the right column.
//
// With a diff selected the view opens on "API changes": only the endpoints
// the diff adds, removes or changes (path, method, parameters, request or
// response shape, auth), breaking first, the changed ones already open on
// their before / after payloads. "All endpoints" shows the whole catalog,
// grouped by resource, with the changes marked. Code changed behind an
// unchanged endpoint is not an API change and isn't listed.

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, LoaderCircle, Search, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { Segmented } from "./Segmented";
import { VIEW_TOOLBAR } from "./view-chrome";
import { ApiEndpointDetail } from "./ApiEndpointDetail";
import { CHANGE_STYLES, KIND_LABELS, methodTone, pathParts, type ApiRow } from "./api-view-model";
import type { ApiCatalogResponseDTO, ApiChange, EndpointKind } from "./api-types";
import type { UseApiCatalogResult } from "./useApiCatalog";

type KindFilter = "all" | EndpointKind;

/** In "API changes", changed endpoints open on their before / after — up to this many. */
const AUTO_OPEN = 8;

export interface ApiViewProps {
  catalog: ApiCatalogResponseDTO | null;
  rows: ApiRow[];
  loading: boolean;
  error: string | null;
  /** The selected diff's API change, when there is one. */
  change?: ApiChange;
  /** The comparison is still running. */
  changePending?: boolean;
  changedOnly: boolean;
  onChangedOnlyChange: (value: boolean) => void;
  /** An endpoint opened from elsewhere (the left column) — opened and scrolled to. A new object each time, so the same one can be asked for twice. */
  focus: { id: string } | null;
  infer: Pick<UseApiCatalogResult, "inferring" | "inferErrors" | "infer">;
  onOpenFile: (path: string, line?: number) => void;
  leading?: React.ReactNode;
  className?: string;
}

export function ApiView({
  catalog,
  rows,
  loading,
  error,
  change,
  changePending,
  changedOnly,
  onChangedOnlyChange,
  focus,
  infer,
  onOpenFile,
  leading,
  className,
}: ApiViewProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const showChanges = Boolean(change) && changedOnly;

  const kinds = useMemo(() => [...new Set(rows.map((r) => r.endpoint.kind))], [rows]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const order = { removed: 0, changed: 1, added: 2 } as const;
    const list = rows.filter((r) => {
      if (showChanges && !r.change) return false;
      if (kind !== "all" && r.endpoint.kind !== kind) return false;
      if (!q) return true;
      const e = r.endpoint;
      return [e.path, e.method, e.group, e.framework, e.handler?.name ?? "", e.handler?.file ?? "", ...e.auth, e.spec?.summary ?? "", e.summary ?? ""].some((t) => t.toLowerCase().includes(q));
    });
    if (showChanges) {
      list.sort(
        (a, b) =>
          Number(Boolean(b.change?.breaking)) - Number(Boolean(a.change?.breaking)) ||
          order[a.change!.status] - order[b.change!.status] ||
          a.endpoint.path.localeCompare(b.endpoint.path)
      );
    }
    return list;
  }, [rows, query, kind, showChanges]);

  // Grouped by resource for the whole catalog; the changes are one flat list.
  const groups = useMemo(() => {
    if (showChanges) return [["", visible] as const];
    const out = new Map<string, ApiRow[]>();
    for (const r of visible) {
      const key = `${r.endpoint.kind === "http" ? "" : `${KIND_LABELS[r.endpoint.kind]} · `}${r.endpoint.group}`;
      (out.get(key) ?? out.set(key, []).get(key)!).push(r);
    }
    return [...out];
  }, [visible, showChanges]);

  // Which rows are open. Entering "API changes" opens the changed ones.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const changeKey = change ? change.changes.map((c) => c.id).join("|") : "";
  useEffect(() => {
    if (!showChanges || !change) return;
    setOpen(new Set(change.changes.filter((c) => c.status === "changed").slice(0, AUTO_OPEN).map((c) => c.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run per set of changes, not per object identity
  }, [showChanges, changeKey]);
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // An endpoint opened from the left column: open it and scroll to it.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    setOpen((s) => new Set(s).add(focus.id));
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-endpoint="${CSS.escape(focus.id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, [focus]);

  const total = catalog?.endpoints.length ?? 0;
  const changeCount = change?.changes.length ?? 0;

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
                    API changes <span className="font-mono text-muted-foreground">{changeCount}</span>
                  </>
                ),
                title: "What this diff changes in the API: endpoints added, removed, or with a new path, method, parameters, request or response shape, or auth",
              },
              {
                value: "all" as const,
                label: (
                  <>
                    All endpoints <span className="font-mono text-muted-foreground">{total}</span>
                  </>
                ),
                title: "Every endpoint, with this diff's changes marked",
              },
            ]}
          />
        ) : (
          catalog?.state === "ready" && <span className="font-mono text-[11px] text-muted-foreground">{total} endpoints</span>
        )}
        {changePending && !change && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" aria-hidden /> Comparing the API…
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {loading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          {kinds.length > 1 && !showChanges && (
            <Segmented
              label="Kind"
              size="xs"
              value={kind}
              onChange={setKind}
              options={[{ value: "all" as const, label: "All" }, ...kinds.map((k) => ({ value: k, label: k === "action" ? "Actions" : KIND_LABELS[k] }))]}
            />
          )}
          <label className="flex h-7 w-44 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs focus-within:border-foreground/30">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find an endpoint…"
              aria-label="Find endpoints by path, handler or middleware"
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
            <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading endpoints…
          </div>
        )}
        {catalog?.state === "none" && (
          <p className="px-6 py-12 text-center text-sm text-muted-foreground">
            The endpoint list is built during analysis — it appears once this repo&apos;s next analysis finishes.
          </p>
        )}
        {catalog?.state === "ready" && total === 0 && !change && (
          <div className="mx-auto max-w-lg px-6 py-12 text-sm text-muted-foreground">
            <p className="text-foreground">No endpoints found.</p>
            <p className="mt-2 leading-relaxed">
              Looked for Next.js route handlers, API routes and server actions; Express, Fastify, Hono, Koa, Elysia and lambda-api
              routers; NestJS, Spring, JAX-RS and Micronaut controllers; FastAPI, Flask, Django and Django REST; SvelteKit, Nuxt and
              Astro endpoints; tRPC routers; GraphQL schemas; and OpenAPI / Swagger files.
            </p>
          </div>
        )}
        {catalog?.state === "ready" && visible.length === 0 && (total > 0 || change) && (
          <p className="px-6 py-12 text-center text-sm text-muted-foreground">
            {showChanges && changeCount === 0
              ? "This diff doesn't change the API — no endpoint was added or removed, and none changed its path, method, parameters, payloads or auth."
              : "Nothing matches."}
          </p>
        )}

        {groups.map(([group, list]) => (
          <section key={group || "changes"}>
            {group && (
              <h3 className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 pt-3 pb-1 text-xs font-semibold backdrop-blur">
                {group}
                <span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground">{list.length}</span>
              </h3>
            )}
            <ul>
              {list.map((row) => {
                const id = row.endpoint.id;
                const isOpen = open.has(id);
                return (
                  <li key={id} data-endpoint={id} className="scroll-mt-2">
                    <EndpointRow row={row} open={isOpen} onToggle={() => toggle(id)} />
                    {isOpen && (
                      <ApiEndpointDetail
                        endpoint={row.endpoint}
                        change={row.change}
                        aiConfigured={catalog?.aiConfigured ?? false}
                        inferring={infer.inferring.has(id)}
                        inferError={infer.inferErrors.get(id)}
                        onInfer={() => void infer.infer(id)}
                        onOpenFile={onOpenFile}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {catalog && catalog.unresolvedMounts > 0 && !showChanges && (
          <p className="px-4 py-3 text-[11px] text-muted-foreground">
            {catalog.unresolvedMounts} router{catalog.unresolvedMounts === 1 ? " is" : "s are"} mounted somewhere static analysis couldn&apos;t follow — their
            paths start with “…”.
          </p>
        )}
      </div>
    </div>
  );
}

export function ChangeCounts({ change, className }: { change: ApiChange; className?: string }) {
  const c = change.counts;
  const parts: Array<[string, string, string]> = [];
  if (c.added) parts.push([`+${c.added}`, "text-success", `${c.added} new`]);
  if (c.removed) parts.push([`−${c.removed}`, "text-destructive", `${c.removed} removed`]);
  if (c.changed) parts.push([`~${c.changed}`, "text-warning", `${c.changed} changed`]);
  if (parts.length === 0) return <span className={cn("font-mono text-[11px] font-normal text-muted-foreground", className)}>none</span>;
  return (
    <span className={cn("flex items-center gap-1.5 font-mono text-[11px] font-normal", className)}>
      {parts.map(([text, tone, title]) => (
        <span key={title} className={tone} title={title}>
          {text}
        </span>
      ))}
      {c.breaking > 0 && (
        <span className="text-destructive" title={`${c.breaking} can break an existing client`}>
          · {c.breaking} breaking
        </span>
      )}
    </span>
  );
}

/** The method as a small tinted pill, fixed width so paths line up. */
export function MethodBadge({ method, className }: { method: string; className?: string }) {
  return (
    <span className={cn("inline-flex w-[4.25rem] shrink-0 justify-center rounded-[3px] bg-current/10 py-px font-mono text-[10px] font-semibold", methodTone(method), className)}>
      {method}
    </span>
  );
}

export function EndpointPath({ path, partial, className }: { path: string; partial?: boolean; className?: string }) {
  return (
    <span className={cn("min-w-0 truncate font-mono text-xs", className)} title={partial ? `${path}\nPart of this path couldn't be read statically.` : path}>
      {pathParts(path).map((part, i) => (
        <span key={i} className={part.param ? "text-brand" : undefined}>
          {part.text}
        </span>
      ))}
      {partial && <span className="ml-1 text-[10px] text-warning" aria-label="partly unresolved">◌</span>}
    </span>
  );
}

function Tag({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span className={cn("shrink-0 rounded-[3px] border px-1.5 text-[10px] leading-4", className)} title={title}>
      {children}
    </span>
  );
}

function EndpointRow({ row, open, onToggle }: { row: ApiRow; open: boolean; onToggle: () => void }) {
  const e = row.endpoint;
  const status = row.change?.status;
  const style = status ? CHANGE_STYLES[status] : null;
  const summary = e.spec?.summary ?? e.summary;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 border-b border-border/60 px-4 py-2 text-left transition-colors hover:bg-secondary/50",
        open && "bg-card/60",
        status === "removed" && "opacity-75"
      )}
    >
      <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
      <MethodBadge method={e.method} />
      <EndpointPath path={e.path} partial={e.partial} className={cn("shrink-0 max-w-[60%]", status === "removed" && "line-through")} />
      {summary && <span className="hidden min-w-0 truncate text-[11px] text-muted-foreground @xl:inline">{summary}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {e.internal && (
          <Tag className="border-border text-muted-foreground" title="A server action: made for the app's own pages, not for third parties">
            internal
          </Tag>
        )}
        {e.drift && (
          <Tag className="border-warning/40 text-warning" title={e.drift === "spec-only" ? "The OpenAPI spec lists it; no code for it was found" : "In the code, but the OpenAPI spec doesn't list it"}>
            {e.drift === "spec-only" ? "spec only" : "not in spec"}
          </Tag>
        )}
        {style && (
          <Tag className={cn("border-current/40", style.className)} title={style.title}>
            {style.word}
          </Tag>
        )}
        {row.change?.breaking && (
          <Tag className="border-destructive/50 bg-destructive/10 text-destructive" title="A client written against the base can fail">
            breaking
          </Tag>
        )}
      </span>
    </button>
  );
}
