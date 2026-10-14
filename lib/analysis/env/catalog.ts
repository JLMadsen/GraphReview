/**
 * The env catalog of one analysed tree (DESIGN.md §6.15 §2): every name the
 * code reads or declares and every committed source that sets it, per
 * environment, with the scope each source reaches and the tags the view
 * filters on. Runs at the end of `analyzeTree`, after the infra catalog,
 * whose workloads are one more source.
 */
import type { CodeFacts } from "../infra/code-facts";
import type { InfraCatalog, InfraResource } from "../infra/types";
import { CLIENT_PREFIXES, isPlatformEnv } from "./platform";
import type { EnvFileFacts, EnvSetFact } from "./read";
import { isSecretName, isSecretValue } from "./secret";
import { EMPTY_ENV_CATALOG, type EnvCatalog, type EnvDecl, type EnvRead, type EnvScope, type EnvSet, type EnvSourceKind, type EnvTag, type EnvTarget, type EnvVar } from "./types";

export interface BuildEnvCatalogInput {
  /** Code files (and Spring config) with their env reads, schema entries and `"use client"` marks. */
  code: ReadonlyArray<{ file: string; facts: CodeFacts }>;
  /** Import edges, to carry "client" from a `"use client"` file to what it imports. */
  edges: ReadonlyArray<{ from: string; to: string; typeOnly?: true }>;
  envFiles: ReadonlyArray<{ file: string; facts: EnvFileFacts }>;
  infra: InfraCatalog;
}

const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const isUnder = (file: string, folder: string) => folder === "" || file === folder || file.startsWith(`${folder}/`);

const MAX_READS = 200;

/** Test and fixture files: their reads are often fixture strings, and tests set env themselves. */
const TEST_FILE = /(^|\/)(__tests__|__fixtures__|__mocks__|fixtures|tests?|spec|e2e|testdata)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)smoke-test[^/]*$|_test\.(go|py)$|(^|\/)(test_[^/]*|conftest)\.py$|Test\.(java|kt)$/;

/** A workload's env value as the infra catalog keeps it: `secret db/url`, `configmap app/X`, `template …` are refs. */
function infraValue(raw: string): { value?: string; ref?: string } {
  if (/^(secret|configmap|field|template) /.test(raw) || raw === "valueFrom") return { ref: raw };
  return { value: raw };
}

/** The nearest scope root a file sits under (the longest). */
function scopeOf(file: string, scopes: readonly EnvScope[]): string {
  let best = "";
  for (const s of scopes) if (isUnder(file, s.root) && s.root.length > best.length) best = s.root;
  return best;
}

function groupKey(name: string): string {
  const pub = CLIENT_PREFIXES.find((p) => name.startsWith(p));
  const rest = pub ? name.slice(pub.length) : name;
  const head = rest.split("_")[0];
  if (!head || head === rest) return pub ?? "";
  return pub ? `${pub}` : `${head}_`;
}

