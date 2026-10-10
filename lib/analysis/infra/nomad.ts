/**
 * Nomad jobspecs (DESIGN.md §6.12 §2): job → group → task, each a row. Type,
 * datacenters, count, driver and image/artifact, resources, network ports
 * (static/dynamic, `to`), `service` blocks (provider, port, tags, checks),
 * `env`, `template` (destination, `env = true`, and the Vault / Consul /
 * Nomad-variable paths it reads), `vault` policies, volumes, constraints,
 * `update` / `migrate`. Levant / nomad-pack `[[ ]]` marks the job
 * templated. HCL2 `variable`s are rows as in Terraform. One stack per file.
 */
import { hclString, hclStringList, type HclBlock, type HclBody } from "../syntax/hcl.mjs";
import { collapse, flattenHcl, literalCount } from "./common";
import type { ResolverFile, ResolverOutput } from "./terraform";
import type { InfraResource, InfraStack, InfraWorkload } from "./types";

const attr = (body: HclBody, name: string) => body.attrs.find((a) => a.name === name)?.expr.text;
const blocks = (body: HclBody, type: string) => body.blocks.filter((b) => b.type === type);

/** Keys a template sets when `env = true`: literal `KEY=…` lines. `undefined` when the keys are built (range loops). */
export function templateEnvKeys(data: string): string[] | undefined {
  const text = data.trim().startsWith('"')
    ? data.trim().slice(1, -1).replace(/\\n/g, "\n")
    : data.replace(/^<<-?\w+\n?/, "").replace(/\n?\s*\w+\s*$/, "");
  if (/\{\{-?\s*range\b/.test(text) && !/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(text)) return undefined;
  const keys: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  // A range inside the template can add keys we can't list.
  if (/\{\{-?\s*range\b/.test(text)) return undefined;
  return keys;
}

/** Vault / Consul / Nomad-variable paths a template reads. */
function secretPaths(data: string): string[] {
  const out = new Set<string>();
  for (const m of data.matchAll(/\b(secret|key|keyOrDefault|nomadVar|nomadVarList|ls|tree|service)\s+"([^"]+)"/g)) out.add(`${m[1] === "secret" ? "vault" : m[1].startsWith("nomadVar") ? "nomad var" : m[1] === "service" ? "consul service" : "consul kv"} ${m[2]}`);
  return [...out];
}

/** Traefik tags → routes: `traefik.http.routers.<r>.rule=Host(`a`) && PathPrefix(`/api`)`; fabio `urlprefix-/api`. */
export function traefikRoutes(tags: string[], via: string): InfraWorkload["routes"] {
  const routes: InfraWorkload["routes"] = [];
  const middlewaresByRouter = new Map<string, string[]>();
  const authMiddlewares = new Set<string>();
  for (const tag of tags) {
    const mw = /^traefik\.http\.routers\.([^.]+)\.middlewares=(.+)$/.exec(tag);
    if (mw) middlewaresByRouter.set(mw[1], mw[2].split(",").map((s) => s.trim()));
    const def = /^traefik\.http\.middlewares\.([^.]+)\.(forwardauth|basicauth|digestauth)\b/i.exec(tag);
    if (def) authMiddlewares.add(def[1]);
  }
  for (const tag of tags) {
    const rule = /^traefik\.http\.routers\.([^.]+)\.rule=(.+)$/.exec(tag);
    if (rule) {
      const host = /Host\(\s*`([^`]+)`/.exec(rule[2])?.[1];
      const path = /Path(?:Prefix)?\(\s*`([^`]+)`/.exec(rule[2])?.[1] ?? "/";
      const mws = middlewaresByRouter.get(rule[1]) ?? [];
      const auth = mws.filter((m) => authMiddlewares.has(m.replace(/@.*$/, "")) || /auth/i.test(m));
      routes.push({ ...(host ? { host } : {}), path, via: `${via} (Traefik router ${rule[1]})`, ...(auth.length ? { auth: auth.map((a) => `traefik ${a}`) } : {}) });
      continue;
    }
    const fabio = /^urlprefix-([^ ]*?)(\/[^ ]*)?(?:\s|$)/.exec(tag);
    if (fabio) routes.push({ ...(fabio[1] ? { host: fabio[1] } : {}), path: fabio[2] ?? "/", via: `${via} (fabio)` });
  }
  return routes;
}

export function resolveNomad(files: ResolverFile[]): ResolverOutput {
  const stacks: InfraStack[] = [];
  const resources: InfraResource[] = [];
  for (const { file, facts } of files) {
    if (facts.kind !== "nomad") continue;
    const templated = Boolean(facts.templated);
    const stackId = `nomad:${file}`;
    const stack: InfraStack = { id: stackId, tool: "nomad", path: file, name: file, kind: "job file", environments: [] };
    stacks.push(stack);
    const t = templated ? { templated: true as const } : {};

    for (const v of blocks(facts.body, "variable")) {
      if (!v.labels[0]) continue;
      resources.push({
        id: `${stackId}:var.${v.labels[0]}`,
        tool: "nomad",
        stack: stackId,
        group: "(variables)",
        kind: "variable",
        category: "variable",
        address: `var.${v.labels[0]}`,
        name: v.labels[0],
        file,
        line: v.line,
        endLine: v.endLine,
        attributes: flattenHcl(v.body),
        refs: [],
        ...t,
      });
    }

    for (const job of blocks(facts.body, "job")) {
      const jobName = job.labels[0] ?? "job";
      const jobId = `${stackId}:${jobName}`;
      const varRefs = (b: HclBody) => {
        const refs: string[] = [];
        const visit = (x: HclBody) => {
          for (const a of x.attrs) for (const r of a.expr.refs) if (r.startsWith("var.")) refs.push(`${stackId}:${r.split(".").slice(0, 2).join(".")}`);
          for (const inner of x.blocks) visit(inner.body);
        };
        visit(b);
        return refs;
      };
      resources.push({
        id: jobId,
        tool: "nomad",
        stack: stackId,
        group: `job ${jobName}`,
        kind: "job",
        category: "job",
        address: jobName,
        name: jobName,
        file,
        line: job.line,
        endLine: job.endLine,
        attributes: flattenHcl(job.body, new Set(["group"])),
        refs: varRefs({ attrs: job.body.attrs, blocks: job.body.blocks.filter((b) => b.type !== "group") }),
        ...t,
      });
      const jobServices = blocks(job.body, "service");

      for (const group of blocks(job.body, "group")) {
        const groupName = group.labels[0] ?? "group";
        const groupId = `${jobId}/${groupName}`;
        const countText = attr(group.body, "count");
        const volumes = blocks(group.body, "volume");
        resources.push({
          id: groupId,
          tool: "nomad",
          stack: stackId,
          group: `job ${jobName}`,
          kind: "group",
          category: "group",
          address: `${jobName}/${groupName}`,
          name: groupName,
          file,
          line: group.line,
          endLine: group.endLine,
          attributes: flattenHcl(group.body, new Set(["task"])),
          ...(countText ? { count: literalCount(countText) ?? "?" } : {}),
          ...(volumes.length ? { stateful: true as const } : {}),
          refs: [jobId, ...varRefs({ attrs: group.body.attrs, blocks: group.body.blocks.filter((b) => b.type !== "task") })],
          ...t,
        });
        // Group-level network ports and services apply to its tasks.
        const groupPorts = portsOf(group.body);
        const groupServices = [...jobServices, ...blocks(group.body, "service")];

        for (const task of blocks(group.body, "task")) {
          const taskName = task.labels[0] ?? "task";
          const config = blocks(task.body, "config")[0]?.body;
          const image = config ? attr(config, "image") : undefined;
          const env: Record<string, string> = {};
          for (const e of blocks(task.body, "env")) for (const a of e.body.attrs) env[a.name] = collapse(hclString(a.expr.text) ?? a.expr.text, 80);
          const maybeEnv: string[] = [];
          const secrets = new Set<string>();
          for (const tpl of blocks(task.body, "template")) {
            const data = attr(tpl.body, "data") ?? "";
            for (const p of secretPaths(data)) secrets.add(p);
            if (!/^true$/.test(attr(tpl.body, "env")?.trim() ?? "")) continue;
            const keys = data ? templateEnvKeys(data) : undefined;
            const dest = hclString(attr(tpl.body, "destination") ?? "") ?? "template";
            if (!keys) maybeEnv.push(`template ${dest}${attr(tpl.body, "source") ? " (from a file)" : " (keys not literal)"}`);
            else for (const k of keys) env[k] ??= `template ${dest}`;
          }
          const artifacts = blocks(task.body, "artifact")
            .map((a) => hclString(attr(a.body, "source") ?? "") ?? collapse(attr(a.body, "source") ?? ""))
            .filter(Boolean);
          const taskServices = blocks(task.body, "service");
          const routes: InfraWorkload["routes"] = [];
          for (const svc of [...groupServices, ...taskServices]) {
            const tags = hclStringList(attr(svc.body, "tags") ?? "[]") ?? [];
            const name = hclString(attr(svc.body, "name") ?? "") ?? taskName;
            routes.push(...traefikRoutes(tags, `service ${name}`));
          }
          const declaredPorts = [...groupPorts, ...portsOf(task.body)];
          const workload: InfraWorkload = {
            images: image ? [hclString(image) ?? collapse(image)] : [],
            env,
            maybeEnv,
            ports: declaredPorts,
            routes,
            ...(artifacts.length ? { artifacts } : {}),
            ...(secrets.size ? { secrets: [...secrets] } : {}),
          };
          const imageText = image ? hclString(image) ?? collapse(image) : undefined;
          resources.push({
            id: `${groupId}/${taskName}`,
            tool: "nomad",
            stack: stackId,
            group: `job ${jobName}`,
            kind: `task (${hclString(attr(task.body, "driver") ?? "") ?? "?"})`,
            category: "task",
            address: `${jobName}/${groupName}/${taskName}`,
            name: taskName,
            file,
            line: task.line,
            endLine: task.endLine,
            attributes: flattenHcl(task.body),
            ...(imageText ? { source: imageText } : {}),
            refs: [groupId, ...varRefs(task.body)],
            workload,
            ...t,
          });
        }
      }
    }
  }
  return { stacks, resources, moves: [] };
}

/** `network { port "http" { static = 8080  to = 3000 } }` and docker `config { ports = [...] }`. */
function portsOf(body: HclBody): InfraWorkload["ports"] {
  const out: InfraWorkload["ports"] = [];
  const visit = (b: HclBlock) => {
    for (const p of blocks(b.body, "port")) {
      const staticPort = Number(literalCount(attr(p.body, "static") ?? "") ?? NaN);
      const to = Number(literalCount(attr(p.body, "to") ?? "") ?? NaN);
      out.push({ ...(p.labels[0] ? { name: p.labels[0] } : {}), ...(Number.isFinite(staticPort) ? { port: staticPort } : {}), ...(Number.isFinite(to) ? { to } : {}) });
    }
  };
  for (const n of blocks(body, "network")) visit(n);
  for (const r of blocks(body, "resources")) for (const n of blocks(r.body, "network")) visit(n);
  return out;
}
