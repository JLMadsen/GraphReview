/**
 * Links from infrastructure to the app's own code (DESIGN.md §6.12 §3).
 * Each link says how it was made; an unresolved one says so instead of
 * being dropped.
 *
 * - Deploys: a workload's image → the Dockerfile that builds it (an image
 *   name CI builds with `docker build -t`, else a matching folder or file
 *   name), or a Nomad `artifact` path in the repo → the folders its build
 *   context copies in → the code that ships.
 * - Env vars: names a workload sets (its env, `envFrom` a known ConfigMap,
 *   its image's Dockerfile ENV, `.env.example` in the build context) against
 *   names the code it deploys reads. "Maybe" sources (`envFrom` a Secret, a
 *   template with built keys, a templated chart) silence "read but not set".
 * - Routes: Traefik tags, Ingress / HTTPRoute host + path → API endpoints
 *   under that prefix, with any auth in front of them.
 * - Ports: the workload's target port against the code's literal listen port.
 */
import type { ApiCatalog } from "../api/types";
import type { CodeFacts } from "./code-facts";
import { basename, dirname } from "./common";
import type { DockerImageBuild } from "./docker";
import { splitImage, type CiBuild } from "./read";
import type { InfraDeployLink, InfraEnvLink, InfraLinks, InfraPortLink, InfraResource, InfraRouteLink } from "./types";

export interface LinkInput {
  resources: InfraResource[];
  builds: DockerImageBuild[];
  ciBuilds: CiBuild[];
  /** `.env.example` and friends: path → names. */
  envFiles: Array<{ file: string; names: string[] }>;
  code: Array<{ file: string; facts: CodeFacts }>;
  api: ApiCatalog;
  allFiles: ReadonlySet<string>;
}

/** Names the platform provides at runtime — never "not set". */
const RUNTIME_ENV = /^(NODE_ENV|HOME|PATH|PWD|HOSTNAME|HOST|USER|SHELL|TMPDIR|TEMP|TMP|CI|TZ|LANG|LC_ALL|TERM|DEBUG|NOMAD_[A-Z0-9_]+|KUBERNETES_[A-Z0-9_]+|npm_[A-Za-z0-9_]+|VERCEL[A-Z0-9_]*|NEXT_RUNTIME|NEXT_PHASE|JAVA_HOME|PYTHONPATH|GOPATH)$/;

export const isUnder = (file: string, folder: string) => folder === "" || file === folder || file.startsWith(`${folder}/`);

/** `ghcr.io/acme/api:1.2` → `acme/api` and `api`; variables and templates stripped. `undefined` when nothing literal is left. */
export function imageKey(image: string): { full: string; last: string } | undefined {
  const cleaned = image
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/\$\{[^}]*\}/g, "")
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "")
    .replace(/^\/+/, "");
  const { image: name } = splitImage(cleaned);
  const parts = name.split("/").filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === "localhost")) parts.shift();
  const last = parts[parts.length - 1].replace(/[^A-Za-z0-9_.-]/g, "");
  if (!last) return undefined;
  return { full: parts.join("/").toLowerCase(), last: last.toLowerCase() };
}

