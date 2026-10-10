/**
 * Dockerfiles (DESIGN.md §6.12 §2). Each Dockerfile is a stack
 * (`docker:<path>`) whose rows are its build stages (`build`, `runtime`, or
 * `stage0` when unnamed), each with its base image, ENV / ARG, EXPOSE, USER
 * and entrypoint; base images are external rows with their tag or digest.
 * For the links: the build context and the folders its `COPY` / `ADD`
 * sources come from, i.e. which code ships in the image.
 */
import { basename, dirname } from "./common";
import { normalizePath, type CiBuild, type DockerStage } from "./read";
import type { ResolverFile, ResolverOutput } from "./terraform";
import type { InfraAttr, InfraResource, InfraStack } from "./types";

export interface DockerImageBuild {
  dockerfile: string;
  /** The build context folder (`""` = repo root). */
  context: string;
  /** Repo folders / files whose content is copied in (excluding `--from` copies). */
  folders: string[];
  /** Env names set by ENV in the final stage's chain. */
  env: string[];
  /** EXPOSEd ports of the final stage's chain. */
  expose: number[];
  /** Image names CI builds from it (`-t`). */
  tags: string[];
  stages: DockerStage[];
}

export const stageName = (s: DockerStage) => s.name ?? `stage${s.index}`;

/** `20-alpine`, `20-alpine@sha256:dacac8e9a0df` (digest shortened), `latest` when neither is written. */
function imageVersion(from: DockerStage["from"]): string {
  const digest = from.digest ? `@${from.digest.replace(/^(sha256:[0-9a-f]{12})[0-9a-f]+$/, "$1")}` : "";
  return `${from.tag ?? (digest ? "" : "latest")}${digest}`;
}

/** The stages the last stage builds on (`FROM build`), last first. */
function finalChain(stages: DockerStage[]): DockerStage[] {
  const chain: DockerStage[] = [];
  let current: DockerStage | undefined = stages[stages.length - 1];
  const seen = new Set<number>();
  while (current && !seen.has(current.index)) {
    seen.add(current.index);
    chain.push(current);
    const parent: string | undefined = current.from.stage;
    current = parent ? stages.find((s) => s.name === parent) : undefined;
  }
  return chain;
}

export function resolveDocker(files: ResolverFile[], ciBuilds: CiBuild[]): ResolverOutput & { builds: DockerImageBuild[] } {
  const stacks: InfraStack[] = [];
  const resources: InfraResource[] = [];
  const builds: DockerImageBuild[] = [];
  for (const { file, facts } of files) {
    if (facts.kind !== "dockerfile" || facts.stages.length === 0) continue;
    const stackId = `docker:${file}`;
    const ci = ciBuilds.filter((b) => b.dockerfile === file || (!b.dockerfile && b.context !== undefined && normalizePath(`${b.context}/Dockerfile`) === file));
    const context = ci.find((b) => b.context !== undefined)?.context ?? dirname(file);
    stacks.push({ id: stackId, tool: "docker", path: file, name: file, kind: "Dockerfile", environments: [] });
    const group = basename(file);
    const images = new Map<string, InfraResource>();
    for (const s of facts.stages) {
      const attrs: InfraAttr[] = [{ name: "from", value: s.from.stage ? `stage ${s.from.stage}` : s.from.image }];
      for (const [k, v] of s.args) attrs.push({ name: `arg.${k}`, value: v ?? "" });
      for (const [k, v] of s.env) attrs.push({ name: `env.${k}`, value: v });
      if (s.expose.length) attrs.push({ name: "expose", value: s.expose.join(" ") });
      if (s.user) attrs.push({ name: "user", value: s.user });
      if (s.workdir) attrs.push({ name: "workdir", value: s.workdir });
      if (s.entrypoint) attrs.push({ name: "entrypoint", value: s.entrypoint });
      if (s.cmd) attrs.push({ name: "cmd", value: s.cmd });
      s.copies.forEach((c, i) => attrs.push({ name: `copy[${i}]`, value: `${c.from ? `--from=${c.from} ` : ""}${c.sources.join(" ")} → ${c.dest}` }));
      const imageId = s.from.stage ? undefined : `${stackId}:image ${s.from.image}`;
      resources.push({
        id: `${stackId}:${stageName(s)}`,
        tool: "docker",
        stack: stackId,
        group,
        kind: "stage",
        category: "stage",
        address: stageName(s),
        name: stageName(s),
        file,
        line: s.line,
        endLine: s.endLine,
        attributes: attrs,
        source: s.from.raw,
        ...(s.from.stage ? {} : { version: imageVersion(s.from) }),
        refs: s.from.stage ? [`${stackId}:${s.from.stage}`] : imageId ? [imageId] : [],
      });
      if (imageId && !images.has(imageId) && s.from.image !== "scratch") {
        images.set(imageId, {
          id: imageId,
          tool: "docker",
          stack: stackId,
          group,
          kind: "base image",
          category: "image",
          address: `image ${s.from.image}`,
          name: s.from.image,
          file,
          line: s.line,
          attributes: [{ name: "image", value: s.from.raw }],
          source: s.from.image,
          version: imageVersion(s.from),
          external: true,
          refs: [],
        });
      }
    }
    resources.push(...images.values());

    // What ships in the image: COPY/ADD sources (not --from), relative to the context.
    const folders = new Set<string>();
    for (const s of facts.stages) {
      for (const c of s.copies) {
        if (c.from) continue;
        for (const src of c.sources) {
          if (/^[a-z]+:\/\//.test(src) || src.startsWith("$")) continue;
          const clean = src.replace(/\*.*$/, "").replace(/\/+$/, "");
          folders.add(normalizePath(context ? `${context}/${clean}` : clean));
        }
      }
    }
    const chain = finalChain(facts.stages);
    builds.push({
      dockerfile: file,
      context,
      folders: [...folders].sort(),
      env: [...new Set(chain.flatMap((s) => s.env.map(([k]) => k)))],
      expose: [...new Set(chain.flatMap((s) => s.expose.map((p) => Number.parseInt(p, 10)).filter(Number.isFinite)))],
      tags: ci.map((b) => b.tag).filter((t): t is string => Boolean(t)),
      stages: facts.stages,
    });
  }
  return { stacks, resources, moves: [], builds };
}
