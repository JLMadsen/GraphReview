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

import { useMemo, useState } from "react";
import { LoaderCircle, Play, RotateCcw } from "lucide-react";
import { cn } from "cn";
import type {
  PreviewInputs,
  PreviewResult,
  PreviewRetry,
  PreviewSymbolResult,
} from "@/lib/preview/types";
import { Spark } from "./Spark";
import { symbolStatus, type PreviewSymbolStatus } from "@/lib/preview/compare";
import { reviewTargetKeyOf, type ReviewTargetDTO } from "./types";
import { usePreview } from "./usePreview";
import { JobFailureInline } from "@/components/jobs/JobParts";
import { useJob } from "@/components/jobs/store";
import { plural, short } from "./preview/format";
import { ErrorLine, SymbolView } from "./preview/SymbolView";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `rendering`: a running preview's symbol that hasn't come back from both sides yet (PreviewProgress.partial). */
type SymbolStatus = PreviewSymbolStatus | "rendering";

/** A component that never rendered (even failing identically on both sides) didn't run; one that renders on one side only fails there — neither "looks different". See lib/preview/compare.ts. */
const statusOf = (symbol: PreviewSymbolResult): SymbolStatus => (symbol.pending ? "rendering" : symbolStatus(symbol));

const STATUS_ORDER: Record<SymbolStatus, number> = {
  breaks: 0,
  different: 1,
  new: 2,
  removed: 3,
  recovers: 4,
  failed: 5,
  same: 6,
  rendering: 7,
};

const STATUS_WORD: Record<SymbolStatus, { text: (kind: PreviewSymbolResult["kind"]) => string; className: string }> = {
  different: { text: (k) => (k === "component" ? "looks different" : "behaves differently"), className: "text-warning" },
  new: { text: () => "new", className: "text-success" },
  removed: { text: () => "removed", className: "text-destructive" },
  failed: { text: () => "didn't run", className: "text-destructive" },
  // One side threw or didn't load — often notFound() or missing data in the
  // sandbox rather than a real regression; the case shows the reason.
  breaks: { text: (k) => (k === "component" ? "doesn't render after the change" : "doesn't run after the change"), className: "text-destructive" },
  recovers: { text: (k) => (k === "component" ? "doesn't render before the change" : "doesn't run before the change"), className: "text-muted-foreground" },
  same: { text: () => "same", className: "text-muted-foreground" },
  rendering: { text: () => "rendering…", className: "text-muted-foreground" },
};

const RETRY_MAX_ERRORS = 8;
const RETRY_MAX_ERROR_CHARS = 1500;

/** Each symbol that threw on either side, with its inputs and its distinct errors; null when nothing threw. */
function retryFor(result: PreviewResult): PreviewRetry | null {
  const retry: PreviewRetry = {};
  for (const symbol of result.symbols) {
    if (symbol.pending) continue;
    const errors = new Set<string>();
    const add = (side: string, text: string | undefined) => {
      if (text && errors.size < RETRY_MAX_ERRORS) errors.add(`${side}: ${text.slice(0, RETRY_MAX_ERROR_CHARS)}`);
    };
    add("before", symbol.beforeError);
    add("after", symbol.afterError);
    for (const c of symbol.cases) {
      add(`before, case "${c.label}"`, c.before?.threw);
      add(`after, case "${c.label}"`, c.after?.threw);
    }
    const cases = result.inputs[symbol.name];
    if (errors.size > 0 && cases?.length) retry[symbol.name] = { cases, errors: [...errors] };
  }
  return Object.keys(retry).length > 0 ? retry : null;
}

