"use client";

// A changed component's before and after, side by side, as a slider or overlaid,
// with the elements that differ marked (DESIGN.md §6.9).

import { useEffect, useRef, useState } from "react";
import type {
  PreviewCaseOutcome,
  PreviewCaseResult,
  PreviewSymbolResult,
} from "@/lib/preview/types";

export type CompareMode = "side" | "slider" | "overlay";

export function srcDoc(html: string, css: string | undefined): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{background:#fff;color:#111;margin:0}body{padding:16px;font-family:system-ui,sans-serif;font-size:14px}</style><style>${(css ?? "").replace(/<\/style/gi, "<\\/style")}</style></head><body>${html}</body></html>`;
}

export const MIN_FRAME = 72;

export const MAX_FRAME = 720;

export const MARK = "data-graphreview-changed";

export function ownText(el: Element): string {
  return [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent?.trim() ?? "")
    .join(" ");
}

/** Styling identity: tag, classes, inline style, image source. */
export function styling(el: Element): string {
  return `${el.tagName}|${el.getAttribute("class") ?? ""}|${el.getAttribute("style") ?? ""}|${el.getAttribute("src") ?? ""}`;
}

/**
 * Outlines what differs between the two renders, element by element at the
 * same position, descending all the way so changes are pinpointed: changed
 * text, leaf elements and added/removed elements get a solid outline;
 * containers whose own styling changed (but whose contents may not) get a
 * faint dashed one.
 */
export function markDifferences(a: Document, b: Document): void {
  const mark = (el: Element, strong: boolean) => {
    el.setAttribute(MARK, "");
    const style = (el as HTMLElement).style;
    style.setProperty("outline", strong ? "2px solid rgb(245 158 11)" : "1px dashed rgb(245 158 11 / 0.7)", "important");
    style.setProperty("outline-offset", strong ? "1px" : "2px", "important");
  };
  const walk = (x: Element | undefined, y: Element | undefined) => {
    if (!x || !y || x.tagName !== y.tagName) {
      if (x) mark(x, true);
      if (y) mark(y, true);
      return;
    }
    const xs = [...x.children];
    const ys = [...y.children];
    const leaf = xs.length === 0 && ys.length === 0;
    if (ownText(x) !== ownText(y) || (leaf && styling(x) !== styling(y))) {
      mark(x, true);
      mark(y, true);
    } else if (styling(x) !== styling(y)) {
      mark(x, false);
      mark(y, false);
    }
    for (let i = 0; i < Math.max(xs.length, ys.length); i++) walk(xs[i], ys[i]);
  };
  const xs = [...a.body.children];
  const ys = [...b.body.children];
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) walk(xs[i], ys[i]);
}

export function clearMarks(doc: Document): void {
  for (const el of doc.querySelectorAll(`[${MARK}]`)) {
    el.removeAttribute(MARK);
    (el as HTMLElement).style.removeProperty("outline");
    (el as HTMLElement).style.removeProperty("outline-offset");
  }
}

