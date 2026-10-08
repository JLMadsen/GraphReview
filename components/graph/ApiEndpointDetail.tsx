"use client";

// One endpoint opened in place in the API view (DESIGN.md §6.11): what an
// OpenAPI page would say about it, read top to bottom without leaving the
// list — and, for an endpoint the selected diff changes, the change itself:
// contract lines (path, method, parameters, auth) as before → after, and
// the request and response payloads as a before / after table aligned
// field by field.

import { useState } from "react";
import { ChevronRight, Database, LoaderCircle } from "lucide-react";
import { cn } from "cn";
import { Spark } from "./Spark";
import { splitDeclId, type ApiField, type ApiParam, type ApiShape, type EndpointChange, type EndpointDelta, type ReachStep, type ServedEndpoint } from "./api-types";

export interface ApiEndpointDetailProps {
  endpoint: ServedEndpoint;
  change?: EndpointChange;
  aiConfigured: boolean;
  inferring: boolean;
  inferError?: string;
  onInfer: () => void;
  onOpenFile: (path: string, line?: number) => void;
}

const SOURCE_LABEL: Record<ApiShape["source"], string> = { static: "from types", spec: "from the OpenAPI spec", ai: "inferred" };

function Label({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <p className="mb-1 flex items-baseline gap-2 text-[11px] font-medium text-muted-foreground">
      <span>{children}</span>
      {aside}
    </p>
  );
}