function deployLink(r: InfraResource, input: LinkInput): InfraDeployLink[] {
  const w = r.workload!;
  const out: InfraDeployLink[] = [];
  for (const art of w.artifacts ?? []) {
    if (/^[a-z]+(::|:\/\/)/.test(art)) continue;
    const path = art.replace(/^\.\//, "").replace(/\/+$/, "");
    const exists = [...input.allFiles].some((f) => isUnder(f, path));
    if (exists) out.push({ resource: r.id, via: `Nomad artifact ${art}`, resolved: true, folders: [path] });
  }
  for (const image of w.images) {
    const key = imageKey(image);
    if (!key) {
      out.push({ resource: r.id, image, via: "image name isn't literal (a variable or template)", resolved: false, folders: [] });
      continue;
    }
    // 1. CI builds it with `docker build -t <name>`.
    const byCi = input.builds.filter((b) => b.tags.some((t) => {
      const k = imageKey(t);
      return k && (k.full === key.full || k.last === key.last);
    }));
    // 2. A Dockerfile whose folder or file name is the image's name.
    const byName = input.builds.filter((b) => {
      const name = basename(b.dockerfile).toLowerCase();
      const folder = basename(dirname(b.dockerfile)).toLowerCase();
      return folder === key.last || name === `${key.last}.dockerfile` || name === `dockerfile.${key.last}`;
    });
    const pick = byCi.length === 1 ? { build: byCi[0], via: `CI builds ${image.replace(/:.*$/, "")} from ${byCi[0].dockerfile}` } : byCi.length === 0 && byName.length === 1 ? { build: byName[0], via: `name ${key.last} matches ${byName[0].dockerfile}` } : undefined;
    if (pick) {
      out.push({ resource: r.id, image, dockerfile: pick.build.dockerfile, via: pick.via, resolved: true, folders: pick.build.folders.length ? pick.build.folders : [pick.build.context] });
    } else {
      const several = byCi.length > 1 ? byCi : byName.length > 1 ? byName : [];
      out.push({
        resource: r.id,
        image,
        via: several.length ? `several Dockerfiles could build it (${several.map((b) => b.dockerfile).join(", ")})` : "no Dockerfile in the repo is known to build it",
        resolved: false,
        folders: [],
      });
    }
  }
  return out;
}

export function linkInfra(input: LinkInput): { links: InfraLinks; envUnset: Array<{ name: string; file: string; line: number }> } {
  const workloads = input.resources.filter((r) => r.workload);
  const deploys = workloads.flatMap((r) => deployLink(r, input));
  const buildByFile = new Map(input.builds.map((b) => [b.dockerfile, b]));
  const deployedBy = new Map<string, InfraDeployLink[]>();
  for (const d of deploys) if (d.resolved) (deployedBy.get(d.resource) ?? deployedBy.set(d.resource, []).get(d.resource)!).push(d);

  const codeUnder = (folders: string[]) => input.code.filter((c) => folders.some((f) => isUnder(c.file, f)));

  const env: InfraEnvLink[] = [];
  const ports: InfraPortLink[] = [];
  const setBy = new Map<string, { set: Set<string>; maybe: boolean }>();
  for (const r of workloads) {
    const links = deployedBy.get(r.id);
    if (!links?.length) continue;
    const folders = [...new Set(links.flatMap((l) => l.folders))];
    const set = new Set(Object.keys(r.workload!.env));
    for (const l of links) {
      const build = l.dockerfile ? buildByFile.get(l.dockerfile) : undefined;
      for (const name of build?.env ?? []) set.add(name);
      const roots = build ? [build.context] : folders;
      for (const f of input.envFiles) if (roots.some((root) => isUnder(f.file, root)) && basename(f.file) !== ".env") for (const n of f.names) set.add(n);
    }
    const maybe = r.workload!.maybeEnv;
    setBy.set(r.id, { set, maybe: maybe.length > 0 });
    const code = codeUnder(folders);
    const read = new Map<string, { file: string; line: number }>();
    for (const c of code) for (const [name, line] of c.facts.env ?? []) if (!read.has(name)) read.set(name, { file: c.file, line });
    const readNotSet = maybe.length ? [] : [...read].filter(([name]) => !set.has(name) && !RUNTIME_ENV.test(name)).map(([name, at]) => ({ name, ...at }));
    const setNotRead = Object.keys(r.workload!.env).filter((n) => !read.has(n) && !RUNTIME_ENV.test(n) && n !== "PORT");
    if (set.size || read.size || maybe.length) env.push({ resource: r.id, set: [...set].sort(), maybe, readNotSet, setNotRead });

    // Ports: what the workload sends traffic to vs. what the code listens on.
    const targets = r.workload!.ports.map((p) => p.to ?? p.port).filter((p): p is number => typeof p === "number");
    if (targets.length) {
      const envPort = r.workload!.env.PORT && /^\d+$/.test(r.workload!.env.PORT) && read.has("PORT") ? Number(r.workload!.env.PORT) : undefined;
      const literal = code.flatMap((c) => (c.facts.ports ?? []).map(([port, line]) => ({ port, file: c.file, line })));
      const listen = envPort !== undefined ? { port: envPort, file: read.get("PORT")!.file, line: read.get("PORT")!.line } : literal[0];
      if (listen) {
        const match = targets.includes(listen.port) || literal.some((l) => targets.includes(l.port));
        ports.push({ resource: r.id, declared: match ? listen.port : targets[0], listen: listen.port, file: listen.file, line: listen.line, match });
      }
    }
  }

  // Routes → endpoints under the prefix (served by the workload's own code when its deploy link is resolved).
  const routes: InfraRouteLink[] = [];
  const http = input.api.endpoints.filter((e) => e.kind === "http");
  for (const r of workloads) {
    const folders = (deployedBy.get(r.id) ?? []).flatMap((l) => l.folders);
    for (const route of r.workload!.routes) {
      const prefix = route.path.replace(/\/+$/, "").replace(/\(.*$/, "");
      const endpoints = http
        .filter((e) => (prefix === "" ? true : e.path === prefix || e.path.startsWith(`${prefix}/`)))
        .filter((e) => (folders.length ? Boolean(e.handler && folders.some((f) => isUnder(e.handler!.file, f))) : prefix !== ""))
        .map((e) => e.id);
      routes.push({ resource: r.id, ...(route.host ? { host: route.host } : {}), path: route.path, via: route.via, endpoints, ...(route.auth?.length ? { auth: route.auth } : {}) });
    }
  }

  // Env reads nothing sets, per file — for the App map's explainer.
  const globalSet = new Set<string>();
  let anySource = false;
  for (const r of workloads) for (const n of Object.keys(r.workload!.env)) {
    globalSet.add(n);
    anySource = true;
  }
  for (const b of input.builds) for (const n of b.env) globalSet.add(n);
  for (const f of input.envFiles) {
    anySource = true;
    for (const n of f.names) globalSet.add(n);
  }
  const anyMaybe = workloads.some((r) => r.workload!.maybeEnv.length > 0);
  const envUnset: Array<{ name: string; file: string; line: number }> = [];
  if (anySource) {
    const deployers = (file: string) => [...deployedBy].filter(([, links]) => links.some((l) => l.folders.some((f) => isUnder(file, f)))).map(([id]) => id);
    for (const c of input.code) {
      if (!c.facts.env?.length) continue;
      const by = deployers(c.file);
      for (const [name, line] of c.facts.env) {
        if (RUNTIME_ENV.test(name)) continue;
        const unset = by.length
          ? by.every((id) => {
              const s = setBy.get(id);
              return s ? !s.maybe && !s.set.has(name) : true;
            })
          : !anyMaybe && !globalSet.has(name);
        if (unset && !envUnset.some((u) => u.name === name && u.file === c.file)) envUnset.push({ name, file: c.file, line });
        if (envUnset.length >= 500) break;
      }
    }
  }
  return { links: { deploys, env, routes, ports }, envUnset };
}
