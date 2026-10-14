"use client";

// The Graph tab's Data view (DESIGN.md §6.13 §7): the tables the analysed
// commit's migrations, schema files and ORM models declare.
//
//   Canvas  an ER diagram on the shared `CardFlow`: table cards listing
//           their columns (keys, type, nullability, +/−/~ on a diff), joined
//           column to column by their foreign keys — dashed when only an ORM
//           relation declares one. "All tables" puts cards in boxes by owning
//           component (else Postgres schema) when there are two or more such
//           boxes; name-prefix groups stay in the list. "Changed only" shows the
//           changed tables with their direct FK neighbours faded. Changed
//           cards get an amber edge, new ones green, removed ones red and
//           struck. A selected table opens its explainer in the right column.
//   List    like the API and Infra views: rows that open in place.
//
// The toolbar: the view switch, then with a diff selected "Changed only N |
// All tables M", then Canvas | List, the database picker and search.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, KeyRound, LoaderCircle, Search, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { CardFlow, DEFAULT_ELK_OPTIONS, type CardFlowLink } from "./CardFlow";
import { Segmented } from "./Segmented";
import { VIEW_CANVAS, VIEW_TOOLBAR } from "./view-chrome";
import { DbTableDetail, SourceBadge } from "./DbTableDetail";
import { DbSourcePicker } from "./DbSourcePicker";
import { ASSESSMENT_VISUALS } from "./review-visuals";
import { STATUS_STYLES, groupTables, tableLabel, type DbRow } from "./db-view-model";
import type { Database, DbChange, DbSchemaResponseDTO, DbTable } from "./db-types";

export type DataMode = "canvas" | "list";

/** Cards on one canvas at most — beyond it the list (or a search) reads better. */
const MAX_CANVAS = 250;
const CARD_WIDTH = 236;
/** Columns a card lists before "+N more" (keys and changed columns first). */
const CARD_COLUMNS = 14;
/** In "Changed only" the list opens the changed rows — up to this many. */
const AUTO_OPEN = 8;
const ELK_OPTIONS = { ...DEFAULT_ELK_OPTIONS, "elk.layered.spacing.nodeNodeBetweenLayers": "90", "elk.spacing.nodeNode": "28", "elk.aspectRatio": "2.2" };

export interface DataViewProps {
  schema: DbSchemaResponseDTO | null;
  rows: DbRow[];
  loading: boolean;
  error: string | null;
  change?: DbChange;
  changePending?: boolean;
  changedOnly: boolean;
  onChangedOnlyChange: (value: boolean) => void;
  mode: DataMode;
  onModeChange: (mode: DataMode) => void;
  /** The table whose explainer is open in the right column (canvas). */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** A table opened from elsewhere (the left column) — shown and scrolled to. A new object each time. */
  focus: { id: string } | null;
  onOpenFile: (path: string, line?: number) => void;
  onOpenEndpoint?: (endpointId: string) => void;
  /** For choosing the schema source file (`DbSourcePicker`); without it the source can't be changed here. */
  repoId?: string;
  /** Re-read the schema — after the source changed and the re-analysis finished. */
  onReload?: () => void;
  className?: string;
}

type CardColumn = { name: string; type: string; nullable: boolean; pk: boolean; fk: boolean; mark?: "added" | "removed" | "changed" | "renamed"; from?: string };

/**
 * The columns a card lists, in table order: every column when they fit,
 * else the keys and changed ones first (still in table order) and a "+N more"
 * line. Columns the change dropped are listed struck at the end.
 */
