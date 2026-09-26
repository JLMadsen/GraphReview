"use client";

// Editing the PR prerequisite checklist (DESIGN.md §6.6). One component for
// both places it's edited:
//
// - Settings (`repoId` absent): the global defaults every repo starts with.
// - The Graph tab's checklist card (`repoId` set): the global items with an
//   on/off switch *for this repo*, plus items only this repo has.
//
// Global items can only be edited in Settings, so a repo never silently
// changes another repo's checklist.

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { cn } from "cn";
import {
  CHECKLIST_KIND_OPTIONS,
  type ChecklistItemDTO,
  type ChecklistItemKindDTO,
  type ChecklistItemsResponseDTO,
} from "./checklist-types";

export interface ChecklistEditorProps {
  /** Absent: edit the global defaults. Present: this repo's view. */
  repoId?: string;
  /** Called after any change, so the caller can re-evaluate. */
  onChanged?: () => void;
}

async function send(url: string, method: string, body?: unknown): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(json?.error ?? `Request failed (${res.status}).`);
  }
}

function describeItem(item: ChecklistItemDTO): string {
  switch (item.kind) {
    case "ai":
      return item.question ?? "";
    case "protected-paths":
      return (item.patterns ?? []).join(", ");
    case "description":
      return `≥ ${item.limit ?? 1} characters`;
    case "max-files":
      return `≤ ${item.limit ?? 30} files`;
    case "max-lines":
      return `≤ ${item.limit ?? 500} lines`;
    default:
      return CHECKLIST_KIND_OPTIONS.find((o) => o.kind === item.kind)?.hint ?? "";
  }
}

