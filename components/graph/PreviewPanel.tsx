"use client";

// The "Before / after" tab of the file diff modal (DESIGN.md §6.9): each
// function or component the file's change touched, run at the target's base
// and at its head on the same mocked-up inputs, side by side.
//
//   function   a row per case: what it returned, and the arguments after the
//              call (in-place changes show up there), before vs after
//   component  a row per case: both renders next to each other, in iframes
//              with scripts off, plus the markup on demand
//
// Anything that differs between the two sides gets the amber "changed"
// treatment; matching cells stay quiet. Inputs can be edited as JSON and
// re-run. Nothing runs until "Run" is pressed — a run costs a model call and
// two sandbox containers.

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, LoaderCircle, Play, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import type {
  PreviewCaseInput,
  PreviewCaseOutcome,
  PreviewCaseResult,
  PreviewInputs,
  PreviewResult,
  PreviewSideSummary,
  PreviewSymbolResult,
} from "@/lib/preview/types";
import { Spark } from "./Spark";
import type { ReviewTargetDTO } from "./types";
import { usePreview } from "./usePreview";

const CHANGE_LETTER: Record<PreviewSymbolResult["change"], { letter: string; className: string; title: string }> = {
  modified: { letter: "M", className: "text-warning", title: "Modified" },
  added: { letter: "A", className: "text-success", title: "Added" },
  removed: { letter: "D", className: "text-destructive", title: "Removed" },
};

