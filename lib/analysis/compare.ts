/**
 * Comparing the analysis of a change's base with its head — pure, no git,
 * no database. Two products:
 *
 * - {@link compareStructure}: what the change does to the import graph —
 *   import cycles it creates (runtime imports only: `import type` and lazy
 *   `import()` can't deadlock module loading), edges it adds and removes,
 *   files nothing imports any more, and how many files depend on what it
 *   touched.
 * - {@link buildCallGraph}: the functions the change touches, with one hop
 *   of callers and callees around them, each marked added / removed /
 *   signature changed / body changed / unchanged, and the calls between
 *   them marked new / removed / existing — plus callers of a changed
 *   signature whose call line the change didn't touch.
 */
import type { AnalysisResult, ImportEdge } from "./graph-builder";
import type { SymbolDecl } from "./symbols";

/** Lines a change touched in one file: `added` at the head, `removed` at the base. */
export interface ChangedLines {
  added: Set<number>;
  removed: Set<number>;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export interface NewCycle {
  /** Stable id: the cycle's files, sorted and joined. */
  id: string;
  /** The loop in import order, starting and ending at the file that gained the closing import. */
  files: string[];
  /** The import the change added that closes the loop. */
  closingEdge: { from: string; to: string };
}

export interface StructureChange {
  newCycles: NewCycle[];
  /** Import edges at the head that the base didn't have, and the other way round (between files present on that side). */
  addedEdges: Array<{ from: string; to: string; typeOnly?: boolean }>;
  removedEdges: Array<{ from: string; to: string; typeOnly?: boolean }>;
  /** Files that something imported at the base and nothing imports at the head (still present). */
  orphaned: string[];
  /** Files at the head that depend, directly or not, on a changed file. */
  dependents: { count: number; sample: string[] };
}

/** Edges that run at module load: not type-only, not a lazy `import()`. */
function isRuntime(edge: ImportEdge): boolean {
  return !edge.typeOnly && edge.kind !== "call";
}

const MAX_CYCLES = 20;
const MAX_CYCLE_LENGTH = 12;

/** Shortest path `from` → … → `to` over `adjacency`, or `null`. */
function shortestPath(adjacency: Map<string, string[]>, from: string, to: string, limit: number): string[] | null {
  const previous = new Map<string, string | null>([[from, null]]);
  let frontier = [from];
  for (let depth = 0; depth < limit && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const target of adjacency.get(node) ?? []) {
        if (previous.has(target)) continue;
        previous.set(target, node);
        if (target === to) {
          const path = [to];
          let cursor: string | null = node;
          while (cursor !== null) {
            path.unshift(cursor);
            cursor = previous.get(cursor) ?? null;
          }
          return path;
        }
        next.push(target);
      }
    }
    frontier = next;
  }
  return null;
}

function adjacencyOf(edges: readonly ImportEdge[], filter: (edge: ImportEdge) => boolean, reverse = false): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    if (!filter(edge)) continue;
    const [a, b] = reverse ? [edge.to, edge.from] : [edge.from, edge.to];
    const list = out.get(a);
    if (list) {
      if (!list.includes(b)) list.push(b);
    } else out.set(a, [b]);
  }
  return out;
}

