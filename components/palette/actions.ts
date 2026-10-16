"use client";

// What each palette result opens in, and the palette's commands
// (DESIGN.md §6.18). Pure descriptions over a small environment the palette
// component provides, so the rules for "where does a symbol go" live in one
// place.

import type { ChatActionDTO } from "@/components/graph/chat-types";
import type { SearchItem, SearchRepoInfo, SearchScope } from "@/lib/search/types";
import type { DiffPickMode, PaletteGraphContext } from "./bus";

export interface PaletteEnv {
  repoId: string | null;
  repo: SearchRepoInfo | null;
  /** The open Graph tab's context, when it is this repo's. */
  graph: PaletteGraphContext | null;
  /** Shows something on the Graph tab — at once when it is open, else after navigating there. */
  show(action: ChatActionDTO, options?: { needsTarget?: boolean }): void;
  /** Opens the Graph tab's diff picker on its PR or branch list. */
  pick(mode: DiffPickMode, repoId?: string): void;
  /** Opens a review target on the Graph tab, then (optionally) shows something in it. */
  openTarget(target: { pr: number } | { base: string; head: string } | null, then?: ChatActionDTO): void;
  navigate(href: string): void;
  openExternal(url: string): void;
  copy(text: string, what: string): void;
  notify(text: string, tone?: "ok" | "error"): void;
  /** A JSON POST; resolves to the parsed body, rejects with the server's message. */
  post<T = unknown>(url: string, body?: unknown): Promise<T>;
  get<T = unknown>(url: string): Promise<T>;
  setScope(scope: SearchScope): void;
  showHelp(): void;
}

export interface PaletteTarget {
  id: string;
  label: string;
  run(env: PaletteEnv): void | Promise<void>;
}

const hasTarget = (env: PaletteEnv) => Boolean(env.graph?.target);

