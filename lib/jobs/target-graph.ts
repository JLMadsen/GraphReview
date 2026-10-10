// Comparing a review target's base and head graphs (DESIGN.md §6.10).
//
// Pins the target to its merge-base and head (the same commits the diff and
// the preview use), analyses both commits — cheap after the first time:
// unchanged files come from the parse cache — and compares them:
//
//   structure   import cycles the change creates (each becomes a `structure`
//               finding, "concern"), component dependencies it adds or
//               removes, files nothing imports any more, how many files
//               depend on what it touched
//   call graph  the functions it touches with one hop of callers/callees,
//               for the PR map's function view and the review's context
//   api         what it does to the endpoints (shown, never findings)
//   infra       what it does to the infrastructure, plan-style; three
//               certain kinds of `infra` finding (DESIGN.md §6.12)
//   db          what it does to the database schema; certain `schema`
//               findings from the migrations it adds (DESIGN.md §6.13)
//
// Each comparison of two catalogs is one entry in `compareCatalogs` below,
// and each kind of static finding one entry in `staticFindings`: a new
// catalog (the DB schema of §6.13) adds a line to each.
//
// Changed lines come from a local `git diff -U0` of the two commits, not
// from the host's API (which drops patches for big files).
//
// Kept out of lib/jobs' barrel: it pulls in lib/analysis.

import { createHash } from "node:crypto";
import { buildCallGraph, compareApis, compareInfra, compareSchemas, compareStructure, parseChangedLines, type DbFinding, type InfraFinding, type NewCycle } from "@/lib/analysis";
import { getFileOwnerMap, getRepoById, listComponentsByRepoId, syncFindingsForTargetCategory, writeTargetGraph } from "@/lib/db";
import type { RepoRecord, TargetFindingInput } from "@/lib/db";
import { emitFindingsChanged } from "@/lib/mcp/events";
import type { JobLogger } from "./analyze";
import { analyzeRepoCommit } from "./commit-analysis";
import { resolveCommits } from "./preview";
import { reviewTargetKey, type ReviewTarget } from "./review-queue";
import { UnrecoverableError } from "./runner";
import { gitIn } from "./source";
import type { ComponentDependencyChange, TargetGraphData, TargetGraphJobData, TargetGraphJobResult } from "./target-graph-queue";

const SHA = /^[0-9a-f]{7,64}$/;

/** `git diff -U0 base head` in the repo: which lines each file's change touched. */
export async function changedLinesBetween(repoDir: string, baseSha: string, headSha: string) {
  if (!SHA.test(baseSha) || !SHA.test(headSha)) throw new Error("Not a commit sha.");
  const diff = await gitIn(repoDir, undefined, ["safe.directory=*"]).raw([
    "diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", baseSha, headSha, "--",
  ]);
  return parseChangedLines(diff);
}

/** Each path's owning component; a file the stored graph doesn't know yet takes its folder's. */
export function ownerLookup(owners: Map<string, string>): (path: string) => string | undefined {
  const byFolder = new Map<string, string>();
  for (const [path, componentId] of owners) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!byFolder.has(dir)) byFolder.set(dir, componentId);
  }
  return (path) => {
    const own = owners.get(path);
    if (own) return own;
    let dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    for (;;) {
      const hit = byFolder.get(dir);
      if (hit) return hit;
      if (dir === "") return undefined;
      dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    }
  };
}

