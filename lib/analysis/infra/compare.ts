/**
 * What a change does to the infrastructure (DESIGN.md §6.12 §4–§5), read
 * like a `terraform plan`: per resource **create**, **destroy**, **update**
 * (attribute by attribute), **moved** (a `moved` block, or a Kubernetes /
 * Nomad name unchanged at a new path) and **version** (module, provider,
 * chart and base-image versions). Replace vs update in place needs provider
 * schemas, so it isn't predicted — only flagged for attributes on a short
 * built-in force-new list. Link deltas (an env var newly unset, a route
 * that now reaches other endpoints, a port that no longer matches) go
 * beside them.
 *
 * Exactly three kinds of finding, all certain, none needing a model:
 *   - a Terraform resource renamed without a `moved` block (it would be
 *     destroyed and created again);
 *   - a stateful resource destroyed, or `prevent_destroy` removed from one;
 *   - an env var a deployed component reads that its workload no longer
 *     sets (only when the deploy link is resolved; "maybe" sources suppress it).
 *
 * Pure: two catalogs in, data out.
 */
import { isForceNew } from "./common";
import type {
  InfraAttr,
  InfraAttrDelta,
  InfraCatalog,
  InfraChange,
  InfraChangeEntry,
  InfraEnvLink,
  InfraFinding,
  InfraLinkDelta,
  InfraResource,
} from "./types";

/** Categories whose `version` change is a version entry of the plan. */
const VERSIONED = new Set(["module", "provider", "stage", "chart"]);
/** Rows derived from others: their change shows on the row they come from. */
const DERIVED = new Set(["image"]);
/** Below this share of equal attributes a destroyed + created pair isn't a rename. */
const RENAME_SIMILARITY = 0.8;

function attrMap(r: InfraResource): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of r.attributes) m.set(a.name, a.value);
  if (r.count !== undefined) m.set("count", r.count);
  if (r.lifecycle?.preventDestroy) m.set("lifecycle.prevent_destroy", "true");
  if (r.lifecycle?.createBeforeDestroy) m.set("lifecycle.create_before_destroy", "true");
  if (r.lifecycle?.ignoreChanges?.length) m.set("lifecycle.ignore_changes", r.lifecycle.ignoreChanges.join(", "));
  for (const [env, list] of Object.entries(r.envValues ?? {})) for (const a of list as InfraAttr[]) m.set(`[${env}] ${a.name}`, a.value);
  return m;
}

function attrDeltas(before: InfraResource, after: InfraResource): InfraAttrDelta[] {
  const b = attrMap(before);
  const a = attrMap(after);
  const out: InfraAttrDelta[] = [];
  for (const [name, value] of a) {
    const old = b.get(name);
    if (old === value) continue;
    out.push({ name, ...(old !== undefined ? { before: old } : {}), after: value, ...(isForceNew(after.kind, name) ? { forceNew: true as const } : {}) });
  }
  for (const [name, old] of b) if (!a.has(name)) out.push({ name, before: old, ...(isForceNew(before.kind, name) ? { forceNew: true as const } : {}) });
  return out;
}

function similarity(a: InfraResource, b: InfraResource): number {
  const x = new Map(a.attributes.map((t) => [t.name, t.value]));
  const y = new Map(b.attributes.map((t) => [t.name, t.value]));
  const names = new Set([...x.keys(), ...y.keys()]);
  if (names.size === 0) return 1;
  let same = 0;
  for (const n of names) if (x.get(n) === y.get(n)) same++;
  return same / names.size;
}

const ORDER: Record<InfraChangeEntry["action"], number> = { destroy: 0, moved: 1, update: 2, version: 3, create: 4 };

function findingKey(rule: string, ...parts: string[]): string {
  return [rule, ...parts].join("|");
}