function short(sha: string): string {
  return sha.slice(0, 7);
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface PreviewPanelProps {
  repoId: string;
  target: ReviewTargetDTO;
  filePath: string;
}

export function PreviewPanel({ repoId, target, filePath }: PreviewPanelProps) {
  const { status, result, error, pending, run, logs } = usePreview(repoId, target, filePath, true);
  const [edited, setEdited] = useState<PreviewInputs>({});

  const runWithEdits = () => {
    if (!result) return void run();
    const inputs: PreviewInputs = { ...result.inputs, ...edited };
    void run(inputs);
    // The edits are the next run's inputs now; the editor compares against those.
    setEdited({});
  };

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-start gap-3 border-b border-border pb-2.5">
        <p className="min-w-0 flex-1 leading-relaxed text-muted-foreground">
          Runs each changed function and component at the base and at the head, on the same inputs, in a Docker
          sandbox, and puts the results side by side.
          {result && (
            <>
              {" "}
              <code className="font-mono text-foreground">{short(result.baseSha)}</code> →{" "}
              <code className="font-mono text-foreground">{short(result.headSha)}</code>
            </>
          )}
        </p>
        <button
          type="button"
          onClick={() =>
            Object.keys(edited).length > 0
              ? runWithEdits()
              : // Hand-edited inputs stick across re-runs; otherwise the model mocks up fresh ones.
                void run(result?.inputsSource === "user" ? result.inputs : undefined)
          }
          disabled={pending}
          className="flex h-fit shrink-0 items-center gap-1.5 rounded-sm border border-border px-2.5 py-1 font-medium transition-colors hover:bg-secondary disabled:opacity-50"
        >
          {pending ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {result ? (Object.keys(edited).length > 0 ? "Run with edited inputs" : "Run again") : "Run"}
          {Object.keys(edited).length === 0 && result?.inputsSource !== "user" && (
            <Spark title="Inputs are mocked up by the model" />
          )}
        </button>
      </div>

      {error && <ErrorLine text={error} />}
      {status?.state === "failed" && status.error && <ErrorLine text={status.error} />}

      {pending && (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            {status?.progress?.message ?? "Starting…"}
          </p>
          {logs.length > 0 && (
            <pre className="max-h-24 overflow-y-auto border-l border-border pl-2.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
              {logs.slice(-8).join("\n")}
            </pre>
          )}
        </div>
      )}

      {!pending && !result && status?.state === "none" && (
        <p className="py-6 text-center text-muted-foreground">Not run yet for this file.</p>
      )}

      {result && (
        <PreviewResultView
          result={result}
          edited={edited}
          onEdit={(name, cases) =>
            setEdited((prev) => {
              const next = { ...prev };
              if (cases) next[name] = cases;
              else delete next[name];
              return next;
            })
          }
        />
      )}
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 text-destructive">
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="whitespace-pre-line">{text}</span>
    </p>
  );
}

function PreviewResultView({
  result,
  edited,
  onEdit,
}: {
  result: PreviewResult;
  edited: PreviewInputs;
  onEdit: (name: string, cases: PreviewCaseInput[] | null) => void;
}) {
  const totalCases = result.symbols.reduce((n, s) => n + s.cases.length, 0);
  const differing = result.symbols.reduce((n, s) => n + s.cases.filter((c) => c.differs).length, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-medium">
          {result.symbols.length === 0
            ? "Nothing to run"
            : differing === 0
              ? `All ${totalCases} case${totalCases === 1 ? "" : "s"} behave the same`
              : `${differing} of ${totalCases} case${totalCases === 1 ? "" : "s"} changed`}
        </h3>
        <span className="text-muted-foreground">
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
          <span className="font-mono">{(result.durationMs / 1000).toFixed(1)} s</span>
        </span>
      </div>

      {result.inputsNote && <p className="text-warning">{result.inputsNote}</p>}
      <SideNotes label="Before" side={result.before} />
      <SideNotes label="After" side={result.after} />

      {result.symbols.length === 0 && (
        <p className="text-muted-foreground">
          No changed function or component in this file can be called from outside it.
        </p>
      )}

      {result.symbols.map((symbol) => (
        <SymbolSection
          key={symbol.name}
          symbol={symbol}
          result={result}
          editedCases={edited[symbol.name]}
          onEdit={(cases) => onEdit(symbol.name, cases)}
        />
      ))}

      {result.skipped.length > 0 && (
        <p className="border-t border-border pt-2 text-muted-foreground">
          Not run:{" "}
          {result.skipped.map((s, i) => (
            <span key={`${s.name}-${i}`}>
              {i > 0 && "; "}
              <code className="font-mono text-foreground">{s.name}</code> — {s.reason}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function SideNotes({ label, side }: { label: string; side: PreviewSideSummary }) {
  const notes: Array<{ text: string; tone: "error" | "warn" | "muted" }> = [];
  if (side.missing) notes.push({ text: "the file doesn't exist on this side", tone: "muted" });
  if (side.fatal) notes.push({ text: side.fatal, tone: "error" });
  if (side.stubbedModules.length > 0) {
    notes.push({
      text: `approximate — couldn't load ${side.stubbedModules.slice(0, 6).join(", ")}${side.stubbedModules.length > 6 ? ` +${side.stubbedModules.length - 6}` : ""}, so they were replaced with empty stand-ins`,
      tone: "warn",
    });
  }
  if (side.deps.startsWith("failed")) notes.push({ text: `dependency install ${side.deps}`, tone: "warn" });
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {notes.map((note, i) => (
        <p
          key={i}
          className={cn(
            "leading-relaxed",
            note.tone === "error" ? "text-destructive" : note.tone === "warn" ? "text-warning" : "text-muted-foreground"
          )}
        >
          <span className="font-medium">{label}:</span> {note.text}
        </p>
      ))}
    </div>
  );
}

function SymbolSection({
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
  const change = CHANGE_LETTER[symbol.change];
  const differing = symbol.cases.filter((c) => c.differs).length;

  return (
    <section className="border-t border-border pt-2.5">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={cn("font-mono text-[11px] font-semibold", change.className)} title={change.title}>
          {change.letter}
        </span>
        <code className="font-mono text-[13px] text-foreground">{symbol.name}</code>
        <span className="text-muted-foreground">
          {symbol.kind}
          {symbol.via && (
            <>
              {" · uses changed "}
              <code className="font-mono">{symbol.via}</code>
            </>
          )}
          {" · "}
          {differing === 0 ? "same on every case" : <span className="text-warning">{differing} changed</span>}
        </span>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="ml-auto rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          {editing ? "Done" : editedCases ? "Inputs edited" : "Edit inputs"}
        </button>
      </header>

      {symbol.beforeError && <p className="mt-1 text-destructive">Before: {symbol.beforeError}</p>}
      {symbol.afterError && <p className="mt-1 text-destructive">After: {symbol.afterError}</p>}

      {editing && (
        <InputsEditor
          initial={editedCases ?? result.inputs[symbol.name] ?? []}
          baseline={result.inputs[symbol.name] ?? []}
          kind={symbol.kind}
          onChange={onEdit}
        />
      )}

      <div className="mt-2 flex flex-col gap-3">
        {symbol.cases.map((c, i) =>
          symbol.kind === "component" ? (
            <ComponentCase key={i} item={c} result={result} change={symbol.change} />
          ) : (
            <FunctionCase key={i} item={c} change={symbol.change} />
          )
        )}
      </div>
    </section>
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
    <div className="mt-2">
      <textarea
        value={text}
        onChange={(e) => apply(e.target.value)}
        spellCheck={false}
        rows={Math.min(16, text.split("\n").length + 1)}
        className="w-full resize-y rounded-sm border border-border bg-canvas p-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:border-brand"
      />
      <p className={cn("mt-0.5 text-[11px]", problem ? "text-destructive" : "text-muted-foreground")}>
        {problem ??
          (kind === "component"
            ? 'Each case: { "label", "input": { "props": { … } } }. Press "Run with edited inputs" to apply.'
            : 'Each case: { "label", "input": { "args": [ … ] } }. Press "Run with edited inputs" to apply.')}
      </p>
    </div>
  );
}

function CaseHeader({ item }: { item: PreviewCaseResult }) {
  const input = item.input.props ?? item.input.args ?? [];
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className={cn("shrink-0 font-medium", item.differs && "text-warning")}>{item.label}</span>
      <code className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={compactJson(input)}>
        {compactJson(input)}
        {item.input.kwargs ? ` ${compactJson(item.input.kwargs)}` : ""}
      </code>
    </div>
  );
}

/** A value cell. `other` is the opposite side's value: when they differ, this one is marked. */
function ValueCell({ label, value, other, missing, error }: { label: string; value?: string; other?: string; missing?: boolean; error?: boolean }) {
  if (missing) return <div className="text-muted-foreground/70 italic">—</div>;
  const differs = value !== other;
  return (
    <div className="min-w-0">
      <div className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</div>
      <pre
        className={cn(
          "overflow-x-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap",
          error ? "text-destructive" : "text-foreground",
          differs && "-mx-1 rounded-sm bg-warning/15 px-1"
        )}
      >
        {value ?? "—"}
      </pre>
    </div>
  );
}

function OutcomeCells({ mine, theirs, missing }: { mine?: PreviewCaseOutcome; theirs?: PreviewCaseOutcome; missing: boolean }) {
  if (missing || !mine) return <div className="text-muted-foreground/70 italic">{missing ? "doesn't exist on this side" : "didn't run"}</div>;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {mine.threw !== undefined ? (
        <ValueCell label="threw" value={mine.threw} other={theirs?.threw} error />
      ) : (
        <ValueCell label="returned" value={mine.returned} other={theirs?.returned} />
      )}
      <ValueCell label="arguments after" value={mine.argsAfter} other={theirs?.argsAfter} />
      {mine.logs && mine.logs.length > 0 && (
        <pre className="max-h-20 overflow-y-auto font-mono text-[10px] leading-relaxed text-muted-foreground">
          {mine.logs.join("\n")}
        </pre>
      )}
    </div>
  );
}

function FunctionCase({ item, change }: { item: PreviewCaseResult; change: PreviewSymbolResult["change"] }) {
  return (
    <div className={cn("border-l-2 pl-2.5", item.differs ? "border-warning" : "border-border")}>
      <CaseHeader item={item} />
      <div className="mt-1.5 grid grid-cols-2 gap-4">
        <div className="min-w-0">
          <SideLabel text="Before" />
          <OutcomeCells mine={item.before} theirs={item.after} missing={change === "added"} />
        </div>
        <div className="min-w-0">
          <SideLabel text="After" />
          <OutcomeCells mine={item.after} theirs={item.before} missing={change === "removed"} />
        </div>
      </div>
    </div>
  );
}

function SideLabel({ text }: { text: string }) {
  return <div className="mb-1 text-[11px] font-medium text-muted-foreground">{text}</div>;
}

function srcDoc(html: string, css: string | undefined): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{background:#fff;color:#111;margin:0}body{padding:12px;font-family:system-ui,sans-serif;font-size:14px}</style><style>${(css ?? "").replace(/<\/style/gi, "<\\/style")}</style></head><body>${html}</body></html>`;
}

function RenderFrame({ outcome, css, missing, title }: { outcome?: PreviewCaseOutcome; css?: string; missing: boolean; title: string }) {
  if (missing) return <div className="py-6 text-center text-muted-foreground/70 italic">doesn&apos;t exist on this side</div>;
  if (!outcome) return <div className="py-6 text-center text-muted-foreground/70 italic">didn&apos;t run</div>;
  if (outcome.threw !== undefined) {
    return <pre className="font-mono text-[11px] whitespace-pre-wrap text-destructive">{outcome.threw}</pre>;
  }
  return (
    <div className="h-32 resize-y overflow-hidden rounded-sm border border-border bg-white">
      {/* Scripts off (empty sandbox): the markup is static server output, nothing in it should run. */}
      <iframe title={title} sandbox="" srcDoc={srcDoc(outcome.html ?? "", css)} className="size-full" />
    </div>
  );
}

function ComponentCase({ item, result, change }: { item: PreviewCaseResult; result: PreviewResult; change: PreviewSymbolResult["change"] }) {
  const [showMarkup, setShowMarkup] = useState(false);
  return (
    <div className={cn("border-l-2 pl-2.5", item.differs ? "border-warning" : "border-border")}>
      <div className="flex items-baseline gap-2">
        <div className="min-w-0 flex-1">
          <CaseHeader item={item} />
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {item.differs ? <span className="text-warning">markup changed</span> : "same markup"}
        </span>
        <button
          type="button"
          onClick={() => setShowMarkup((v) => !v)}
          className="flex shrink-0 items-center gap-0.5 rounded-sm px-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {showMarkup ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
          HTML
        </button>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-4">
        <div className="min-w-0">
          <SideLabel text="Before" />
          <RenderFrame outcome={item.before} css={result.before.css} missing={change === "added"} title={`${item.label}, before`} />
        </div>
        <div className="min-w-0">
          <SideLabel text="After" />
          <RenderFrame outcome={item.after} css={result.after.css} missing={change === "removed"} title={`${item.label}, after`} />
        </div>
      </div>
      {showMarkup && (
        <div className="mt-2 grid grid-cols-2 gap-4">
          <ValueCell label="before" value={item.before?.html} other={item.after?.html} missing={change === "added"} />
          <ValueCell label="after" value={item.after?.html} other={item.before?.html} missing={change === "removed"} />
        </div>
      )}
    </div>
  );
}