export function Compare({
  item,
  mode,
  highlight,
  beforeCss,
  afterCss,
  beforeLabel,
  afterLabel,
  change,
}: {
  item: PreviewCaseResult;
  mode: CompareMode;
  highlight: boolean;
  beforeCss?: string;
  afterCss?: string;
  beforeLabel: string;
  afterLabel: string;
  change: PreviewSymbolResult["change"];
}) {
  const beforeRef = useRef<HTMLIFrameElement>(null);
  const afterRef = useRef<HTMLIFrameElement>(null);
  const [heights, setHeights] = useState({ before: 0, after: 0 });
  const [loaded, setLoaded] = useState({ before: false, after: false });
  const [split, setSplit] = useState(50);
  const [opacity, setOpacity] = useState(50);

  const measure = (side: "before" | "after") => {
    const doc = (side === "before" ? beforeRef : afterRef).current?.contentDocument;
    if (!doc?.documentElement) return;
    const h = doc.documentElement.scrollHeight;
    setHeights((prev) => (prev[side] === h ? prev : { ...prev, [side]: h }));
  };

  // Re-measure when the layout changes width (side by side vs full width).
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      measure("before");
      measure("after");
    });
    return () => cancelAnimationFrame(id);
  }, [mode]);

  useEffect(() => {
    const a = beforeRef.current?.contentDocument;
    const b = afterRef.current?.contentDocument;
    if (!a?.body || !b?.body || !loaded.before || !loaded.after) return;
    clearMarks(a);
    clearMarks(b);
    if (highlight) markDifferences(a, b);
  }, [highlight, loaded, mode]);

  const height = Math.min(MAX_FRAME, Math.max(MIN_FRAME, heights.before, heights.after));
  const frame = (side: "before" | "after", outcome: PreviewCaseOutcome | undefined, css: string | undefined) => {
    const missing = side === "before" ? change === "added" : change === "removed";
    if (missing) {
      return (
        <div className="flex items-center justify-center rounded-sm border border-dashed border-border text-muted-foreground" style={{ height }}>
          {side === "before" ? "Didn't exist before" : "Removed"}
        </div>
      );
    }
    if (!outcome || outcome.threw !== undefined) {
      return (
        <div className="overflow-auto rounded-sm border border-destructive/40 p-3 font-mono text-[11px] whitespace-pre-wrap text-destructive" style={{ minHeight: height }}>
          {outcome?.threw ?? "Didn't run."}
        </div>
      );
    }
    return (
      <iframe
        ref={side === "before" ? beforeRef : afterRef}
        title={`${item.label}, ${side}`}
        // Same origin but no scripts: nothing in the markup can run, and the
        // panel can still measure it and outline what changed.
        sandbox="allow-same-origin"
        srcDoc={srcDoc(outcome.html ?? "", css)}
        onLoad={() => {
          measure(side);
          // Again once fonts and late layout have settled, so the frame doesn't end up a few pixels short.
          setTimeout(() => measure(side), 150);
          setTimeout(() => measure(side), 600);
          setLoaded((prev) => ({ ...prev, [side]: true }));
        }}
        className="block w-full rounded-sm border border-border bg-white"
        style={{ height }}
      />
    );
  };

  if (mode === "side") {
    return (
      <div className="grid grid-cols-2 gap-4">
        <div className="min-w-0">
          <FrameLabel text={beforeLabel} />
          {frame("before", item.before, beforeCss)}
        </div>
        <div className="min-w-0">
          <FrameLabel text={afterLabel} />
          {frame("after", item.after, afterCss)}
        </div>
      </div>
    );
  }

  // Slider / overlay: both frames stacked; "after" on top, clipped or faded.
  return (
    <div>
      <div className="flex justify-between">
        <FrameLabel text={beforeLabel} />
        <FrameLabel text={afterLabel} />
      </div>
      <div className="relative" style={{ height }}>
        <div className="absolute inset-0">{frame("before", item.before, beforeCss)}</div>
        <div
          className="absolute inset-0"
          style={
            mode === "slider"
              ? { clipPath: `inset(0 0 0 ${split}%)` }
              : { opacity: opacity / 100 }
          }
        >
          {frame("after", item.after, afterCss)}
        </div>
        {mode === "slider" && (
          <div className="pointer-events-none absolute inset-y-0 w-px bg-warning" style={{ left: `${split}%` }} aria-hidden />
        )}
      </div>
      <label className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        Before
        <input
          type="range"
          min={0}
          max={100}
          value={mode === "slider" ? split : opacity}
          onChange={(e) => (mode === "slider" ? setSplit(Number(e.target.value)) : setOpacity(Number(e.target.value)))}
          className="flex-1 accent-current"
          aria-label={mode === "slider" ? "Divider position" : "After opacity"}
        />
        After
      </label>
    </div>
  );
}

export function FrameLabel({ text }: { text: string }) {
  return <div className="mb-1 font-mono text-[11px] text-muted-foreground">{text}</div>;
}
