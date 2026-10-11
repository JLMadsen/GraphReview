"use client";

// One changed symbol in the preview, with the inputs editor for its cases.

import { useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "cn";
import type {
  PreviewCaseInput,
  PreviewResult,
  PreviewSymbolResult,
} from "@/lib/preview/types";
import { ComponentView } from "./ComponentView";
import { FunctionView } from "./FunctionView";

export function ErrorLine({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 text-left text-destructive">
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="whitespace-pre-line">{text}</span>
    </p>
  );
}

export function SymbolView({
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

export function InputsEditor({
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
