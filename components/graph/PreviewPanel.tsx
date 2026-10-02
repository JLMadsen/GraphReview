"use client";

// The "Before / after" tab of the file diff modal (DESIGN.md §6.9). One
// changed component or function at a time, exceptions first:
//
//   header     what came out ("1 component looks different"), Run
//   switcher   the file's changed symbols, the ones that differ first
//   component  its cases as chips; one large comparison, side by side, with
//              Slider and Overlay as alternatives and Highlight changes as
//              an option; frames grow to fit the render
//   function   a case / input / before / after table, unchanged cases folded;
//              arguments are only mentioned when a call changed them
//   inputs     readable `key: value` text; Edit opens the JSON
//
// Nothing runs until Run is pressed — a run costs a model call and two
// sandbox containers.

import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Play, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import type {
  PreviewCaseInput,
  PreviewCaseOutcome,
  PreviewCaseResult,
  PreviewInputs,
  PreviewResult,
  PreviewSymbolResult,
} from "@/lib/preview/types";
import { Segmented } from "./Segmented";
import { Spark } from "./Spark";
import type { ReviewTargetDTO } from "./types";
import { usePreview } from "./usePreview";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function short(sha: string): string {
  return sha.slice(0, 7);
}

function compact(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One value at a glance: scalars as they are (long strings clipped), objects and lists as their shape. */
function glance(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    // Tagged values the harness revives ({"$undefined": true}, {"$date": "…"}, …).
    if (keys.length === 1 && keys[0].startsWith("$")) {
      const inner = (value as Record<string, unknown>)[keys[0]];
      return keys[0] === "$undefined" ? "undefined" : `${keys[0].slice(1)}(${glance(inner)})`;
    }
    return keys.length === 0 ? "{}" : `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
  }
  const text = compact(value);
  return text.length > 40 ? `${text.slice(0, 39)}…"` : text;
}

/** `status: "analyzing" · repoId: "repo-123"`, or `1, 1` for arguments. The full JSON is behind Edit. */
function readableInput(item: PreviewCaseInput): string {
  const { props, args, kwargs } = item.input;
  if (props) {
    const entries = Object.entries(props);
    return entries.length === 0 ? "no props" : entries.map(([k, v]) => `${k}: ${glance(v)}`).join(" · ");
  }
  const parts = (args ?? []).map(glance);
  for (const [k, v] of Object.entries(kwargs ?? {})) parts.push(`${k}=${glance(v)}`);
  return parts.length === 0 ? "no arguments" : parts.join(", ");
}

type SymbolStatus = "different" | "new" | "removed" | "same" | "failed";

function statusOf(symbol: PreviewSymbolResult): SymbolStatus {
  // A component that never rendered (even failing identically on both sides) didn't run in any useful
  // sense; a function throwing the same error before and after is a real, unchanged result.
  const ran =
    symbol.kind === "component"
      ? symbol.cases.some((c) => c.before?.html !== undefined || c.after?.html !== undefined)
      : symbol.cases.some((c) => c.before || c.after);
  if (!ran) return "failed";
  if (symbol.change === "added") return "new";
  if (symbol.change === "removed") return "removed";
  return symbol.cases.some((c) => c.differs) ? "different" : "same";
}

const STATUS_ORDER: Record<SymbolStatus, number> = { different: 0, new: 1, removed: 2, failed: 3, same: 4 };

const STATUS_WORD: Record<SymbolStatus, { text: (kind: PreviewSymbolResult["kind"]) => string; className: string }> = {
  different: { text: (k) => (k === "component" ? "looks different" : "behaves differently"), className: "text-warning" },
  new: { text: () => "new", className: "text-success" },
  removed: { text: () => "removed", className: "text-destructive" },
  failed: { text: () => "didn't run", className: "text-destructive" },
  same: { text: () => "same", className: "text-muted-foreground" },
};

function verdict(symbols: PreviewSymbolResult[]): { text: string; tone: "warn" | "quiet" } {
  const differing = symbols.filter((s) => ["different", "new", "removed"].includes(statusOf(s)));
  const components = differing.filter((s) => s.kind === "component").length;
  const functions = differing.length - components;
  const parts: string[] = [];
  if (components > 0) parts.push(`${plural(components, "component", "components")} ${components === 1 ? "looks" : "look"} different`);
  if (functions > 0) parts.push(`${plural(functions, "function", "functions")} ${functions === 1 ? "behaves" : "behave"} differently`);
  if (parts.length > 0) return { text: parts.join(", "), tone: "warn" };
  if (symbols.length === 0) return { text: "Nothing in this file can be rendered or called", tone: "quiet" };
  return { text: "Everything behaves the same", tone: "quiet" };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface PreviewPanelProps {
  repoId: string;
  target: ReviewTargetDTO;
  filePath: string;
  /** Symbol to show first, e.g. the component clicked in "Looks different". */
  initialSymbol?: string;
}

export function PreviewPanel({ repoId, target, filePath, initialSymbol }: PreviewPanelProps) {
  const { status, result, error, pending, run, logs } = usePreview(repoId, target, filePath, true);
  const [edited, setEdited] = useState<PreviewInputs>({});
  const [selected, setSelected] = useState<string | undefined>(initialSymbol);

  const symbols = useMemo(
    () =>
      [...(result?.symbols ?? [])].sort(
        (a, b) =>
          STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)] ||
          (a.kind === b.kind ? 0 : a.kind === "component" ? -1 : 1) ||
          a.line - b.line
      ),
    [result]
  );
  const current = symbols.find((s) => s.name === selected) ?? symbols[0];
  const hasEdits = Object.keys(edited).length > 0;

  const start = () => {
    if (hasEdits && result) {
      void run({ ...result.inputs, ...edited });
      setEdited({});
    } else {
      // Hand-edited inputs stick across re-runs; otherwise the model mocks up fresh ones.
      void run(result?.inputsSource === "user" ? result.inputs : undefined);
    }
  };

  const runButton = (
    <button
      type="button"
      onClick={start}
      disabled={pending}
      title="Render the changed components and run the changed functions at the base and at the head, on the same inputs, in a Docker sandbox"
      className="flex shrink-0 items-center gap-1.5 rounded-sm border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary disabled:opacity-50"
    >
      {pending ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
      {hasEdits ? "Run with edited inputs" : result ? "Run again" : "Run"}
      {!hasEdits && result?.inputsSource !== "user" && <Spark title="Inputs are mocked up by the model" />}
    </button>
  );

  if (!result) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center text-xs">
        {pending ? (
          <Progress message={status?.progress?.message} logs={logs} />
        ) : (
          <>
            <p className="max-w-md leading-relaxed text-muted-foreground">
              Renders the changed components and runs the changed functions at the base and at the head, on the same
              mocked-up inputs.
            </p>
            {runButton}
          </>
        )}
        {error && <ErrorLine text={error} />}
        {status?.state === "failed" && status.error && <ErrorLine text={status.error} />}
      </div>
    );
  }

  const summary = verdict(result.symbols);

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {pending ? (
            <Progress message={status?.progress?.message} logs={[]} inline />
          ) : (
            <p className={cn("text-[15px] leading-tight font-medium", summary.tone === "warn" ? "text-warning" : "text-muted-foreground")}>
              {summary.text}
            </p>
          )}
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {result.inputsSource === "ai" ? (
              <span className="inline-flex items-center gap-1">
                inputs mocked up <Spark />
              </span>
            ) : result.inputsSource === "user" ? (
              "your inputs"
            ) : (
              "empty inputs"
            )}
            {" · "}
            <span className="font-mono">
              {short(result.baseSha)} → {short(result.headSha)} · {(result.durationMs / 1000).toFixed(0)} s
            </span>
          </p>
        </div>
        {runButton}
      </div>

      {error && <ErrorLine text={error} />}
      {status?.state === "failed" && status.error && <ErrorLine text={status.error} />}
      {result.inputsNote && <p className="text-warning">{result.inputsNote}</p>}
      {result.before.fatal && <ErrorLine text={`Before: ${result.before.fatal}`} />}
      {result.after.fatal && <ErrorLine text={`After: ${result.after.fatal}`} />}

      {symbols.length > 1 && (
        <div role="tablist" aria-label="Changed symbols" className="flex flex-wrap gap-x-1 gap-y-1 border-b border-border">
          {symbols.map((s) => {
            const st = statusOf(s);
            const active = s.name === current?.name;
            return (
              <button
                key={s.name}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSelected(s.name)}
                className={cn(
                  "-mb-px flex items-baseline gap-1.5 border-b-2 px-2 pt-1 pb-1.5 transition-colors",
                  active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="font-mono text-[12px]">{s.name}</span>
                <span className={cn("text-[11px]", STATUS_WORD[st].className)}>{STATUS_WORD[st].text(s.kind)}</span>
                {edited[s.name] && <span className="text-[10px] text-brand">edited</span>}
              </button>
            );
          })}
        </div>
      )}

      {current && (
        <SymbolView
          key={current.name}
          symbol={current}
          result={result}
          editedCases={edited[current.name]}
          onEdit={(cases) =>
            setEdited((prev) => {
              const next = { ...prev };
              if (cases) next[current.name] = cases;
              else delete next[current.name];
              return next;
            })
          }
        />
      )}

      <Footnotes result={result} />
    </div>
  );
}

