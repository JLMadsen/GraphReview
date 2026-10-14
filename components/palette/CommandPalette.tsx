"use client";

// The command palette (DESIGN.md §6.18): Ctrl+Space or Ctrl/Cmd+K anywhere.
// Mounted once in the root layout. Navigate first — type part of a name, pick
// a result, land on it; commands behind `>`. Every result has a list of
// places it opens in: Enter takes the first, → (caret at the end) or Tab
// opens the list, Ctrl+Enter takes the second.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Box,
  ChevronRight,
  CircleAlert,
  CornerDownLeft,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Globe,
  KeyRound,
  Layers,
  MessageSquare,
  Search,
  Server,
  Sparkles,
  SquareFunction,
  Table2,
  Terminal,
} from "lucide-react";
import { cn } from "cn";
import type { ChatActionDTO } from "@/components/graph/chat-types";
import { fuzzyMatch } from "@/lib/search/fuzzy";
import { SCOPE_PREFIXES, type SearchItem, type SearchKind, type SearchNotice, type SearchRepoInfo, type SearchResponse, type SearchScope } from "@/lib/search/types";
import { COMMANDS, targetsFor, type PaletteCommand, type PaletteEnv, type PaletteTarget } from "./actions";
import {
  graphIsOpen,
  onOpenPalette,
  retargetGraph,
  sendToGraph,
  setPendingGraphRequest,
  useGraphContext,
  type GraphTarget,
} from "./bus";

type Scope = SearchScope | "commands";

const KIND_META: Record<SearchKind, { label: string; icon: typeof Box }> = {
  component: { label: "Components", icon: Box },
  file: { label: "Files", icon: FileCode2 },
  symbol: { label: "Symbols", icon: SquareFunction },
  finding: { label: "Findings", icon: CircleAlert },
  pr: { label: "Pull requests", icon: GitPullRequest },
  branch: { label: "Branches", icon: GitBranch },
  commit: { label: "Commits", icon: GitCommitHorizontal },
  endpoint: { label: "Endpoints", icon: Globe },
  table: { label: "Tables", icon: Table2 },
  env: { label: "Env vars", icon: KeyRound },
  infra: { label: "Infra", icon: Server },
  repo: { label: "Repos", icon: FolderGit2 },
};

const SCOPE_LABEL: Record<Scope, string> = {
  all: "",
  commands: "Commands",
  files: "Files",
  symbols: "Symbols",
  refs: "PRs, branches, commits",
  findings: "Findings",
  "findings-all": "Findings, all reviews",
  endpoints: "Endpoints",
  repos: "Repos",
};

const TONE_CLASS: Record<string, string> = {
  defect: "bg-red-500/15 text-red-400",
  concern: "bg-amber-500/15 text-amber-400",
  unknown: "bg-sky-500/15 text-sky-400",
  ok: "bg-emerald-500/15 text-emerald-400",
  changed: "bg-amber-500/15 text-amber-300",
  open: "bg-emerald-500/15 text-emerald-400",
  merged: "bg-violet-500/15 text-violet-400",
  closed: "bg-red-500/15 text-red-400",
  draft: "bg-muted text-muted-foreground",
  muted: "bg-muted text-muted-foreground",
};

/** One selectable line of the list. */
type Row =
  | { type: "item"; item: SearchItem; group: string }
  | { type: "command"; command: PaletteCommand; match?: number[]; group: string }
  | { type: "notice"; notice: SearchNotice; group: string }
  | { type: "ask"; question: string; group: string };

