/**
 * Terraform / OpenTofu (DESIGN.md §6.12 §2). A **stack** is a folder of
 * `.tf` files that no other folder calls as a module; local modules are
 * followed with their inputs, so a stack's resources carry module paths
 * (`module.db.aws_db_instance.main`). Registry and git modules are external
 * rows with their version constraint; `.terraform.lock.hcl` gives provider
 * versions. Variables with their defaults and values per environment (an
 * environment = a tfvars file), locals, outputs, data sources, providers,
 * the backend, `moved` / `removed` / `import` blocks and lifecycle flags.
 * Nothing is evaluated: `count` / `for_each` show as ×N or ×?.
 */
import { hclString, hclStringList, type HclBlock, type HclBody } from "../syntax/hcl.mjs";
import { basename, collapse, countOf, dirname, flattenHcl, isConditional, isStatefulTerraform } from "./common";
import { normalizePath, type InfraFileFacts } from "./read";
import type { InfraAttr, InfraMoveBlock, InfraResource, InfraStack } from "./types";

export interface ResolverFile {
  file: string;
  facts: InfraFileFacts;
}

export interface ResolverOutput {
  stacks: InfraStack[];
  resources: InfraResource[];
  moves: InfraMoveBlock[];
}

interface TfDir {
  dir: string;
  files: Array<{ file: string; body: HclBody; templated?: boolean }>;
  tfvars: Array<{ file: string; body: HclBody }>;
  lock: Array<{ source: string; version: string }>;
}

/** Meta-arguments shown on their own, not as attributes. */
const META = new Set(["count", "for_each", "depends_on", "lifecycle", "provider", "provisioner", "connection"]);
/** Module calls: `source` and `version` are shown as the row's source and version. */
const MODULE_META = new Set([...META, "source", "version", "providers"]);
const MAX_MODULE_DEPTH = 6;

const isLocalSource = (s: string) => s.startsWith("./") || s.startsWith("../") || s === "." || s === "..";

/** `prod.tfvars` → `prod`, `envs/staging.auto.tfvars.json` → `staging`. */
export function environmentOf(file: string): string {
  const name = basename(file);
  // The auto-loaded file is "the" values, not an environment's name.
  if (name === "terraform.tfvars" || name === "terraform.tfvars.json") return name;
  return name.replace(/\.json$/, "").replace(/\.tfvars$/, "").replace(/\.auto$/, "") || name;
}

function attrText(body: HclBody, name: string): string | undefined {
  return body.attrs.find((a) => a.name === name)?.expr.text;
}

/** A git source's `?ref=v1.2.0`. */
function refOf(source: string): string | undefined {
  return /[?&]ref=([^&]+)/.exec(source)?.[1];
}

