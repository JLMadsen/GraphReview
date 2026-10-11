"use client";

// The preview of one changed component.

import { useState } from "react";
import { cn } from "cn";
import type {
  PreviewResult,
  PreviewSymbolResult,
} from "@/lib/preview/types";
import { Segmented } from "../Segmented";
import { brokenSide, caseDiffers } from "@/lib/preview/compare";
import { type CompareMode, Compare } from "./Compare";
import { short, readableInput } from "./format";

export function ComponentView({ symbol, result }: { symbol: PreviewSymbolResult; result: PreviewResult }) {
  const firstDiffering = Math.max(
    0,
    symbol.cases.findIndex((c) => caseDiffers(symbol, c) || brokenSide(symbol, c) !== null)
  );
  const [index, setIndex] = useState(firstDiffering);
  const [mode, setMode] = useState<CompareMode>("side");
  const [highlight, setHighlight] = useState(false);
  const item = symbol.cases[index] ?? symbol.cases[0];
  if (!item) return <p className="text-muted-foreground">No cases to render.</p>;

  const bothSides = symbol.change === "modified";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {symbol.cases.map((c, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIndex(i)}
              aria-pressed={i === index}
              title={
                brokenSide(symbol, c)
                  ? `Doesn't render ${brokenSide(symbol, c)} the change`
                  : caseDiffers(symbol, c)
                    ? "Renders differently"
                    : "Renders the same"
              }
              className={cn(
                "rounded-sm border px-2 py-0.5 text-[11px] transition-colors",
                i === index ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
                brokenSide(symbol, c)
                  ? "border-destructive/70"
                  : caseDiffers(symbol, c)
                    ? "border-warning/70"
                    : "border-border"
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        {/* A new or removed component has one side only: nothing to slide or overlay. */}
        {bothSides && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHighlight((v) => !v)}
              aria-pressed={highlight}
              title="Outline what changed: solid for changed text and elements, dashed for containers restyled"
              className={cn(
                "rounded-sm border border-border px-2 py-0.5 text-[11px] transition-colors",
                highlight ? "border-warning/70 bg-warning/10 text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Highlight changes
            </button>
            <Segmented
              size="xs"
              label="Compare"
              value={mode}
              onChange={setMode}
              options={[
                { value: "side", label: "Side by side" },
                { value: "slider", label: "Slider" },
                { value: "overlay", label: "Overlay" },
              ]}
            />
          </div>
        )}
      </div>

      <Compare
        key={index}
        item={item}
        mode={bothSides ? mode : "side"}
        highlight={bothSides && highlight}
        beforeCss={result.before.css}
        afterCss={result.after.css}
        beforeLabel={`Before · ${short(result.baseSha)}`}
        afterLabel={`After · ${short(result.headSha)}`}
        change={symbol.change}
      />

      <p className="truncate font-mono text-[11px] text-muted-foreground" title={JSON.stringify(item.input.props ?? {}, null, 2)}>
        {readableInput(item)}
      </p>
    </div>
  );
}
