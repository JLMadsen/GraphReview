"use client";

// The right column's inspector for a function picked in the PR map's
// Functions view (DESIGN.md §6.10): what happened to it, its signature before
// and after, who calls it — marking callers of a changed signature whose
// call the change didn't touch — and what it calls. Every name selects that
// function; every file:line opens the file there.

import { EyeOff, X } from "lucide-react";
import { cn } from "cn";
import { FUNCTION_STATUS } from "./FunctionCard";
import type { FunctionView } from "./call-graph-view";
import type { CallGraphEdge, CallGraphFunction } from "./target-graph-types";

export interface FunctionPanelProps {
  fn: CallGraphFunction;
  view: FunctionView;
  onSelectFunction: (id: string) => void;
  /** Takes it (and callers only there for it) off the map. */
  onHide?: (id: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onClose: () => void;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function CallStatus({ edge, calleeChanged }: { edge: CallGraphEdge; calleeChanged: boolean }) {
  if (edge.notUpdated) {
    return (
      <span className="shrink-0 text-[10px] font-medium text-destructive" title="Calls a function whose signature changed, on a line this change didn't touch">
        not updated
      </span>
    );
  }
  if (edge.status === "new") return <span className="shrink-0 text-[10px] text-[#d8703a]">new call</span>;
  if (edge.status === "removed") return <span className="shrink-0 text-[10px] text-muted-foreground">removed</span>;
  if (calleeChanged) return <span className="shrink-0 text-[10px] text-success">updated</span>;
  return null;
}

function CallList({
  title,
  edges,
  other,
  view,
  signatureChanged,
  onSelectFunction,
  onOpenFile,
}: {
  title: string;
  edges: CallGraphEdge[];
  other: (edge: CallGraphEdge) => string;
  view: FunctionView;
  signatureChanged: (edge: CallGraphEdge) => boolean;
  onSelectFunction: (id: string) => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  if (edges.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title} ({edges.length})
      </p>
      <ul className="space-y-0.5">
        {edges.map((edge) => {
          const id = other(edge);
          const fn = view.functionById.get(id);
          return (
            <li key={`${edge.from}=>${edge.to}`} className="flex items-center gap-2 rounded-sm px-1 py-0.5 hover:bg-secondary/60">
              <button
                type="button"
                onClick={() => onSelectFunction(id)}
                className="min-w-0 flex-1 truncate text-left font-mono text-[11px] hover:underline"
                title={id}
              >
                {fn?.qualified ?? id.slice(id.indexOf("#") + 1)}
              </button>
              <button
                type="button"
                onClick={() => onOpenFile(edge.file, edge.line)}
                className="shrink-0 font-mono text-[10px] text-muted-foreground hover:text-foreground hover:underline"
                title={`Open ${edge.file} at line ${edge.line}`}
              >
                {basename(edge.file)}:{edge.line}
              </button>
              <CallStatus edge={edge} calleeChanged={signatureChanged(edge)} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function FunctionPanel({ fn, view, onSelectFunction, onHide, onOpenFile, onClose }: FunctionPanelProps) {
  const look = FUNCTION_STATUS[fn.status];
  const callers = view.edges.filter((e) => e.to === fn.id);
  const callees = view.edges.filter((e) => e.from === fn.id);
  const left = callers.filter((e) => e.notUpdated).length;
  const changedSignature = (id: string) => view.functionById.get(id)?.status === "signature";
  return (
    <section className="px-4 py-3 text-xs" aria-label={`Function: ${fn.qualified}`}>
      <div className="flex items-center gap-1">
        <p className="flex-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Function <span className="font-normal normal-case">· {look.label}</span>
        </p>
        {onHide && (
          <button
            type="button"
            onClick={() => onHide(fn.id)}
            className="flex items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="Take it off the map, with the untouched callers that are only there because of it"
          >
            <EyeOff className="size-3" aria-hidden /> Hide
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Close"
          title="Back to the areas"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <p className="mt-1 font-mono text-[13px] font-medium break-all">{fn.qualified}</p>
      <button
        type="button"
        onClick={() => onOpenFile(fn.file, fn.startLine)}
        className="font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
      >
        {fn.file}:{fn.startLine}
      </button>
      {fn.movedFrom && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Moved from <span className="font-mono">{fn.movedFrom}</span>
          {fn.status === "moved"
            ? " — the code is the same."
            : fn.status === "body"
              ? " — and its body changed on the way."
              : " — and its signature changed on the way."}
        </p>
      )}

      {(fn.signatureBefore || fn.signatureAfter) && (
        <div className="mt-3 space-y-1">
          {fn.status === "signature" && fn.signatureBefore && (
            <pre className="overflow-x-auto rounded-sm border border-destructive/25 bg-destructive/6 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
              <span className="text-destructive select-none">− </span>
              {fn.signatureBefore}
            </pre>
          )}
          {fn.status === "removed" && fn.signatureBefore && (
            <pre className="overflow-x-auto rounded-sm border border-border bg-secondary/40 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground line-through">
              {fn.signatureBefore}
            </pre>
          )}
          {fn.signatureAfter && fn.status !== "removed" && (
            <pre
              className={cn(
                "overflow-x-auto rounded-sm border px-2 py-1 font-mono text-[11px] whitespace-pre-wrap",
                fn.status === "signature" ? "border-success/30 bg-success/6" : "border-border bg-secondary/40 text-muted-foreground"
              )}
            >
              {fn.status === "signature" && <span className="text-success select-none">+ </span>}
              {fn.signatureAfter}
            </pre>
          )}
        </div>
      )}

      {left > 0 && (
        <p className="mt-3 rounded-sm border border-destructive/30 bg-destructive/6 px-2 py-1.5 text-[11px] text-destructive">
          {left} caller{left === 1 ? "" : "s"} still call{left === 1 ? "s" : ""} it the old way on a line this change didn&apos;t touch.
        </p>
      )}

      <CallList
        title="Called by"
        edges={callers}
        other={(e) => e.from}
        view={view}
        signatureChanged={(e) => changedSignature(e.to)}
        onSelectFunction={onSelectFunction}
        onOpenFile={onOpenFile}
      />
      <CallList
        title="Calls"
        edges={callees}
        other={(e) => e.to}
        view={view}
        signatureChanged={() => false}
        onSelectFunction={onSelectFunction}
        onOpenFile={onOpenFile}
      />
      {callers.length === 0 && callees.length === 0 && (
        <p className="mt-3 text-[11px] text-muted-foreground">No calls to or from it that static analysis could resolve.</p>
      )}
      {fn.unresolvedCalls > 0 && (
        <p className="mt-3 text-[11px] text-muted-foreground" title="Calls on instances (obj.method()) need type information to resolve">
          {fn.unresolvedCalls} more call{fn.unresolvedCalls === 1 ? "" : "s"} from it name repo functions but couldn&apos;t be resolved.
        </p>
      )}
    </section>
  );
}
