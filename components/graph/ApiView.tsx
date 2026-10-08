"use client";

// The Graph tab's API view (DESIGN.md §6.11): every endpoint the analysed
// commit exposes — HTTP routes, server actions (labelled internal: they are
// the app's own backend-for-frontend), tRPC procedures and GraphQL fields —
// as one dense list grouped by resource, like an OpenAPI page: method ·
// path · kind · middleware/auth · handler. Selecting a row opens the
// explainer in the right column (`ApiPanel`).
//
// With a diff selected, the list shows only its changes to the API: new,
// removed and changed endpoints (path, method, parameters, request or
// response shape, auth), breaking ones marked. "All endpoints" brings back
// the whole catalog with the changes marked in it. Code changed behind an
// unchanged endpoint is not an API change and isn't listed.

import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Search, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { Segmented } from "./Segmented";
import { VIEW_TOOLBAR } from "./view-chrome";
import { CHANGE_STYLES, KIND_LABELS, methodTone, pathParts, type ApiRow } from "./api-view-model";
import type { ApiCatalogResponseDTO, ApiChange, EndpointKind } from "./api-types";

type KindFilter = "all" | EndpointKind;

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
  selectedId: string | null;
  onSelect: (id: string | null) => void;
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
  selectedId,
  onSelect,
  leading,
  className,
}: ApiViewProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");

  const kinds = useMemo(() => [...new Set(rows.map((r) => r.endpoint.kind))], [rows]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (changedOnly && change && !r.change) return false;
      if (kind !== "all" && r.endpoint.kind !== kind) return false;
      if (!q) return true;
      const e = r.endpoint;
      return [e.path, e.method, e.group, e.framework, e.handler?.name ?? "", e.handler?.file ?? "", ...e.auth, e.spec?.summary ?? "", e.summary ?? ""].some((t) => t.toLowerCase().includes(q));
    });
  }, [rows, query, kind, changedOnly, change]);

  const groups = useMemo(() => {
    const out = new Map<string, ApiRow[]>();
    for (const r of visible) {
      const key = `${r.endpoint.kind === "http" ? "" : `${KIND_LABELS[r.endpoint.kind]} · `}${r.endpoint.group}`;
      (out.get(key) ?? out.set(key, []).get(key)!).push(r);
    }
    return [...out];
  }, [visible]);

  // An endpoint opened from elsewhere (the left column, an area) scrolls into view.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-endpoint="${CSS.escape(selectedId)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId, groups]);

  const total = catalog?.endpoints.length ?? 0;
  const drift = rows.filter((r) => r.endpoint.drift).length;

  return (
    <div className={className}>
      <div className={VIEW_TOOLBAR}>
        {leading}
        <label className="flex h-7 w-40 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs focus-within:border-foreground/30">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find…"
            aria-label="Find endpoints by path, handler or middleware"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear" className="text-muted-foreground hover:text-foreground">
              <X className="size-3" />
            </button>
          )}
        </label>
        {kinds.length > 1 && (
          <Segmented
            label="Kind"
            size="xs"
            value={kind}
            onChange={setKind}
            options={[{ value: "all" as const, label: "All" }, ...kinds.map((k) => ({ value: k, label: k === "action" ? "Actions" : KIND_LABELS[k] }))]}
          />
        )}
        {change && (
          <>
            <Segmented
              label="Show"
              size="xs"
              value={changedOnly ? "changes" : "all"}
              onChange={(v) => onChangedOnlyChange(v === "changes")}
              options={[
                { value: "changes" as const, label: "API changes", title: "Only what this diff changes in the API: endpoints added, removed, or with a new path, method, parameters, request or response shape, or auth" },
                { value: "all" as const, label: "All endpoints", title: "Every endpoint, with this diff's changes marked" },
              ]}
            />
            <ChangeCounts change={change} />
          </>
        )}
        {changePending && !change && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" aria-hidden /> Comparing the API…
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          {loading && <LoaderCircle className="size-3 animate-spin" aria-label="Loading" />}
          {catalog?.state === "ready" && (
            <span title={catalog.frameworks.join(", ")}>
              {visible.length === total ? total : `${visible.length} of ${total}`} endpoint{total === 1 ? "" : "s"}
              {catalog.frameworks.length > 0 && ` · ${catalog.frameworks.slice(0, 3).join(", ")}${catalog.frameworks.length > 3 ? ` +${catalog.frameworks.length - 3}` : ""}`}
            </span>
          )}
          {catalog && catalog.specs.length > 0 && (
            <span title={`OpenAPI: ${catalog.specs.join(", ")}`} className={drift > 0 ? "text-warning" : undefined}>
              · spec{drift > 0 ? `, ${drift} drift` : " in sync"}
            </span>
          )}
        </span>
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
            {changedOnly && change && change.changes.length === 0 ? "This diff doesn't change the API — no endpoint was added, removed, or changed its path, method, parameters, shapes or auth." : "Nothing matches."}
          </p>
        )}

        {groups.map(([group, list]) => (
          <section key={group}>
            <h3 className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-border bg-card/95 px-4 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur">
              <span className="truncate normal-case">{group}</span>
              <span className="font-mono font-normal">{list.length}</span>
            </h3>
            <ul>
              {list.map((row) => (
                <ApiListRow key={row.endpoint.id} row={row} withChange={Boolean(change)} selected={row.endpoint.id === selectedId} onSelect={() => onSelect(row.endpoint.id === selectedId ? null : row.endpoint.id)} />
              ))}
            </ul>
          </section>
        ))}
        {catalog && catalog.unresolvedMounts > 0 && (
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

export function MethodBadge({ method, className }: { method: string; className?: string }) {
  return <span className={cn("shrink-0 font-mono text-[11px] font-semibold", methodTone(method), className)}>{method}</span>;
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

function ApiListRow({ row, selected, onSelect, withChange }: { row: ApiRow; selected: boolean; onSelect: () => void; withChange: boolean }) {
  const e = row.endpoint;
  const status = row.change?.status;
  const style = status ? CHANGE_STYLES[status] : null;
  return (
    <li data-endpoint={e.id}>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          "grid w-full items-baseline gap-x-2 border-b border-border/60 px-4 py-1.5 text-left transition-colors hover:bg-secondary/60",
          withChange
            ? "grid-cols-[3.75rem_4.75rem_minmax(0,1fr)] @2xl:grid-cols-[3.75rem_4.75rem_minmax(0,1fr)_7rem_minmax(0,11rem)] @4xl:grid-cols-[3.75rem_4.75rem_minmax(0,1fr)_7rem_minmax(0,13rem)_minmax(0,14rem)]"
            : "grid-cols-[4.75rem_minmax(0,1fr)] @2xl:grid-cols-[4.75rem_minmax(0,1fr)_7rem_minmax(0,11rem)] @4xl:grid-cols-[4.75rem_minmax(0,1fr)_7rem_minmax(0,13rem)_minmax(0,14rem)]",
          selected && "bg-secondary shadow-[inset_2px_0_0_var(--brand)]",
          status === "removed" && "opacity-70"
        )}
      >
        {withChange && (
          <span className={cn("font-mono text-[10px] font-medium", style?.className)} title={style?.title}>
            {style?.word ?? ""}
            {row.change?.breaking && (
              <span className="ml-0.5 text-destructive" title="Can break an existing client">
                !
              </span>
            )}
          </span>
        )}
        <MethodBadge method={e.method} />
        <span className="flex min-w-0 items-baseline gap-2">
          <EndpointPath path={e.path} partial={e.partial} className={cn(status === "removed" && "line-through")} />
          {e.internal && (
            <span className="shrink-0 rounded-sm border border-border px-1 text-[10px] text-muted-foreground" title="A server action: callable over the network, but made for the app's own pages (a BFF), not for third parties">
              internal
            </span>
          )}
          {e.drift && (
            <span className="shrink-0 text-[10px] text-warning" title={e.drift === "spec-only" ? "The OpenAPI spec lists it; no code for it was found" : "In the code, but the OpenAPI spec doesn't list it"}>
              {e.drift === "spec-only" ? "spec only" : "not in spec"}
            </span>
          )}
          {(e.spec?.summary ?? e.summary) && <span className="hidden min-w-0 truncate text-[11px] text-muted-foreground @xl:inline">{e.spec?.summary ?? e.summary}</span>}
        </span>
        <span className="hidden truncate text-[11px] text-muted-foreground @2xl:inline" title={`${KIND_LABELS[e.kind]} · ${e.framework}`}>
          {e.framework}
        </span>
        <span className="hidden truncate font-mono text-[11px] text-muted-foreground @2xl:inline" title={e.auth.length ? e.auth.join(" → ") : "No middleware or auth found statically — that doesn't mean there is none"}>
          {e.auth.length ? e.auth.join(" → ") : "?"}
        </span>
        <span className="hidden truncate font-mono text-[11px] text-muted-foreground @4xl:inline" title={e.handler ? `${e.handler.file}:${e.handler.startLine}` : "No handler found"}>
          {e.handler ? (e.handler.name === e.method ? e.handler.file.split("/").slice(-2).join("/") : e.handler.name) : "—"}
        </span>
      </button>
    </li>
  );
}
