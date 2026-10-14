"use client";

// The Infra view's Files (DESIGN.md §6.16): the infrastructure files
// themselves, cut into one block per resource, each with a plain-English
// note in the margin (`explainResource`) — what it is, what it is linked to
// in the code, what the diff does to it. With a diff selected, a changed
// file shows its head with the removed lines put back in red where they
// were, so the note sits beside the lines it talks about.

import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, SquareArrowOutUpRight, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { diffQuery } from "../FileDiffModal";
import { mergeWithPatch, type MergedLine } from "../diff-utils";
import { highlightLines, languageForPath } from "../highlight";
import { ToolIcon } from "../InfraView";
import { explainResource, type NoteLine, type NoteTone } from "../infra-explain";
import type { InfraRow } from "../infra-view-model";
import type { InfraCatalog } from "../infra-types";
import type { FileContentResponseDTO, FileDiffResponseDTO, ReviewTargetDTO } from "../types";

type Loaded = { lines: MergedLine[]; diffed: boolean; truncated: boolean; deleted: boolean };
type LoadState = { status: "loading" } | { status: "error"; message: string } | ({ status: "ready" } & Loaded);

const plainLines = (text: string): MergedLine[] => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((t, i) => ({ old: i + 1, neu: i + 1, text: t, type: "ctx" as const }));
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json().catch(() => null)) as T | { error: string } | null;
  if (!res.ok || !json || (typeof json === "object" && "error" in (json as object))) {
    throw new Error(json && typeof json === "object" && "error" in (json as object) ? (json as { error: string }).error : `Request failed (${res.status}).`);
  }
  return json as T;
}