function cardColumns(row: DbRow): { shown: CardColumn[]; more: number } {
  const t = row.table;
  const c = row.change;
  const deltas = c && c.status !== "added" && c.status !== "removed" ? c.columns : [];
  const markOf = new Map(deltas.filter((d) => d.status !== "removed").map((d) => [d.name, d]));
  const fkCols = new Set(t.fks.flatMap((f) => f.columns));
  const all: CardColumn[] = t.columns.map((col) => {
    const d = markOf.get(col.name);
    return {
      name: col.name,
      type: col.type,
      nullable: col.nullable,
      pk: Boolean(col.primary) || t.pk.includes(col.name),
      fk: fkCols.has(col.name),
      ...(d ? { mark: d.status, ...(d.status === "renamed" ? { from: d.from } : {}) } : {}),
    };
  });
  const dropped: CardColumn[] = deltas
    .filter((d) => d.status === "removed")
    .map((d) => ({ name: d.name, type: d.before?.type ?? "", nullable: d.before?.nullable ?? true, pk: false, fk: false, mark: "removed" }));
  if (all.length <= CARD_COLUMNS) return { shown: [...all, ...dropped], more: 0 };
  const keep = new Set(all.filter((x) => x.pk || x.fk || x.mark).slice(0, CARD_COLUMNS).map((x) => x.name));
  for (const x of all) if (keep.size < CARD_COLUMNS) keep.add(x.name);
  return { shown: [...all.filter((x) => keep.has(x.name)), ...dropped], more: all.length - keep.size };
}

const MARKS = { added: ["+", "text-success"], removed: ["−", "text-destructive"], changed: ["~", "text-warning"], renamed: ["~", "text-warning"] } as const;

function TableCard({ row, selected, faded }: { row: DbRow; selected: boolean; faded: boolean }) {
  const t = row.table;
  const c = row.change;
  const status = c?.status;
  const concern = ASSESSMENT_VISUALS.concern;
  const { shown, more } = cardColumns(row);
  return (
    <div
      style={{ width: CARD_WIDTH }}
      className={cn(
        "relative overflow-hidden rounded-md border bg-card text-left transition-[opacity,border-color]",
        status === "added"
          ? "border-success/70"
          : status === "removed"
            ? "border-destructive/70"
            : status
              ? "border-warning/70"
              : "border-foreground/20",
        selected && "border-brand ring-1 ring-brand",
        faded && "opacity-40",
      )}
    >
      <div
        className={cn(
          "flex items-baseline gap-2 border-b border-foreground/10 px-2.5 py-1",
          status === "added"
            ? "bg-[color-mix(in_oklab,var(--success)_12%,var(--card))]"
            : status === "removed"
              ? "bg-[color-mix(in_oklab,var(--destructive)_12%,var(--card))]"
              : status
                ? "bg-[color-mix(in_oklab,var(--warning)_12%,var(--card))]"
                : "bg-secondary/60",
        )}
      >
        <p className={cn("amc-name min-w-0 flex-1 font-mono text-[12px] font-medium [overflow-wrap:anywhere]", status === "removed" && "line-through")} title={tableLabel(t)}>
          {tableLabel(t)}
        </p>
        {row.findings.length > 0 && <TriangleAlert className="size-3 shrink-0 self-center" style={{ color: concern.text }} aria-label={`${row.findings.length} finding(s)`} />}
        {status && status !== "changed" && <span className={cn("shrink-0 text-[10px]", STATUS_STYLES[status]?.className)}>{STATUS_STYLES[status]?.word}</span>}
      </div>
      {status === "renamed" && <p className="truncate px-2.5 pt-0.5 font-mono text-[10px] text-muted-foreground">was {c?.renamedFrom}</p>}
      <ul className="py-0.5 font-mono text-[10.5px] leading-[17px]">
        {shown.map((col) => {
          const mark = col.mark ? MARKS[col.mark] : null;
          return (
            <li key={`${col.mark ?? ""}:${col.name}`} data-port={col.mark === "removed" ? undefined : col.name} className={cn("flex min-w-0 items-center gap-1 px-2.5", col.mark === "removed" && "opacity-70")}>
              <span className={cn("w-2 shrink-0 text-center", mark?.[1])}>{mark?.[0] ?? ""}</span>
              <span className="w-3.5 shrink-0 text-[9px] text-muted-foreground" title={col.pk ? "Primary key" : col.fk ? "Foreign key" : undefined}>
                {col.pk ? <KeyRound className="size-2.5 text-warning" aria-label="Primary key" /> : col.fk ? "fk" : ""}
              </span>
              <span className={cn("min-w-0 flex-1 truncate", col.pk && "font-medium", col.mark === "removed" && "line-through")} title={col.from ? `${col.from} → ${col.name}` : col.name}>
                {col.name}
              </span>
              <span className="max-w-[45%] shrink-0 truncate text-muted-foreground" title={col.type}>
                {col.type}
                {col.nullable && !col.pk ? "?" : ""}
              </span>
            </li>
          );
        })}
        {more > 0 && <li className="px-2.5 pl-[2.1rem] text-muted-foreground">+{more} more</li>}
        {shown.length === 0 && <li className="px-2.5 text-muted-foreground">no columns read</li>}
      </ul>
    </div>
  );
}

