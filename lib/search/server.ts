// The command palette's search (DESIGN.md §6.18): every source in the
// database, matched with a subsequence `LIKE` where there are many rows and
// ranked by lib/search/fuzzy.ts. Never touches the network.
//
// Server-only.

import {
  findFiles,
  findSymbols,
  hasSymbolIndex,
  listComponentsByRepoId,
  listFindingsByTargetKey,
  listPullRequestsByRepoId,
  listRepos,
  lookupFileOwners,
  readApiCatalog,
  readDbSchema,
  readEnvCatalog,
  readInfraCatalog,
  readPaletteHistory,
  readRemoteSnapshot,
  readRepoFindings,
  readTargetGraph,
  type FindingRecord,
  type RepoRecord,
} from "@/lib/db";
import { endpointLabel } from "@/lib/analysis/api/describe";
import { readsInPlace } from "@/lib/jobs/source";
import { fuzzyMatch, fuzzyMatchPath, subsequenceLike, type FuzzyMatch } from "./fuzzy";
import type { SearchItem, SearchKind, SearchNotice, SearchRepoInfo, SearchRequest, SearchResponse, SearchScope } from "./types";

/** Rows the SQL pre-filter hands to the scorer, per source. */
const CANDIDATES = 4000;
const PER_KIND_ALL = 6;
const PER_KIND_SCOPED = 60;
const TOUCHED_BOOST = 40;

/** Unprefixed search is about getting somewhere: things before history, the repo's own code first. */
const KIND_WEIGHT: Record<SearchKind, number> = {
  component: 12,
  file: 10,
  finding: 8,
  pr: 8,
  symbol: 6,
  endpoint: 5,
  table: 5,
  env: 4,
  infra: 4,
  branch: 3,
  commit: 0,
  repo: -5,
};

const SCOPE_KINDS: Record<SearchScope, readonly SearchKind[]> = {
  all: ["file", "symbol", "component", "pr", "branch", "commit", "finding", "endpoint", "table", "env", "infra", "repo"],
  files: ["file"],
  symbols: ["symbol"],
  refs: ["pr", "branch", "commit"],
  findings: ["finding"],
  "findings-all": ["finding"],
  endpoints: ["endpoint"],
  repos: ["repo"],
};

interface Ctx {
  repo: RepoRecord | null;
  q: string;
  scope: SearchScope;
  targetKey?: string;
  touched: Set<string>;
  notices: SearchNotice[];
}

