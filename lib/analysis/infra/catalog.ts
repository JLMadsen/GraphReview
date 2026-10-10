/**
 * The infra catalog of one analysed tree (DESIGN.md §6.12): every tool's
 * resolver over the files' facts, then the links to code. Runs at the end
 * of `analyzeTree`, beside the endpoint catalog, so every analysed commit
 * has one.
 *
 * Static only — no `terraform init/plan`, no providers, no state, no module
 * or chart downloads, no `helm template`. A resolver that throws costs only
 * its own resources, never the analysis.
 */
import type { ApiCatalog } from "../api/types";
import type { CodeFacts } from "./code-facts";
import { pruneRefs } from "./common";
import { resolveDocker, type DockerImageBuild } from "./docker";
import { resolveKubernetes } from "./kubernetes";
import { linkInfra } from "./link";
import { resolveNomad } from "./nomad";
import { resolveCiBuilds, type InfraFileFacts, type CiBuild } from "./read";
import { resolveTerraform, type ResolverFile, type ResolverOutput } from "./terraform";
import { EMPTY_INFRA_CATALOG, type InfraCatalog, type InfraCategory, type InfraTool } from "./types";

export interface BuildInfraCatalogInput {
  /** Every infra-ish file read, with what it says. */
  infraFiles: ReadonlyArray<{ file: string; facts: InfraFileFacts }>;
  /** Env reads and listen ports of the code (and Spring config) files. */
  code: ReadonlyArray<{ file: string; facts: CodeFacts }>;
  api: ApiCatalog;
  allFiles: ReadonlySet<string>;
}

const EMPTY: ResolverOutput = { stacks: [], resources: [], moves: [] };

function run<T>(name: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    console.warn(`[infra] ${name} failed: ${(error as Error).message}`);
    return fallback;
  }
}

const TOOL_ORDER: Record<InfraTool, number> = { terraform: 0, nomad: 1, kubernetes: 2, helm: 3, docker: 4 };
const CATEGORY_ORDER: Record<InfraCategory, number> = {
  job: 0, group: 1, task: 2, workload: 3, service: 4, route: 5, resource: 6, module: 7, data: 8, config: 9, secret: 10, volume: 11,
  autoscaler: 12, stage: 13, image: 14, chart: 15, provider: 16, variable: 17, local: 18, output: 19, other: 20,
};

export function buildInfraCatalog(input: BuildInfraCatalogInput): InfraCatalog {
  const files = input.infraFiles as ResolverFile[];
  if (files.every((f) => f.facts.kind === "none")) return { ...EMPTY_INFRA_CATALOG, envUnset: [] };
  const ciBuilds: CiBuild[] = files.flatMap((f) => (f.facts.kind === "ci" ? resolveCiBuilds(f.file, f.facts.builds) : []));
  const terraform = run("Terraform", () => resolveTerraform(files), EMPTY);
  const nomad = run("Nomad", () => resolveNomad(files), EMPTY);
  const k8s = run("Kubernetes", () => resolveKubernetes(files), EMPTY);
  const docker = run("Dockerfiles", () => resolveDocker(files, ciBuilds), { ...EMPTY, builds: [] as DockerImageBuild[] });

  const stacks = [...terraform.stacks, ...nomad.stacks, ...k8s.stacks, ...docker.stacks];
  const resources = [...terraform.resources, ...nomad.resources, ...k8s.resources, ...docker.resources];
  // Ids are unique: a second row with the same address in one stack keeps its file in the id.
  const seen = new Set<string>();
  for (const r of resources) {
    if (seen.has(r.id)) r.id = `${r.id}#${r.file}:${r.line}`;
    seen.add(r.id);
  }
  pruneRefs(resources);
  const stackOrder = new Map(stacks.map((s, i) => [s.id, i]));
  resources.sort(
    (a, b) =>
      (stackOrder.get(a.stack) ?? 0) - (stackOrder.get(b.stack) ?? 0) ||
      (a.group === "(root)" ? -1 : 0) - (b.group === "(root)" ? -1 : 0) ||
      a.group.localeCompare(b.group) ||
      CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
      a.address.localeCompare(b.address)
  );
  stacks.sort((a, b) => TOOL_ORDER[a.tool] - TOOL_ORDER[b.tool] || a.path.localeCompare(b.path));

  const { links, envUnset } = run(
    "links",
    () =>
      linkInfra({
        resources,
        builds: docker.builds,
        ciBuilds,
        envFiles: files.flatMap((f) => (f.facts.kind === "env" ? [{ file: f.file, names: f.facts.names }] : [])),
        code: [...input.code],
        api: input.api,
        allFiles: input.allFiles,
      }),
    { links: { deploys: [], env: [], routes: [], ports: [] }, envUnset: [] }
  );
  return {
    stacks,
    resources,
    moves: [...terraform.moves],
    links,
    envUnset,
    tools: [...new Set(stacks.map((s) => s.tool))].sort((a, b) => TOOL_ORDER[a] - TOOL_ORDER[b]),
    files: files.filter((f) => f.facts.kind !== "none" && f.facts.kind !== "ci" && f.facts.kind !== "env" && f.facts.kind !== "spring").length,
  };
}