export function compareStructure(
  base: Pick<AnalysisResult, "edges" | "files">,
  head: Pick<AnalysisResult, "edges" | "files">,
  changedFiles: readonly string[],
): StructureChange {
  const key = (edge: { from: string; to: string }) => `${edge.from}\u0000${edge.to}`;
  const baseKeys = new Set(base.edges.map(key));
  const headKeys = new Set(head.edges.map(key));
  const baseRuntime = new Set(base.edges.filter(isRuntime).map(key));
  const headFiles = new Set(head.files.map((f) => f.file));

  const dedupe = (edges: ImportEdge[]) => {
    const seen = new Set<string>();
    return edges.filter((e) => (seen.has(key(e)) ? false : (seen.add(key(e)), true)));
  };
  const addedEdges = dedupe(head.edges.filter((e) => !baseKeys.has(key(e)))).map((e) => ({ from: e.from, to: e.to, ...(e.typeOnly ? { typeOnly: true } : {}) }));
  const removedEdges = dedupe(base.edges.filter((e) => !headKeys.has(key(e)) && headFiles.has(e.from) && headFiles.has(e.to)))
    .map((e) => ({ from: e.from, to: e.to, ...(e.typeOnly ? { typeOnly: true } : {}) }));

  // --- cycles closed by a runtime import the change added ------------------
  const runtime = adjacencyOf(head.edges, isRuntime);
  const baseAdjacency = adjacencyOf(base.edges, isRuntime);
  const cycles = new Map<string, NewCycle>();
  for (const edge of head.edges) {
    if (cycles.size >= MAX_CYCLES) break;
    if (!isRuntime(edge) || baseRuntime.has(key(edge))) continue;
    const back = shortestPath(runtime, edge.to, edge.from, MAX_CYCLE_LENGTH);
    if (!back) continue;
    const files = [edge.from, ...back];
    const id = [...new Set(files)].sort().join("|");
    if (cycles.has(id)) continue;
    // The two files already depended on each other at the base (through
    // other imports): the change didn't create this loop.
    if (shortestPath(baseAdjacency, edge.from, edge.to, MAX_CYCLE_LENGTH) && shortestPath(baseAdjacency, edge.to, edge.from, MAX_CYCLE_LENGTH)) continue;
    cycles.set(id, { id, files, closingEdge: { from: edge.from, to: edge.to } });
  }

  // --- files left with no importer --------------------------------------------
  const headIncoming = new Set(head.edges.map((e) => e.to));
  const orphaned = [...new Set(removedEdges.map((e) => e.to))]
    .filter((file) => headFiles.has(file) && !headIncoming.has(file))
    .sort();

  // --- everything downstream of the change --------------------------------
  const reverse = adjacencyOf(head.edges, () => true, true);
  const seen = new Set<string>(changedFiles.filter((f) => headFiles.has(f)));
  let frontier = [...seen];
  const dependents: string[] = [];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const importer of reverse.get(file) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        dependents.push(importer);
        next.push(importer);
      }
    }
    frontier = next;
  }

  return {
    newCycles: [...cycles.values()],
    addedEdges,
    removedEdges,
    orphaned,
    dependents: { count: dependents.length, sample: dependents.slice(0, 20) },
  };
}

// ---------------------------------------------------------------------------
// Call graph
// ---------------------------------------------------------------------------

/** `moved`: the same code now lives in another file (a move whose code changed is `signature` or `body`, with `movedFrom`). */
export type FunctionStatus = "added" | "removed" | "signature" | "body" | "moved" | "unchanged";

export interface CallGraphFunction {
  /** Declaration id (`<file>#<qualified>`); a removed one's is from the base. */
  id: string;
  file: string;
  name: string;
  qualified: string;
  kind: SymbolDecl["kind"];
  status: FunctionStatus;
  /** Head lines (base lines for a removed one). */
  startLine: number;
  endLine: number;
  signatureBefore?: string;
  signatureAfter?: string;
  /** The file it was moved from, when the change moved it (`id` is its new place). */
  movedFrom?: string;
  /** Calls from it naming a repo function that static analysis couldn't tie to one (instance calls). */
  unresolvedCalls: number;
}

export interface CallGraphEdge {
  from: string;
  to: string;
  status: "new" | "removed" | "existing";
  /** Where the call is (head; base for a removed one). */
  file: string;
  line: number;
  /** A call to a function whose signature changed, on a line the change didn't touch. */
  notUpdated?: true;
}

export interface CallGraph {
  functions: CallGraphFunction[];
  edges: CallGraphEdge[];
  /** Set when caps cut functions off. */
  truncated?: boolean;
}

const CALLABLE = new Set(["function", "method", "class"]);
const MAX_FUNCTIONS = 400;

/**
 * Declarations the change moved: gone from one changed file and, under the
 * same name and kind, new in exactly one other. `changed` says whether the
 * code changed on the way (`signature` before `body`), from the
 * declarations' signatures and text fingerprints.
 */
export function findMovedDeclarations(
  base: Pick<AnalysisResult, "symbols">,
  head: Pick<AnalysisResult, "symbols">,
  changedFiles: ReadonlySet<string>,
): Array<{ before: SymbolDecl; after: SymbolDecl; changed: "signature" | "body" | null }> {
  const baseIds = new Set(base.symbols.decls.map((d) => d.id));
  const headIds = new Set(head.symbols.decls.map((d) => d.id));
  const added = new Map<string, SymbolDecl[]>();
  for (const decl of head.symbols.decls) {
    if (baseIds.has(decl.id) || !changedFiles.has(decl.file)) continue;
    const key = `${decl.kind}\u0000${decl.qualified}`;
    (added.get(key) ?? added.set(key, []).get(key)!).push(decl);
  }
  const moves: Array<{ before: SymbolDecl; after: SymbolDecl; changed: "signature" | "body" | null }> = [];
  for (const before of base.symbols.decls) {
    if (headIds.has(before.id) || !changedFiles.has(before.file)) continue;
    const candidates = (added.get(`${before.kind}\u0000${before.qualified}`) ?? []).filter((d) => d.file !== before.file);
    if (candidates.length !== 1) continue;
    const after = candidates[0];
    const changed =
      before.signature !== after.signature
        ? "signature"
        : before.textHash && after.textHash && before.textHash !== after.textHash
          ? "body"
          : null;
    moves.push({ before, after, changed });
  }
  return moves;
}