function scored(m: FuzzyMatch | null, q: string): m is FuzzyMatch {
  return q === "" || m !== null;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function searchFiles(ctx: Ctx): Promise<SearchItem[]> {
  const { repo, q, touched } = ctx;
  if (!repo) return [];
  const out = new Map<string, SearchItem>();
  const add = (path: string, componentId: string | undefined) => {
    const m = fuzzyMatchPath(q, path);
    if (!scored(m, q)) return;
    const isTouched = touched.has(path);
    const slash = path.lastIndexOf("/");
    out.set(path, {
      key: `file:${path}`,
      kind: "file",
      id: path,
      title: path,
      score: (m?.score ?? 0) + (isTouched ? TOUCHED_BOOST : 0),
      ...(m?.indexes.length ? { match: m.indexes } : {}),
      path,
      ...(slash > 0 ? { subtitle: path.slice(0, slash) } : {}),
      ...(componentId ? { componentId } : {}),
      ...(isTouched ? { touched: true, badge: { text: "changed", tone: "changed" as const } } : {}),
    });
  };
  if (q) {
    for (const f of findFiles(repo.id, subsequenceLike(q), CANDIDATES)) add(f.path, f.componentId);
  }
  // The change's paths, added files included (the analysed tip doesn't have them).
  const missing = [...touched].filter((p) => !out.has(p));
  for (const owner of missing.length ? await lookupFileOwners(repo.id, missing) : []) add(owner.path, owner.componentId);
  return [...out.values()];
}

function searchSymbols(ctx: Ctx): SearchItem[] {
  const { repo, q, touched } = ctx;
  if (!repo) return [];
  // The open change's head when it has an index, else the analysed tip.
  let sha = repo.lastAnalyzedSha;
  if (ctx.targetKey) {
    const head = readTargetGraph(repo.id, ctx.targetKey)?.headSha;
    if (head && hasSymbolIndex(repo.id, head)) sha = head;
    else if (ctx.scope === "symbols" || q) {
      ctx.notices.push({
        id: "head-unindexed",
        text: head ? "The PR head's symbols aren't indexed yet — searching the analysed tip." : "The PR head isn't analysed yet — searching the analysed tip.",
        action: "analyse-head",
      });
    }
  }
  if (!sha || !hasSymbolIndex(repo.id, sha)) {
    if (ctx.scope === "symbols" || q) {
      ctx.notices.push({ id: "tip-unindexed", text: "Symbols aren't indexed for this repo yet — re-analyse it to search them.", action: "reanalyse" });
    }
    return [];
  }
  if (!q) return [];
  const out: SearchItem[] = [];
  for (const s of findSymbols(repo.id, sha, subsequenceLike(q), CANDIDATES)) {
    const byName = fuzzyMatch(q, s.name);
    const byQualified = fuzzyMatch(q, s.qualified);
    const offset = s.qualified.length - s.name.length;
    const m =
      byName && (!byQualified || byName.score + 10 >= byQualified.score)
        ? { score: byName.score + 10, indexes: byName.indexes.map((i) => i + offset) }
        : byQualified;
    if (!m) continue;
    const isTouched = touched.has(s.file);
    out.push({
      key: `symbol:${s.file}#${s.qualified}`,
      kind: "symbol",
      id: `${s.file}#${s.qualified}`,
      declId: `${s.file}#${s.qualified}`,
      title: s.qualified,
      subtitle: `${s.kind} · ${s.file}:${s.line}`,
      score: m.score + (s.exported ? 5 : 0) + (isTouched ? TOUCHED_BOOST : 0),
      match: m.indexes,
      path: s.file,
      line: s.line,
      ...(isTouched ? { touched: true, badge: { text: "changed", tone: "changed" as const } } : {}),
    });
  }
  return out;
}

async function searchComponents(ctx: Ctx): Promise<SearchItem[]> {
  const { repo, q, touched } = ctx;
  if (!repo) return [];
  const touchedComponents = new Set<string>();
  if (touched.size) {
    for (const row of await lookupFileOwners(repo.id, [...touched])) if (row.componentId) touchedComponents.add(row.componentId);
  }
  const out: SearchItem[] = [];
  for (const c of await listComponentsByRepoId(repo.id)) {
    if (c.tier === "file") continue;
    const byName = fuzzyMatch(q, c.name);
    const inDescription = q && !byName && c.description?.toLowerCase().includes(q.toLowerCase());
    if (q && !byName && !inDescription) continue;
    if (!q && !touchedComponents.has(c.id)) continue;
    const isTouched = touchedComponents.has(c.id);
    const folder = c.pathPatterns[0]?.replace(/\/\*\*$/, "");
    out.push({
      key: `component:${c.id}`,
      kind: "component",
      id: c.id,
      componentId: c.id,
      title: c.name,
      subtitle: [c.tier === "domain" ? "domain" : "module", c.description].filter(Boolean).join(" · "),
      score: (byName?.score ?? (inDescription ? 30 : 0)) + (isTouched ? TOUCHED_BOOST : 0),
      ...(byName?.indexes.length ? { match: byName.indexes } : {}),
      ...(folder && !folder.includes("*") ? { path: folder } : {}),
      ...(isTouched ? { touched: true, badge: { text: "changed", tone: "changed" as const } } : {}),
    });
  }
  return out;
}

async function searchRefs(ctx: Ctx, kinds: ReadonlySet<SearchKind>): Promise<SearchItem[]> {
  const { repo, q } = ctx;
  if (!repo) return [];
  const snap = readRemoteSnapshot(repo.id);
  const out: SearchItem[] = [];
  const numberQuery = /^#?(\d+)$/.exec(q)?.[1];

  if (kinds.has("pr")) {
    const prs = new Map(snap.prs.map((p) => [p.number, p]));
    for (const p of await listPullRequestsByRepoId(repo.id)) {
      if (!prs.has(p.number)) {
        prs.set(p.number, { number: p.number, title: p.title, state: p.state, author: p.author, headRef: p.headRef, baseRef: p.baseRef, url: p.url, updatedAt: p.updatedAt });
      }
    }
    const word = repo.provider === "gitlab" ? "!" : "#";
    for (const p of prs.values()) {
      const title = `${word}${p.number} ${p.title}`;
      const m = numberQuery ? (String(p.number).startsWith(numberQuery) ? { score: String(p.number) === numberQuery ? 200 : 120, indexes: [] } : null) : fuzzyMatch(q, title);
      if (!scored(m, q)) continue;
      if (!q && p.state !== "open") continue;
      out.push({
        key: `pr:${p.number}`,
        kind: "pr",
        id: String(p.number),
        prNumber: p.number,
        title,
        subtitle: [p.author, `${p.headRef} → ${p.baseRef}`].filter(Boolean).join(" · "),
        badge: { text: p.draft ? "draft" : p.state, tone: p.draft ? "draft" : (p.state as "open" | "merged" | "closed") },
        score: (m?.score ?? 0) + (p.state === "open" ? 10 : 0),
        ...(m?.indexes.length ? { match: m.indexes } : {}),
        url: p.url,
      });
    }
    if (q === "" && !snap.fetchedAt.prs && !readsInPlace(repo)) {
      ctx.notices.push({ id: "no-remote", text: "No PR list stored yet — refresh to search PRs, branches and commits.", action: "refresh-remote" });
    }
  }
  if (kinds.has("branch") && !numberQuery) {
    for (const b of snap.branches) {
      const m = fuzzyMatch(q, b.name);
      if (!scored(m, q) || !q) continue;
      out.push({
        key: `branch:${b.name}`,
        kind: "branch",
        id: b.name,
        ref: b.name,
        title: b.name,
        subtitle: b.name === repo.defaultBranch ? "default branch" : `compare with ${repo.defaultBranch}`,
        score: m?.score ?? 0,
        ...(m?.indexes.length ? { match: m.indexes } : {}),
      });
    }
  }
  if (kinds.has("commit") && !numberQuery) {
    const shaQuery = /^[0-9a-f]{4,40}$/i.test(q) ? q.toLowerCase() : undefined;
    for (const c of snap.commits) {
      const title = `${c.sha.slice(0, 7)} ${c.subject}`;
      const m = shaQuery && c.sha.startsWith(shaQuery) ? { score: 150, indexes: [...Array(Math.min(shaQuery.length, 7)).keys()] } : fuzzyMatch(q, title);
      if (!scored(m, q) || !q) continue;
      out.push({
        key: `commit:${c.sha}`,
        kind: "commit",
        id: c.sha,
        ref: c.sha,
        ...(c.parent ? { parent: c.parent } : {}),
        title,
        subtitle: [c.author, c.date.slice(0, 10)].filter(Boolean).join(" · "),
        score: m?.score ?? 0,
        ...(m?.indexes.length ? { match: m.indexes } : {}),
      });
    }
  }
  return out;
}

const ASSESSMENT_BOOST: Record<FindingRecord["assessment"], number> = { defect: 30, concern: 20, unknown: 5, ok: -10 };

async function searchFindings(ctx: Ctx, everyReview: boolean): Promise<SearchItem[]> {
  const { repo, q } = ctx;
  if (!repo) return [];
  if (!everyReview && !ctx.targetKey) return [];
  const findings: Array<FindingRecord & { componentName?: string }> = everyReview
    ? readRepoFindings(repo.id)
    : await listFindingsByTargetKey(repo.id, ctx.targetKey!);
  const out: SearchItem[] = [];
  for (const f of findings) {
    const m = fuzzyMatch(q, f.summary);
    const other = q && !m ? fuzzyMatch(q, `${f.filePath ?? ""} ${f.componentName ?? ""} ${f.category}`) : null;
    if (q && !m && !other) continue;
    const resolved = Boolean(f.resolvedAt);
    const fixing = Boolean(f.responses?.some((r) => r.kind === "fixing"));
    const line = f.lineRange ? Number(/^(\d+)/.exec(f.lineRange)?.[1]) || undefined : undefined;
    out.push({
      key: `finding:${f.id}`,
      kind: "finding",
      id: f.id,
      title: f.summary,
      subtitle: [everyReview ? f.targetKey.replace(/^pr:/, "#") : undefined, f.componentName, f.filePath ? `${f.filePath}${line ? `:${line}` : ""}` : undefined, f.category]
        .filter(Boolean)
        .join(" · "),
      badge: resolved ? { text: "resolved", tone: "muted" } : fixing ? { text: "fixing", tone: "muted" } : { text: f.assessment, tone: f.assessment },
      score: (m?.score ?? (other ? other.score * 0.6 : 0)) + ASSESSMENT_BOOST[f.assessment] + (resolved ? -40 : 0) + (fixing ? -10 : 0),
      ...(m?.indexes.length ? { match: m.indexes } : {}),
      componentId: f.componentId,
      ...(f.filePath ? { path: f.filePath } : {}),
      ...(line ? { line } : {}),
      fixing,
      ...(everyReview ? { url: f.targetKey } : {}),
    });
  }
  return out;
}

function searchEndpoints(ctx: Ctx): SearchItem[] {
  const { repo, q } = ctx;
  if (!repo) return [];
  const stored = readApiCatalog(repo.id);
  if (!stored) return [];
  const out: SearchItem[] = [];
  for (const e of stored.catalog.endpoints) {
    const title = endpointLabel(e);
    const m = fuzzyMatch(q, title) ?? (e.handler?.name ? (q ? fuzzyMatch(q, e.handler.name) && { score: 40, indexes: [] } : null) : null);
    if (!scored(m, q)) continue;
    out.push({
      key: `endpoint:${e.id}`,
      kind: "endpoint",
      id: e.id,
      title,
      subtitle: e.handler ? `${e.handler.name} · ${e.handler.file}:${e.handler.startLine}` : undefined,
      score: m?.score ?? 0,
      ...(m?.indexes.length ? { match: m.indexes } : {}),
      ...(e.handler ? { path: e.handler.file, line: e.handler.startLine } : {}),
    });
  }
  return out;
}

function searchCatalogs(ctx: Ctx, kinds: ReadonlySet<SearchKind>): SearchItem[] {
  const { repo, q } = ctx;
  if (!repo || !q) return [];
  const out: SearchItem[] = [];
  if (kinds.has("table")) {
    for (const db of readDbSchema(repo.id)?.schema.databases ?? []) {
      for (const t of db.tables) {
        const title = t.schema ? `${t.schema}.${t.name}` : t.name;
        const m = fuzzyMatch(q, title);
        if (!m) continue;
        out.push({
          key: `table:${t.id}`,
          kind: "table",
          id: t.id,
          title,
          subtitle: `table · ${t.database} · ${t.definedAt.file}`,
          score: m.score,
          match: m.indexes,
          path: t.definedAt.file,
          line: t.definedAt.line,
        });
      }
    }
  }
  if (kinds.has("env")) {
    for (const v of readEnvCatalog(repo.id)?.catalog.vars ?? []) {
      const m = fuzzyMatch(q, v.name);
      if (!m) continue;
      const at = v.reads[0] ?? v.decls[0];
      out.push({
        key: `env:${v.name}`,
        kind: "env",
        id: v.name,
        title: v.name,
        subtitle: `env var · ${v.reads.length} read(s)${v.tags.length ? ` · ${v.tags.join(", ")}` : ""}`,
        score: m.score,
        match: m.indexes,
        ...(at && "file" in at && "line" in at ? { path: at.file as string, line: at.line as number } : {}),
      });
    }
  }
  if (kinds.has("infra")) {
    for (const r of readInfraCatalog(repo.id)?.catalog.resources ?? []) {
      const m = fuzzyMatch(q, r.address);
      if (!m) continue;
      out.push({
        key: `infra:${r.id}`,
        kind: "infra",
        id: r.id,
        title: r.address,
        subtitle: `${r.tool} ${r.kind} · ${r.file}:${r.line}`,
        score: m.score,
        match: m.indexes,
        path: r.file,
        line: r.line,
      });
    }
  }
  return out;
}

async function searchRepos(ctx: Ctx): Promise<SearchItem[]> {
  const out: SearchItem[] = [];
  for (const r of await listRepos()) {
    const m = fuzzyMatch(ctx.q, r.name);
    if (!scored(m, ctx.q)) continue;
    if (ctx.repo && r.id === ctx.repo.id && ctx.scope !== "repos") continue;
    out.push({
      key: `repo:${r.id}`,
      kind: "repo",
      id: r.id,
      repoId: r.id,
      title: r.name,
      subtitle: r.url ?? r.localPath ?? r.provider,
      score: m?.score ?? 0,
      ...(m?.indexes.length ? { match: m.indexes } : {}),
      ...(ctx.repo && r.id === ctx.repo.id ? { badge: { text: "current", tone: "muted" as const } } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

export async function search(req: SearchRequest, repo: RepoRecord | null): Promise<SearchResponse> {
  const q = req.q.trim();
  const scope: SearchScope = repo ? req.scope : "repos";
  const ctx: Ctx = { repo, q, scope, targetKey: req.targetKey, touched: new Set(req.touched ?? []), notices: [] };
  const kinds = new Set(SCOPE_KINDS[scope]);
  const repoInfo: SearchRepoInfo | undefined = repo
    ? { id: repo.id, name: repo.name, provider: repo.provider, ...(repo.url ? { url: repo.url } : {}), defaultBranch: repo.defaultBranch }
    : undefined;

  // An empty unscoped query shows the last picks, not a list of everything.
  if (q === "" && scope === "all") {
    const recents = readPaletteHistory<SearchItem>(repo?.id ?? "", 8).map((row) => row.item);
    return { repo: repoInfo, items: [], notices: [], recents };
  }

  const groups: SearchItem[][] = [];
  if (kinds.has("file")) groups.push(await searchFiles(ctx));
  if (kinds.has("symbol")) groups.push(searchSymbols(ctx));
  if (kinds.has("component")) groups.push(await searchComponents(ctx));
  if (kinds.has("pr") || kinds.has("branch") || kinds.has("commit")) groups.push(await searchRefs(ctx, kinds));
  if (kinds.has("finding")) groups.push(await searchFindings(ctx, scope === "findings-all"));
  if (kinds.has("endpoint")) groups.push(searchEndpoints(ctx));
  if (kinds.has("table") || kinds.has("env") || kinds.has("infra")) groups.push(searchCatalogs(ctx, kinds));
  if (kinds.has("repo")) groups.push(await searchRepos(ctx));

  // History: what was picked often and lately ranks higher.
  const history = new Map(readPaletteHistory<SearchItem>(repo?.id ?? "").map((h) => [h.key, h]));
  const now = Date.now();
  const perKind = scope === "all" ? PER_KIND_ALL : PER_KIND_SCOPED;
  const items: SearchItem[] = [];
  const byKind = new Map<SearchKind, SearchItem[]>();
  for (const item of groups.flat()) {
    const h = history.get(item.key);
    if (h) item.score += Math.min(h.uses, 10) * 3 + (now - h.lastUsed < 86_400_000 ? 10 : 0);
    if (scope === "all") item.score += KIND_WEIGHT[item.kind];
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  }
  for (const list of byKind.values()) {
    list.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    items.push(...list.slice(0, perKind));
  }
  items.sort((a, b) => b.score - a.score);
  return { repo: repoInfo, items, notices: ctx.notices };
}