export function ChecklistEditor({ repoId, onChanged }: ChecklistEditorProps) {
  const [items, setItems] = useState<ChecklistItemDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/checklist/items${repoId ? `?repoId=${encodeURIComponent(repoId)}` : ""}`);
      if (!res.ok) throw new Error(`Could not load the checklist (${res.status}).`);
      setItems(((await res.json()) as ChecklistItemsResponseDTO).items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [repoId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const scope = repoId ?? "global";
  const global = (items ?? []).filter((i) => i.scope === "global");
  const own = repoId ? (items ?? []).filter((i) => i.scope === repoId) : [];

  const row = (item: ChecklistItemDTO, control: React.ReactNode, removable: boolean) => (
    <li key={item.id} className="flex items-start gap-2 py-1.5">
      {control}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{item.label}</p>
        <p className="truncate text-[11px] text-muted-foreground" title={describeItem(item)}>
          <span className="mr-1 rounded bg-secondary px-1 font-mono text-[10px] uppercase">{item.kind}</span>
          {describeItem(item)}
        </p>
      </div>
      {removable && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => send(`/api/checklist/items/${encodeURIComponent(item.id)}`, "DELETE"))}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          aria-label={`Delete ${item.label}`}
          title="Delete"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </li>
  );

  const toggle = (checked: boolean, onChange: (next: boolean) => void, label: string) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={busy}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-0.5 size-3.5 shrink-0 accent-[var(--brand)]"
      aria-label={label}
    />
  );

  if (!items) {
    return error ? (
      <p className="text-[11px] text-destructive">{error}</p>
    ) : (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" /> Loading checklist…
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-[11px] text-destructive">{error}</p>}

      <div>
        <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {repoId ? "Defaults (switch off for this repo)" : "Defaults for every repo"}
        </p>
        <ul className="divide-y divide-border">
          {global.map((item) =>
            repoId
              ? row(
                  item,
                  toggle(
                    item.enabled && !item.disabledForRepo,
                    (on) =>
                      void act(() =>
                        send(`/api/repos/${encodeURIComponent(repoId)}/checklist/overrides`, "POST", {
                          itemId: item.id,
                          disabled: !on,
                        })
                      ),
                    `Use ${item.label} for this repo`
                  ),
                  false
                )
              : row(
                  item,
                  toggle(
                    item.enabled,
                    (on) => void act(() => send(`/api/checklist/items/${encodeURIComponent(item.id)}`, "PATCH", { enabled: on })),
                    `Enable ${item.label}`
                  ),
                  true
                )
          )}
          {global.length === 0 && <li className="py-1.5 text-[11px] text-muted-foreground">No default items.</li>}
        </ul>
        {repoId && <p className="mt-1 text-[10px] text-muted-foreground">Edit the defaults themselves in Settings.</p>}
      </div>

      {repoId && (
        <div>
          <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Only this repo</p>
          <ul className="divide-y divide-border">
            {own.map((item) =>
              row(
                item,
                toggle(
                  item.enabled,
                  (on) => void act(() => send(`/api/checklist/items/${encodeURIComponent(item.id)}`, "PATCH", { enabled: on })),
                  `Enable ${item.label}`
                ),
                true
              )
            )}
            {own.length === 0 && <li className="py-1.5 text-[11px] text-muted-foreground">None yet.</li>}
          </ul>
        </div>
      )}

      {adding ? (
        <AddItemForm
          busy={busy}
          onCancel={() => setAdding(false)}
          onAdd={(input) =>
            act(async () => {
              await send("/api/checklist/items", "POST", { scope, ...input });
              setAdding(false);
            })
          }
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Plus className="size-3" /> Add {repoId ? "an item for this repo" : "a default item"}
        </button>
      )}
    </div>
  );
}

interface NewItem {
  kind: ChecklistItemKindDTO;
  label: string;
  question?: string;
  limit?: number;
  patterns?: string[];
}

function AddItemForm({
  busy,
  onAdd,
  onCancel,
}: {
  busy: boolean;
  onAdd: (item: NewItem) => Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<ChecklistItemKindDTO>("ai");
  const option = CHECKLIST_KIND_OPTIONS.find((o) => o.kind === kind)!;
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");

  const valid =
    label.trim().length > 0 &&
    (option.field !== "question" || value.trim().length > 0) &&
    (option.field !== "patterns" || value.trim().length > 0) &&
    (option.field !== "limit" || value === "" || Number(value) > 0);

  const input =
    "w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand";

  return (
    <form
      className="space-y-2 rounded-lg border border-border bg-background/40 p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const item: NewItem = { kind, label: label.trim() };
        if (option.field === "question") item.question = value.trim();
        if (option.field === "patterns") item.patterns = value.split(/\r?\n|,/).map((p) => p.trim()).filter(Boolean);
        if (option.field === "limit") item.limit = value ? Number(value) : option.defaultLimit;
        void onAdd(item);
      }}
    >
      <select
        value={kind}
        onChange={(e) => {
          const next = e.target.value as ChecklistItemKindDTO;
          setKind(next);
          setValue("");
        }}
        className={input}
        aria-label="Kind of check"
      >
        {CHECKLIST_KIND_OPTIONS.map((o) => (
          <option key={o.kind} value={o.kind}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="text-[10px] text-muted-foreground">{option.hint}</p>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={kind === "ai" ? "Short label, e.g. Has tests" : option.label}
        className={input}
        aria-label="Label"
        maxLength={120}
      />
      {option.field === "question" && (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. Does the change add or update tests for the new behaviour?"
          rows={2}
          className={cn(input, "resize-y")}
          aria-label="Question"
        />
      )}
      {option.field === "patterns" && (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={"db/migrations/**\n*.prisma\npackage.json"}
          rows={3}
          className={cn(input, "resize-y font-mono")}
          aria-label="Paths"
        />
      )}
      {option.field === "limit" && (
        <input
          type="number"
          min={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={String(option.defaultLimit ?? "")}
          className={input}
          aria-label="Limit"
        />
      )}
      <div className="flex gap-1.5">
        <button
          type="submit"
          disabled={!valid || busy}
          className="rounded-full bg-brand px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
        >
          Add
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