function componentChanges(
  edges: Array<{ from: string; to: string }>,
  ownerOf: (path: string) => string | undefined,
  nameOf: Map<string, string>,
  existingPairs: Set<string>
): ComponentDependencyChange[] {
  const byPair = new Map<string, ComponentDependencyChange>();
  for (const edge of edges) {
    const from = ownerOf(edge.from);
    const to = ownerOf(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    if (existingPairs.has(key)) continue; // the components already depended on each other through other files
    let change = byPair.get(key);
    if (!change) {
      change = { from, to, fromName: nameOf.get(from) ?? from, toName: nameOf.get(to) ?? to, files: [] };
      byPair.set(key, change);
    }
    if (change.files.length < 10) change.files.push(edge);
  }
  return [...byPair.values()];
}

type Revision = Pick<TargetFindingInput, "reviewedBaseSha" | "reviewedHeadSha" | "reviewedAt">;

/** A finding id derived from what it is about, so replies survive a recomputation. */
function stableFindingId(seed: string): string {
  const id = createHash("sha1").update(seed).digest("hex");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`;
}

function cycleFinding(cycle: NewCycle, targetKey: string, componentId: string, revision: Revision, prId?: string): TargetFindingInput & { componentId: string } {
  const loop = cycle.files.map((f) => f.split("/").pop()).join(" → ");
  return {
    id: stableFindingId(`structure|${targetKey}|${cycle.id}`),
    componentId,
    ...(prId ? { prId } : {}),
    filePath: cycle.closingEdge.from,
    summary: `New import cycle: ${loop}`,
    assessment: "concern",
    confidence: 1,
    rationale:
      `This change adds an import from ${cycle.closingEdge.from} to ${cycle.closingEdge.to}, and ${cycle.closingEdge.to} already ` +
      `leads back to ${cycle.closingEdge.from} (${cycle.files.join(" → ")}). Modules that import each other at load time can see each ` +
      `other half-initialised, and the loop ties them together for every future change. Type-only and lazy imports are not counted.`,
    model: "static analysis",
    createdAt: new Date().toISOString(),
    ...revision,
  };
}

/** One of the schema comparison's certain findings (DESIGN.md §6.13 §5) — `concern`, no model. */
function schemaFinding(f: DbFinding, targetKey: string, componentId: string, revision: Revision, prId?: string): TargetFindingInput & { componentId: string } {
  return {
    id: stableFindingId(`schema|${targetKey}|${f.key}`),
    componentId,
    ...(prId ? { prId } : {}),
    filePath: f.file,
    ...(f.line ? { lineRange: String(f.line) } : {}),
    summary: f.summary,
    assessment: "concern",
    confidence: 1,
    rationale: f.rationale,
    model: "static analysis",
    createdAt: new Date().toISOString(),
    ...revision,
  };
}

/** One of the infra comparison's certain findings (DESIGN.md §6.12 §5) — `concern`, no model. */
function infraFinding(f: InfraFinding, targetKey: string, componentId: string, revision: Revision, prId?: string): TargetFindingInput & { componentId: string } {
  return {
    id: stableFindingId(`infra|${targetKey}|${f.key}`),
    componentId,
    ...(prId ? { prId } : {}),
    filePath: f.file,
    ...(f.line ? { lineRange: String(f.line) } : {}),
    summary: f.summary,
    assessment: "concern",
    confidence: 1,
    rationale: f.rationale,
    model: "static analysis",
    createdAt: new Date().toISOString(),
    ...revision,
  };
}

export async function runTargetGraphJob(data: TargetGraphJobData, log: JobLogger): Promise<TargetGraphJobResult> {
  const startedAt = Date.now();
  const repo: RepoRecord | null = await getRepoById(data.repoId);
  if (!repo) throw new UnrecoverableError(`Repo ${data.repoId} not found.`);
  const target: ReviewTarget = data.target;
  const targetKey = reviewTargetKey(target);

  const { repoDir, baseSha, headSha, changedFiles } = await resolveCommits(repo, target, log);
  log(`comparing ${baseSha.slice(0, 7)} (merge-base) with ${headSha.slice(0, 7)} — ${changedFiles.length} changed file(s)`);

  const base = await analyzeRepoCommit(repoDir, baseSha);
  const head = await analyzeRepoCommit(repoDir, headSha);
  log(`analysed: base ${base.files.length} file(s), head ${head.files.length} file(s), ${base.cached + head.cached} from the cache`);

  const changed = await changedLinesBetween(repoDir, baseSha, headSha);
  const structure = compareStructure(base, head, [...changed.keys()]);
  const callGraph = buildCallGraph(base, head, changed);
  // The catalogs, base against head — stored beside each other in the result.
  const compareCatalogs = {
    api: compareApis(base, head, changed),
    infra: compareInfra(base.infra, head.infra),
    db: compareSchemas(base.db, head.db),
  };
  const { api, infra, db } = compareCatalogs;

  const [owners, components] = await Promise.all([getFileOwnerMap(repo.id), listComponentsByRepoId(repo.id)]);
  const ownerOf = ownerLookup(owners);
  const nameOf = new Map(components.map((c) => [c.id, c.name]));
  const pairsOf = (edges: Array<{ from: string; to: string }>) => {
    const pairs = new Set<string>();
    for (const e of edges) {
      const from = ownerOf(e.from);
      const to = ownerOf(e.to);
      if (from && to && from !== to) pairs.add(`${from}\u0000${to}`);
    }
    return pairs;
  };
  const basePairs = pairsOf(base.edges);
  const headPairs = pairsOf(head.edges);
  const dependentComponents = new Set<string>();
  // Count owners over every dependent, not just the sample.
  const reverse = new Map<string, string[]>();
  for (const e of head.edges) (reverse.get(e.to) ?? reverse.set(e.to, []).get(e.to)!).push(e.from);
  const seen = new Set<string>(changed.keys());
  let frontier = [...seen];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const file of frontier) for (const importer of reverse.get(file) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      next.push(importer);
      const owner = ownerOf(importer);
      if (owner) dependentComponents.add(owner);
    }
    frontier = next;
  }

  // Which component each file the UI shows belongs to (function cards of
  // files outside the change are grouped by it).
  const fileComponents: TargetGraphData["fileComponents"] = {};
  const noteFile = (file: string) => {
    if (fileComponents[file]) return;
    const id = ownerOf(file);
    if (id) fileComponents[file] = { id, name: nameOf.get(id) ?? id };
  };
  for (const fn of callGraph.functions) noteFile(fn.file);
  for (const e of [...structure.addedEdges, ...structure.removedEdges]) {
    noteFile(e.from);
    noteFile(e.to);
  }

  const result: TargetGraphData = {
    fileComponents,
    structure: {
      ...structure,
      components: {
        added: componentChanges(structure.addedEdges, ownerOf, nameOf, basePairs),
        removed: componentChanges(structure.removedEdges, ownerOf, nameOf, headPairs),
      },
      dependentComponents: dependentComponents.size,
    },
    callGraph,
    ...compareCatalogs,
    stats: {
      baseFiles: base.files.length,
      headFiles: head.files.length,
      cached: base.cached + head.cached,
      skipped: {
        binary: head.skipped.binary,
        large: head.skipped.large,
        failed: head.skipped.failed,
      },
      durationMs: Date.now() - startedAt,
    },
  };
  writeTargetGraph(repo.id, targetKey, { baseSha, headSha, computedAt: new Date().toISOString(), data: result });

  // Static findings: new cycles, and the infra and schema comparisons' certain ones.
  // Everything else is shown, not counted. Each category is synced as a
  // whole (stable ids keep replies), and an open review dock refetches.
  const revision: Revision = { reviewedBaseSha: baseSha, reviewedHeadSha: headSha, reviewedAt: new Date().toISOString() };
  const prId = target.kind === "pr" ? `${repo.id}:pr:${target.prNumber}` : undefined;
  const staticFindings: Array<{ category: "structure" | "infra" | "schema"; findings: Array<TargetFindingInput & { componentId: string }> }> = [
    { category: "structure", findings: structure.newCycles.map((cycle) => cycleFinding(cycle, targetKey, ownerOf(cycle.closingEdge.from) ?? "", revision, prId)) },
    { category: "infra", findings: infra.findings.map((f) => infraFinding(f, targetKey, ownerOf(f.file) ?? "", revision, prId)) },
    { category: "schema", findings: db.findings.map((f) => schemaFinding(f, targetKey, ownerOf(f.file) ?? "", revision, prId)) },
  ];
  for (const { category, findings } of staticFindings) {
    await syncFindingsForTargetCategory(repo.id, targetKey, category, findings);
    // An open review dock refetches its findings (the same signal as an MCP reply).
    emitFindingsChanged(repo.id, targetKey, category);
  }

  log(
    `${structure.newCycles.length} new import cycle(s), ${result.structure.components.added.length} new / ` +
      `${result.structure.components.removed.length} removed component dependenc(ies), ${structure.orphaned.length} orphaned file(s), ` +
      `${structure.dependents.count} dependent file(s); call graph: ${callGraph.functions.length} function(s), ${callGraph.edges.length} call(s); ` +
      `API: +${api.counts.added} −${api.counts.removed} ~${api.counts.changed} changed (${api.counts.breaking} breaking); logic changed behind ${api.counts.logic}; ` +
      `infra: +${infra.counts.create} −${infra.counts.destroy} ~${infra.counts.update} (${infra.counts.moved} moved, ${infra.counts.version} version), ${infra.findings.length} finding(s); ` +
      `schema: +${db.counts.added} −${db.counts.removed} ~${db.counts.changed} (${db.counts.renamed} renamed), ${db.counts.migrations} new migration(s), ${db.findings.length} finding(s)`
  );
  return { baseSha, headSha, cycles: structure.newCycles.length, functions: callGraph.functions.length };
}
