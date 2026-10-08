/**
 * What a change does to the API (DESIGN.md §6.11): endpoints added and
 * removed, and endpoints whose path, method, parameters, request or
 * response shape or auth chain changed — each delta marked breaking when a
 * client written against the base can fail. Separately (`logic`), the
 * endpoints whose contract stayed but whose handler code changed or calls
 * code that did, with the call path: not API changes, context for the
 * review.
 *
 * Pure: two analyses and the changed lines in, data out. Shown, never
 * turned into findings.
 */
import { changedDeclarations, type ChangedLines } from "../compare";
import type { AnalysisResult } from "../graph-builder";
import { handlerCalls, indexCalls } from "./context";
import {
  MAX_API_REACH_FUNCTIONS,
  MAX_API_REACH_HOPS,
  type ApiChange,
  type ApiShape,
  type Endpoint,
  type EndpointChange,
  type EndpointDelta,
  type EndpointLogicChange,
  type EndpointReach,
} from "./types";

type Side = Pick<AnalysisResult, "symbols" | "api">;

const MAX_REACHES_PER_ENDPOINT = 6;

function overlaps(start: number, end: number, lines: Set<number> | undefined): boolean {
  if (!lines) return false;
  for (const line of lines) if (line >= start && line <= end) return true;
  return false;
}

const paramKey = (p: { in: string; name: string }) => `${p.in}:${p.name}`;
const paramText = (p: { in: string; name: string; type?: string; required?: boolean }) => `${p.name}${p.required ? "" : "?"} (${p.in}${p.type ? `, ${p.type}` : ""})`;

function compareParams(before: Endpoint, after: Endpoint): EndpointDelta[] {
  const out: EndpointDelta[] = [];
  const b = new Map(before.params.filter((p) => p.in !== "path").map((p) => [paramKey(p), p]));
  const a = new Map(after.params.filter((p) => p.in !== "path").map((p) => [paramKey(p), p]));
  for (const [key, p] of a) {
    const old = b.get(key);
    if (!old) out.push({ aspect: "params", after: paramText(p), ...(p.required ? { breaking: true as const } : {}) });
    else if ((old.type ?? "") !== (p.type ?? "") || Boolean(old.required) !== Boolean(p.required)) {
      out.push({ aspect: "params", before: paramText(old), after: paramText(p), ...(p.required && !old.required ? { breaking: true as const } : old.type && p.type && old.type !== p.type ? { breaking: true as const } : {}) });
    }
  }
  for (const [key, p] of b) if (!a.has(key)) out.push({ aspect: "params", before: paramText(p) });
  return out;
}

function shapeText(s: ApiShape | undefined): string | undefined {
  if (!s) return undefined;
  if (s.fields?.length) return `${s.type ? `${s.type} ` : ""}{ ${s.fields.map((f) => `${f.name}${f.required ? "" : "?"}: ${f.type}`).join("; ")} }`;
  return s.type;
}

/** Field-level differences; `request` breaks on new required / retyped fields, `response` on removed / retyped ones. */
function compareShape(aspect: "request" | "response", before: ApiShape | undefined, after: ApiShape | undefined): EndpointDelta[] {
  // An inferred (✦) shape is a guess; differences between guesses say nothing.
  if (before?.source === "ai" || after?.source === "ai") return [];
  if (!before && !after) return [];
  if (!before?.fields || !after?.fields) {
    const b = shapeText(before);
    const a = shapeText(after);
    if (b === a) return [];
    // Only a change of what the code names it — the fields are unknown on one side.
    return [{ aspect, before: b, after: a, ...(aspect === "response" && b && !a ? { breaking: true as const } : {}) }];
  }
  const out: EndpointDelta[] = [];
  const b = new Map(before.fields.map((f) => [f.name, f]));
  const a = new Map(after.fields.map((f) => [f.name, f]));
  for (const [name, f] of a) {
    const old = b.get(name);
    const text = `${name}${f.required ? "" : "?"}: ${f.type}`;
    if (!old) out.push({ aspect, after: text, ...(aspect === "request" && f.required ? { breaking: true as const } : {}) });
    else if (old.type !== f.type || old.required !== f.required) {
      const tightened = aspect === "request" ? f.required && !old.required : !f.required && old.required;
      out.push({ aspect, before: `${name}${old.required ? "" : "?"}: ${old.type}`, after: text, ...(old.type !== f.type || tightened ? { breaking: true as const } : {}) });
    }
  }
  for (const [name, f] of b) if (!a.has(name)) out.push({ aspect, before: `${name}${f.required ? "" : "?"}: ${f.type}`, ...(aspect === "response" ? { breaking: true as const } : {}) });
  return out;
}

function compareEndpoint(before: Endpoint, after: Endpoint): EndpointDelta[] {
  const deltas: EndpointDelta[] = [];
  if (before.path !== after.path) deltas.push({ aspect: "path", before: before.path, after: after.path, ...(before.kind !== "action" ? { breaking: true as const } : {}) });
  if (before.method !== after.method) deltas.push({ aspect: "method", before: before.method, after: after.method, ...(before.kind !== "action" ? { breaking: true as const } : {}) });
  deltas.push(...compareParams(before, after));
  deltas.push(...compareShape("request", before.request, after.request));
  deltas.push(...compareShape("response", before.response, after.response));
  const authBefore = before.auth.join(" → ");
  const authAfter = after.auth.join(" → ");
  if (authBefore !== authAfter) {
    const added = after.auth.filter((a) => !before.auth.includes(a));
    deltas.push({ aspect: "auth", before: authBefore || undefined, after: authAfter || undefined, ...(added.length ? { breaking: true as const } : {}) });
  }
  return deltas;
}