function repoIdFromPath(pathname: string): string | null {
  return /^\/repo\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

function parseQuery(raw: string, chip: Scope | null): { scope: Scope; q: string } {
  if (chip) return { scope: chip, q: raw };
  const hit = SCOPE_PREFIXES.find((p) => raw.startsWith(p.prefix));
  return hit ? { scope: hit.scope, q: raw.slice(hit.prefix.length).trimStart() } : { scope: "all", q: raw };
}

function Highlighted({ text, match }: { text: string; match?: number[] }) {
  if (!match?.length) return <>{text}</>;
  const set = new Set(match);
  const parts: React.ReactNode[] = [];
  let run = "";
  let runHit = false;
  const flush = (key: number) => {
    if (!run) return;
    parts.push(runHit ? <mark key={key} className="bg-transparent font-semibold text-foreground">{run}</mark> : <span key={key}>{run}</span>);
    run = "";
  };
  [...text].forEach((ch, i) => {
    const hit = set.has(i);
    if (hit !== runHit) {
      flush(i);
      runHit = hit;
    }
    run += ch;
  });
  flush(text.length);
  return <>{parts}</>;
}

const SHORTCUTS: Array<[string, string]> = [
  ["Ctrl+Space, Ctrl/Cmd+K", "Open or close the palette"],
  ["↑ ↓", "Move"],
  ["Enter", "Open in the first place"],
  ["Ctrl+Enter", "Open in the second place"],
  ["→ or Tab", "Open in… (all places)"],
  ["← or Esc", "Back"],
  ["Backspace", "Drop the scope chip (empty query)"],
  ["> / @ # ! :", "Commands, files, symbols, PRs/branches/commits, findings, endpoints"],
  ["t", "Files view: search files"],
];

export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const repoId = repoIdFromPath(pathname);
  const graphCtx = useGraphContext();
  const graph = graphCtx && graphCtx.repoId === repoId ? graphCtx : null;

  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [chip, setChip] = useState<Scope | null>(null);
  const [help, setHelp] = useState(false);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [context, setContext] = useState<SearchItem[]>([]);
  const [cursor, setCursor] = useState(-1);
  const [submenu, setSubmenu] = useState<{ cursor: number } | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [repoInfo, setRepoInfo] = useState<SearchRepoInfo | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { scope, q } = parseQuery(raw, chip);

  const show = useCallback(
    (options: { scope?: Scope; query?: string } = {}) => {
      setOpen(true);
      setHelp(false);
      setSubmenu(null);
      setChip(options.scope && options.scope !== "all" ? options.scope : null);
      setRaw(options.query ?? "");
      setCursor(-1);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    []
  );
  const close = useCallback(() => {
    setOpen(false);
    setSubmenu(null);
    setHelp(false);
  }, []);

  // Ctrl+Space / Ctrl/Cmd+K, in text fields too (capture: before anything else sees it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const space = e.ctrlKey && !e.metaKey && !e.altKey && (e.code === "Space" || e.key === " ");
      const k = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
      if (!space && !k) return;
      e.preventDefault();
      e.stopPropagation();
      if (open) close();
      else show();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, show, close]);
  useEffect(() => onOpenPalette((o) => show(o)), [show]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.tone === "error" ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- Searching ------------------------------------------------------------
  const touchedKey = graph?.touched.join("\n") ?? "";
  useEffect(() => {
    if (!open || scope === "commands" || help) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(repoId ? { repoId } : {}),
            q,
            scope,
            ...(graph?.targetKey ? { targetKey: graph.targetKey } : {}),
            ...(graph?.touched.length ? { touched: graph.touched } : {}),
          }),
          signal: controller.signal,
        });
        const body = (await res.json().catch(() => null)) as SearchResponse | null;
        if (!res.ok || !body) throw new Error((body as unknown as { error?: string })?.error ?? `Search failed (${res.status}).`);
        setResult(body);
        if (body.repo) setRepoInfo(body.repo);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setResult({ items: [], notices: [{ id: "error", text: (error as Error).message }] });
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 80);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `graph` is read through its key fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, scope, repoId, graph?.targetKey, touchedKey, help]);

  // Empty query inside a review: its open defects and concerns as context rows.
  useEffect(() => {
    if (!open || !repoId || !graph?.targetKey) {
      setContext([]);
      return;
    }
    const controller = new AbortController();
    fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoId, q: "", scope: "findings", targetKey: graph.targetKey }),
      signal: controller.signal,
    })
      .then((r) => (r.ok ? (r.json() as Promise<SearchResponse>) : null))
      .then((body) => setContext((body?.items ?? []).filter((i) => i.badge?.tone === "defect" || i.badge?.tone === "concern").slice(0, 5)))
      .catch(() => {});
    return () => controller.abort();
  }, [open, repoId, graph?.targetKey]);

  // --- Rows -------------------------------------------------------------------
  const env = useMemo<PaletteEnv>(() => {
    const json = async <T,>(res: Response): Promise<T> => {
      const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
      return body as T;
    };
    const graphUrl = (target: GraphTarget) => {
      const params = new URLSearchParams();
      if (target && "pr" in target) params.set("pr", String(target.pr));
      else if (target) {
        params.set("base", target.base);
        params.set("head", target.head);
      }
      const qs = params.toString();
      return `/repo/${repoId}/graph${qs ? `?${qs}` : ""}`;
    };
    return {
      repoId,
      repo: repoInfo && repoInfo.id === repoId ? repoInfo : null,
      graph,
      show(action: ChatActionDTO, options = {}) {
        if (!repoId) return;
        if (sendToGraph(repoId, { kind: "action", action })) return;
        setPendingGraphRequest({ repoId, request: { kind: "action", action }, needsTarget: Boolean(options.needsTarget) });
        router.push(`/repo/${repoId}/graph`);
      },
      openTarget(target, then) {
        if (!repoId) return;
        const key = target ? ("pr" in target ? `pr:${target.pr}` : `refs:${target.base}...${target.head}`) : undefined;
        if (graph && key && graph.targetKey === key) {
          if (then) sendToGraph(repoId, { kind: "action", action: then });
          return;
        }
        if (then) setPendingGraphRequest({ repoId, request: { kind: "action", action: then }, needsTarget: true });
        if (graphIsOpen(repoId)) {
          try {
            window.history.replaceState(window.history.state, "", graphUrl(target));
          } catch {
            /* the URL is a convenience */
          }
          retargetGraph(target);
        } else {
          router.push(graphUrl(target));
        }
      },
      navigate: (href) => router.push(href),
      openExternal: (url) => window.open(url, "_blank", "noopener,noreferrer"),
      copy: (text, what) => {
        void navigator.clipboard?.writeText(text).then(
          () => setToast({ text: `${what} copied.`, tone: "ok" }),
          () => setToast({ text: `Couldn't copy the ${what.toLowerCase()}.`, tone: "error" })
        );
      },
      notify: (text, tone = "ok") => setToast({ text, tone }),
      post: async (url, body) =>
        json(await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) })),
      get: async (url) => json(await fetch(url, { cache: "no-store" })),
      setScope: (s) => {
        setChip(s);
        setRaw("");
        setCursor(-1);
        setSubmenu(null);
        requestAnimationFrame(() => inputRef.current?.focus());
      },
      showHelp: () => setHelp(true),
    };
  }, [repoId, repoInfo, graph, router]);

  const commandRows = useMemo<Row[]>(() => {
    if (scope !== "commands" && (scope !== "all" || !q)) return [];
    const scoredCommands: Array<{ command: PaletteCommand; score: number; match?: number[] }> = [];
    for (const command of COMMANDS) {
      if (command.when && !command.when(env)) continue;
      const m = fuzzyMatch(q, command.title) ?? (q && command.keywords && fuzzyMatch(q, command.keywords) ? { score: 20, indexes: [] } : null);
      if (!m) continue;
      scoredCommands.push({ command, score: m.score, match: m.indexes });
    }
    scoredCommands.sort((a, b) => b.score - a.score);
    const list = scope === "all" ? scoredCommands.slice(0, 3) : scoredCommands;
    return list.map(({ command, match }) => ({ type: "command" as const, command, match, group: scope === "all" ? "Commands" : command.group }));
  }, [scope, q, env]);

  const rows = useMemo<Row[]>(() => {
    if (help) return [];
    if (scope === "commands") return commandRows;
    const out: Row[] = [];
    for (const notice of result?.notices ?? []) out.push({ type: "notice", notice, group: "" });
    if (scope === "all" && !q) {
      for (const item of result?.recents ?? []) out.push({ type: "item", item, group: "Recent" });
      for (const item of context) out.push({ type: "item", item, group: "Open findings in this review" });
      return out;
    }
    // Groups in the order of their best result.
    const groups = new Map<SearchKind, SearchItem[]>();
    for (const item of result?.items ?? []) {
      const list = groups.get(item.kind) ?? [];
      list.push(item);
      groups.set(item.kind, list);
    }
    for (const [kind, items] of groups) {
      const label = scope === "findings-all" ? "Findings in every review" : KIND_META[kind].label;
      for (const item of items) out.push({ type: "item", item, group: label });
    }
    out.push(...commandRows);
    // The chat answers about the open review, or the whole repo with none open.
    if (repoId && q && scope === "all") out.push({ type: "ask", question: q, group: "" });
    return out;
  }, [help, scope, q, result, context, commandRows, repoId]);

  useEffect(() => {
    setCursor(-1);
    setSubmenu(null);
  }, [raw, chip]);
  // `cursor` -1 is "not moved yet": the first row — but never the Ask row,
  // which would spend tokens on a plain Enter.
  const activeIndex = cursor === -1 ? rows.findIndex((r) => r.type !== "ask") : Math.min(cursor, rows.length - 1);
  const active = activeIndex >= 0 ? rows[activeIndex] : undefined;

  const targetsOf = useCallback((row: Row | undefined): PaletteTarget[] => {
    if (!row) return [];
    if (row.type === "item") return targetsFor(row.item, env);
    if (row.type === "command") return [{ id: "run", label: "Run", run: (e) => row.command.run(e) }];
    if (row.type === "ask") {
      return [
        {
          id: "ask",
          label: "Ask the chat",
          run: (e) => {
            if (!e.repoId) return;
            const request = { kind: "ask" as const, question: row.question };
            if (sendToGraph(e.repoId, request)) return;
            setPendingGraphRequest({ repoId: e.repoId, request, needsTarget: false });
            router.push(`/repo/${e.repoId}/graph`);
          },
        },
      ];
    }
    const action = row.notice.action;
    const command = action === "analyse-head" ? "analyse-head" : action === "reanalyse" ? "reanalyse" : action === "refresh-remote" ? "refresh-remote" : null;
    const found = COMMANDS.find((c) => c.id === command);
    return found ? [{ id: "run", label: found.title, run: (e) => found.run(e) }] : [];
  }, [env, router]);

  const activeTargets = useMemo(() => targetsOf(active), [targetsOf, active]);

  const runTarget = useCallback(
    async (row: Row, target: PaletteTarget | undefined) => {
      if (!target) return;
      const keepOpen = row.type === "command" && (row.command.id === "shortcuts" || row.command.id.startsWith("search-"));
      if (!keepOpen) close();
      if (row.type === "item") {
        void fetch("/api/search/history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(repoId ? { repoId } : {}), item: row.item }),
        }).catch(() => {});
      }
      try {
        await target.run(env);
      } catch (error) {
        setToast({ text: (error as Error).message, tone: "error" });
      }
    },
    [close, env, repoId]
  );

  // Keep the active row in view.
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    if (e.key === "Escape") {
      e.preventDefault();
      if (submenu) setSubmenu(null);
      else if (help) setHelp(false);
      else close();
      return;
    }
    if (submenu) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = activeTargets.length;
        setSubmenu({ cursor: (submenu.cursor + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSubmenu(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (active) void runTarget(active, activeTargets[submenu.cursor]);
      } else if (e.key === "Tab") {
        e.preventDefault();
        setSubmenu(null);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      const n = rows.length;
      const from = activeIndex === -1 ? (e.key === "ArrowDown" ? -1 : 0) : activeIndex;
      setCursor((from + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n);
      return;
    }
    if ((e.key === "ArrowRight" && input.selectionStart === raw.length && input.selectionEnd === raw.length) || (e.key === "Tab" && !e.shiftKey)) {
      if (activeTargets.length > 1) {
        e.preventDefault();
        setSubmenu({ cursor: 0 });
      } else if (e.key === "Tab") {
        e.preventDefault();
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!active) return;
      void runTarget(active, activeTargets[(e.ctrlKey || e.metaKey) && activeTargets.length > 1 ? 1 : 0]);
      return;
    }
    if (e.key === "Backspace" && raw === "" && chip) {
      e.preventDefault();
      setChip(null);
    }
  }

  if (!open) return toast ? <Toast toast={toast} /> : null;

  const placeholder = !repoId
    ? "Search repos, or > for commands"
    : chip
      ? `Search ${SCOPE_LABEL[chip].toLowerCase()}…`
      : "Search files, components, PRs, findings… (> commands, / files, @ symbols)";

  let lastGroup: string | null = null;

  return (
    <>
      {toast && <Toast toast={toast} />}
      <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[1px]" onMouseDown={close} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="fixed top-[12vh] left-1/2 z-[101] flex max-h-[70vh] w-[min(680px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {(chip || (scope !== "all" && !chip)) && (
            <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[11px] font-medium text-accent-foreground">
              {SCOPE_LABEL[scope]}
            </span>
          )}
          <input
            ref={inputRef}
            autoFocus
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            aria-label="Search"
            aria-activedescendant={activeIndex >= 0 ? `palette-row-${activeIndex}` : undefined}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {loading && <span className="size-3 shrink-0 animate-spin rounded-full border border-muted-foreground border-t-transparent" aria-label="Searching" />}
        </div>

        <div className="relative flex min-h-0 flex-1">
          <div ref={listRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
            {help ? (
              <div className="px-4 py-3 text-sm">
                <div className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Keyboard shortcuts</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
                  {SHORTCUTS.map(([keys, what]) => (
                    <div key={keys} className="contents">
                      <dt className="font-mono text-xs text-foreground/80">{keys}</dt>
                      <dd className="text-muted-foreground">{what}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : rows.length > 0 && rows.every((r) => r.type === "ask") ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">{loading ? "Searching…" : "Nothing matches."}</div>
            ) : rows.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                {loading ? "Searching…" : q ? "Nothing matches." : scope === "all" ? "Nothing picked yet in this repo — start typing." : "Type to search."}
              </div>
            ) : (
              rows.map((row, i) => {
                if (row.type === "ask") return null;
                const header = row.group && row.group !== lastGroup ? row.group : null;
                lastGroup = row.group;
                const selected = i === activeIndex;
                return (
                  <div key={rowKey(row, i)}>
                    {header && <div className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{header}</div>}
                    <RowView
                      row={row}
                      index={i}
                      selected={selected}
                      hasMore={selected && activeTargets.length > 1}
                      defaultLabel={selected ? activeTargets[0]?.label : undefined}
                      onHover={() => !submenu && setCursor(i)}
                      onPick={() => void runTarget(row, targetsOf(row)[0])}
                      onMore={() => {
                        setCursor(i);
                        setSubmenu({ cursor: 0 });
                        inputRef.current?.focus();
                      }}
                    />
                  </div>
                );
              })
            )}
          </div>

          {submenu && active && active.type !== "ask" && (
            <div className="absolute top-2 right-2 z-10 w-60 rounded-lg border border-border bg-popover p-1 shadow-xl" role="menu" aria-label="Open in">
              <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Open in…</div>
              {activeTargets.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitem"
                  onMouseEnter={() => setSubmenu({ cursor: i })}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void runTarget(active, t)}
                  className={cn(
                    "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm",
                    i === submenu.cursor ? "bg-accent text-accent-foreground" : "text-foreground/85"
                  )}
                >
                  <span>{t.label}</span>
                  {i === 0 && <span className="text-[10px] text-muted-foreground">Enter</span>}
                  {i === 1 && <span className="text-[10px] text-muted-foreground">Ctrl+Enter</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Pinned under the results, so it never scrolls out of sight; never the default selection. */}
        {!help &&
          rows.map((row, i) =>
            row.type === "ask" ? (
              <div key="ask" className="border-t border-border py-1">
                <RowView
                  row={row}
                  index={i}
                  selected={i === activeIndex}
                  hasMore={false}
                  defaultLabel={i === activeIndex ? "Enter to send" : undefined}
                  onHover={() => !submenu && setCursor(i)}
                  onPick={() => void runTarget(row, targetsOf(row)[0])}
                  onMore={() => {}}
                />
              </div>
            ) : null
          )}

        <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          {SCOPE_PREFIXES.map((p) => (
            <button
              key={p.prefix}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setChip(null);
                setRaw(`${p.prefix}${q}`);
                inputRef.current?.focus();
              }}
              className="hover:text-foreground"
              title={p.label}
            >
              <span className="font-mono text-foreground/70">{p.prefix}</span> {p.label.split(",")[0]}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-1">
            <CornerDownLeft className="size-3" aria-hidden /> open · → more
          </span>
        </div>
      </div>
    </>
  );
}

function rowKey(row: Row, i: number): string {
  if (row.type === "item") return `${row.group}:${row.item.key}`;
  if (row.type === "command") return `cmd:${row.command.id}`;
  if (row.type === "notice") return `notice:${row.notice.id}`;
  return `ask:${i}`;
}

function RowView({
  row,
  index,
  selected,
  hasMore,
  defaultLabel,
  onHover,
  onPick,
  onMore,
}: {
  row: Row;
  index: number;
  selected: boolean;
  hasMore: boolean;
  defaultLabel?: string;
  onHover: () => void;
  onPick: () => void;
  onMore: () => void;
}) {
  let Icon: typeof Box = Terminal;
  let title: React.ReactNode;
  let subtitle: string | undefined;
  let badge: SearchItem["badge"];
  if (row.type === "item") {
    Icon = KIND_META[row.item.kind].icon;
    title = <Highlighted text={row.item.title} match={row.item.match} />;
    subtitle = row.item.subtitle;
    badge = row.item.badge;
  } else if (row.type === "command") {
    Icon = Layers;
    title = <Highlighted text={row.command.title} match={row.match} />;
    subtitle = row.command.group;
  } else if (row.type === "notice") {
    Icon = Sparkles;
    title = row.notice.text;
  } else {
    Icon = MessageSquare;
    title = (
      <>
        Ask chat: <span className="text-foreground">{row.question}</span>
      </>
    );
    subtitle = "Sends it to the chat on the Graph tab — uses your AI provider";
  }
  return (
    <div
      id={`palette-row-${index}`}
      data-row={index}
      role="option"
      aria-selected={selected}
      onMouseMove={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className={cn(
        "mx-1 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm",
        selected ? "bg-accent text-accent-foreground" : "text-foreground/85",
        row.type === "notice" && "text-muted-foreground"
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate">{title}</div>
        {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {badge && <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", TONE_CLASS[badge.tone])}>{badge.text}</span>}
      {selected && defaultLabel && <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">{defaultLabel}</span>}
      {hasMore && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onMore();
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          aria-label="Open in…"
          title="Open in… (→)"
        >
          <ChevronRight className="size-4" />
        </button>
      )}
    </div>
  );
}

function Toast({ toast }: { toast: { text: string; tone: "ok" | "error" } }) {
  return (
    <div
      role="status"
      className={cn(
        "fixed right-4 bottom-4 z-[102] max-w-sm rounded-lg border px-3 py-2 text-sm shadow-lg",
        toast.tone === "error" ? "border-red-500/40 bg-popover text-red-300" : "border-border bg-popover text-foreground"
      )}
    >
      {toast.text}
    </div>
  );
}