function overlaps(start: number, end: number, lines: Set<number> | undefined): boolean {
  if (!lines || lines.size === 0) return false;
  for (const line of lines) if (line >= start && line <= end) return true;
  return false;
}

/**
 * Every function, method and class the change touched, with how: added,
 * removed, moved, signature or body changed. Uncapped — {@link buildCallGraph}
 * draws a neighbourhood of these, the API comparison follows calls to them.
 */
export function changedDeclarations(
  base: Pick<AnalysisResult, "symbols">,
  head: Pick<AnalysisResult, "symbols">,
  changed: ReadonlyMap<string, ChangedLines>,
): {
  statusOf: Map<string, FunctionStatus>;
  moves: Array<{ before: SymbolDecl; after: SymbolDecl; changed: "signature" | "body" | null }>;
} {
  const baseDecls = new Map(base.symbols.decls.map((d) => [d.id, d]));
  const headDecls = new Map(head.symbols.decls.map((d) => [d.id, d]));
  const statusOf = new Map<string, FunctionStatus>();
  const moves = findMovedDeclarations(base, head, new Set(changed.keys())).filter((m) => CALLABLE.has(m.after.kind));
  const movedTo = new Map(moves.map((m) => [m.before.id, m.after.id]));
  const moveOf = new Map(moves.map((m) => [m.after.id, m]));

  // Declarations in changed files, on either side.
  for (const decl of head.symbols.decls) {
    if (!CALLABLE.has(decl.kind) || !changed.has(decl.file)) continue;
    const lines = changed.get(decl.file)!;
    const old = baseDecls.get(decl.id);
    const move = moveOf.get(decl.id);
    if (move) statusOf.set(decl.id, move.changed ?? "moved");
    else if (!old) statusOf.set(decl.id, "added");
    else if (old.signature !== decl.signature) statusOf.set(decl.id, "signature");
    else if (overlaps(decl.startLine, decl.endLine, lines.added) || overlaps(old.startLine, old.endLine, lines.removed)) {
      // A class only counts when its own head changed; its methods carry the body changes.
      statusOf.set(decl.id, decl.kind === "class" ? "unchanged" : "body");
    }
  }
  for (const decl of base.symbols.decls) {
    if (!CALLABLE.has(decl.kind) || !changed.has(decl.file) || headDecls.has(decl.id) || movedTo.has(decl.id)) continue;
    statusOf.set(decl.id, "removed");
  }
  for (const [id, status] of [...statusOf]) if (status === "unchanged") statusOf.delete(id);
  return { statusOf, moves };
}

