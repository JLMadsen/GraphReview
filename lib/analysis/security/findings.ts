/**
 * The "security" findings (DESIGN.md §6.26) — certain or rule-based, no
 * model call:
 *
 *   secret            a credential on a line the change adds, in any file (defect)
 *   auth-removed      an existing endpoint's auth is now none — removed in the diff, or replaced by an explicit public marker (defect)
 *   auth-unknown      an existing endpoint's auth went from something to `?` (concern)
 *   new-endpoint-open a new endpoint with no visible auth and no infra-level auth in front of it, in an app that authenticates elsewhere (concern)
 *
 * A secret's value never reaches a finding: the summary and rationale name
 * the file, the line and the kind only.
 */
import type { ChangedLines } from "../compare";
import type { ApiChange, Endpoint } from "../api/types";
import type { InfraCatalog } from "../infra/types";
import type { SecretHit } from "./secret-scan";

export type SecurityFindingRule = "secret" | "auth-removed" | "auth-unknown" | "new-endpoint-open";

export interface SecurityFinding {
  key: string;
  rule: SecurityFindingRule;
  file: string;
  line?: number;
  assessment: "defect" | "concern";
  summary: string;
  rationale: string;
}

/** One finding per secret hit; lines the env comparison already reported (`committed-secret`) are left to it. */
export function secretFindings(hits: readonly SecretHit[], capped: boolean, alreadyReported: ReadonlySet<string> = new Set()): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (alreadyReported.has(`${h.file}:${h.line}`)) continue;
    const key = `security:secret:${h.file}:${h.kind}:${h.fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      rule: "secret",
      file: h.file,
      line: h.line,
      assessment: "defect",
      summary: `${article(h.kind)} ${h.kind} is committed in ${h.file}:${h.line}`,
      rationale:
        `Line ${h.line} of ${h.file}, added by this change, holds what looks like ${article(h.kind).toLowerCase()} ${h.kind} (the value is not shown here). ` +
        `Anything committed stays in the repository's history, even after it is removed, so treat it as leaked: rotate it, then read it from outside the repo ` +
        `(a CI secret, the host's env, a git-ignored file). If it is a deliberate test value, replace it with an obvious placeholder.`,
    });
  }
  if (capped && out.length) {
    const last = out[out.length - 1];
    last.rationale += ` The scan stopped after ${hits.length} hits; there are more in this change.`;
  }
  return out;
}

const article = (kind: string) => (/^[aeiou]/i.test(kind) ? "An" : "A");

/** Entries that say "deliberately open", not "protected". */
const PUBLIC_MARKER = /(PermitAll|AllowAnonymous|\bAnonymous\b|AllowAny\b|\bPublic\b|isPublic|SkipAuth|NoAuth|publicProcedure)/i;
const isPublicMarker = (a: string) => PUBLIC_MARKER.test(a);
const realAuth = (e: Endpoint) => e.auth.filter((a) => !isPublicMarker(a));

const label = (e: Endpoint) => `${e.method} ${e.path}`;
const where = (e: Endpoint) => e.registeredAt ?? (e.handler ? { file: e.handler.file, line: e.handler.startLine, endLine: undefined } : undefined);

/** The lines that register the endpoint (or its handler's first line) are lines the change added. */
function registrationTouched(e: Endpoint, changed: ReadonlyMap<string, ChangedLines>): boolean {
  const at = where(e);
  if (!at) return false;
  const added = changed.get(at.file)?.added;
  if (!added) return false;
  for (let l = at.line; l <= (at.endLine ?? at.line); l++) if (added.has(l)) return true;
  return false;
}

/** Most new-endpoint concerns raised one by one; past it, one finding names the rest. */
const MAX_OPEN_ENDPOINTS = 6;

/**
 * The endpoint auth findings, from the API catalog diff (DESIGN.md §6.11)
 * and the head's infra routes (§6.12): a route with auth middleware in front
 * of an endpoint covers it.
 */