export function compareInfra(base: InfraCatalog, head: InfraCatalog): InfraChange {
  const baseRows = base.resources.filter((r) => !DERIVED.has(r.category));
  const headRows = head.resources.filter((r) => !DERIVED.has(r.category));
  const baseById = new Map(baseRows.map((r) => [r.id, r]));
  const headById = new Map(headRows.map((r) => [r.id, r]));
  const changes: InfraChangeEntry[] = [];
  const findings: InfraFinding[] = [];
  /** base id → head id, for everything that is "the same resource". */
  const pairs = new Map<string, string>();
  for (const id of baseById.keys()) if (headById.has(id)) pairs.set(id, id);

  // Moved: `moved` blocks first, then Kubernetes / Nomad names unchanged at a new path.
  const movedVia = new Map<string, string>();
  for (const m of head.moves) {
    if (m.kind !== "moved" || !m.from || !m.to) continue;
    const from = `${m.stack}:${m.from}`;
    const to = `${m.stack}:${m.to}`;
    if (baseById.has(from) && !headById.has(from) && headById.has(to) && !baseById.has(to) && !pairs.has(from)) {
      pairs.set(from, to);
      movedVia.set(from, `moved block (${m.file}:${m.line})`);
    }
  }
  const pairedHead = () => new Set(pairs.values());
  const removed = () => baseRows.filter((r) => !pairs.has(r.id));
  const added = () => {
    const taken = pairedHead();
    return headRows.filter((r) => !taken.has(r.id));
  };
  for (const r of removed()) {
    if (r.tool === "terraform" || r.category === "variable" || r.category === "output" || r.category === "local") continue;
    const candidates = added().filter((a) => a.tool === r.tool && a.kind === r.kind && a.address === r.address && a.stack !== r.stack);
    if (candidates.length === 1) {
      pairs.set(r.id, candidates[0].id);
      movedVia.set(r.id, `same name at a new path (${r.file} → ${candidates[0].file})`);
    }
  }

  // Terraform: removed + added of one type in one stack with matching attributes, no `moved` → a rename Terraform would destroy and recreate.
  const renames = new Map<string, InfraResource>(); // base id → head resource
  {
    const taken = new Set<string>();
    for (const r of removed()) {
      if (r.tool !== "terraform" || r.category !== "resource") continue;
      const best = added()
        .filter((a) => a.tool === "terraform" && a.category === "resource" && a.kind === r.kind && a.stack === r.stack && !taken.has(a.id))
        .map((a) => ({ a, s: similarity(r, a) }))
        .filter((x) => x.s >= RENAME_SIMILARITY)
        .sort((x, y) => y.s - x.s);
      if (best.length === 0 || (best.length > 1 && best[0].s === best[1].s)) continue;
      taken.add(best[0].a.id);
      renames.set(r.id, best[0].a);
    }
  }
  const forgotten = new Set(head.moves.filter((m) => m.kind === "removed" && m.destroy === false && m.from).map((m) => `${m.stack}:${m.from}`));

  // Pairs: moved / update / version.
  for (const [baseId, headId] of pairs) {
    const before = baseById.get(baseId)!;
    const after = headById.get(headId)!;
    const deltas = attrDeltas(before, after);
    const versionChanged = VERSIONED.has(after.category) && (before.version ?? "") !== (after.version ?? "");
    const replace = deltas.some((d) => d.forceNew);
    if (baseId !== headId) {
      changes.push({ id: headId, action: "moved", resource: after, before, deltas, movedFrom: before.address === after.address ? before.stack : before.address, movedVia: movedVia.get(baseId), ...(replace ? { replace: true as const } : {}) });
      continue;
    }
    if (versionChanged) {
      changes.push({ id: headId, action: "version", resource: after, before, deltas: deltas.filter((d) => d.name !== "constraint"), version: { before: before.version, after: after.version }, ...(replace ? { replace: true as const } : {}) });
      continue;
    }
    if (deltas.length > 0) changes.push({ id: headId, action: "update", resource: after, before, deltas, ...(replace ? { replace: true as const } : {}) });
  }
  for (const r of removed()) changes.push({ id: r.id, action: "destroy", resource: r, deltas: [] });
  for (const r of added()) changes.push({ id: r.id, action: "create", resource: r, deltas: [] });
  const entryOf = (id: string, action?: InfraChangeEntry["action"]) => changes.find((c) => c.id === id && (!action || c.action === action));
  const flag = (entry: InfraChangeEntry | undefined, key: string) => {
    if (entry) entry.findings = [...(entry.findings ?? []), key];
  };

  // Finding 1: renamed without `moved`.
  for (const [baseId, after] of renames) {
    const before = baseById.get(baseId)!;
    const key = findingKey("rename", baseId);
    findings.push({
      key,
      rule: "rename-without-moved",
      resource: after.id,
      file: after.file,
      line: after.line,
      summary: `${before.address} renamed to ${after.address} without a moved block`,
      rationale:
        `${before.address} is gone and ${after.address}, a ${after.kind} with the same attributes, is new in the same stack (${after.stack.replace(/^terraform:/, "") || "(root)"}). ` +
        `Without a \`moved { from = ${before.address}  to = ${after.address} }\` block Terraform plans to destroy the existing resource and create a new one` +
        `${before.stateful ? " — and it holds data" : ""}. Add the moved block if this is a rename.`,
    });
    flag(entryOf(baseId, "destroy"), key);
    flag(entryOf(after.id, "create"), key);
  }

  // Finding 2: a stateful resource destroyed, or prevent_destroy removed.
  for (const c of changes) {
    if (c.action === "destroy" && (c.resource.stateful || c.resource.lifecycle?.preventDestroy) && !renames.has(c.id) && !forgotten.has(c.id)) {
      const key = findingKey("destroy", c.id);
      const what = c.resource.stateful ? `stateful ${c.resource.kind}` : `${c.resource.kind} with prevent_destroy`;
      findings.push({
        key,
        rule: "stateful-destroyed",
        resource: c.id,
        file: c.resource.file,
        line: c.resource.line,
        summary: `Destroys ${what} ${c.resource.address}`,
        rationale: c.resource.stateful
          ? `${c.resource.address} (${c.resource.kind}) holds data and this change removes it, so applying it deletes the resource and what is stored in it. Make sure that is intended, the data is backed up or migrated, or keep it out of management instead (Terraform: a \`removed\` block with \`destroy = false\`).`
          : `${c.resource.address} had lifecycle.prevent_destroy = true and this change removes the resource; Terraform refuses to plan its destruction until prevent_destroy is lifted, and the protection was there for a reason.`,
      });
      flag(c, key);
    }
    if ((c.action === "update" || c.action === "version" || c.action === "moved") && c.before?.lifecycle?.preventDestroy && !c.resource.lifecycle?.preventDestroy) {
      const key = findingKey("prevent", c.id);
      findings.push({
        key,
        rule: "prevent-destroy-removed",
        resource: c.id,
        file: c.resource.file,
        line: c.resource.line,
        summary: `Removes prevent_destroy from ${c.resource.address}`,
        rationale: `${c.resource.address} (${c.resource.kind}${c.resource.stateful ? ", stateful" : ""}) was protected by lifecycle.prevent_destroy = true; this change lifts the protection, so a later plan can destroy it without being stopped.`,
      });
      flag(c, key);
    }
  }

  // Link deltas and finding 3 (env var no longer set).
  const links: InfraLinkDelta[] = [];
  const headIdOf = (baseId: string) => pairs.get(baseId);
  const baseEnv = new Map<string, InfraEnvLink>();
  for (const l of base.links.env) {
    const id = headIdOf(l.resource);
    if (id) baseEnv.set(id, l);
  }
  for (const l of head.links.env) {
    const before = baseEnv.get(l.resource);
    const w = head.resources.find((r) => r.id === l.resource);
    if (!before || !w) continue;
    const wasSet = new Set(before.set);
    const nowSet = new Set(l.set);
    const gone = before.set.filter((n) => !nowSet.has(n));
    const newly = l.set.filter((n) => !wasSet.has(n));
    if (gone.length) links.push({ kind: "env", resource: l.resource, text: `${w.address} no longer sets ${gone.join(", ")}` });
    if (newly.length) links.push({ kind: "env", resource: l.resource, text: `${w.address} now sets ${newly.join(", ")}` });
    if (before.maybe.join("|") !== l.maybe.join("|")) links.push({ kind: "env", resource: l.resource, text: `${w.address} env sources it can't list: ${before.maybe.join(", ") || "none"} → ${l.maybe.join(", ") || "none"}` });
    const already = new Set(before.readNotSet.map((x) => x.name));
    for (const miss of l.readNotSet) {
      if (already.has(miss.name)) continue;
      const removedSetting = wasSet.has(miss.name);
      const key = findingKey("env", l.resource, miss.name);
      findings.push({
        key,
        rule: "env-unset",
        resource: l.resource,
        file: removedSetting ? w.file : miss.file,
        line: removedSetting ? w.line : miss.line,
        summary: removedSetting ? `${w.address} no longer sets ${miss.name}, which ${miss.file} reads` : `${miss.file} now reads ${miss.name}, which ${w.address} doesn't set`,
        rationale:
          `${w.address} deploys the code in ${miss.file} (deploy link resolved), and that code reads the env var ${miss.name} (line ${miss.line}). ` +
          (removedSetting ? `This change removes it from what the workload sets` : `This change adds the read, and the workload doesn't set it`) +
          ` — not in its env, its image's Dockerfile ENV or a .env.example in the build context, and no Secret / template source could provide it. At runtime it will be undefined.`,
      });
      links.push({ kind: "env", resource: l.resource, text: `${miss.name} is read by ${miss.file} but ${w.address} doesn't set it`, files: [miss.file] });
      flag(entryOf(l.resource), key);
    }
  }
  // Routes: a path gone or added, or reaching a different set of endpoints.
  const routeKey = (r: { resource: string; host?: string; path: string }) => `${r.host ?? ""}${r.path}`;
  const baseRoutes = new Map<string, Map<string, string[]>>();
  for (const r of base.links.routes) {
    const id = headIdOf(r.resource);
    if (!id) continue;
    const m = baseRoutes.get(id) ?? new Map<string, string[]>();
    m.set(routeKey(r), r.endpoints);
    baseRoutes.set(id, m);
  }
  const headRoutes = new Map<string, Map<string, string[]>>();
  for (const r of head.links.routes) {
    const m = headRoutes.get(r.resource) ?? new Map<string, string[]>();
    m.set(routeKey(r), r.endpoints);
    headRoutes.set(r.resource, m);
  }
  for (const [id, now] of headRoutes) {
    const was = baseRoutes.get(id);
    if (!was) continue;
    const w = head.resources.find((r) => r.id === id);
    for (const [k, eps] of now) {
      const before = was.get(k);
      if (!before) links.push({ kind: "route", resource: id, text: `new route ${k} → ${w?.address ?? id} (${eps.length} endpoint${eps.length === 1 ? "" : "s"})` });
      else if (before.slice().sort().join("|") !== eps.slice().sort().join("|")) links.push({ kind: "route", resource: id, text: `route ${k} now reaches ${eps.length} endpoint${eps.length === 1 ? "" : "s"} (was ${before.length})` });
    }
    for (const k of was.keys()) if (!now.has(k)) links.push({ kind: "route", resource: id, text: `route ${k} no longer points at ${w?.address ?? id}` });
  }
  // Ports.
  const basePorts = new Map(base.links.ports.map((p) => [headIdOf(p.resource) ?? "", p]));
  for (const p of head.links.ports) {
    const before = basePorts.get(p.resource);
    const w = head.resources.find((r) => r.id === p.resource);
    if (before && before.match && !p.match) links.push({ kind: "port", resource: p.resource, text: `${w?.address ?? p.resource} sends traffic to port ${p.declared}, but the code listens on ${p.listen}`, ...(p.file ? { files: [p.file] } : {}) });
    else if (before && !before.match && p.match) links.push({ kind: "port", resource: p.resource, text: `${w?.address ?? p.resource} port now matches the code (${p.listen})` });
    else if (!before && !p.match && w && headIdOf(w.id) === undefined && !baseById.has(w.id)) links.push({ kind: "port", resource: p.resource, text: `${w.address} sends traffic to port ${p.declared}, but the code listens on ${p.listen}`, ...(p.file ? { files: [p.file] } : {}) });
  }
  // Deploys: built from a different Dockerfile, or no longer resolved.
  const baseDeploys = new Map<string, string>();
  for (const d of base.links.deploys) {
    const id = headIdOf(d.resource);
    if (id) baseDeploys.set(`${id}|${d.image ?? ""}`, d.dockerfile ?? "");
  }
  for (const d of head.links.deploys) {
    const before = baseDeploys.get(`${d.resource}|${d.image ?? ""}`);
    if (before === undefined || before === (d.dockerfile ?? "")) continue;
    const w = head.resources.find((r) => r.id === d.resource);
    links.push({ kind: "deploy", resource: d.resource, text: d.dockerfile ? `${w?.address ?? d.resource} is now built from ${d.dockerfile}${before ? ` (was ${before})` : ""}` : `${w?.address ?? d.resource}'s image is no longer built from ${before}` });
  }

  const hasFinding = (c: InfraChangeEntry) => (c.findings?.length ? 0 : 1);
  changes.sort((a, b) => hasFinding(a) - hasFinding(b) || ORDER[a.action] - ORDER[b.action] || a.resource.stack.localeCompare(b.resource.stack) || a.resource.address.localeCompare(b.resource.address));
  const count = (action: InfraChangeEntry["action"]) => changes.filter((c) => c.action === action).length;
  return {
    changes,
    links,
    findings,
    counts: { create: count("create"), destroy: count("destroy"), update: count("update"), moved: count("moved"), version: count("version"), findings: findings.length },
    total: headRows.length,
  };
}