/** The host's web page for the repo, without a trailing `.git`. */
export function repoWebUrl(repo: SearchRepoInfo | null): string | undefined {
  if (!repo?.url || !/^https?:\/\//.test(repo.url)) return undefined;
  return repo.url.replace(/\.git$/, "").replace(/\/+$/, "");
}

export function prWebUrl(repo: SearchRepoInfo | null, number: number): string | undefined {
  const base = repoWebUrl(repo);
  if (!base) return undefined;
  return repo!.provider === "gitlab" ? `${base}/-/merge_requests/${number}` : `${base}/pull/${number}`;
}

/** `pr:<n>` / `refs:<base>...<head>` → the Graph tab's params. */
function targetFromKey(key: string): { pr: number } | { base: string; head: string } | null {
  const pr = /^pr:(\d+)$/.exec(key);
  if (pr) return { pr: Number(pr[1]) };
  const refs = /^refs:(.+)\.\.\.(.+)$/.exec(key);
  return refs ? { base: refs[1], head: refs[2] } : null;
}

const showFile = (path: string, line?: number): ChatActionDTO => ({
  kind: "show",
  target: "file",
  id: path,
  label: line ? `${path}:${line}` : path,
  ...(line ? { line } : {}),
});

const showComponent = (id: string, label: string): ChatActionDTO => ({ kind: "show", target: "component", id, label });

/** Where a result can go, the default first. */
export function targetsFor(item: SearchItem, env: PaletteEnv): PaletteTarget[] {
  const out: PaletteTarget[] = [];
  const add = (id: string, label: string, run: PaletteTarget["run"]) => out.push({ id, label, run });
  const changed = hasTarget(env) && item.touched;

  switch (item.kind) {
    case "file": {
      const path = item.path ?? item.id;
      if (changed) {
        add("diff", "Diff", (e) => e.show({ kind: "file", path, tab: "diff", label: path }, { needsTarget: true }));
        add("changed", "Changed file, whole", (e) => e.show({ kind: "file", path, tab: "file", label: path }, { needsTarget: true }));
        add("base", "File before the change", (e) => e.show({ kind: "file", path, tab: "base", label: path }, { needsTarget: true }));
      } else {
        add("files", "Files view", (e) => e.show(showFile(path)));
      }
      if (item.componentId) add("component", "Its component on the map", (e) => e.show(showComponent(item.componentId!, path)));
      add("copy", "Copy path", (e) => e.copy(path, "Path"));
      break;
    }
    case "symbol": {
      const path = item.path!;
      if (changed) {
        add("changed", "Changed file at the line", (e) =>
          e.show({ kind: "file", path, tab: "file", label: item.title, ...(item.line ? { lines: String(item.line) } : {}) }, { needsTarget: true })
        );
        if (item.declId) {
          add("function", "PR map function", (e) => e.show({ kind: "show", target: "function", id: item.declId!, label: item.title }, { needsTarget: true }));
        }
      }
      add("files", "Files view at the line", (e) => e.show(showFile(path, item.line)));
      add("copy", "Copy name", (e) => e.copy(item.title, "Name"));
      break;
    }
    case "component":
      add("map", item.touched && hasTarget(env) ? "Its area on the PR map" : "App map", (e) => e.show(showComponent(item.id, item.title)));
      if (item.path) add("files", "Its folder in the Files view", (e) => e.show(showFile(item.path!)));
      break;
    case "pr": {
      const n = item.prNumber!;
      add("open", "Open on the Graph tab", (e) => e.openTarget({ pr: n }));
      const url = item.url ?? prWebUrl(env.repo, n);
      if (url) {
        add("web", env.repo?.provider === "gitlab" ? "Open on GitLab" : "Open on GitHub", (e) => e.openExternal(url));
        add("copy", "Copy link", (e) => e.copy(url, "Link"));
      }
      break;
    }
    case "branch": {
      const base = env.repo?.defaultBranch;
      if (base && base !== item.ref) add("compare", `Compare with ${base}`, (e) => e.openTarget({ base, head: item.ref! }));
      add("branches", "Pick another branch", (e) => e.pick("refs"));
      add("copy", "Copy name", (e) => e.copy(item.ref!, "Branch name"));
      break;
    }
    case "commit":
      if (item.parent) add("compare", "Compare with its parent", (e) => e.openTarget({ base: item.parent!, head: item.ref! }));
      add("copy", "Copy sha", (e) => e.copy(item.ref!, "Sha"));
      break;
    case "finding": {
      // A finding of another review (Search findings in all reviews) opens that review first.
      const other = item.url && item.url !== env.graph?.targetKey ? targetFromKey(item.url) : null;
      const showIt: ChatActionDTO = { kind: "show", target: "finding", id: item.id, label: item.title };
      if (other) add("review", "Open its review", (e) => e.openTarget(other, showIt));
      else add("review", "Show in the review", (e) => e.show(showIt, { needsTarget: true }));
      if (item.path && !other) add("file", "Its file at the line", (e) => e.show(showFile(item.path!, item.line)));
      if (item.componentId) add("component", "Its component on the map", (e) => e.show(showComponent(item.componentId!, item.title)));
      const open = item.badge && !["resolved", "fixing", "ok"].includes(item.badge.text);
      if (open) {
        add("fixing", "Mark fixing", async (e) => {
          await e.post(`/api/repos/${e.repoId}/review/findings/${encodeURIComponent(item.id)}`, { kind: "fixing" });
          e.notify("Marked as fixing.");
          if (!other) e.show(showIt, { needsTarget: true });
        });
      }
      break;
    }
    case "endpoint":
    case "table":
    case "env":
    case "infra":
      add("view", { endpoint: "API view", table: "Data view", env: "Env view", infra: "Infra view" }[item.kind], (e) =>
        e.show({ kind: "show", target: item.kind as "endpoint", id: item.id, label: item.title })
      );
      if (item.path) add("file", item.kind === "endpoint" ? "Handler code" : "Where it's defined", (e) => e.show(showFile(item.path!, item.line)));
      break;
    case "repo":
      add("graph", "Graph tab", (e) => e.navigate(`/repo/${item.id}/graph`));
      add("prs", "Pick a pull request", (e) => e.pick("pr", item.id));
      add("branches", "Compare branches", (e) => e.pick("refs", item.id));
      add("stats", "Stats", (e) => e.navigate(`/repo/${item.id}/stats`));
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface PaletteCommand {
  id: string;
  title: string;
  /** More words it is found by. */
  keywords?: string;
  group: "Go to" | "View" | "Review" | "Repo" | "Search" | "App";
  when?(env: PaletteEnv): boolean;
  run(env: PaletteEnv): void | Promise<void>;
}

const inRepo = (env: PaletteEnv) => env.repoId !== null;

const view = (v: Extract<ChatActionDTO, { kind: "view" }>["view"], extra: Partial<Extract<ChatActionDTO, { kind: "view" }>> = {}): ChatActionDTO => ({
  kind: "view",
  view: v,
  label: v,
  ...extra,
});

export const COMMANDS: readonly PaletteCommand[] = [
  { id: "go-repos", title: "Go to Repos", keywords: "home list", group: "Go to", run: (e) => e.navigate("/") },
  { id: "go-settings", title: "Go to Settings", keywords: "ai provider token", group: "Go to", run: (e) => e.navigate("/settings") },
  { id: "go-graph", title: "Go to the Graph tab", group: "Go to", when: inRepo, run: (e) => e.navigate(`/repo/${e.repoId}/graph`) },
  { id: "go-prs", title: "Pick a pull request", keywords: "go to pull requests merge requests diff open pr", group: "Go to", when: inRepo, run: (e) => e.pick("pr") },
  { id: "go-branches", title: "Compare branches", keywords: "go to branches diff refs", group: "Go to", when: inRepo, run: (e) => e.pick("refs") },
  { id: "go-stats", title: "Go to Stats", keywords: "lines of code languages contributors timeline ci", group: "Go to", when: inRepo, run: (e) => e.navigate(`/repo/${e.repoId}/stats`) },

  { id: "view-app", title: "Show the App map", keywords: "cards architecture", group: "View", when: inRepo, run: (e) => e.show(view("app")) },
  { id: "view-pr", title: "Show the PR map", keywords: "areas change", group: "View", when: hasTarget, run: (e) => e.show(view("pr"), { needsTarget: true }) },
  { id: "view-files", title: "Show Files", keywords: "tree browse", group: "View", when: inRepo, run: (e) => e.show(view("files")) },
  { id: "view-api", title: "Show API", keywords: "endpoints routes", group: "View", when: inRepo, run: (e) => e.show(view("api")) },
  { id: "view-infra", title: "Show Infra", keywords: "terraform kubernetes nomad docker", group: "View", when: inRepo, run: (e) => e.show(view("infra")) },
  { id: "view-data", title: "Show Data", keywords: "schema tables database", group: "View", when: inRepo, run: (e) => e.show(view("data")) },
  { id: "view-env", title: "Show Env", keywords: "environment variables", group: "View", when: inRepo, run: (e) => e.show(view("env")) },
  { id: "level-architecture", title: "App map: Architecture level", group: "View", when: inRepo, run: (e) => e.show(view("app", { level: "architecture" })) },
  { id: "level-features", title: "App map: Features level", group: "View", when: inRepo, run: (e) => e.show(view("app", { level: "features" })) },
  { id: "level-modules", title: "App map: Modules level", group: "View", when: inRepo, run: (e) => e.show(view("app", { level: "modules" })) },
  { id: "pr-areas", title: "PR map: areas", keywords: "files mode", group: "View", when: hasTarget, run: (e) => e.show(view("pr", { mode: "files" }), { needsTarget: true }) },
  { id: "pr-functions", title: "PR map: functions", keywords: "call graph mode", group: "View", when: hasTarget, run: (e) => e.show(view("pr", { mode: "functions" }), { needsTarget: true }) },

  {
    id: "open-pr-web",
    title: "Open this PR on the git host",
    keywords: "github gitlab browser",
    group: "Review",
    when: (e) => Boolean(e.graph?.target && "prNumber" in e.graph.target && prWebUrl(e.repo, e.graph.target.prNumber)),
    run: (e) => {
      const t = e.graph!.target as { prNumber: number };
      e.openExternal(prWebUrl(e.repo, t.prNumber)!);
    },
  },
  {
    id: "analyse-head",
    title: "Analyse the change's head",
    keywords: "compare target graph symbols index",
    group: "Review",
    when: hasTarget,
    run: async (e) => {
      const t = e.graph!.target!;
      const qs = "prNumber" in t ? `prNumber=${t.prNumber}` : `baseRef=${encodeURIComponent(t.baseRef)}&headRef=${encodeURIComponent(t.headRef)}`;
      await e.get(`/api/repos/${e.repoId}/target-graph?${qs}`);
      e.notify("Comparing base and head — the head's symbols are searchable once it's done.");
    },
  },
  { id: "close-change", title: "Close the open change", keywords: "clear diff deselect", group: "Review", when: hasTarget, run: (e) => e.openTarget(null) },

  {
    id: "reanalyse",
    title: "Re-analyse this repo",
    keywords: "refresh rebuild graph index",
    group: "Repo",
    when: inRepo,
    run: async (e) => {
      await e.post(`/api/repos/${e.repoId}/refresh`);
      e.notify("Re-analysis queued.");
    },
  },
  {
    id: "refresh-remote",
    title: "Refresh PRs, branches and commits",
    keywords: "fetch sync github gitlab",
    group: "Repo",
    when: inRepo,
    run: async (e) => {
      const r = await e.post<{ prs: number; branches: number; commits: number; errors: string[] }>(`/api/search/remote`, { repoId: e.repoId });
      if (r.errors.length) e.notify(`Refreshed with errors: ${r.errors.join("; ")}`, "error");
      else e.notify(`Refreshed: ${r.prs} PR(s), ${r.branches} branch(es), ${r.commits} commit(s).`);
    },
  },
  {
    id: "repo-web",
    title: "Open this repo on the git host",
    keywords: "github gitlab browser",
    group: "Repo",
    when: (e) => Boolean(repoWebUrl(e.repo)),
    run: (e) => e.openExternal(repoWebUrl(e.repo)!),
  },
  { id: "add-repo", title: "Add a repo", keywords: "new clone local", group: "Repo", run: (e) => e.navigate("/") },

  { id: "search-findings-all", title: "Search findings in all reviews", keywords: "every pr", group: "Search", when: inRepo, run: (e) => e.setScope("findings-all") },
  { id: "search-repos", title: "Switch repo", keywords: "repos change", group: "Search", run: (e) => e.setScope("repos") },

  { id: "copy-link", title: "Copy a link to this page", keywords: "url share", group: "App", run: (e) => e.copy(window.location.href, "Link") },
  { id: "import-config", title: "Import AI providers from local config", keywords: "opencode codex claude code", group: "App", run: (e) => e.navigate("/settings") },
  { id: "shortcuts", title: "Keyboard shortcuts", keywords: "help keys", group: "App", run: (e) => e.showHelp() },
];