export function buildCallGraph(
  base: Pick<AnalysisResult, "symbols">,
  head: Pick<AnalysisResult, "symbols">,
  changed: ReadonlyMap<string, ChangedLines>,
): CallGraph {
  const baseDecls = new Map(base.symbols.decls.map((d) => [d.id, d]));
  const headDecls = new Map(head.symbols.decls.map((d) => [d.id, d]));
  const { statusOf, moves } = changedDeclarations(base, head, changed);
  // Moves: the old id is the new id's past — calls to it at the base are calls to the new one.
  const movedTo = new Map(moves.map((m) => [m.before.id, m.after.id]));
  const moveOf = new Map(moves.map((m) => [m.after.id, m]));
  const current = (id: string) => movedTo.get(id) ?? id;

  const changedIds = new Set(statusOf.keys());
  const callKey = (c: { from: string; to: string }) => `${c.from}\u0000${c.to}`;
  const baseCalls = new Set(base.symbols.calls.map((c) => callKey({ from: current(c.from), to: current(c.to) })));
  const headCalls = new Set(head.symbols.calls.map(callKey));

  const edges: CallGraphEdge[] = [];
  const seenEdge = new Set<string>();
  const included = new Set<string>(changedIds);
  for (const call of head.symbols.calls) {
    if (!changedIds.has(call.from) && !changedIds.has(call.to)) continue;
    const k = callKey(call);
    if (seenEdge.has(k)) continue;
    seenEdge.add(k);
    const status = baseCalls.has(k) ? "existing" : "new";
    const callerLines = changed.get(call.file)?.added;
    const notUpdated = statusOf.get(call.to) === "signature" && !callerLines?.has(call.line) && !changedIds.has(call.from) ? true : undefined;
    edges.push({ from: call.from, to: call.to, status, file: call.file, line: call.line, ...(notUpdated ? { notUpdated } : {}) });
    included.add(call.from);
    included.add(call.to);
  }
  for (const baseCall of base.symbols.calls) {
    const call = { ...baseCall, from: current(baseCall.from), to: current(baseCall.to) };
    if (!changedIds.has(call.from) && !changedIds.has(call.to)) continue;
    const k = callKey(call);
    if (headCalls.has(k) || seenEdge.has(k)) continue;
    seenEdge.add(k);
    edges.push({ from: call.from, to: call.to, status: "removed", file: call.file, line: call.line });
    included.add(call.from);
    included.add(call.to);
  }

  // Module-level code calling into the change (`<file>#`) shows as the file's top level.
  const functions: CallGraphFunction[] = [];
  const unresolved = head.symbols.unresolved;
  for (const id of included) {
    const status = statusOf.get(id) ?? "unchanged";
    const decl = (status === "removed" ? baseDecls.get(id) : headDecls.get(id)) ?? baseDecls.get(id);
    if (!decl) {
      if (!id.endsWith("#")) continue;
      const file = id.slice(0, -1);
      functions.push({ id, file, name: "(top level)", qualified: "(top level)", kind: "module", status: "unchanged", startLine: 1, endLine: 1, unresolvedCalls: unresolved[id] ?? 0 });
      continue;
    }
    const move = moveOf.get(id);
    const old = move?.before ?? baseDecls.get(id);
    functions.push({
      id,
      file: decl.file,
      name: decl.name,
      qualified: decl.qualified,
      kind: decl.kind,
      status,
      startLine: decl.startLine,
      endLine: decl.endLine,
      ...(move ? { movedFrom: move.before.file } : {}),
      ...(status === "signature" || status === "removed" ? { signatureBefore: old?.signature } : {}),
      ...(status !== "removed" ? { signatureAfter: decl.signature } : {}),
      unresolvedCalls: status === "removed" ? (base.symbols.unresolved[id] ?? 0) : (unresolved[id] ?? 0),
    });
  }

  // Changed functions first, then the neighbours with the most calls.
  const weight = new Map<string, number>();
  for (const edge of edges) for (const end of [edge.from, edge.to]) weight.set(end, (weight.get(end) ?? 0) + 1);
  functions.sort(
    (a, b) =>
      Number(a.status === "unchanged") - Number(b.status === "unchanged") ||
      (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const truncated = functions.length > MAX_FUNCTIONS;
  const kept = functions.slice(0, MAX_FUNCTIONS);
  const keptIds = new Set(kept.map((f) => f.id));
  return {
    functions: kept,
    edges: edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to)),
    ...(truncated ? { truncated } : {}),
  };
}

/** Parses `git diff -U0` output into the lines each file's change touched. */
export function parseChangedLines(diff: string): Map<string, ChangedLines> {
  const out = new Map<string, ChangedLines>();
  const entry = (path: string) => {
    let lines = out.get(path);
    if (!lines) out.set(path, (lines = { added: new Set(), removed: new Set() }));
    return lines;
  };
  let oldPath: string | undefined;
  let current: ChangedLines | undefined;
  for (const row of diff.split("\n")) {
    if (row.startsWith("--- ")) {
      const path = row.slice(4).trim();
      oldPath = path === "/dev/null" ? undefined : path.replace(/^a\//, "");
      continue;
    }
    if (row.startsWith("+++ ")) {
      const path = row.slice(4).trim();
      // A deleted file's removed lines are recorded under its old path.
      const file = path === "/dev/null" ? oldPath : path.replace(/^b\//, "");
      current = file ? entry(file) : undefined;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (hunk && current) {
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const newStart = Number(hunk[3]);
      const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
      for (let i = 0; i < oldCount; i++) current.removed.add(oldStart + i);
      for (let i = 0; i < newCount; i++) current.added.add(newStart + i);
    }
  }
  return out;
}