export function resolveTerraform(files: ResolverFile[]): ResolverOutput {
  const dirs = new Map<string, TfDir>();
  const dirOf = (dir: string) => {
    let d = dirs.get(dir);
    if (!d) dirs.set(dir, (d = { dir, files: [], tfvars: [], lock: [] }));
    return d;
  };
  for (const { file, facts } of files) {
    if (facts.kind === "terraform") dirOf(dirname(file)).files.push({ file, body: facts.body, ...(facts.templated ? { templated: true } : {}) });
  }
  const tfDirs = new Set(dirs.keys());
  // tfvars and lock files attach to their folder, or the nearest one above with .tf files.
  const owningDir = (file: string) => {
    let dir = dirname(file);
    for (;;) {
      if (tfDirs.has(dir)) return dir;
      if (dir === "") return undefined;
      dir = dirname(dir);
    }
  };
  for (const { file, facts } of files) {
    if (facts.kind !== "tfvars" && facts.kind !== "tflock") continue;
    const dir = owningDir(file);
    if (dir === undefined) continue;
    if (facts.kind === "tfvars") dirOf(dir).tfvars.push({ file, body: facts.body });
    else dirOf(dir).lock.push(...facts.providers);
  }

  // Which folders are called as local modules: they aren't stacks of their own.
  const called = new Set<string>();
  for (const d of dirs.values()) {
    for (const f of d.files) {
      for (const b of f.body.blocks) {
        if (b.type !== "module") continue;
        const source = hclString(attrText(b.body, "source") ?? "");
        if (source && isLocalSource(source)) {
          const target = normalizePath(d.dir ? `${d.dir}/${source}` : source);
          if (target !== d.dir && tfDirs.has(target)) called.add(target);
        }
      }
    }
  }
  let roots = [...tfDirs].filter((d) => !called.has(d));
  if (roots.length === 0) roots = [...tfDirs]; // every folder calls another: show them all
  roots.sort();

  const stacks: InfraStack[] = [];
  const resources: InfraResource[] = [];
  const moves: InfraMoveBlock[] = [];

  for (const root of roots) {
    const d = dirs.get(root)!;
    const stackId = `terraform:${root}`;
    const environments = [...new Set(d.tfvars.map((t) => environmentOf(t.file)))].sort();
    const stack: InfraStack = { id: stackId, tool: "terraform", path: root, name: root || "(root)", kind: "root module", environments };
    stacks.push(stack);
    const out: InfraResource[] = [];
    expand(stack, d, "", "(root)", 0, new Set([root]));
    resources.push(...out);

    // Values per environment: variables, and root attributes that are exactly `var.x`.
    const envVars = new Map<string, Map<string, string>>();
    for (const t of d.tfvars) {
      const env = environmentOf(t.file);
      const map = envVars.get(env) ?? new Map<string, string>();
      for (const a of t.body.attrs) map.set(a.name, collapse(a.expr.text));
      envVars.set(env, map);
    }
    if (envVars.size > 0) {
      for (const r of out) {
        const perEnv: Record<string, InfraAttr[]> = {};
        for (const [env, values] of envVars) {
          const list: InfraAttr[] = [];
          if (r.category === "variable") {
            const v = values.get(r.name);
            const def = r.attributes.find((a) => a.name === "default")?.value;
            if (v !== undefined && v !== def) list.push({ name: "value", value: v });
          } else if (!r.address.startsWith("module.") || r.category === "module") {
            for (const a of r.attributes) {
              const m = /^var\.([A-Za-z_][\w-]*)$/.exec(a.value);
              if (m && values.has(m[1])) list.push({ name: a.name, value: values.get(m[1])! });
            }
          }
          if (list.length) perEnv[env] = list;
        }
        if (Object.keys(perEnv).length) r.envValues = perEnv;
      }
    }

    function expand(st: InfraStack, dir: TfDir, prefix: string, group: string, depth: number, visiting: Set<string>, parentModuleId?: string): void {
      const id = (address: string) => `${stackId}:${address}`;
      const isRoot = prefix === "";
      /** A traversal in this module → the id it points at. */
      const refId = (t: string): string | undefined => {
        const parts = t.replace(/\[[^\]]*\]/g, "").split(".");
        switch (parts[0]) {
          case "var":
            return isRoot ? id(`var.${parts[1]}`) : parentModuleId;
          case "local":
            return isRoot ? id(`local.${parts[1]}`) : undefined;
          case "module":
            return parts[1] ? id(`${prefix}module.${parts[1]}`) : undefined;
          case "data":
            return parts[2] ? id(`${prefix}data.${parts[1]}.${parts[2]}`) : undefined;
          case "each":
          case "count":
          case "self":
          case "path":
          case "terraform":
            return undefined;
          default:
            return parts[1] ? id(`${prefix}${parts[0]}.${parts[1]}`) : undefined;
        }
      };
      const refsOf = (body: HclBody): string[] => {
        const out: string[] = [];
        const visit = (b: HclBody) => {
          for (const a of b.attrs) {
            for (const t of a.expr.refs) {
              const r = refId(t);
              if (r) out.push(r);
            }
            if (a.name === "depends_on") for (const m of a.expr.text.matchAll(/[A-Za-z_][\w.-]*/g)) {
              const r = refId(m[0]);
              if (r) out.push(r);
            }
          }
          for (const inner of b.blocks) visit(inner.body);
        };
        visit(body);
        return out;
      };
      const base = (file: string, b: HclBlock, templated?: boolean) => ({
        tool: "terraform" as const,
        stack: st.id,
        group,
        file,
        line: b.line,
        endLine: b.endLine,
        ...(templated ? { templated: true as const } : {}),
      });

      for (const f of dir.files) {
        for (const b of f.body.blocks) {
          switch (b.type) {
            case "resource":
            case "data": {
              const [type, name] = b.labels;
              if (!type || !name) break;
              const address = `${prefix}${b.type === "data" ? "data." : ""}${type}.${name}`;
              const countText = attrText(b.body, "count");
              const forEachText = attrText(b.body, "for_each");
              const lifecycle = b.body.blocks.find((x) => x.type === "lifecycle")?.body;
              const preventDestroy = lifecycle && /^true$/.test(attrText(lifecycle, "prevent_destroy")?.trim() ?? "");
              const cbd = lifecycle && /^true$/.test(attrText(lifecycle, "create_before_destroy")?.trim() ?? "");
              const ignore = lifecycle ? attrText(lifecycle, "ignore_changes") : undefined;
              const attributes = flattenHcl(b.body, META);
              const depends = attrText(b.body, "depends_on");
              if (depends) attributes.push({ name: "depends_on", value: collapse(depends) });
              out.push({
                ...base(f.file, b, f.templated),
                id: id(address),
                kind: type,
                category: b.type === "data" ? "data" : "resource",
                address,
                name,
                attributes,
                ...(countText !== undefined ? { count: countOf(countText, false) } : forEachText !== undefined ? { count: countOf(forEachText, true) } : {}),
                ...((countText && isConditional(countText)) || (forEachText && isConditional(forEachText)) ? { conditional: true as const } : {}),
                ...(b.type === "resource" && isStatefulTerraform(type) ? { stateful: true as const } : {}),
                ...(preventDestroy || cbd || ignore
                  ? {
                      lifecycle: {
                        ...(preventDestroy ? { preventDestroy: true as const } : {}),
                        ...(cbd ? { createBeforeDestroy: true as const } : {}),
                        ...(ignore ? { ignoreChanges: (hclStringList(ignore) ?? ignore.replace(/[[\]\s]/g, "").split(",")).filter(Boolean) } : {}),
                      },
                    }
                  : {}),
                refs: refsOf(b.body),
              });
              break;
            }
            case "module": {
              const name = b.labels[0];
              if (!name) break;
              const address = `${prefix}module.${name}`;
              const source = hclString(attrText(b.body, "source") ?? "") ?? collapse(attrText(b.body, "source") ?? "?");
              const versionText = attrText(b.body, "version");
              const version = (versionText ? hclString(versionText) ?? collapse(versionText) : undefined) ?? refOf(source);
              const local = isLocalSource(source);
              const target = local ? normalizePath(dir.dir ? `${dir.dir}/${source}` : source) : undefined;
              const countText = attrText(b.body, "count");
              const forEachText = attrText(b.body, "for_each");
              const moduleId = id(address);
              out.push({
                ...base(f.file, b, f.templated),
                id: moduleId,
                kind: "module",
                category: "module",
                address,
                name,
                attributes: flattenHcl(b.body, MODULE_META),
                source,
                ...(version ? { version } : {}),
                ...(local ? {} : { external: true as const }),
                ...(countText !== undefined ? { count: countOf(countText, false) } : forEachText !== undefined ? { count: countOf(forEachText, true) } : {}),
                ...((countText && isConditional(countText)) || (forEachText && isConditional(forEachText)) ? { conditional: true as const } : {}),
                refs: refsOf(b.body),
              });
              if (target !== undefined && dirs.has(target) && depth < MAX_MODULE_DEPTH && !visiting.has(target)) {
                const next = new Set(visiting).add(target);
                expand(st, dirs.get(target)!, `${address}.`, address, depth + 1, next, moduleId);
              }
              break;
            }
            case "variable": {
              if (!isRoot || !b.labels[0]) break;
              out.push({
                ...base(f.file, b, f.templated),
                id: id(`var.${b.labels[0]}`),
                kind: "variable",
                category: "variable",
                address: `var.${b.labels[0]}`,
                name: b.labels[0],
                attributes: flattenHcl(b.body),
                refs: [],
              });
              break;
            }
            case "output": {
              if (!isRoot || !b.labels[0]) break;
              out.push({
                ...base(f.file, b, f.templated),
                id: id(`output.${b.labels[0]}`),
                kind: "output",
                category: "output",
                address: `output.${b.labels[0]}`,
                name: b.labels[0],
                attributes: flattenHcl(b.body),
                refs: refsOf(b.body),
              });
              break;
            }
            case "locals": {
              if (!isRoot) break;
              for (const a of b.body.attrs) {
                out.push({
                  ...base(f.file, b, f.templated),
                  line: a.line,
                  endLine: a.endLine,
                  id: id(`local.${a.name}`),
                  kind: "local",
                  category: "local",
                  address: `local.${a.name}`,
                  name: a.name,
                  attributes: [{ name: "value", value: collapse(a.expr.text) }],
                  refs: a.expr.refs.map(refId).filter((r): r is string => Boolean(r)),
                });
              }
              break;
            }
            case "provider": {
              if (!isRoot || !b.labels[0]) break;
              const alias = hclString(attrText(b.body, "alias") ?? "");
              const address = `provider.${b.labels[0]}${alias ? `.${alias}` : ""}`;
              const existing = out.find((r) => r.id === id(address));
              if (existing) {
                existing.attributes.push(...flattenHcl(b.body));
                existing.line = b.line;
                existing.file = f.file;
                break;
              }
              out.push({
                ...base(f.file, b, f.templated),
                id: id(address),
                kind: "provider",
                category: "provider",
                address,
                name: b.labels[0],
                attributes: flattenHcl(b.body),
                refs: refsOf(b.body),
              });
              break;
            }
            case "terraform": {
              if (!isRoot) break;
              const backend = b.body.blocks.find((x) => x.type === "backend" || x.type === "cloud");
              if (backend) st.backend = backend.type === "cloud" ? "cloud" : backend.labels[0];
              const required = b.body.blocks.find((x) => x.type === "required_providers");
              for (const a of required?.body.attrs ?? []) {
                const sourceM = /source\s*=\s*"([^"]+)"/.exec(a.expr.text);
                const versionM = /version\s*=\s*"([^"]+)"/.exec(a.expr.text);
                const plain = hclString(a.expr.text); // old form: `aws = "~> 4.0"`
                const providerSource = sourceM?.[1] ?? `hashicorp/${a.name}`;
                const locked = dir.lock.find((l) => l.source === providerSource || l.source.endsWith(`/${providerSource}`));
                const address = `provider.${a.name}`;
                const row: InfraResource = {
                  ...base(f.file, b),
                  line: a.line,
                  endLine: a.endLine,
                  id: id(address),
                  kind: "provider",
                  category: "provider",
                  address,
                  name: a.name,
                  attributes: [
                    { name: "source", value: providerSource },
                    ...(versionM?.[1] ?? plain ? [{ name: "constraint", value: versionM?.[1] ?? plain! }] : []),
                  ],
                  source: providerSource,
                  ...(locked ? { version: locked.version } : versionM?.[1] ?? plain ? { version: versionM?.[1] ?? plain } : {}),
                  refs: [],
                };
                const existing = out.find((r) => r.id === row.id);
                if (existing) {
                  existing.attributes.unshift(...row.attributes);
                  existing.source = row.source;
                  if (row.version) existing.version = row.version;
                } else out.push(row);
              }
              break;
            }
            case "moved":
            case "removed":
            case "import": {
              const from = attrText(b.body, b.type === "import" ? "id" : "from");
              const to = attrText(b.body, "to");
              const lifecycle = b.body.blocks.find((x) => x.type === "lifecycle")?.body;
              const destroy = lifecycle ? !/^false$/.test(attrText(lifecycle, "destroy")?.trim() ?? "") : true;
              moves.push({
                kind: b.type,
                stack: st.id,
                ...(from && b.type !== "import" ? { from: `${prefix}${from.trim()}` } : {}),
                ...(to ? { to: `${prefix}${to.trim()}` } : {}),
                ...(b.type === "removed" ? { destroy } : {}),
                file: f.file,
                line: b.line,
              });
              break;
            }
          }
        }
      }
    }
  }
  return { stacks, resources, moves };
}
