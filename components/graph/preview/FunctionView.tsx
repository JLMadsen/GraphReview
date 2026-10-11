"use client";

// The preview of one changed function: its cases, before and after.

import { useState } from "react";
import { cn } from "cn";
import type {
  PreviewCaseOutcome,
  PreviewCaseResult,
  PreviewSymbolResult,
} from "@/lib/preview/types";
import { brokenSide, caseDiffers } from "@/lib/preview/compare";
import { plural, readableInput } from "./format";

export function mutated(outcome: PreviewCaseOutcome | undefined): boolean {
  return Boolean(outcome?.argsBefore && outcome.argsAfter && outcome.argsBefore !== outcome.argsAfter);
}

export function FunctionView({ symbol }: { symbol: PreviewSymbolResult }) {
  const [showSame, setShowSame] = useState(false);
  const differing = symbol.cases.filter((c) => caseDiffers(symbol, c) || brokenSide(symbol, c) !== null);
  const same = symbol.cases.filter((c) => !differing.includes(c));
  const rows = showSame ? [...differing, ...same] : differing;

  return (
    <table className="w-full table-fixed border-collapse text-left">
      <colgroup>
        <col className="w-[18%]" />
        <col className="w-[22%]" />
        <col className="w-[30%]" />
        <col className="w-[30%]" />
      </colgroup>
      <thead>
        <tr className="border-b border-border text-[11px] text-muted-foreground">
          <th className="py-1.5 pr-3 font-normal">Case</th>
          <th className="py-1.5 pr-3 font-normal">Input</th>
          <th className="py-1.5 pr-3 font-normal">Before</th>
          <th className="py-1.5 font-normal">After</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c, i) => (
          <FunctionRow key={`${c.label}-${i}`} item={c} change={symbol.change} />
        ))}
        {same.length > 0 && (
          <tr>
            <td colSpan={4} className="py-1.5">
              <button
                type="button"
                onClick={() => setShowSame((v) => !v)}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {plural(same.length, "case", "cases")} unchanged · {showSame ? "hide" : "show"}
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export function ResultCell({ outcome, other, missing }: { outcome?: PreviewCaseOutcome; other?: PreviewCaseOutcome; missing: boolean }) {
  if (missing) return <span className="text-muted-foreground/70">—</span>;
  if (!outcome) return <span className="text-muted-foreground/70">didn&apos;t run</span>;
  const text = outcome.threw !== undefined ? `throws ${outcome.threw}` : (outcome.returned ?? "—");
  const otherText = other ? (other.threw !== undefined ? `throws ${other.threw}` : other.returned) : undefined;
  return (
    <pre
      className={cn(
        "font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap",
        outcome.threw !== undefined && "text-destructive",
        other && text !== otherText && "-mx-1 rounded-sm bg-warning/15 px-1"
      )}
    >
      {text}
    </pre>
  );
}

export function FunctionRow({ item, change }: { item: PreviewCaseResult; change: PreviewSymbolResult["change"] }) {
  const mutatedBefore = mutated(item.before);
  const mutatedAfter = mutated(item.after);
  return (
    <>
      <tr className={cn("align-top", !(mutatedBefore || mutatedAfter) && "border-b border-border")}>
        <td
          className={cn(
            "py-1.5 pr-3",
            brokenSide({ kind: "function", change }, item)
              ? "text-destructive"
              : caseDiffers({ kind: "function", change }, item) && "text-warning"
          )}
        >
          {item.label}
        </td>
        <td className="py-1.5 pr-3">
          <span
            className="font-mono text-[11px] break-words text-muted-foreground"
            title={JSON.stringify(item.input.kwargs ? item.input : (item.input.args ?? []), null, 2)}
          >
            {readableInput(item)}
          </span>
        </td>
        <td className="py-1.5 pr-3">
          <ResultCell outcome={item.before} other={change === "modified" ? item.after : undefined} missing={change === "added"} />
        </td>
        <td className="py-1.5">
          <ResultCell outcome={item.after} other={change === "modified" ? item.before : undefined} missing={change === "removed"} />
        </td>
      </tr>
      {(mutatedBefore || mutatedAfter) && (
        <tr className="border-b border-border align-top text-[11px] text-muted-foreground">
          <td className="pb-1.5" />
          <td className="pr-3 pb-1.5">changes its arguments to</td>
          <td className="pr-3 pb-1.5">
            {mutatedBefore ? <pre className="font-mono break-words whitespace-pre-wrap">{item.before?.argsAfter}</pre> : "—"}
          </td>
          <td className="pb-1.5">
            {mutatedAfter ? (
              <pre
                className={cn(
                  "font-mono break-words whitespace-pre-wrap",
                  item.before?.argsAfter !== item.after?.argsAfter && "-mx-1 rounded-sm bg-warning/15 px-1 text-foreground"
                )}
              >
                {item.after?.argsAfter}
              </pre>
            ) : (
              "—"
            )}
          </td>
        </tr>
      )}
    </>
  );
}