function Progress({ message, logs, inline }: { message?: string; logs: string[]; inline?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-1", !inline && "items-center")}>
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        {message ?? "Starting…"}
      </p>
      {logs.length > 0 && <p className="max-w-lg truncate font-mono text-[11px] text-muted-foreground/70">{logs[logs.length - 1]}</p>}
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 text-left text-destructive">
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="whitespace-pre-line">{text}</span>
    </p>
  );
}

/** Quiet notes that qualify the result rather than being it. */
function Footnotes({ result }: { result: PreviewResult }) {
  const notes: string[] = [];
  const stubbed = [...new Set([...result.before.stubbedModules, ...result.after.stubbedModules])];
  if (stubbed.length > 0) {
    notes.push(
      `Approximate: ${stubbed.slice(0, 5).join(", ")}${stubbed.length > 5 ? ` and ${stubbed.length - 5} more` : ""} couldn't be loaded and were replaced with empty stand-ins.`
    );
  }
  for (const [label, side] of [["before", result.before], ["after", result.after]] as const) {
    if (side.deps.startsWith("failed")) notes.push(`Installing dependencies ${label} ${side.deps}.`);
  }
  if (result.skipped.length > 0) {
    notes.push(`Not run: ${result.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}.`);
  }
  if (notes.length === 0) return null;
  return (
    <div className="space-y-0.5 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One symbol
// ---------------------------------------------------------------------------

function SymbolView({
  symbol,
  result,
  editedCases,
  onEdit,
}: {
  symbol: PreviewSymbolResult;
  result: PreviewResult;
  editedCases: PreviewCaseInput[] | undefined;
  onEdit: (cases: PreviewCaseInput[] | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const errors = [
    symbol.beforeError && `Before: ${symbol.beforeError}`,
    symbol.afterError && `After: ${symbol.afterError}`,
  ].filter(Boolean) as string[];

  return (
    <div className="flex flex-col gap-2">
      {symbol.via && (
        <p className="text-muted-foreground">
          Its own code didn&apos;t change; it uses <code className="font-mono text-foreground">{symbol.via}</code>, which did.
        </p>
      )}
      {errors.map((e) => (
        <ErrorLine key={e} text={e} />
      ))}

      {symbol.kind === "component" ? (
        <ComponentView symbol={symbol} result={result} />
      ) : (
        <FunctionView symbol={symbol} />
      )}

      <div className="flex items-baseline gap-2 pt-1">
        <span className="text-[11px] text-muted-foreground">Inputs</span>
        {editedCases && <span className="text-[11px] text-brand">edited — press Run with edited inputs</span>}
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="ml-auto rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          {editing ? "Close editor" : "Edit"}
        </button>
      </div>
      {editing && (
        <InputsEditor
          initial={editedCases ?? result.inputs[symbol.name] ?? []}
          baseline={result.inputs[symbol.name] ?? []}
          kind={symbol.kind}
          onChange={onEdit}
        />
      )}
    </div>
  );
}

function InputsEditor({
  initial,
  baseline,
  kind,
  onChange,
}: {
  initial: PreviewCaseInput[];
  /** The inputs the last run used — editing back to these clears the edit. */
  baseline: PreviewCaseInput[];
  kind: PreviewSymbolResult["kind"];
  onChange: (cases: PreviewCaseInput[] | null) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const original = useMemo(() => JSON.stringify(baseline), [baseline]);
  const [problem, setProblem] = useState<string | null>(null);

  const apply = (value: string) => {
    setText(value);
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) throw new Error("Expected a list of cases.");
      for (const c of parsed) {
        if (!c || typeof c !== "object" || typeof (c as PreviewCaseInput).label !== "string" || typeof (c as PreviewCaseInput).input !== "object") {
          throw new Error('Each case needs a "label" and an "input".');
        }
      }
      setProblem(null);
      onChange(JSON.stringify(parsed) === original ? null : (parsed as PreviewCaseInput[]));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Not valid JSON.");
    }
  };

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => apply(e.target.value)}
        spellCheck={false}
        rows={Math.min(18, text.split("\n").length + 1)}
        className="w-full resize-y rounded-sm border border-border bg-canvas p-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:border-brand"
      />
      <p className={cn("mt-0.5 text-[11px]", problem ? "text-destructive" : "text-muted-foreground")}>
        {problem ??
          (kind === "component"
            ? 'A list of cases: { "label": "…", "input": { "props": { … } } }'
            : 'A list of cases: { "label": "…", "input": { "args": [ … ] } }')}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Components: one large comparison per case
// ---------------------------------------------------------------------------

type CompareMode = "side" | "slider" | "overlay";

function ComponentView({ symbol, result }: { symbol: PreviewSymbolResult; result: PreviewResult }) {
  const firstDiffering = Math.max(0, symbol.cases.findIndex((c) => c.differs));
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
              title={c.differs ? "Renders differently" : "Renders the same"}
              className={cn(
                "rounded-sm border px-2 py-0.5 text-[11px] transition-colors",
                i === index ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
                c.differs ? "border-warning/70" : "border-border"
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

function srcDoc(html: string, css: string | undefined): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{background:#fff;color:#111;margin:0}body{padding:16px;font-family:system-ui,sans-serif;font-size:14px}</style><style>${(css ?? "").replace(/<\/style/gi, "<\\/style")}</style></head><body>${html}</body></html>`;
}

const MIN_FRAME = 72;
const MAX_FRAME = 720;
const MARK = "data-graphreview-changed";

function ownText(el: Element): string {
  return [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent?.trim() ?? "")
    .join(" ");
}

/** Styling identity: tag, classes, inline style, image source. */
function styling(el: Element): string {
  return `${el.tagName}|${el.getAttribute("class") ?? ""}|${el.getAttribute("style") ?? ""}|${el.getAttribute("src") ?? ""}`;
}

/**
 * Outlines what differs between the two renders, element by element at the
 * same position, descending all the way so changes are pinpointed: changed
 * text, leaf elements and added/removed elements get a solid outline;
 * containers whose own styling changed (but whose contents may not) get a
 * faint dashed one.
 */
function markDifferences(a: Document, b: Document): void {
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

function clearMarks(doc: Document): void {
  for (const el of doc.querySelectorAll(`[${MARK}]`)) {
    el.removeAttribute(MARK);
    (el as HTMLElement).style.removeProperty("outline");
    (el as HTMLElement).style.removeProperty("outline-offset");
  }
}

function Compare({
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

function FrameLabel({ text }: { text: string }) {
  return <div className="mb-1 font-mono text-[11px] text-muted-foreground">{text}</div>;
}

// ---------------------------------------------------------------------------
// Functions: a table, unchanged cases folded
// ---------------------------------------------------------------------------

function mutated(outcome: PreviewCaseOutcome | undefined): boolean {
  return Boolean(outcome?.argsBefore && outcome.argsAfter && outcome.argsBefore !== outcome.argsAfter);
}

function FunctionView({ symbol }: { symbol: PreviewSymbolResult }) {
  const [showSame, setShowSame] = useState(false);
  const differing = symbol.cases.filter((c) => c.differs);
  const same = symbol.cases.filter((c) => !c.differs);
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

function ResultCell({ outcome, other, missing }: { outcome?: PreviewCaseOutcome; other?: PreviewCaseOutcome; missing: boolean }) {
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

function FunctionRow({ item, change }: { item: PreviewCaseResult; change: PreviewSymbolResult["change"] }) {
  const mutatedBefore = mutated(item.before);
  const mutatedAfter = mutated(item.after);
  return (
    <>
      <tr className={cn("align-top", !(mutatedBefore || mutatedAfter) && "border-b border-border")}>
        <td className={cn("py-1.5 pr-3", item.differs && "text-warning")}>{item.label}</td>
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