/** The handler's own lines changed (at the head, or its old lines at the base). */
function handlerChanged(before: Endpoint, after: Endpoint, changed: ReadonlyMap<string, ChangedLines>): boolean {
  const h = after.handler;
  const hb = before.handler;
  return Boolean(
    (h && overlaps(h.startLine, h.endLine, changed.get(h.file)?.added)) || (hb && overlaps(hb.startLine, hb.endLine, changed.get(hb.file)?.removed))
  );
}

/** The same handler code: one declaration, or one inline function's unchanged text. */
const sameHandler = (a: Endpoint, b: Endpoint) =>
  Boolean(a.handler && b.handler && ((a.handler.declId && a.handler.declId === b.handler.declId) || (!a.handler.declId && a.handler.hash && a.handler.hash === b.handler.hash)));

export function compareApis(base: Side, head: Side, changed: ReadonlyMap<string, ChangedLines>): ApiChange {
  const baseById = new Map(base.api.endpoints.map((e) => [e.id, e]));
  const headById = new Map(head.api.endpoints.map((e) => [e.id, e]));
  const changes: EndpointChange[] = [];

  // Re-pathed / re-methoded: one removed and one added endpoint served by the same handler.
  const removed = base.api.endpoints.filter((e) => !headById.has(e.id));
  const added = head.api.endpoints.filter((e) => !baseById.has(e.id));
  const pairedBefore = new Map<string, Endpoint>();
  for (const a of added) {
    const candidates = removed.filter((r) => r.kind === a.kind && sameHandler(r, a) && !pairedBefore.has(r.id));
    const match = candidates.find((r) => r.method === a.method) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (match) pairedBefore.set(match.id, a);
  }
  const pairedAfter = new Map([...pairedBefore].map(([beforeId, after]) => [after.id, baseById.get(beforeId)!]));

  // Reach: from every head handler, through resolved calls, to changed functions.
  const { statusOf } = changedDeclarations(base, head, changed);
  for (const [id, status] of [...statusOf]) if (status === "moved" || status === "removed") statusOf.delete(id);
  const calls = indexCalls(head.symbols);
  const declById = new Map(head.symbols.decls.map((d) => [d.id, d]));
  let reachCapped = false;
  const reachesOf = (e: Endpoint): EndpointReach[] => {
    if (!e.handler || statusOf.size === 0) return [];
    const out: EndpointReach[] = [];
    const previous = new Map<string, string | null>();
    let frontier: string[] = [];
    for (const call of handlerCalls(calls, e.handler)) {
      if (previous.has(call.to) || call.to === e.handler.declId) continue;
      previous.set(call.to, null);
      frontier.push(call.to);
    }
    let visited = frontier.length;
    for (let hop = 1; hop <= MAX_API_REACH_HOPS && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        const status = statusOf.get(id);
        if (status && out.length < MAX_REACHES_PER_ENDPOINT) {
          const path: string[] = [];
          for (let cursor: string | null = id; cursor; cursor = previous.get(cursor) ?? null) path.unshift(cursor);
          const decl = declById.get(id);
          out.push({
            id,
            name: decl?.qualified ?? id.split("#").pop()!,
            file: decl?.file ?? id.split("#")[0],
            status,
            path: path.map((p) => ({ id: p, name: declById.get(p)?.qualified ?? p.split("#").pop()!, file: declById.get(p)?.file ?? p.split("#")[0] })),
          });
        }
        for (const call of calls.from.get(id) ?? []) {
          if (previous.has(call.to) || call.to === e.handler.declId) continue;
          if (visited >= MAX_API_REACH_FUNCTIONS) {
            reachCapped = true;
            break;
          }
          previous.set(call.to, id);
          visited++;
          next.push(call.to);
        }
      }
      frontier = next;
    }
    return out;
  };

  const logic: EndpointLogicChange[] = [];
  for (const e of head.api.endpoints) {
    const before = baseById.get(e.id) ?? pairedAfter.get(e.id);
    if (!before) {
      changes.push({ id: e.id, status: "added", endpoint: e, deltas: [] });
      continue;
    }
    const deltas = compareEndpoint(before, e);
    if (deltas.length > 0) {
      const breaking = deltas.some((d) => d.breaking);
      changes.push({ id: e.id, status: "changed", endpoint: e, before, deltas, ...(breaking ? { breaking: true as const } : {}) });
    }
    // The code behind it — not an API change, context for the review.
    const own = handlerChanged(before, e, changed);
    const reaches = reachesOf(e);
    if (own || reaches.length > 0) logic.push({ id: e.id, endpoint: e, handlerChanged: own, reaches });
  }
  for (const e of removed) {
    if (pairedBefore.has(e.id)) continue;
    changes.push({ id: e.id, status: "removed", endpoint: e, deltas: [], ...(e.kind !== "action" && e.drift !== "spec-only" ? { breaking: true as const } : {}) });
  }

  const order = { removed: 0, changed: 1, added: 2 };
  changes.sort((a, b) => Number(Boolean(b.breaking)) - Number(Boolean(a.breaking)) || order[a.status] - order[b.status] || a.endpoint.path.localeCompare(b.endpoint.path));
  const count = (s: EndpointChange["status"]) => changes.filter((c) => c.status === s).length;
  return {
    changes,
    logic,
    counts: { added: count("added"), removed: count("removed"), changed: count("changed"), breaking: changes.filter((c) => c.breaking).length, logic: logic.length },
    total: head.api.endpoints.length,
    ...(reachCapped ? { reachCapped: true as const } : {}),
  };
}