function SourceNote({ shape }: { shape?: ApiShape }) {
  if (!shape) return null;
  return (
    <span className="font-normal text-muted-foreground/80">
      {shape.source === "ai" && <Spark className="mr-0.5" title="Inferred by the model from the handler's code — a guess" />}
      {SOURCE_LABEL[shape.source]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

type FieldRow = { name: string; before?: string; after?: string; state: "same" | "added" | "removed" | "changed" };

const fieldType = (f?: ApiField) => (f ? `${f.type}${f.required ? "" : " · optional"}` : undefined);
const paramType = (p?: ApiParam) => (p ? `${p.in}${p.type ? ` · ${p.type}` : ""}${p.required === false ? " · optional" : ""}` : undefined);

/** One row per name on either side, marked added / removed / changed / same. */
function diffRows<T>(before: T[], after: T[], key: (t: T) => string, text: (t?: T) => string | undefined): FieldRow[] {
  const b = new Map(before.map((t) => [key(t), t]));
  const a = new Map(after.map((t) => [key(t), t]));
  return [...new Set([...a.keys(), ...b.keys()])].map((name) => {
    const bt = text(b.get(name));
    const at = text(a.get(name));
    const state = bt === undefined ? "added" : at === undefined ? "removed" : bt !== at ? "changed" : "same";
    return { name, before: bt, after: at, state };
  });
}

function fieldRows(before: ApiShape | undefined, after: ApiShape | undefined): FieldRow[] {
  return diffRows(before?.fields ?? [], after?.fields ?? [], (f) => f.name, fieldType);
}

const ROW_TONE: Record<FieldRow["state"], string> = {
  same: "text-muted-foreground",
  added: "bg-success/8",
  removed: "bg-destructive/8",
  changed: "bg-warning/10",
};
const MARK: Record<FieldRow["state"], { text: string; className: string }> = {
  same: { text: "", className: "" },
  added: { text: "+", className: "text-success" },
  removed: { text: "−", className: "text-destructive" },
  changed: { text: "~", className: "text-warning" },
};

/** A body as a table of fields: name · type. */
function PayloadTable({ shape }: { shape: ApiShape }) {
  if (!shape.fields?.length) return <p className="font-mono text-[11px]">{shape.type ?? "—"}</p>;
  return (
    <div className="overflow-hidden rounded-md border border-border">
      {shape.type && <p className="truncate border-b border-border bg-secondary/40 px-2 py-1 font-mono text-[11px]" title={shape.type}>{shape.type}</p>}
      <table className="w-full font-mono text-[11px]">
        <tbody>
          {shape.fields.map((f) => (
            <tr key={f.name} className="border-b border-border/50 last:border-0">
              <td className="w-[40%] px-2 py-0.5 align-top">
                {f.name}
                {!f.required && <span className="text-muted-foreground">?</span>}
              </td>
              <td className="px-2 py-0.5 break-all text-muted-foreground">{f.type}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Before and after side by side, one row per field, the difference coloured. */
function PayloadDiff({ before, after }: { before?: ApiShape; after?: ApiShape }) {
  const rows = fieldRows(before, after);
  const typeChanged = (before?.type ?? "") !== (after?.type ?? "");
  if (rows.length > 0) return <DiffTable rows={rows} first="field" beforeNote={typeChanged ? before?.type : undefined} afterNote={typeChanged ? after?.type : undefined} />;
  if (rows.length === 0) {
    // Only what the code names it is known.
    return (
      <p className="font-mono text-[11px]">
        <span className="text-destructive line-through">{before?.type ?? "none"}</span>
        <span className="text-muted-foreground"> → </span>
        <span className="text-success">{after?.type ?? "none"}</span>
      </p>
    );
  }
  return null;
}

/** The before / after table, shared by payloads and parameters. */
function DiffTable({ rows, first, beforeNote, afterNote }: { rows: FieldRow[]; first: string; beforeNote?: string; afterNote?: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full table-fixed font-mono text-[11px]">
        <thead>
          <tr className="border-b border-border bg-secondary/40 text-left text-[10px] text-muted-foreground">
            <th className="w-4 px-1 py-1 font-normal" />
            <th className="w-[30%] px-2 py-1 font-normal">{first}</th>
            <th className="px-2 py-1 font-normal">
              before{beforeNote ? <span className="ml-1 text-foreground/70">{beforeNote}</span> : null}
            </th>
            <th className="px-2 py-1 font-normal">
              after{afterNote ? <span className="ml-1 text-foreground/70">{afterNote}</span> : null}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className={cn("border-b border-border/50 last:border-0", ROW_TONE[r.state])}>
              <td className={cn("px-1 py-0.5 text-center font-semibold", MARK[r.state].className)}>{MARK[r.state].text}</td>
              <td className={cn("truncate px-2 py-0.5", r.state === "removed" && "line-through decoration-destructive/60")} title={r.name}>
                {r.name}
              </td>
              <td className={cn("px-2 py-0.5 break-all", r.state === "changed" && "text-destructive/90")}>{r.before ?? <span className="text-muted-foreground/50">—</span>}</td>
              <td className={cn("px-2 py-0.5 break-all", r.state === "changed" && "text-success")}>{r.after ?? <span className="text-muted-foreground/50">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------

const DELTA_LABELS: Record<EndpointDelta["aspect"], string> = {
  path: "Path",
  method: "Method",
  params: "Parameter",
  request: "Request",
  response: "Response",
  auth: "Auth",
};

function ContractDeltas({ deltas }: { deltas: EndpointDelta[] }) {
  const lines = deltas.filter((d) => d.aspect === "path" || d.aspect === "method" || d.aspect === "auth");
  if (lines.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-[11px]">
      {lines.map((d, i) => (
        <li key={i} className="flex min-w-0 items-baseline gap-2">
          <span className={cn("w-16 shrink-0 text-muted-foreground", d.breaking && "text-destructive")}>
            {DELTA_LABELS[d.aspect]}
            {d.breaking && " !"}
          </span>
          <span className="min-w-0 font-mono break-all">
            {d.before && <span className="text-destructive line-through decoration-destructive/50">{d.before}</span>}
            {d.before && d.after && <span className="text-muted-foreground"> → </span>}
            {d.after && <span className="text-success">{d.after}</span>}
            {d.before && !d.after && <span className="text-muted-foreground"> removed</span>}
            {d.after && !d.before && <span className="text-muted-foreground"> added</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ParamsTable({ params }: { params: ApiParam[] }) {
  return (
    <table className="w-full font-mono text-[11px]">
      <tbody>
        {params.map((p) => (
          <tr key={`${p.in}:${p.name}`}>
            <td className="w-[40%] py-0.5 pr-2 align-top">
              {p.name}
              {p.required === false && <span className="text-muted-foreground">?</span>}
            </td>
            <td className="w-14 py-0.5 pr-2 align-top text-[10px] text-muted-foreground">{p.in}</td>
            <td className="py-0.5 break-all text-muted-foreground">{p.type ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReachList({ steps, truncated, onOpenFile }: { steps: ReachStep[]; truncated?: boolean; onOpenFile: (path: string, line?: number) => void }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const data = steps.filter((s) => s.data).length;
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" aria-expanded={open}>
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden />
        Calls {steps.length}
        {truncated ? "+" : ""} function{steps.length === 1 ? "" : "s"}
        {data > 0 && <span>, {data} touching data</span>}
      </button>
      {open && (
        <ul className="mt-1 space-y-px font-mono text-[11px]">
          {steps.map((s) => {
            const { file, name } = splitDeclId(s.id);
            return (
              <li key={s.id} style={{ paddingLeft: `${(s.depth - 1) * 12 + 16}px` }}>
                <button type="button" onClick={() => onOpenFile(file, s.line)} className="flex w-full min-w-0 items-baseline gap-1.5 text-left hover:underline" title={`${file}:${s.line}`}>
                  <span className="min-w-0 truncate">{name}</span>
                  {s.data && <Database className="size-3 shrink-0 translate-y-0.5 text-info" aria-label="Data access" />}
                  <span className="ml-auto shrink-0 text-muted-foreground">{file.split("/").pop()}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ApiEndpointDetail({ endpoint: e, change, aiConfigured, inferring, inferError, onInfer, onOpenFile }: ApiEndpointDetailProps) {
  const before = change?.status === "changed" ? change.before : undefined;
  const removed = change?.status === "removed";
  const requestChanged = Boolean(change?.deltas.some((d) => d.aspect === "request"));
  const responseChanged = Boolean(change?.deltas.some((d) => d.aspect === "response"));
  const paramsChanged = Boolean(change?.deltas.some((d) => d.aspect === "params"));
  const canInfer = Boolean(e.handler?.hash) && (!e.request?.fields?.length || !e.response?.fields?.length) && e.drift !== "spec-only" && !removed;
  const description = e.spec?.description ?? e.spec?.summary ?? e.summary;

  const payload = (title: string, now: ApiShape | undefined, then: ApiShape | undefined, changed: boolean) => {
    if (!now && !then) return null;
    return (
      <div className="min-w-0">
        <Label aside={<SourceNote shape={now ?? then} />}>
          {title}
          {changed && <span className="ml-1.5 text-warning">changed</span>}
        </Label>
        {changed ? <PayloadDiff before={then} after={now} /> : (now ?? then) ? <PayloadTable shape={(now ?? then)!} /> : null}
      </div>
    );
  };

  return (
    <div className="space-y-3 border-b border-border bg-card/60 px-4 pt-2 pb-3 pl-[5.75rem]">
      {description && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {description}
          {!e.spec && e.summary && <Spark className="ml-1" />}
        </p>
      )}
      {e.internal && <p className="text-[11px] text-muted-foreground">A Next.js server action — reachable as a POST, but made for this app&apos;s own pages, not a public API.</p>}
      {e.partial && <p className="text-[11px] text-warning">Part of this path couldn&apos;t be read statically (a variable, or a mount the analysis couldn&apos;t follow).</p>}
      {removed && <p className="text-[11px] text-destructive">{e.kind === "action" ? "This diff removes the server action." : "This diff removes the endpoint — clients still calling it will fail."}</p>}

      {change?.status === "changed" && <ContractDeltas deltas={change.deltas} />}

      {paramsChanged && before ? (
        <div>
          <Label>
            Parameters<span className="ml-1.5 text-warning">changed</span>
          </Label>
          <DiffTable rows={diffRows(before.params, e.params, (p) => p.name, paramType)} first="name" />
        </div>
      ) : (
        e.params.length > 0 && (
          <div>
            <Label>Parameters</Label>
            <ParamsTable params={e.params} />
          </div>
        )
      )}

      <div className="grid gap-3 @3xl:grid-cols-2">
        {payload(e.kind === "trpc" ? "Input" : "Request body", removed ? undefined : e.request, removed ? e.request : before?.request, requestChanged)}
        {payload(e.kind === "trpc" ? "Output" : "Response", removed ? undefined : e.response, removed ? e.response : before?.response, responseChanged)}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[11px]">
        {e.handler ? (
          <button type="button" onClick={() => onOpenFile(e.handler!.file, e.handler!.startLine)} className="min-w-0 truncate font-mono hover:underline" title="Open the handler">
            <span className="text-muted-foreground">handler </span>
            {e.handler.file}:{e.handler.startLine}
          </button>
        ) : (
          <span className="text-muted-foreground">No code serves this — only the OpenAPI spec lists it.</span>
        )}
        <span className="min-w-0 font-mono" title="Middleware, guards and dependencies in front of the handler, as far as static analysis sees them">
          <span className="text-muted-foreground">auth </span>
          {e.auth.length ? e.auth.join(" → ") : <span className="text-muted-foreground">? none found statically</span>}
        </span>
        <span className="text-muted-foreground">{e.framework}</span>
        {e.spec && (
          <button type="button" onClick={() => onOpenFile(e.spec!.file)} className="font-mono text-muted-foreground hover:text-foreground hover:underline">
            {e.spec.file}
          </button>
        )}
        {e.drift && <span className="text-warning">{e.drift === "spec-only" ? "in the spec, not in the code" : "in the code, not in the spec"}</span>}
        {canInfer && (
          <button
            type="button"
            onClick={onInfer}
            disabled={!aiConfigured || inferring}
            className="ml-auto flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
            title={
              aiConfigured
                ? "Part of the payload isn't readable from types — read the handler with the model and fill it in"
                : "Part of the payload isn't readable from types. Set up an AI provider in Settings to infer it."
            }
          >
            {inferring ? <LoaderCircle className="size-3 animate-spin" aria-hidden /> : <Spark />}
            Infer payloads
          </button>
        )}
      </div>
      {inferError && <p className="text-[11px] text-destructive">{inferError}</p>}

      {e.callers && e.callers.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Called from{" "}
          {e.callers.map((c, i) => (
            <span key={c}>
              {i > 0 && ", "}
              <button type="button" onClick={() => onOpenFile(c)} className="font-mono text-foreground hover:underline">
                {c.split("/").slice(-2).join("/")}
              </button>
            </span>
          ))}
        </p>
      )}
      {!removed && <ReachList steps={e.reach} truncated={e.reachTruncated} onOpenFile={onOpenFile} />}
    </div>
  );
}