export function endpointAuthFindings(
  api: ApiChange,
  baseEndpoints: readonly Endpoint[],
  headInfra: Pick<InfraCatalog, "links">,
  changed: ReadonlyMap<string, ChangedLines>
): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const infraCovered = new Set(headInfra.links.routes.filter((r) => r.auth?.length).flatMap((r) => r.endpoints));
  const infraAuth = headInfra.links.routes.some((r) => r.auth?.length);
  const authedFrameworks = new Set(baseEndpoints.filter((e) => realAuth(e).length > 0).map((e) => e.framework));
  const open: Endpoint[] = [];

  for (const c of api.changes) {
    const e = c.endpoint;
    const at = where(e);
    if (!at) continue;
    if (c.status === "changed" && c.before && c.deltas.some((d) => d.aspect === "auth")) {
      const before = realAuth(c.before);
      if (before.length === 0 || realAuth(e).length > 0 || infraCovered.has(e.id)) continue;
      const was = before.join(" → ");
      const explicit = e.auth.some(isPublicMarker);
      if (explicit || registrationTouched(e, changed)) {
        out.push({
          key: `security:auth-removed:${e.id}`,
          rule: "auth-removed",
          file: at.file,
          line: at.line,
          assessment: "defect",
          summary: `${label(e)} no longer has auth (was ${was})`,
          rationale:
            `At the base, ${label(e)} sat behind ${was}. ` +
            (explicit
              ? `This change marks it ${e.auth.filter(isPublicMarker).join(", ")}, so anyone who can reach it can call it.`
              : `This change edits the lines that register it (${at.file}:${at.line}) and leaves nothing in front of the handler, and no infra route adds auth for it.`) +
            ` If it is meant to be public, say so in the PR; otherwise put the auth back.`,
        });
      } else {
        out.push({
          key: `security:auth-unknown:${e.id}`,
          rule: "auth-unknown",
          file: at.file,
          line: at.line,
          assessment: "concern",
          summary: `${label(e)}'s auth is no longer visible (was ${was})`,
          rationale:
            `At the base, ${label(e)} sat behind ${was}; at the head no auth is visible for it any more. The change didn't edit the lines that register it, ` +
            `so the auth may have moved somewhere static analysis can't follow (a mount point, global middleware, a gateway) — or it may be gone. Check that it is still protected.`,
        });
      }
    } else if (c.status === "added") {
      if (e.kind === "action" || e.internal || e.drift === "spec-only" || e.auth.length > 0 || infraCovered.has(e.id)) continue;
      // Only where the app authenticates elsewhere: an app with no auth at all would flag every route.
      if (!authedFrameworks.has(e.framework) && !infraAuth) continue;
      open.push(e);
    }
  }

  for (const e of open.slice(0, MAX_OPEN_ENDPOINTS)) {
    const at = where(e)!;
    out.push({
      key: `security:new-endpoint-open:${e.id}`,
      rule: "new-endpoint-open",
      file: at.file,
      line: at.line,
      assessment: "concern",
      summary: `New endpoint ${label(e)} has no visible auth`,
      rationale:
        `This change adds ${label(e)} (${e.framework}) with no middleware, guard or dependency in front of its handler, and no infra route (Traefik, ingress) adds auth for it — ` +
        `while other ${e.framework} endpoints in this repo do have auth. If it is meant to be public, say so; otherwise protect it like its neighbours.`,
    });
  }
  if (open.length > MAX_OPEN_ENDPOINTS) {
    const rest = open.slice(MAX_OPEN_ENDPOINTS);
    const at = where(rest[0])!;
    out.push({
      key: `security:new-endpoint-open:more`,
      rule: "new-endpoint-open",
      file: at.file,
      line: at.line,
      assessment: "concern",
      summary: `${rest.length} more new endpoints have no visible auth`,
      rationale: `Besides the ones reported separately, this change adds ${rest.length} endpoint(s) with no visible auth and no infra-level auth: ${rest.slice(0, 10).map(label).join(", ")}${rest.length > 10 ? ", …" : ""}.`,
    });
  }
  return out;
}
