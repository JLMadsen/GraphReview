"use client";

// One card of the PR map's Functions view (DESIGN.md §6.10): an area of the
// change — or an untouched neighbour — opened up into its functions. Each
// row is a port (`data-port`): calls are drawn from the caller's row to the
// callee's. Rendered twice per layout, like PrMapCard (once offscreen to
// measure), so it takes plain props.

import { cn } from "cn";
import type { FunctionCardModel } from "./call-graph-view";
import type { CallGraphFunction, FunctionStatus } from "./target-graph-types";

/** Wider than an area card: rows carry names that need the room. */
export const FUNCTION_CARD_WIDTH = 248;

/** How each status looks on a row — colour carries it, the word is in the title and the legend. */
export const FUNCTION_STATUS: Record<FunctionStatus, { label: string; row: string; title: string }> = {
  signature: {
    label: "signature changed",
    row: "border-warning/50 bg-warning/14 text-foreground",
    title: "Its signature changed — callers may need updating",
  },
  body: { label: "body changed", row: "border-brand/35 bg-brand/10 text-foreground", title: "Its body changed; the signature didn't" },
  added: { label: "new", row: "border-success/45 bg-success/12 text-foreground", title: "New in this change" },
  removed: {
    label: "removed",
    row: "border-destructive/40 bg-destructive/8 text-muted-foreground line-through decoration-destructive/60",
    title: "Removed by this change",
  },
  unchanged: { label: "unchanged", row: "border-border bg-secondary/40 text-muted-foreground", title: "Not changed — calls or is called by changed code" },
};

/** `Class.method` → `method` with the class dimmed in front. */
function FunctionName({ fn }: { fn: CallGraphFunction }) {
  const dot = fn.qualified.lastIndexOf(".");
  if (fn.kind === "method" && dot > 0) {
    return (
      <>
        <span className="opacity-60">{fn.qualified.slice(0, dot + 1)}</span>
        {fn.qualified.slice(dot + 1)}
      </>
    );
  }
  return <>{fn.name}</>;
}

export interface FunctionCardProps {
  card: FunctionCardModel;
  selectedFunctionId: string | null;
  /** Functions called by / calling the selected one. */
  relatedIds: Set<string>;
  onSelectFunction: (id: string) => void;
  dimmed?: boolean;
}

export function FunctionCard({ card, selectedFunctionId, relatedIds, onSelectFunction, dimmed }: FunctionCardProps) {
  const neighbour = card.role === "neighbour";
  const files = new Set(card.functions.map((f) => f.file)).size;
  return (
    <div
      style={{ width: FUNCTION_CARD_WIDTH }}
      className={cn(
        "rounded-md border px-2 pt-2 pb-2 text-left transition-opacity",
        neighbour ? "border-dashed border-border bg-card/50" : "border-foreground/18 bg-card",
        dimmed && "opacity-45"
      )}
    >
      {neighbour && <p className="mb-0.5 px-1 font-mono text-[10px] text-muted-foreground lowercase">unchanged</p>}
      <p className="truncate px-1 text-[12px] leading-snug font-medium" title={card.name}>
        {card.name}
      </p>
      <p className="mb-1.5 px-1 font-mono text-[10px] text-muted-foreground">
        {card.functions.length + card.hidden} function{card.functions.length + card.hidden === 1 ? "" : "s"} · {files} file{files === 1 ? "" : "s"}
      </p>
      <ul className="space-y-1">
        {card.functions.map((fn) => {
          const look = FUNCTION_STATUS[fn.status];
          const selected = fn.id === selectedFunctionId;
          const related = relatedIds.has(fn.id);
          return (
            <li key={fn.id} data-port={fn.id}>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectFunction(fn.id);
                }}
                title={`${fn.qualified} — ${look.title}\n${fn.file}:${fn.startLine}`}
                className={cn(
                  "flex h-6 w-full items-center rounded-[3px] border px-1.5 text-left font-mono text-[11px] transition-shadow",
                  look.row,
                  selected && "shadow-[0_0_0_2px_var(--brand)]",
                  !selected && related && "shadow-[0_0_0_1px_color-mix(in_oklab,var(--brand)_60%,transparent)]"
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  <FunctionName fn={fn} />
                </span>
                {fn.kind === "module" && <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">module</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {(card.hidden > 0 || card.unresolved > 0) && (
        <p className="mt-1.5 space-x-2 px-1 font-mono text-[10px] text-muted-foreground">
          {card.hidden > 0 && <span>+{card.hidden} more</span>}
          {card.unresolved > 0 && (
            <span title="Calls on instances (obj.method()) can't be tied to a function without type information, so they aren't drawn.">
              {card.unresolved} call{card.unresolved === 1 ? "" : "s"} not resolved
            </span>
          )}
        </p>
      )}
    </div>
  );
}