export function buildEnvCatalog(input: BuildEnvCatalogInput): EnvCatalog {
  const sources = input.envFiles.filter((f): f is { file: string; facts: Extract<EnvFileFacts, { kind: "env-source" }> } => f.facts.kind === "env-source");
  const anyCode = input.code.some((c) => c.facts.env?.length || c.facts.decl?.length);
  const anyInfraEnv = input.infra.resources.some((r) => r.workload && Object.keys(r.workload.env).length);
  if (!sources.length && !anyCode && !anyInfraEnv) return { ...EMPTY_ENV_CATALOG };

  // Scopes: framework configs and folders holding `.env*` files.
  const scopeMap = new Map<string, EnvScope>();
  for (const s of sources) {
    const root = dirname(s.file);
    if (s.facts.framework) scopeMap.set(root, { root, framework: s.facts.framework });
    else if ((s.facts.source === "dotenv" || s.facts.source === "example") && !scopeMap.has(root)) scopeMap.set(root, { root });
  }
  const scopes = [...scopeMap.values()].sort((a, b) => a.root.localeCompare(b.root));
  // `PUBLIC_` is a plain word everywhere but SvelteKit and Astro: only theirs
  // (or a config naming it as a prefix) puts it in the bundle.
  const prefixes = new Set(CLIENT_PREFIXES.filter((p) => p !== "PUBLIC_" || scopes.some((sc) => sc.framework === "sveltekit" || sc.framework === "astro")));
  for (const s of sources) for (const p of s.facts.prefixes ?? []) prefixes.add(p);

  // Client code: `"use client"` files and everything they import (at runtime).
  // A `"use server"` file (or one importing `server-only`) stops it: the client gets RPC stubs, not its code.
  const server = new Set(input.code.filter((c) => c.facts.server).map((c) => c.file));
  const client = new Set(input.code.filter((c) => c.facts.client).map((c) => c.file));
  const out = new Map<string, string[]>();
  for (const e of input.edges) if (!e.typeOnly) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  const queue = [...client];
  while (queue.length && client.size < 20_000) {
    const f = queue.pop()!;
    for (const to of out.get(f) ?? []) if (!client.has(to) && !server.has(to)) {
      client.add(to);
      queue.push(to);
    }
  }
  const viteOnly = scopes.filter((s) => s.framework === "vite").map((s) => s.root);

  const vars = new Map<string, EnvVar>();
  const entry = (name: string): EnvVar => {
    let v = vars.get(name);
    if (!v) vars.set(name, (v = { name, reads: [], decls: [], sets: [], tags: [], infra: [], group: "" }));
    return v;
  };

  // Reads and schema declarations in code.
  for (const c of input.code) {
    for (const [name, line, flags] of c.facts.env ?? []) {
      const v = entry(name);
      if (v.reads.length >= MAX_READS) continue;
      const read: EnvRead = { file: c.file, line };
      if (flags?.f !== undefined) read.fallback = flags.f;
      if (flags?.r) read.required = true;
      if (flags?.m) read.meta = true;
      if (TEST_FILE.test(c.file)) read.test = true;
      if (client.has(c.file) || (flags?.m && viteOnly.some((root) => isUnder(c.file, root)))) read.client = true;
      v.reads.push(read);
    }
    for (const [name, line, d] of c.facts.decl ?? []) {
      const decl: EnvDecl = { file: c.file, line, via: d.via };
      if (d.type) decl.type = d.type;
      if (d.default !== undefined) decl.default = d.default;
      if (d.optional) decl.optional = true;
      if (d.client) decl.client = true;
      entry(name).decls.push(decl);
    }
  }

  // Sets from env source files.
  const setsByFile = new Map<string, EnvSet[]>();
  const maybeScopes: string[] = [];
  const addSet = (name: string, set: EnvSet) => {
    const v = entry(name);
    if (v.sets.some((s) => s.id === set.id)) return;
    v.sets.push(set);
    (setsByFile.get(set.file) ?? setsByFile.set(set.file, []).get(set.file)!).push(set);
  };
  const toSet = (source: EnvSourceKind, file: string, f: EnvSetFact, scope: string[]): EnvSet => ({
    id: `${source}:${file}:${f.target}:${f.name}`,
    source,
    file,
    line: f.line,
    target: f.target,
    ...(f.value !== undefined ? { value: f.value } : {}),
    ...(f.ref ? { ref: f.ref } : {}),
    ...(f.interpolated ? { interpolated: true as const } : {}),
    scope,
    ...(f.client ? { client: true as const } : {}),
  });
  for (const s of sources) {
    const dir = dirname(s.file);
    for (const f of s.facts.sets) {
      if (s.facts.source === "example") {
        entry(f.name).decls.push({ file: s.file, line: f.line, via: "example", ...(f.value ? { default: f.value } : {}), ...(f.description ? { description: f.description } : {}) });
        addSet(f.name, toSet("dotenv", s.file, f, [dir]));
        continue;
      }
      const scope = s.facts.source === "ci" ? [""] : s.facts.source === "compose" ? [s.facts.contexts?.[f.target] ?? dir] : [dir];
      addSet(f.name, toSet(s.facts.source, s.file, f, scope));
    }
    for (const [name, line, flags] of s.facts.reads ?? []) {
      const v = entry(name);
      if (v.reads.length >= MAX_READS) continue;
      v.reads.push({ file: s.file, line, host: true, ...(flags?.f !== undefined ? { fallback: flags.f } : {}), ...(flags?.r ? { required: true as const } : {}) });
    }
  }
  // Compose `env_file:` gives that file's values the service's build context too.
  for (const s of sources) {
    for (const ef of s.facts.envFiles ?? []) {
      const context = s.facts.contexts?.[ef.target];
      for (const set of setsByFile.get(ef.file) ?? []) if (context !== undefined && !set.scope.includes(context)) set.scope.push(context);
    }
  }

  // Sets from infrastructure: workload env and Dockerfile ENV.
  const deployFolders = new Map<string, string[]>();
  for (const d of input.infra.links.deploys) if (d.resolved) deployFolders.set(d.resource, [...(deployFolders.get(d.resource) ?? []), ...d.folders]);
  const infraScope = (r: InfraResource) => {
    const folders = deployFolders.get(r.id);
    return folders?.length ? [...new Set(folders)] : [""];
  };
  for (const r of input.infra.resources) {
    if (r.workload) {
      const source: EnvSourceKind = r.tool === "nomad" ? "nomad" : "kubernetes";
      const target = `${r.tool === "nomad" ? "nomad" : "k8s"}:${r.address}`;
      const scope = infraScope(r);
      for (const [name, raw] of Object.entries(r.workload.env)) {
        addSet(name, { id: `${source}:${r.file}:${target}:${name}`, source, file: r.file, line: r.line, target, ...infraValue(raw), scope });
        const v = entry(name);
        if (!v.infra.includes(r.id)) v.infra.push(r.id);
      }
      if (r.workload.maybeEnv.length) maybeScopes.push(...scope);
    } else if (r.tool === "docker" && r.category === "stage") {
      const target = `docker:${r.stack.replace(/^docker:/, "")}`;
      for (const a of r.attributes) {
        if (!a.name.startsWith("env.")) continue;
        const name = a.name.slice(4);
        addSet(name, { id: `docker:${r.file}:${target}:${name}`, source: "docker", file: r.file, line: r.line, target, value: a.value, scope: [dirname(r.file)] });
        const v = entry(name);
        if (!v.infra.includes(r.id)) v.infra.push(r.id);
      }
    }
  }

  // Tags.
  const groups = new Map<string, number>();
  for (const name of vars.keys()) groups.set(groupKey(name), (groups.get(groupKey(name)) ?? 0) + 1);
  const declScope = (d: EnvDecl) => (d.via === "example" ? dirname(d.file) : scopeOf(d.file, scopes));
  for (const v of vars.values()) {
    const tags = new Set<EnvTag>();
    const platform = isPlatformEnv(v.name);
    if (platform) tags.add("platform");
    const realSets = v.sets.filter((s) => s.target !== "example");
    const valued = realSets.filter((s) => !s.ref);
    const covers = (file: string, sets: EnvSet[]) => sets.some((s) => s.scope.some((root) => isUnder(file, root)));
    const maybe = (file: string) => maybeScopes.some((root) => isUnder(file, root)) || covers(file, realSets.filter((s) => s.ref));
    const declared = (file: string) => v.decls.some((d) => isUnder(file, declScope(d)));
    if (!platform) {
      for (const r of v.reads) {
        if (r.test || r.fallback !== undefined || covers(r.file, valued)) continue;
        r.gap = maybe(r.file) ? "maybe-set" : declared(r.file) ? "not-set" : "undeclared";
        tags.add(r.gap);
      }
      if (realSets.length && !v.reads.length && !v.decls.some((d) => d.via !== "example")) tags.add("set-not-read");
    }
    if (isSecretName(v.name) || v.sets.some((s) => s.value !== undefined && isSecretValue(s.value))) tags.add("secret");
    const prefix = [...prefixes].find((p) => v.name.startsWith(p));
    const clientSet = v.sets.find((s) => s.client);
    const clientDecl = v.decls.find((d) => d.client);
    v.clientVia = prefix ? `${prefix} prefix` : clientSet ? `${clientSet.target} ${clientSet.target === "next.config" ? "env" : "define"}` : clientDecl ? `${clientDecl.via} client` : undefined;
    if (!v.clientVia) delete v.clientVia;
    if (v.clientVia) tags.add("client");
    else if (!platform && v.reads.some((r) => r.client && !r.test)) tags.add("undefined-in-client");
    v.tags = [...tags];
    const g = groupKey(v.name);
    v.group = g && (groups.get(g) ?? 0) >= 2 ? `${g}*` : "";
    v.reads.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  // Columns: every target that sets something, examples first, then .env files, frameworks, Compose, CI, infra.
  const KIND_ORDER: Record<EnvTarget["kind"], number> = { example: 0, dotenv: 1, framework: 2, compose: 3, ci: 4, docker: 5, nomad: 6, kubernetes: 7 };
  const targets = new Map<string, EnvTarget>();
  for (const v of vars.values()) for (const s of v.sets) {
    const kind: EnvTarget["kind"] = s.target === "example" ? "example" : s.source;
    const t = targets.get(s.target) ?? targets.set(s.target, { id: s.target, kind, files: [] }).get(s.target)!;
    if (!t.files.includes(s.file)) t.files.push(s.file);
  }
  const DOTENV_ORDER = ["default", "development", "local", "test", "staging", "production"];
  const rank = (id: string) => {
    const i = DOTENV_ORDER.findIndex((d) => id === d || id.startsWith(`${d} `));
    return i === -1 ? DOTENV_ORDER.length : i;
  };
  const sortedTargets = [...targets.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.kind === "dotenv" ? rank(a.id) - rank(b.id) : 0) || a.id.localeCompare(b.id));

  const list = [...vars.values()].sort(
    (a, b) =>
      Number(a.tags.includes("platform")) - Number(b.tags.includes("platform")) ||
      (a.group || "￿").localeCompare(b.group || "￿") ||
      a.name.localeCompare(b.name)
  );
  return { vars: list, targets: sortedTargets, scopes, files: sources.length };
}
