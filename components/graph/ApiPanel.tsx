"use client";

// The API view's explainer (DESIGN.md §6.11), in the Graph tab's right
// column: one endpoint as an OpenAPI page would describe it — what it's
// for, its parameters, the body it takes and returns (from the code's
// types, the spec, or ✦ a model's reading of the handler, on request), the
// middleware and auth in front of it — plus what Swagger can't show: the
// handler itself and every function it reaches, down to data access. With
// a diff selected, what the change does to it comes first.

import { useState } from "react";
import { Database, LoaderCircle, X } from "lucide-react";
import { cn } from "cn";
import { Spark } from "./Spark";
import { EndpointPath, MethodBadge } from "./ApiView";
import { CHANGE_STYLES, KIND_LABELS, type ApiRow } from "./api-view-model";
import { splitDeclId, type ApiShape, type EndpointDelta, type ReachStep } from "./api-types";

export interface ApiPanelProps {
  row: ApiRow;
  aiConfigured: boolean;
  inferring: boolean;
  inferError?: string;
  onInfer: () => void;
  onOpenFile: (path: string, line?: number) => void;
  onClose: () => void;
}

function Section({ title, children, aside }: { title: React.ReactNode; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="mt-3 border-t border-border pt-2.5">
      <h3 className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
        <span className="min-w-0 flex-1">{title}</span>
        {aside}
      </h3>
      {children}
    </section>
  );
}

const DELTA_LABELS: Record<EndpointDelta["aspect"], string> = {
  path: "Path",
  method: "Method",
  params: "Parameter",
  request: "Request",
  response: "Response",
  auth: "Middleware & auth",
  handler: "Handler",
};

function SourceTag({ shape }: { shape: ApiShape }) {
  if (shape.source === "ai") return <Spark title="Inferred by the model from the handler's code — a guess" />;
  return <span className="font-mono text-[10px] text-muted-foreground">{shape.source === "spec" ? "from the spec" : "from the code's types"}</span>;
}

function ShapeBlock({ shape }: { shape: ApiShape }) {
  return (
    <div>
      {shape.type && <p className="mb-1 truncate font-mono text-[11px]" title={shape.type}>{shape.type}</p>}
      {shape.fields && shape.fields.length > 0 ? (
        <ul className="space-y-0.5 font-mono text-[11px]">
          {shape.fields.map((f) => (
            <li key={f.name} className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0">
                {f.name}
                {!f.required && <span className="text-muted-foreground">?</span>}
              </span>
              <span className="min-w-0 truncate text-muted-foreground" title={f.type}>{f.type}</span>
            </li>
          ))}
        </ul>
      ) : (
        !shape.type && <p className="text-[11px] text-muted-foreground">No fields read.</p>
      )}
    </div>
  );
}

