/**
 * The env catalog and change in words, for the places that hand them to a
 * model or an agent: the review's per-component context and intent check,
 * the PR chat and the MCP server (DESIGN.md §6.15 §5). Values go through
 * `valueForModel` — secret-looking ones never reach the model as text.
 */
import { valueForModel } from "./secret";
import type { EnvCatalog, EnvChange, EnvChangeEntry, EnvFinding, EnvSet, EnvVar } from "./types";

const setValue = (name: string, s: EnvSet) => (s.ref ? `↗ ${s.ref}` : valueForModel(name, s.value ?? "") ?? "");

/** "DATABASE_URL [secret]: read apps/web/page.tsx:3 (required); declared t3-env url; set production=<set, 50 chars>, ci:production=↗ secret DATABASE_URL". */
export function describeEnvVar(v: EnvVar, maxReads = 4, maxSets = 8): string {
  const parts: string[] = [];
  const reads = v.reads.slice(0, maxReads).map((r) => {
    const how = [r.required ? "required" : "", r.fallback !== undefined ? `fallback ${valueForModel(v.name, r.fallback)}` : "", r.client ? "client" : "", r.host ? "host" : ""].filter(Boolean);
    return `${r.file}:${r.line}${how.length ? ` (${how.join(", ")})` : ""}`;
  });
  if (reads.length) parts.push(`read ${reads.join(", ")}${v.reads.length > maxReads ? ` +${v.reads.length - maxReads}` : ""}`);
  const decls = v.decls.filter((d) => d.via !== "example").map((d) => `${d.via}${d.type ? ` ${d.type}` : ""}${d.default !== undefined ? ` default ${valueForModel(v.name, d.default)}` : ""}${d.optional ? " optional" : ""}`);
  if (decls.length) parts.push(`declared ${decls.join(", ")}`);
  const sets = v.sets.slice(0, maxSets).map((s) => `${s.target}=${setValue(v.name, s)}`);
  if (sets.length) parts.push(`set ${sets.join(", ")}${v.sets.length > maxSets ? ` +${v.sets.length - maxSets}` : ""}`);
  if (v.clientVia) parts.push(`exposed to the browser (${v.clientVia})`);
  const tags = v.tags.filter((t) => t !== "client");
  return `${v.name}${tags.length ? ` [${tags.join(", ")}]` : ""}: ${parts.join("; ") || "no reads or sets"}`;
}

/** "new STRIPE_SECRET_KEY: production + <set, 31 chars> (apps/web/.env.production:3)". */
export function describeEnvChangeEntry(c: EnvChangeEntry, maxDeltas = 8): string {
  const parts = c.deltas.slice(0, maxDeltas).map((d) => {
    const before = d.before !== undefined ? (d.where === "read" || d.where === "declared" ? d.before : valueForModel(c.name, d.before.replace(/^↗ /, ""))) : undefined;
    const after = d.after !== undefined ? (d.where === "read" || d.where === "declared" ? d.after : d.after.startsWith("↗ ") ? d.after : valueForModel(c.name, d.after)) : undefined;
    const v = before !== undefined && after !== undefined ? `${before} → ${after}` : after !== undefined ? `+ ${after}` : `− ${before}`;
    return `${d.where} ${v}`;
  });
  if (c.deltas.length > maxDeltas) parts.push(`+${c.deltas.length - maxDeltas} more`);
  const tags = c.newTags.length ? ` [now ${c.newTags.join(", ")}]` : "";
  return `${c.status} ${c.name}${tags}: ${parts.join("; ") || "status changed"}`;
}

export function envChangeSummary(change: EnvChange): string {
  const { new: added, gone, changed } = change.counts;
  if (change.changes.length === 0) return `No env var change (${change.total} names).`;
  return `${added} new, ${gone} gone, ${changed} changed — of ${change.total} env var names; ${change.findings.length} certain finding(s).`;
}

export function describeEnvFinding(f: EnvFinding): string {
  return `${f.summary} (${f.file}${f.line ? `:${f.line}` : ""})`;
}

export function describeEnvChange(change: EnvChange, max = 25): string[] {
  const lines = [envChangeSummary(change)];
  for (const c of change.changes.slice(0, max)) lines.push(describeEnvChangeEntry(c));
  if (change.changes.length > max) lines.push(`(${change.changes.length - max} more env var changes)`);
  return lines;
}

const touches = (v: EnvVar, files: ReadonlySet<string>) =>
  v.reads.some((r) => files.has(r.file)) || v.decls.some((d) => files.has(d.file)) || v.sets.some((s) => files.has(s.file));

/** The change entries and findings about names `files` read, declare or set — one component's review context. */
export function envChangesTouching(change: EnvChange | undefined, files: ReadonlySet<string>): { entries: EnvChangeEntry[]; findings: EnvFinding[] } {
  if (!change) return { entries: [], findings: [] };
  const entries = change.changes.filter((c) => touches(c.variable, files) || c.deltas.some((d) => d.file && files.has(d.file)));
  const names = new Set(entries.map((e) => e.name));
  return { entries, findings: change.findings.filter((f) => names.has(f.name) || files.has(f.file)) };
}

/**
 * Names matching a filter, for `list_env` (chat and MCP): `query` is text in
 * the name, a file or a value; `tag` one of the tags (`undeclared`,
 * `secret`, …); `environment` a target id that must set it.
 */
export function filterEnv(catalog: EnvCatalog, opts: { query?: string; tag?: string; environment?: string } = {}): EnvVar[] {
  const q = opts.query?.trim().toLowerCase();
  const tag = opts.tag?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const environment = opts.environment?.trim().toLowerCase();
  return catalog.vars.filter(
    (v) =>
      (!q ||
        v.name.toLowerCase().includes(q) ||
        v.reads.some((r) => r.file.toLowerCase().includes(q)) ||
        v.sets.some((s) => s.file.toLowerCase().includes(q) || (!v.tags.includes("secret") && s.value?.toLowerCase().includes(q)))) &&
      (!tag || v.tags.some((t) => t === tag)) &&
      (!environment || v.sets.some((s) => s.target.toLowerCase() === environment))
  );
}

/** "Configuration this change touches": the names `files` read, declare or set, as the head's catalog has them. */
export function envVarsTouching(catalog: EnvCatalog | undefined, files: ReadonlySet<string>, max = 20): string[] {
  if (!catalog) return [];
  return catalog.vars.filter((v) => !v.tags.includes("platform") && touches(v, files)).slice(0, max).map((v) => describeEnvVar(v));
}