function verdict(symbols: PreviewSymbolResult[]): { text: string; tone: "warn" | "quiet" } {
  const differing = symbols.filter((s) => ["different", "new", "removed"].includes(statusOf(s)));
  const components = differing.filter((s) => s.kind === "component").length;
  const functions = differing.length - components;
  const parts: string[] = [];
  if (components > 0) parts.push(`${plural(components, "component", "components")} ${components === 1 ? "looks" : "look"} different`);
  if (functions > 0) parts.push(`${plural(functions, "function", "functions")} ${functions === 1 ? "behaves" : "behave"} differently`);
  const breaking = symbols.filter((s) => statusOf(s) === "breaks").length;
  if (breaking > 0) parts.unshift(`${plural(breaking, "symbol", "symbols")} ${breaking === 1 ? "doesn't" : "don't"} run after the change`);
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
  const sandboxDown = status?.sandbox?.available === false;
  // This file's preview job, from the shared jobs poll (DESIGN.md §6.20 §4).
  const jobTargetKey = reviewTargetKeyOf(target);
  const job = useJob("preview", (j) => j.repoId === repoId && j.targetKey === jobTargetKey && j.filePath === filePath);
  const progressMessage =
    status?.state === "queued" && job?.state === "queued" && job.positionText ? `Queued, ${job.positionText}` : status?.progress?.message;

  // Symbols that threw, with the inputs they threw on: "Retry with the error" hands both to the model.
  const retry = useMemo(() => (result ? retryFor(result) : null), [result]);

  const retryWithError = () => {
    if (!result || !retry) return;
    // Hand-edited inputs of the symbols that worked stay; the failing ones get fresh ones.
    const kept = result.inputsSource === "user" ? Object.fromEntries(Object.entries(result.inputs).filter(([name]) => !retry[name])) : undefined;
    setEdited({});
    void run(kept, result.mocks, retry);
  };

  const start = () => {
    if (hasEdits && result) {
      void run({ ...result.inputs, ...edited }, result.mocks);
      setEdited({});
    } else {
      // Hand-edited inputs stick across re-runs; otherwise the model mocks up fresh ones.
      void run(result?.inputsSource === "user" ? result.inputs : undefined, result?.mocks);
    }
  };

  const runButton = (
    <button
      type="button"
      onClick={start}
      disabled={pending || sandboxDown}
      title={
        sandboxDown
          ? status?.sandbox?.reason
          : "Render the changed components and run the changed functions at the base and at the head, on the same inputs, in a Docker sandbox"
      }
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
          <Progress message={progressMessage} logs={logs} />
        ) : (
          <>
            <p className="max-w-md leading-relaxed text-muted-foreground">
              Renders the changed components and runs the changed functions at the base and at the head, on the same
              mocked-up inputs.
            </p>
            {runButton}
            {sandboxDown && <p className="max-w-md leading-relaxed text-warning">{status?.sandbox?.reason}</p>}
          </>
        )}
        {error && <ErrorLine text={error} />}
        {status?.state === "failed" &&
          (job?.state === "failed" ? (
            <JobFailureInline job={job} className="w-full max-w-md text-left" runAgain={start} />
          ) : (
            status.error && <ErrorLine text={status.error} />
          ))}
      </div>
    );
  }

  const summary = verdict(result.symbols);
  const retryButton = retry && (
    <button
      type="button"
      onClick={retryWithError}
      disabled={pending || sandboxDown}
      title="Run again with new inputs: the model sees the errors the last inputs hit and writes ones that avoid them"
      className="flex shrink-0 items-center gap-1.5 rounded-sm border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary disabled:opacity-50"
    >
      <RotateCcw className="size-3.5" aria-hidden />
      Retry with the error
      <Spark title="New inputs are mocked up by the model" />
    </button>
  );

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {pending ? (
            <Progress message={progressMessage} logs={[]} inline />
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
        {retryButton}
        {runButton}
      </div>

      {error && <ErrorLine text={error} />}
      {status?.state === "failed" &&
        (job?.state === "failed" ? (
          <JobFailureInline job={job} runAgain={start} />
        ) : (
          status.error && <ErrorLine text={status.error} />
        ))}
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

      {current?.pending ? (
        <p className="flex items-center gap-2 py-10 text-[13px] text-muted-foreground justify-center">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          Rendering {current.name}…
        </p>
      ) : current && (
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

/** Quiet notes that qualify the result rather than being it. */
function Footnotes({ result }: { result: PreviewResult }) {
  const notes: string[] = [];
  const mocked = (result.serverCalls ?? []).filter((c) => c.mocked);
  if (mocked.length > 0) {
    const names = mocked.map((c) => (c.kind === "action" ? c.name : `${c.method} ${c.url ? new URL(c.url).pathname : ""}`));
    notes.push(
      `Server responses ${result.mocksSource === "user" ? "reused" : "mocked by the model"} (the sandbox has no server): ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""}.`
    );
  }
  if (result.mocksNote) notes.push(result.mocksNote);
  if (result.runtimeNote) notes.push(result.runtimeNote);
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

// ---------------------------------------------------------------------------
// Components: one large comparison per case
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Functions: a table, unchanged cases folded
// ---------------------------------------------------------------------------