function ReachTree({ steps, truncated, onOpenFile }: { steps: ReachStep[]; truncated?: boolean; onOpenFile: (path: string, line?: number) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? steps : steps.slice(0, 24);
  return (
    <>
      <ul className="space-y-px font-mono text-[11px]">
        {shown.map((s) => {
          const { file, name } = splitDeclId(s.id);
          return (
            <li key={s.id} style={{ paddingLeft: `${(s.depth - 1) * 10}px` }}>
              <button
                type="button"
                onClick={() => onOpenFile(file, s.line)}
                className="flex w-full min-w-0 items-baseline gap-1.5 text-left hover:underline"
                title={`${file}:${s.line}${s.via ? `\ncalled from ${splitDeclId(s.via).name}` : ""}`}
              >
                <span className="text-muted-foreground/60">{s.depth > 1 ? "└" : "→"}</span>
                <span className="min-w-0 truncate">{name}</span>
                {s.data && <Database className="size-3 shrink-0 translate-y-0.5 text-info" aria-label="Data access" />}
                <span className="ml-auto min-w-0 shrink truncate text-muted-foreground">{file.split("/").pop()}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {(steps.length > shown.length || truncated) && (
        <button type="button" onClick={() => setAll(true)} className="mt-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline" disabled={all}>
          {steps.length > shown.length ? `${steps.length - shown.length} more` : ""}
          {truncated ? `${steps.length > shown.length ? " · " : ""}the list stops at ${steps.length}` : ""}
        </button>
      )}
    </>
  );
}

export function ApiPanel({ row, aiConfigured, inferring, inferError, onInfer, onOpenFile, onClose }: ApiPanelProps) {
  const e = row.endpoint;
  const change = row.change;
  const style = change ? CHANGE_STYLES[change.status] : null;
  const missingShape = !e.request?.fields?.length || !e.response?.fields?.length;
  const canInfer = Boolean(e.handler?.hash) && missingShape && e.drift !== "spec-only" && change?.status !== "removed";
  const description = e.spec?.description ?? e.spec?.summary ?? e.summary;
  const pathParams = e.params.filter((p) => p.in === "path");
  const otherParams = e.params.filter((p) => p.in !== "path");

  const inferButton = canInfer ? (
    <button
      type="button"
      onClick={onInfer}
      disabled={!aiConfigured || inferring}
      title={aiConfigured ? "Read the handler with the model and fill in what it takes and returns" : "Set up an AI provider in Settings first"}
      className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
    >
      {inferring ? <LoaderCircle className="size-3 animate-spin" aria-hidden /> : <Spark />}
      Infer
    </button>
  ) : null;

  return (
    <div className="px-3 py-3">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
          {KIND_LABELS[e.kind]} · {e.framework}
          {e.internal && " · internal"}
        </p>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      <p className="mt-0.5 flex min-w-0 items-baseline gap-2 text-sm">
        <MethodBadge method={e.method} className="text-xs" />
        <EndpointPath path={e.path} partial={e.partial} className="text-[13px] font-medium" />
      </p>
      {e.partial && <p className="mt-1 text-[11px] text-warning">Part of this path couldn&apos;t be read statically (a variable, or a mount the analysis couldn&apos;t follow).</p>}
      {e.internal && (
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          A Next.js server action: reachable over the network as a POST, but made for this app&apos;s own pages — a backend-for-frontend, not a public API.
        </p>
      )}
      {description && (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {description}
          {!e.spec && e.summary && <Spark className="ml-1" />}
        </p>
      )}

      {change && style && (
        <Section title={<span className={style.className}>{change.breaking ? `${style.word} · can break clients` : style.word} in this diff</span>}>
          {change.status === "removed" && (
            <p className="text-[11px] text-muted-foreground">{e.kind === "action" ? "This diff removes the server action." : "This diff removes the endpoint — clients calling it will get a 404."}</p>
          )}
          {change.deltas.length > 0 && (
            <ul className="space-y-1 text-[11px]">
              {change.deltas.map((d, i) => (
                <li key={i} className="leading-snug">
                  <span className={cn("font-medium", d.breaking && "text-destructive")}>
                    {DELTA_LABELS[d.aspect]}
                    {d.breaking && " !"}
                  </span>{" "}
                  {d.aspect === "handler" && !d.before ? (
                    <span className="text-muted-foreground">its code changed</span>
                  ) : (
                    <span className="font-mono">
                      {d.before && <span className="text-destructive line-through decoration-destructive/50">{d.before}</span>}
                      {d.before && d.after && <span className="text-muted-foreground"> → </span>}
                      {d.after && <span className="text-success">{d.after}</span>}
                      {!d.after && d.before && <span className="text-muted-foreground"> (removed)</span>}
                      {d.after && !d.before && <span className="text-muted-foreground"> (new)</span>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {change.reaches && change.reaches.length > 0 && (
            <div className="mt-1.5">
              <p className="mb-1 text-[11px] text-muted-foreground">Calls code this diff changed:</p>
              <ul className="space-y-1">
                {change.reaches.map((r) => (
                  <li key={r.id} className="font-mono text-[11px] leading-snug">
                    {r.path.map((p, i) => (
                      <span key={p.id}>
                        {i > 0 && <span className="text-muted-foreground/60"> → </span>}
                        <button type="button" onClick={() => onOpenFile(p.file)} className={cn("hover:underline", i === r.path.length - 1 && "text-warning")} title={p.file}>
                          {p.name}
                        </button>
                      </span>
                    ))}
                    <span className="text-muted-foreground"> ({r.status})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      <Section title="Handler">
        {e.handler ? (
          <button type="button" onClick={() => onOpenFile(e.handler!.file, e.handler!.startLine)} className="block w-full min-w-0 text-left font-mono text-[11px] hover:underline" title={`${e.handler.file}:${e.handler.startLine}`}>
            <span className="block truncate">{e.handler.name}</span>
            <span className="block truncate text-muted-foreground">
              {e.handler.file}:{e.handler.startLine}
            </span>
          </button>
        ) : (
          <p className="text-[11px] text-muted-foreground">The OpenAPI spec lists this endpoint, but no code serving it was found.</p>
        )}
        {e.registeredAt && (
          <button type="button" onClick={() => onOpenFile(e.registeredAt!.file, e.registeredAt!.line)} className="mt-1 block max-w-full truncate font-mono text-[11px] text-muted-foreground hover:underline">
            registered at {e.registeredAt.file.split("/").pop()}:{e.registeredAt.line}
          </button>
        )}
      </Section>

      <Section title="Middleware & auth">
        {e.auth.length > 0 ? (
          <ol className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
            {e.auth.map((a, i) => (
              <li key={`${a}-${i}`} className="flex items-center gap-1">
                {i > 0 && <span className="text-muted-foreground/60">→</span>}
                <span className="rounded-sm bg-secondary px-1">{a}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[11px] text-muted-foreground" title="Static analysis sees route and router middleware, decorators, dependencies and middleware.ts — not checks made inside the handler or by infrastructure">
            ? — none found statically. That doesn&apos;t mean there is none.
          </p>
        )}
      </Section>

      {(pathParams.length > 0 || otherParams.length > 0) && (
        <Section title="Parameters">
          <ul className="space-y-0.5 font-mono text-[11px]">
            {[...pathParams, ...otherParams].map((p) => (
              <li key={`${p.in}:${p.name}`} className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0">
                  {p.name}
                  {p.required === false && <span className="text-muted-foreground">?</span>}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{p.in}</span>
                {p.type && <span className="min-w-0 truncate text-muted-foreground" title={p.type}>{p.type}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(e.request || (canInfer && e.kind !== "graphql")) && (
        <Section title={e.kind === "trpc" ? "Input" : "Request body"} aside={e.request ? <SourceTag shape={e.request} /> : undefined}>
          {e.request ? <ShapeBlock shape={e.request} /> : <p className="text-[11px] text-muted-foreground">Not readable from types.</p>}
        </Section>
      )}
      {(e.response || canInfer) && (
        <Section title={e.kind === "trpc" ? "Output" : "Response"} aside={e.response ? <SourceTag shape={e.response} /> : undefined}>
          {e.response ? <ShapeBlock shape={e.response} /> : <p className="text-[11px] text-muted-foreground">Not readable from types.</p>}
        </Section>
      )}
      {canInfer && (
        <div className="mt-2 flex items-center gap-2">
          {inferButton}
          <span className="text-[11px] text-muted-foreground">{aiConfigured ? "Read the handler to fill in what's missing" : "Needs an AI provider"}</span>
        </div>
      )}
      {inferError && <p className="mt-1 text-[11px] text-destructive">{inferError}</p>}

      {e.callers && e.callers.length > 0 && (
        <Section title={`Called from (${e.callers.length})`}>
          <ul className="space-y-0.5 font-mono text-[11px]">
            {e.callers.map((c) => (
              <li key={c}>
                <button type="button" onClick={() => onOpenFile(c)} className="block max-w-full truncate hover:underline" title={c}>
                  {c}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(e.spec || e.drift) && (
        <Section title="OpenAPI">
          {e.spec && (
            <p className="font-mono text-[11px]">
              <button type="button" onClick={() => onOpenFile(e.spec!.file)} className="hover:underline">
                {e.spec.file}
              </button>
              {e.spec.operationId && <span className="text-muted-foreground"> · {e.spec.operationId}</span>}
            </p>
          )}
          {e.drift === "code-only" && <p className="mt-0.5 text-[11px] text-warning">In the code, but the spec doesn&apos;t list it.</p>}
          {e.drift === "spec-only" && <p className="mt-0.5 text-[11px] text-warning">The spec lists it, but no code serves it.</p>}
        </Section>
      )}

      {e.handler && (
        <Section title={`Reaches (${e.reach.length}${e.reachTruncated ? "+" : ""})`}>
          {e.reach.length > 0 ? (
            <ReachTree steps={e.reach} truncated={e.reachTruncated} onOpenFile={onOpenFile} />
          ) : (
            <p className="text-[11px] text-muted-foreground">No calls into the repo&apos;s own functions were resolved (calls on instances need types, and aren&apos;t followed).</p>
          )}
        </Section>
      )}
    </div>
  );
}