function useInfraFile(repoId: string, path: string | null, target: ReviewTargetDTO | null, changed: boolean): LoadState | null {
  const [state, setState] = useState<LoadState | null>(null);
  const targetKey = target ? JSON.stringify(target) : "";
  useEffect(() => {
    if (!path) return setState(null);
    let cancelled = false;
    setState({ status: "loading" });
    const load = async (): Promise<Loaded> => {
      if (target && changed) {
        const diff = await getJson<FileDiffResponseDTO>(`/api/repos/${repoId}/diff-impact/file?${diffQuery(target, path)}`);
        const file = await getJson<FileContentResponseDTO>(`/api/repos/${repoId}/diff-impact/file?${diffQuery(target, path, undefined, "file")}`);
        if (diff.status === "removed" || file.side === "base") {
          return { lines: plainLines(file.content).map((l) => ({ old: l.old, text: l.text, type: "del" as const })), diffed: true, truncated: file.truncated, deleted: true };
        }
        return { lines: mergeWithPatch(file.content, diff.patch), diffed: true, truncated: file.truncated, deleted: false };
      }
      const file = await getJson<FileContentResponseDTO>(`/api/repos/${encodeURIComponent(repoId)}/file?path=${encodeURIComponent(path)}`);
      return { lines: plainLines(file.content), diffed: false, truncated: file.truncated, deleted: false };
    };
    load()
      .then((data) => !cancelled && setState({ status: "ready", ...data }))
      .catch((err: unknown) => !cancelled && setState({ status: "error", message: err instanceof Error ? err.message : "Couldn't read the file." }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `targetKey` stands for `target`
  }, [repoId, path, targetKey, changed]);
  return state;
}

export interface InfraFilesProps {
  repoId: string;
  target: ReviewTargetDTO | null;
  catalog: InfraCatalog | null;
  rows: InfraRow[];
  /** Only files the diff changes (or with findings). */
  changedOnly: boolean;
  query: string;
  /** The file to show; null picks the first. */
  file: string | null;
  onFileChange: (file: string) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onOpenFile: (path: string, line?: number) => void;
}

interface FileEntry {
  path: string;
  rows: InfraRow[];
  changed: boolean;
  findings: number;
}

export function InfraFiles({ repoId, target, catalog, rows, changedOnly, query, file, onFileChange, selected, onSelect, onOpenFile }: InfraFilesProps) {
  const files = useMemo(() => {
    const byPath = new Map<string, FileEntry>();
    for (const row of rows) {
      const r = row.resource;
      if (!r.file || r.external) continue;
      const e = byPath.get(r.file) ?? byPath.set(r.file, { path: r.file, rows: [], changed: false, findings: 0 }).get(r.file)!;
      e.rows.push(row);
      if (row.change) e.changed = true;
      e.findings += row.findings.length;
    }
    // Changed first, then files that read as written (Helm templates last), then by path.
    const templated = (f: FileEntry) => f.rows.every((r) => r.resource.templated);
    return [...byPath.values()].sort(
      (a, b) => Number(b.changed || b.findings > 0) - Number(a.changed || a.findings > 0) || Number(templated(a)) - Number(templated(b)) || a.path.localeCompare(b.path)
    );
  }, [rows]);
  const q = query.trim().toLowerCase();
  const visible = files.filter((f) => (!changedOnly || f.changed || f.findings > 0) && (!q || f.path.toLowerCase().includes(q) || f.rows.some((r) => r.resource.address.toLowerCase().includes(q))));
  const current = visible.find((f) => f.path === file) ?? visible[0] ?? null;
  useEffect(() => {
    if (current && current.path !== file) onFileChange(current.path);
  }, [current, file, onFileChange]);

  const state = useInfraFile(repoId, current?.path ?? null, target, Boolean(current?.changed));

  if (visible.length === 0) {
    return <p className="px-6 py-12 text-center text-sm text-muted-foreground">{changedOnly ? "This diff doesn't change any infrastructure file." : "No infrastructure files match."}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Infrastructure files" className="w-60 shrink-0 overflow-y-auto border-r border-border py-1.5">
        {visible.map((f) => (
          <button
            key={f.path}
            type="button"
            onClick={() => onFileChange(f.path)}
            className={cn("flex w-full min-w-0 items-center gap-1.5 px-3 py-1 text-left hover:bg-secondary/50", current?.path === f.path && "bg-secondary")}
            title={f.path}
          >
            <ToolIcon tool={f.rows[0].resource.tool} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[11px]">{f.path.slice(f.path.lastIndexOf("/") + 1)}</span>
              <span className="block truncate font-mono text-[10px] text-muted-foreground">{f.path.slice(0, Math.max(0, f.path.lastIndexOf("/"))) || "/"}</span>
            </span>
            {f.findings > 0 && <TriangleAlert className="size-3 shrink-0 text-destructive" aria-label="Findings" />}
            {f.changed && <span className="size-1.5 shrink-0 rounded-full bg-warning" title="Changed by this diff" />}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {current && <AnnotatedFile entry={current} state={state} catalog={catalog} selected={selected} onSelect={onSelect} onOpenFile={onOpenFile} />}
      </div>
    </div>
  );
}

interface Block {
  start: number;
  end: number;
  rows: InfraRow[];
}

function AnnotatedFile({
  entry,
  state,
  catalog,
  selected,
  onSelect,
  onOpenFile,
}: {
  entry: FileEntry;
  state: LoadState | null;
  catalog: InfraCatalog | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const ready = state?.status === "ready" ? state : null;
  const highlighted = useMemo(() => (ready ? highlightLines(ready.lines.map((l) => l.text), languageForPath(entry.path)) : null), [ready, entry.path]);

  // Each resource starts a block at its first line: head lines for what the diff changed, base lines for the rest.
  const blocks = useMemo((): Block[] => {
    if (!ready) return [];
    const at = new Map<number, InfraRow[]>();
    for (const row of entry.rows) {
      const useNew = ready.diffed && row.change && row.change.action !== "destroy";
      let idx = ready.lines.findIndex((l) => (useNew ? l.neu : l.old) === row.resource.line);
      // A YAML document's resource starts at `kind:`; its `apiVersion:` line just above belongs to it too.
      if (idx > 0 && /^apiVersion:/.test(ready.lines[idx - 1].text)) idx--;
      if (idx >= 0) (at.get(idx) ?? at.set(idx, []).get(idx)!).push(row);
    }
    const starts = [...at.keys()].sort((a, b) => a - b);
    const out: Block[] = [];
    if (starts[0] !== 0) out.push({ start: 0, end: (starts[0] ?? ready.lines.length) - 1, rows: [] });
    starts.forEach((s, i) => out.push({ start: s, end: (starts[i + 1] ?? ready.lines.length) - 1, rows: at.get(s)! }));
    return out.filter((b) => b.end >= b.start);
  }, [ready, entry.rows]);

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-4 py-1.5 backdrop-blur">
        <span className="min-w-0 truncate font-mono text-xs">{entry.path}</span>
        {ready?.deleted && <span className="text-[11px] text-destructive">deleted by this diff</span>}
        {ready?.diffed && !ready.deleted && <span className="text-[11px] text-muted-foreground">as changed by this diff</span>}
        <button type="button" onClick={() => onOpenFile(entry.path)} className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          <SquareArrowOutUpRight className="size-3" aria-hidden /> Open file
        </button>
      </div>
      {(!state || state.status === "loading") && (
        <p className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Reading the file…
        </p>
      )}
      {state?.status === "error" && <p className="px-4 py-8 text-sm text-destructive">{state.message}</p>}
      {ready &&
        blocks.map((b) => (
          <section key={b.start} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] border-b border-border/60">
            <pre className="overflow-x-auto py-1 font-mono text-[11.5px] leading-[1.55]">
              {ready.lines.slice(b.start, b.end + 1).map((l, i) => {
                const html = highlighted?.[b.start + i];
                return (
                  <div key={i} className={cn("flex", l.type === "add" && "bg-success/10", l.type === "del" && "bg-destructive/10 text-destructive")}>
                    <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/70">{l.type === "del" ? "−" : (l.neu ?? "")}</span>
                    {html !== undefined && l.type !== "del" ? <span className="pr-3" dangerouslySetInnerHTML={{ __html: html || " " }} /> : <span className="pr-3">{l.text || " "}</span>}
                  </div>
                );
              })}
            </pre>
            <div className="border-l border-border/60 bg-card/30">
              {b.rows.map((row) => (
                <Note key={row.resource.id} row={row} catalog={catalog} selected={selected === row.resource.id} onSelect={onSelect} />
              ))}
            </div>
          </section>
        ))}
      {ready?.truncated && <p className="px-4 py-3 text-[11px] text-muted-foreground">The file is longer than is read here; the rest is cut off.</p>}
    </div>
  );
}

const TONE: Record<NoteTone, string> = {
  plain: "text-muted-foreground",
  good: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
};

function Note({ row, catalog, selected, onSelect }: { row: InfraRow; catalog: InfraCatalog | null; selected: boolean; onSelect: (id: string | null) => void }) {
  const note = useMemo(() => explainResource(row, catalog), [row, catalog]);
  const r = row.resource;
  return (
    <button
      type="button"
      onClick={() => onSelect(selected ? null : r.id)}
      className={cn("sticky top-9 block w-full px-3 py-2 text-left hover:bg-secondary/40", selected && "bg-secondary/60")}
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">{r.kind}</span>
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">{r.address}</span>
      </span>
      <span className="mt-0.5 block text-xs font-medium leading-snug">{note.title}</span>
      {note.change.length > 0 && (
        <span className="mt-1.5 block space-y-0.5 border-l-2 border-warning/70 pl-2">
          {note.change.map((l, i) => (
            <Line key={i} line={l} />
          ))}
        </span>
      )}
      {note.lines.length > 0 && (
        <span className="mt-1 block space-y-0.5">
          {note.lines.map((l, i) => (
            <Line key={i} line={l} />
          ))}
        </span>
      )}
    </button>
  );
}

function Line({ line }: { line: NoteLine }) {
  return <span className={cn("block text-[11px] leading-snug", TONE[line.tone])}>{line.text}</span>;
}