export function DataView({
  schema,
  rows,
  loading,
  error,
  change,
  changePending,
  changedOnly,
  onChangedOnlyChange,
  mode,
  onModeChange,
  selectedId,
  onSelect,
  focus,
  onOpenFile,
  onOpenEndpoint,
  repoId,
  onReload,
  className,
}: DataViewProps) {
  const [query, setQuery] = useState("");
  // --- The schema source (DESIGN.md §6.13, pinned source) --------------------
  const [picking, setPicking] = useState(false);
  /** A source change is being applied: the re-analysis it started hasn't finished. */
  const [reReading, setReReading] = useState(false);
  const pin = schema?.pin ?? null;
  const builtFrom = schema?.pinned?.file ?? null;
  useEffect(() => {
    if (!reReading || !repoId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}`, { cache: "no-store" });
        const repo = res.ok ? ((await res.json()) as { status?: string }) : null;
        if (cancelled) return;
        if (repo && repo.status !== "analyzing" && repo.status !== "stale") {
          setReReading(false);
          onReload?.();
          return;
        }
      } catch {
        /* try again */
      }
      timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [reReading, repoId, onReload]);
  const sourceChanged = () => {
    setPicking(false);
    setReReading(true);
    onReload?.();
  };
  const databases = useMemo(() => schema?.databases ?? [], [schema]);
  const [dbId, setDbId] = useState<string | null>(null);
  const showChanges = Boolean(change) && changedOnly;

  // The database shown: the picked one, else the one the change touches most, else the biggest.
  const activeDb: Database | undefined = useMemo(() => {
    const picked = databases.find((d) => d.id === dbId);
    if (picked) return picked;
    if (change?.tables.length) {
      const counts = new Map<string, number>();
      for (const c of change.tables) counts.set(c.table.database, (counts.get(c.table.database) ?? 0) + 1);
      const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
      const db = databases.find((d) => d.id === best);
      if (db) return db;
    }
    return databases[0];
  }, [databases, dbId, change]);

  const tablesById = useMemo(() => new Map(rows.map((r) => [r.table.id, r.table])), [rows]);
  const dbRows = useMemo(() => rows.filter((r) => !activeDb || r.table.database === activeDb.id), [rows, activeDb]);
  const changedRows = useMemo(() => dbRows.filter((r) => r.change || r.findings.length > 0), [dbRows]);

  const matches = useCallback(
    (t: DbTable) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return [tableLabel(t), t.definedAt.file, ...t.models.map((m) => m.name), ...t.columns.map((c) => c.name)].some((x) => x.toLowerCase().includes(q));
    },
    [query],
  );

  /** What the canvas / list shows, and which of it is context (faded FK neighbours). */
  const { visible, context } = useMemo(() => {
    if (!showChanges) return { visible: dbRows.filter((r) => matches(r.table)), context: new Set<string>() };
    const ids = new Set(changedRows.map((r) => r.table.id));
    const ctx = new Set<string>();
    if (mode === "canvas") {
      for (const r of changedRows) {
        for (const f of r.table.fks) if (!ids.has(f.refTable) && tablesById.has(f.refTable)) ctx.add(f.refTable);
        for (const o of dbRows) if (!ids.has(o.table.id) && o.table.fks.some((f) => f.refTable === r.table.id)) ctx.add(o.table.id);
      }
    }
    const list = dbRows.filter((r) => (ids.has(r.table.id) || ctx.has(r.table.id)) && matches(r.table));
    const order: Record<string, number> = { removed: 0, renamed: 1, changed: 2, added: 3 };
    list.sort(
      (a, b) =>
        Number(ctx.has(a.table.id)) - Number(ctx.has(b.table.id)) ||
        Number(b.findings.length > 0) - Number(a.findings.length > 0) ||
        (order[a.change?.status ?? ""] ?? 9) - (order[b.change?.status ?? ""] ?? 9) ||
        a.table.name.localeCompare(b.table.name),
    );
    return { visible: list, context: ctx };
  }, [showChanges, dbRows, changedRows, matches, mode, tablesById]);

  // --- Focus from the left column ---------------------------------------------
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!focus) return;
    const row = rows.find((r) => r.table.id === focus.id);
    if (!row) return;
    if (row.table.database !== activeDb?.id) setDbId(row.table.database);
    if (!visible.some((r) => r.table.id === focus.id)) {
      setQuery("");
      if (showChanges && !row.change) onChangedOnlyChange(false);
    }
    onSelect(focus.id);
    setOpen((s) => new Set(s).add(focus.id));
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-table="${CSS.escape(focus.id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new focus object moves anything
  }, [focus]);
  const changeKey = change ? change.tables.map((c) => `${c.status}:${c.id}`).join("|") : "";
  useEffect(() => {
    if (!showChanges) return;
    setOpen(new Set(changedRows.filter((r) => r.change?.status !== "added" || r.findings.length).slice(0, AUTO_OPEN).map((r) => r.table.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run per set of changes, not per object identity
  }, [showChanges, changeKey]);
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const focusTable = (id: string) => {
    const row = rows.find((r) => r.table.id === id);
    if (!row) return;
    if (row.table.database !== activeDb?.id) setDbId(row.table.database);
    if (!visible.some((r) => r.table.id === id)) {
      setQuery("");
      if (showChanges) onChangedOnlyChange(false);
    }
    onSelect(id);
    setOpen((s) => new Set(s).add(id));
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-table="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  // --- Canvas -------------------------------------------------------------------
  const canvasRows = useMemo(() => visible.slice(0, MAX_CANVAS), [visible]);
  const rowById = useMemo(() => new Map(canvasRows.map((r) => [r.table.id, r])), [canvasRows]);
  const links = useMemo<CardFlowLink[]>(() => {
    const out: CardFlowLink[] = [];
    for (const r of canvasRows) {
      const added = new Set((r.change?.fks.added ?? []).map((f) => f.columns.join(",")));
      for (const f of r.table.fks) {
        if (!rowById.has(f.refTable) || f.refTable === r.table.id) continue;
        const isNew = r.change?.status !== "added" && added.has(f.columns.join(","));
        out.push({
          id: `${r.table.id}->${f.refTable}:${f.columns.join(",")}`,
          source: r.table.id,
          target: f.refTable,
          label: `${f.columns.join(", ")} → ${f.refColumns.join(", ")}`,
          weight: 1,
          sourcePort: f.columns[0],
          ...(f.refColumns[0] ? { targetPort: f.refColumns[0] } : {}),
          ...(f.inferred ? { dashed: true } : {}),
          ...(isNew ? { tone: "new" as const } : {}),
        });
      }
      for (const f of r.change?.status === "changed" || r.change?.status === "renamed" ? r.change.fks.removed : []) {
        if (rowById.has(f.refTable)) out.push({ id: `${r.table.id}-x>${f.refTable}:${f.columns.join(",")}`, source: r.table.id, target: f.refTable, label: `${f.columns.join(", ")} → ${f.refColumns.join(", ")}`, weight: 1, tone: "removed" });
      }
    }
    return out;
  }, [canvasRows, rowById]);
  // Boxes only for owning components / Postgres schemas, and only when there
  // are two or more: a box per name prefix (or one box around everything)
  // says little. With boxes, FKs between them get no ELK route (CardFlow
  // lays each box out on its own and packs them, linked boxes side by side).
  const groups = useMemo(() => {
    if (showChanges) return undefined;
    const boxes = [...groupTables(canvasRows.map((r) => r.table))].filter(([id]) => !id.startsWith("p:"));
    return boxes.length >= 2 ? boxes.map(([id, g]) => ({ id, label: g.label, cardIds: g.ids })) : undefined;
  }, [canvasRows, showChanges]);
  const renderCard = useCallback(
    (id: string) => {
      const row = rowById.get(id);
      return row ? <TableCard row={row} selected={selectedId === id} faded={context.has(id)} /> : null;
    },
    [rowById, selectedId, context],
  );
  const highlighted = useMemo(() => new Set(selectedId && rowById.has(selectedId) ? [selectedId] : []), [selectedId, rowById]);
  // Tables that all reference one hub (`users`) share a layer — a column as
  // tall as their count. Coffman-Graham caps a layer's size, spreading them
  // over several columns left of the hub. `layoutKey` covers the count.
  const elkOptions = useMemo(
    () => ({
      ...ELK_OPTIONS,
      "elk.layered.layering.strategy": "COFFMAN_GRAHAM",
      "elk.layered.layering.coffmanGraham.layerBound": String(Math.max(4, Math.ceil(Math.sqrt(canvasRows.length)))),
    }),
    [canvasRows.length],
  );
  const layoutKey = `${activeDb?.id}|${showChanges}|${canvasRows.map((r) => `${r.table.id}:${r.table.columns.length}:${r.change?.status ?? ""}:${r.change?.columns.length ?? 0}`).join(",")}|${links.length}`;

  // --- List: All tables grouped like the canvas boxes; Changed only flat ----------
  const sections = useMemo(() => {
    if (showChanges) return [{ key: "changes", label: "", rows: visible }];
    const groupsOf = groupTables(visible.map((r) => r.table));
    const byId = new Map(visible.map((r) => [r.table.id, r]));
    const placed = new Set<string>();
    const out = [...groupsOf].map(([key, g]) => {
      g.ids.forEach((id) => placed.add(id));
      return { key, label: g.label, rows: g.ids.map((id) => byId.get(id)!).filter(Boolean) };
    });
    const rest = visible.filter((r) => !placed.has(r.table.id));
    if (rest.length) out.push({ key: "rest", label: out.length ? "other tables" : "", rows: rest });
    return out.sort((a, b) => (a.key === "rest" ? 1 : b.key === "rest" ? -1 : a.label.localeCompare(b.label)));
  }, [visible, showChanges]);

  const total = databases.reduce((n, d) => n + d.tables.length, 0);
  const changeCount = rows.filter((r) => r.change || r.findings.length > 0).length;

  return (
    <div className={className}>
      <div className={VIEW_TOOLBAR}>
        {change ? (
          <Segmented
            label="Show"
            size="xs"
            value={changedOnly ? "changes" : "all"}
            onChange={(v) => onChangedOnlyChange(v === "changes")}
            options={[
              {
                value: "changes" as const,
                label: (
                  <>
                    Changed only <span className="font-mono text-muted-foreground">{changeCount}</span>
                  </>
                ),
                title: "The tables this diff changes, with their direct foreign-key neighbours (faded) on the canvas",
              },
              {
                value: "all" as const,
                label: (
                  <>
                    All tables <span className="font-mono text-muted-foreground">{total}</span>
                  </>
                ),
                title: "Every table, with this diff's changes marked",
              },
            ]}
          />
        ) : (
          schema?.state === "ready" && <span className="font-mono text-[11px] text-muted-foreground">{total} tables</span>
        )}
        <Segmented
          label="Layout"
          size="xs"
          value={mode}
          onChange={onModeChange}
          options={[
            { value: "canvas" as const, label: "Canvas", title: "Tables as cards joined by their foreign keys" },
            { value: "list" as const, label: "List", title: "Tables as rows that open in place" },
          ]}
        />
        {changePending && !change && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" aria-hidden /> Comparing the schema…
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {loading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          {databases.length > 1 && (
            <select
              value={activeDb?.id ?? ""}
              onChange={(e) => {
                setDbId(e.target.value);
                onSelect(null);
              }}
              aria-label="Database"
              title="One database per migrations folder or schema source"
              className="h-7 max-w-56 rounded-md border border-border bg-background px-1.5 font-mono text-[11px] text-foreground"
            >
              {databases.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.tables.length}
                </option>
              ))}
            </select>
          )}
          <label className="flex h-7 w-44 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs focus-within:border-foreground/30">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a table…"
              aria-label="Find tables by name, column, model or file"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear" className="text-muted-foreground hover:text-foreground">
                <X className="size-3" />
              </button>
            )}
          </label>
        </div>
      </div>

      {schema?.state === "ready" && repoId && (pin || databases.length > 0 || reReading) && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border bg-card/60 px-4 py-1 text-[11px] text-muted-foreground">
          {pin ? (
            <>
              <span>
                Source: <span className="font-mono text-foreground">{pin}</span> (pinned)
              </span>
              <span aria-hidden>·</span>
              <button type="button" onClick={() => setPicking(true)} className="hover:text-foreground hover:underline">
                Change
              </button>
              <span aria-hidden>·</span>
              <button
                type="button"
                onClick={() =>
                  void fetch(`/api/repos/${encodeURIComponent(repoId)}/db-schema/source`, { method: "DELETE" }).then((res) => {
                    if (res.ok) sourceChanged();
                  })
                }
                className="hover:text-foreground hover:underline"
              >
                Use auto-detect
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setPicking(true)} className="hover:text-foreground hover:underline">
              Choose the source file…
            </button>
          )}
          {(reReading || pin !== builtFrom) && (
            <span className="ml-auto flex items-center gap-1">
              <LoaderCircle className="size-3 animate-spin" aria-hidden /> Re-reading the schema{pin ? ` from ${pin}` : " by auto-detection"}…
            </span>
          )}
        </div>
      )}
      {picking && repoId && <DbSourcePicker repoId={repoId} pin={pin} onChanged={sourceChanged} onClose={() => setPicking(false)} className="border-b border-border bg-card/60 px-4 py-3" />}

      {activeDb && (activeDb.orderProblems.length > 0 || activeDb.sources.length > 0) && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 border-b border-border bg-card/60 px-4 py-1 text-[11px] text-muted-foreground">
          <span className="font-mono">
            {activeDb.name}
            {activeDb.dialect ? ` · ${activeDb.dialect}${activeDb.dialectGuessed ? " (guessed)" : ""}` : ""}
          </span>
          {activeDb.sources.map((s) => (
            <span key={`${s.kind}:${s.path}`} className="flex items-center gap-1">
              <SourceBadge source={s.kind} />
              <span className="font-mono">{s.tool === "sql-in-code" ? (s.kind === "migration" ? "migrations in code" : "DDL in code") : s.tool}</span> {s.path}
            </span>
          ))}
          {activeDb.migrations.length > 0 && <span>{activeDb.migrations.length} migrations</span>}
          {activeDb.opaque.length > 0 && <span title={activeDb.opaque.slice(0, 8).map((o) => o.text).join("\n")}>{activeDb.opaque.length} statements not modelled</span>}
          {activeDb.orderProblems.map((p) => (
            <span key={p} className="text-warning">
              {p}
            </span>
          ))}
        </div>
      )}

      {error && !schema && (
        <p className="flex items-start gap-2 px-6 py-8 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      {!schema && !error && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading the schema…
        </div>
      )}
      {schema?.state === "none" && (
        <p className="px-6 py-12 text-center text-sm text-muted-foreground">The schema is read during analysis — it appears once this repo&apos;s next analysis finishes.</p>
      )}
      {schema?.state === "ready" && databases.length === 0 && !change?.tables.length && (
        <div className="mx-auto max-w-2xl overflow-y-auto px-6 py-12 text-sm text-muted-foreground">
          <p className="text-foreground">No database schema found.</p>
          <p className="mt-2 leading-relaxed">
            Looked for migrations (Prisma, Drizzle, TypeORM, Django, Alembic, golang-migrate, dbmate, goose, Supabase, Flyway, numbered <span className="font-mono">.sql</span> folders),
            <span className="font-mono"> schema.prisma</span>, Drizzle tables, <span className="font-mono">schema.sql</span>, ORM models (TypeORM, Django, SQLAlchemy, SQLModel) and
            CREATE / ALTER statements in code strings. Rails, Sequelize, Knex
            migrations, Mongoose and JPA aren&apos;t read yet.
          </p>
          {repoId && !picking && <DbSourcePicker repoId={repoId} pin={pin} onChanged={sourceChanged} className="mt-6 border-t border-border pt-4" />}
        </div>
      )}
      {schema?.state === "ready" && visible.length === 0 && (total > 0 || Boolean(change?.tables.length)) && (
        <p className="px-6 py-12 text-center text-sm text-muted-foreground">
          {showChanges && changeCount === 0 ? "This diff doesn't change the schema." : showChanges ? "This diff doesn't change this database — pick another one, or show all tables." : "Nothing matches."}
        </p>
      )}

      {mode === "canvas" && visible.length > 0 && (
        <CardFlow
          className={VIEW_CANVAS}
          cardIds={canvasRows.map((r) => r.table.id)}
          cardWidth={CARD_WIDTH}
          renderCard={renderCard}
          links={links}
          highlighted={highlighted}
          layoutKey={layoutKey}
          onCardClick={(id) => onSelect(selectedId === id ? null : id)}
          onPaneClick={() => onSelect(null)}
          alwaysLabelEdges={0}
          ports
          elkOptions={elkOptions}
          groups={groups}
        >
          {visible.length > MAX_CANVAS && (
            <p className="absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground">
              Showing {MAX_CANVAS} of {visible.length} tables — search, or use the list.
            </p>
          )}
        </CardFlow>
      )}

      {mode === "list" && visible.length > 0 && (
        <div ref={listRef} className="@container relative min-h-[220px] flex-1 overflow-y-auto bg-background">
          {sections.map((s) => (
            <section key={s.key}>
              {s.label && (
                <h3 className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-border bg-background/95 px-4 pt-3 pb-1 text-xs font-semibold backdrop-blur">
                  <span className="min-w-0 truncate font-mono">{s.label}</span>
                  <span className="ml-auto font-mono text-[11px] font-normal text-muted-foreground">{s.rows.length}</span>
                </h3>
              )}
              <ul>
                {s.rows.map((row) => {
                  const id = row.table.id;
                  const isOpen = open.has(id);
                  return (
                    <Fragment key={id}>
                      <li data-table={id} className="scroll-mt-10">
                        <TableRow row={row} open={isOpen} onToggle={() => toggle(id)} />
                        {isOpen && (
                          <DbTableDetail
                            row={row}
                            db={databases.find((d) => d.id === row.table.database)}
                            tablesById={tablesById}
                            change={change}
                            onFocusTable={focusTable}
                            onOpenFile={onOpenFile}
                            onOpenEndpoint={onOpenEndpoint}
                            className="border-b border-border bg-card/60 px-4 pt-2 pb-3 pl-[2.75rem]"
                          />
                        )}
                      </li>
                    </Fragment>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function TableRow({ row, open, onToggle }: { row: DbRow; open: boolean; onToggle: () => void }) {
  const t = row.table;
  const status = row.change?.status;
  const style = status ? STATUS_STYLES[status] : null;
  const concern = ASSESSMENT_VISUALS.concern;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn("flex w-full min-w-0 items-center gap-2.5 border-b border-border/60 px-4 py-1.5 text-left transition-colors hover:bg-secondary/50", open && "bg-card/60", status === "removed" && "opacity-75")}
    >
      <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
      <span className={cn("min-w-0 truncate font-mono text-xs", status === "removed" && "line-through")}>{tableLabel(t)}</span>
      {status === "renamed" && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">was {row.change?.renamedFrom}</span>}
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{t.columns.length} col</span>
      {t.models[0] && <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground @xl:inline">{t.models.map((m) => m.name).join(", ")}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {t.view && <span className="rounded-[3px] border border-border px-1.5 text-[10px] leading-4 text-muted-foreground">view</span>}
        {t.drift.length > 0 && (
          <span className="rounded-[3px] border border-border px-1.5 text-[10px] leading-4 text-muted-foreground" title={t.drift.map((d) => d.text).join("\n")}>
            drift {t.drift.length}
          </span>
        )}
        <SourceBadge source={t.source} />
        {style && (
          <span className={cn("shrink-0 rounded-[3px] border border-current/40 px-1.5 text-[10px] leading-4", style.className)} title={style.title}>
            {style.word}
          </span>
        )}
        {row.findings.length > 0 && (
          <span className="flex items-center gap-0.5 text-[10px]" style={{ color: concern.text }} title={row.findings.map((f) => f.summary).join("\n")}>
            <TriangleAlert className="size-3" aria-hidden />
            {row.findings.length > 1 && <span className="font-mono">{row.findings.length}</span>}
          </span>
        )}
      </span>
    </button>
  );
}
