/**
 * Reading infra files (DESIGN.md §6.12 §1): which paths are infra, and what
 * each says, as plain data the catalog's resolvers work from. One file at a
 * time, no cross-file knowledge beyond "does this sibling exist" — so the
 * result is cached by the file's git blob, like a code file's parse.
 *
 *   HCL       Terraform / OpenTofu (`*.tf`, `*.tf.json`, `*.tfvars`, the
 *             provider lock file) and Nomad jobspecs, via ../syntax/hcl.mjs
 *   YAML      Kubernetes manifests (any document with `apiVersion` + `kind`),
 *             `kustomization.yaml`, Helm's `Chart.yaml` and `values*.yaml`
 *             (js-yaml); Helm `templates/` read by line, since they aren't
 *             YAML until rendered
 *   Docker    Dockerfiles: stages, FROM, COPY/ADD, ENV, ARG, EXPOSE, USER,
 *             CMD/ENTRYPOINT
 *   Links     `.env.example` (names only), CI/build scripts (`docker build
 *             -t`), Spring `application.properties` / `.yml` placeholders
 */
import { load } from "js-yaml";
import { readHcl, readHclJson, hclString, type HclBody } from "../syntax/hcl.mjs";
import { scanSpringConfig, type CodeFacts } from "./code-facts";

export type InfraReader =
  | "tf"
  | "tfjson"
  | "tfvars"
  | "tfvarsjson"
  | "tflock"
  | "nomad"
  | "nomadjson"
  | "hcl"
  | "yaml"
  | "dockerfile"
  | "env"
  | "ci"
  | "packagejson"
  | "spring";

export interface DockerCopy {
  /** `--from=<stage or image>`. */
  from?: string;
  sources: string[];
  dest: string;
  line: number;
}

export interface DockerStage {
  /** `AS <name>`. */
  name?: string;
  index: number;
  line: number;
  endLine: number;
  /** As written after ARG defaults are substituted. */
  from: { raw: string; image: string; tag?: string; digest?: string; /** An earlier stage. */ stage?: string };
  env: Array<[string, string]>;
  args: Array<[string, string | undefined]>;
  expose: string[];
  user?: string;
  workdir?: string;
  entrypoint?: string;
  cmd?: string;
  copies: DockerCopy[];
}

export interface CiBuild {
  /** `-t` as written (`ghcr.io/acme/api:${TAG}`). */
  tag?: string;
  /** `-f`: relative to the script's folder as read (cached by blob), relative to the repo once resolved ({@link resolveCiBuilds}). */
  dockerfile?: string;
  /** The build context, likewise (`""` = the script's folder / the repo root). */
  context?: string;
  line: number;
}

/** A script's builds with their paths made repo-relative. */
export function resolveCiBuilds(file: string, builds: readonly CiBuild[]): CiBuild[] {
  const dir = dirname(file);
  return builds.map((b) => ({
    ...b,
    ...(b.dockerfile !== undefined ? { dockerfile: join(dir, b.dockerfile) } : {}),
    ...(b.context !== undefined ? { context: join(dir, b.context) } : {}),
  }));
}

/** One document of a Helm template: its kind, literal name, and the `.Values` paths it (and its guard) uses. */
export interface HelmTemplateDoc {
  kind: string;
  name?: string;
  line: number;
  values: string[];
  conditional?: true;
}

export interface YamlDoc {
  line: number;
  doc: Record<string, unknown>;
}

export type InfraFileFacts =
  | { kind: "terraform"; body: HclBody; templated?: true }
  | { kind: "tfvars"; body: HclBody }
  | { kind: "tflock"; providers: Array<{ source: string; version: string }> }
  | { kind: "nomad"; body: HclBody; templated?: true }
  | { kind: "k8s"; docs: YamlDoc[] }
  | { kind: "kustomization"; doc: Record<string, unknown> }
  | { kind: "chart"; doc: Record<string, unknown> }
  | { kind: "values"; doc: Record<string, unknown> }
  | { kind: "helm-template"; docs: HelmTemplateDoc[] }
  | { kind: "dockerfile"; stages: DockerStage[] }
  | { kind: "env"; names: string[] }
  | { kind: "ci"; builds: CiBuild[] }
  | { kind: "spring"; code: CodeFacts }
  | { kind: "none" };

/** Facts that make a file part of the repo's graph: it is infra itself (DESIGN.md §6.12 §6). */
export const GRAPH_FILE_KINDS: Partial<Record<InfraFileFacts["kind"], string>> = {
  terraform: "terraform",
  tfvars: "terraform",
  tflock: "terraform",
  nomad: "nomad",
  k8s: "kubernetes",
  kustomization: "kubernetes",
  chart: "helm",
  values: "helm",
  "helm-template": "helm",
  dockerfile: "dockerfile",
};

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (dir: string, rel: string) => normalizePath(dir ? `${dir}/${rel}` : rel);

/** `a/./b/../c` → `a/c`; a path escaping the repo keeps its leading `..`. */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * What, besides its content, a file's facts depend on — part of its cache
 * key. Only YAML depends on its name and siblings (a Helm template, a
 * values file, a kustomization); every other reader keeps paths relative.
 */
export function infraCacheTag(reader: InfraReader, path: string, has: (p: string) => boolean): string {
  if (reader !== "yaml") return reader;
  const name = basename(path).toLowerCase();
  if (helmChartOf(path, has)) return "yaml:template";
  if (name === "kustomization.yaml" || name === "kustomization.yml") return "yaml:kustomization";
  if (name === "chart.yaml" || name === "chart.yml") return "yaml:chart";
  if (/^values([-.][\w.-]+)?\.ya?ml$/.test(name) && (has(join(dirname(path), "Chart.yaml")) || has(join(dirname(path), "Chart.yml")))) return "yaml:values";
  return "yaml";
}

/** Which reader a path takes, if any. `has` asks whether a repo file exists (a Helm chart's `Chart.yaml`). */
export function infraReaderFor(path: string, has: (p: string) => boolean): InfraReader | undefined {
  const name = basename(path).toLowerCase();
  if (name === ".terraform.lock.hcl") return "tflock";
  if (name.endsWith(".tf")) return "tf";
  if (name.endsWith(".tf.json")) return "tfjson";
  if (name.endsWith(".tfvars")) return "tfvars";
  if (name.endsWith(".tfvars.json")) return "tfvarsjson";
  // `.nomad.tpl`: a nomad-pack template (`[[ ]]`), read as written and marked templated.
  if (name.endsWith(".nomad") || name.endsWith(".nomad.hcl") || name.endsWith(".nomad.tpl")) return "nomad";
  if (name.endsWith(".nomad.json")) return "nomadjson";
  if (name.endsWith(".hcl")) return "hcl";
  if (name === "dockerfile" || name === "containerfile" || name.endsWith(".dockerfile") || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === ".gitlab-ci.yml" || name === "skaffold.yaml" || name === "skaffold.yml") return "ci";
  if (/^(application|bootstrap)([-.][\w-]+)?\.(properties|ya?ml)$/.test(name)) return "spring";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  if (name === ".env" || /^\.env\.(example|sample|template|defaults|dist|local\.example)$/.test(name)) return "env";
  if (name === "makefile" || name.endsWith(".mk") || name.endsWith(".sh") || name === "jenkinsfile" || name === "justfile") return "ci";
  if (name === "package.json") return "packagejson";
  // A Helm template that isn't .yaml (NOTES.txt, _helpers.tpl) says nothing about resources.
  void has;
  return undefined;
}

/** The chart folder a path under `<chart>/templates/` belongs to, when that folder has a `Chart.yaml`. */
export function helmChartOf(path: string, has: (p: string) => boolean): string | undefined {
  const parts = path.split("/");
  const at = parts.lastIndexOf("templates");
  if (at === -1) return undefined;
  const chart = parts.slice(0, at).join("/");
  return has(join(chart, "Chart.yaml")) || has(join(chart, "Chart.yml")) ? chart : undefined;
}

/** Read one infra file. Never throws: an unreadable file is `{ kind: "none" }`. */
export function readInfraFile(reader: InfraReader, path: string, source: string, has: (p: string) => boolean): InfraFileFacts {
  try {
    switch (reader) {
      case "tf": {
        const file = readHcl(source);
        return { kind: "terraform", body: file.body, ...(file.templated ? { templated: true as const } : {}) };
      }
      case "tfjson":
        return { kind: "terraform", body: readHclJson(source, "terraform").body };
      case "tfvars":
        return { kind: "tfvars", body: readHcl(source).body };
      case "tfvarsjson":
        return { kind: "tfvars", body: readHclJson(source, "tfvars").body };
      case "tflock": {
        const body = readHcl(source).body;
        const providers = body.blocks
          .filter((b) => b.type === "provider" && b.labels[0])
          .map((b) => ({ source: b.labels[0], version: hclString(b.body.attrs.find((a) => a.name === "version")?.expr.text ?? "") ?? "" }))
          .filter((p) => p.version);
        return providers.length ? { kind: "tflock", providers } : { kind: "none" };
      }
      case "nomad":
      case "hcl": {
        const file = readHcl(source);
        if (!file.body.blocks.some((b) => b.type === "job")) return { kind: "none" };
        return { kind: "nomad", body: file.body, ...(file.templated ? { templated: true as const } : {}) };
      }
      case "nomadjson":
        return readNomadJson(source);
      case "dockerfile":
        return { kind: "dockerfile", stages: readDockerfile(source) };
      case "env":
        return readEnvFile(source);
      case "ci":
        return readCi(path, source);
      case "packagejson":
        return readPackageJsonScripts(source);
      case "spring": {
        const code = scanSpringConfig(source);
        return code ? { kind: "spring", code } : { kind: "none" };
      }
      case "yaml":
        return readYaml(path, source, has);
    }
  } catch (error) {
    console.warn(`[infra] could not read ${path}: ${(error as Error).message}`);
    return { kind: "none" };
  }
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

/** Kinds whose `spec` is a schema, not configuration — dropped to keep the cache small. */
const SCHEMA_KINDS = new Set(["CustomResourceDefinition"]);

/** Splits a multi-document YAML stream, keeping each document's first line. */
export function yamlDocuments(source: string): Array<{ line: number; text: string }> {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const docs: Array<{ line: number; text: string }> = [];
  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    if (i === lines.length || /^---(\s|$)/.test(lines[i])) {
      const text = lines.slice(start, i).join("\n");
      if (text.trim()) {
        // the line of the first non-blank, non-comment line
        let first = start;
        while (first < i && (!lines[first].trim() || lines[first].trim().startsWith("#"))) first++;
        docs.push({ line: first + 1, text });
      }
      start = i + 1;
    }
  }
  return docs;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function readYaml(path: string, source: string, has: (p: string) => boolean): InfraFileFacts {
  const name = basename(path).toLowerCase();
  const dir = dirname(path);
  if (helmChartOf(path, has)) return readHelmTemplate(source);
  if (name === "kustomization.yaml" || name === "kustomization.yml") {
    const doc = load(source, { json: true });
    return isObject(doc) ? { kind: "kustomization", doc } : { kind: "none" };
  }
  if (name === "chart.yaml" || name === "chart.yml") {
    const doc = load(source, { json: true });
    return isObject(doc) && typeof doc.name === "string" ? { kind: "chart", doc } : { kind: "none" };
  }
  if (/^values([-.][\w.-]+)?\.ya?ml$/.test(name) && (has(join(dir, "Chart.yaml")) || has(join(dir, "Chart.yml")))) {
    const doc = load(source, { json: true });
    return { kind: "values", doc: isObject(doc) ? doc : {} };
  }
  // A Kubernetes manifest: any document with apiVersion + kind. Cheap test first.
  if (!/^apiVersion:/m.test(source) || !/^kind:/m.test(source)) return { kind: "none" };
  if (source.includes("{{")) return { kind: "none" }; // a template of some other tool
  const docs: YamlDoc[] = [];
  for (const { line, text } of yamlDocuments(source)) {
    let doc: unknown;
    try {
      doc = load(text, { json: true });
    } catch {
      continue;
    }
    for (const item of isObject(doc) && doc.kind === "List" && Array.isArray(doc.items) ? doc.items : [doc]) {
      if (!isObject(item) || typeof item.apiVersion !== "string" || typeof item.kind !== "string") continue;
      if (/^skaffold\//.test(item.apiVersion) || item.kind === "Kustomization" || (item.kind === "Config" && "clusters" in item)) continue;
      const meta = isObject(item.metadata) ? { ...item.metadata } : {};
      delete meta.managedFields;
      const kept: Record<string, unknown> = { ...item, metadata: meta };
      delete kept.status;
      if (SCHEMA_KINDS.has(item.kind)) kept.spec = {};
      docs.push({ line, doc: kept });
    }
  }
  return docs.length ? { kind: "k8s", docs } : { kind: "none" };
}

/** A Helm template, read by line: each document's `kind:`, its `metadata.name` when literal, the `.Values.*` it uses. */
function readHelmTemplate(source: string): InfraFileFacts {
  const docs: HelmTemplateDoc[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let current: HelmTemplateDoc | null = null;
  let inMetadata = false;
  /** `.Values` paths seen in a document before its `kind:` (its `{{ if }}` guard). */
  let pending = new Set<string>();
  /** An `{{ if … }}` at the top of the document, before its `kind:`: the document is conditional. */
  let guarded = false;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (/^---/.test(text)) {
      current = null;
      inMetadata = false;
      pending = new Set();
      guarded = false;
      continue;
    }
    const used = [...text.matchAll(/\.Values\.([A-Za-z0-9_.]+)/g)].map((m) => m[1].replace(/\.$/, ""));
    if (!current && /^\{\{-?\s*(if|with|range)\b/.test(text)) guarded = true;
    const kind = /^kind:\s*["']?([A-Za-z][\w]*)/.exec(text);
    if (kind) {
      current = { kind: kind[1], line: i + 1, values: [...pending], ...(guarded ? { conditional: true as const } : {}) };
      docs.push(current);
      continue;
    }
    if (current) {
      for (const v of used) if (!current.values.includes(v) && current.values.length < 120) current.values.push(v);
    } else for (const v of used) pending.add(v);
    if (/^metadata:\s*$/.test(text)) inMetadata = true;
    else if (/^\S/.test(text)) inMetadata = false;
    else if (inMetadata && current && !current.name) {
      const n = /^ {2}name:\s*(.+?)\s*$/.exec(text);
      if (n) current.name = n[1].replace(/^["']|["']$/g, "");
    }
  }
  if (docs.length === 0) return { kind: "none" };
  return { kind: "helm-template", docs };
}

// ---------------------------------------------------------------------------
// Nomad JSON (the API's job format) → the HCL shape the resolver reads
// ---------------------------------------------------------------------------

function readNomadJson(source: string): InfraFileFacts {
  const parsed: unknown = JSON.parse(source);
  const job = isObject(parsed) && isObject(parsed.Job) ? parsed.Job : isObject(parsed) && typeof parsed.ID === "string" ? parsed : null;
  if (!job) return { kind: "none" };
  const attr = (name: string, v: unknown) => ({ name, line: 1, endLine: 1, expr: { text: JSON.stringify(v), refs: [] as string[] } });
  const block = (type: string, labels: string[], body: HclBody) => ({ type, labels, line: 1, endLine: 1, body });
  const attrsOf = (o: Record<string, unknown>, keys: Array<[string, string]>) =>
    keys.filter(([k]) => o[k] !== undefined && o[k] !== null).map(([k, name]) => attr(name, o[k]));
  const services = (list: unknown) =>
    (Array.isArray(list) ? list : []).filter(isObject).map((s) =>
      block("service", [], { attrs: attrsOf(s, [["Name", "name"], ["PortLabel", "port"], ["Tags", "tags"], ["Provider", "provider"]]), blocks: [] })
    );
  const groups = (Array.isArray(job.TaskGroups) ? job.TaskGroups : []).filter(isObject).map((g) => {
    const tasks = (Array.isArray(g.Tasks) ? g.Tasks : []).filter(isObject).map((t) => {
      const config = isObject(t.Config) ? t.Config : {};
      const env = isObject(t.Env) ? t.Env : {};
      return block("task", [String(t.Name ?? "task")], {
        attrs: attrsOf(t, [["Driver", "driver"], ["User", "user"]]),
        blocks: [
          block("config", [], { attrs: Object.entries(config).map(([k, v]) => attr(k, v)), blocks: [] }),
          block("env", [], { attrs: Object.entries(env).map(([k, v]) => attr(k, v)), blocks: [] }),
          ...services(t.Services),
        ],
      });
    });
    const ports: ReturnType<typeof block>[] = [];
    for (const net of Array.isArray(g.Networks) ? g.Networks.filter(isObject) : []) {
      for (const [list, staticPort] of [[net.ReservedPorts, true], [net.DynamicPorts, false]] as const) {
        for (const p of Array.isArray(list) ? list.filter(isObject) : []) {
          ports.push(
            block("port", [String(p.Label ?? "port")], {
              attrs: [...(staticPort && p.Value ? [attr("static", p.Value)] : []), ...(p.To ? [attr("to", p.To)] : [])],
              blocks: [],
            })
          );
        }
      }
    }
    return block("group", [String(g.Name ?? "group")], {
      attrs: attrsOf(g, [["Count", "count"]]),
      blocks: [...(ports.length ? [block("network", [], { attrs: [], blocks: ports })] : []), ...services(g.Services), ...tasks],
    });
  });
  const body: HclBody = {
    attrs: [],
    blocks: [
      block("job", [String(job.ID ?? job.Name ?? "job")], {
        attrs: attrsOf(job, [["Type", "type"], ["Datacenters", "datacenters"], ["Namespace", "namespace"], ["Region", "region"]]),
        blocks: groups,
      }),
    ],
  };
  return { kind: "nomad", body };
}

// ---------------------------------------------------------------------------
// Dockerfile
// ---------------------------------------------------------------------------

/** Logical instructions: continuation lines joined, comments and heredoc bodies skipped. */
function dockerInstructions(source: string): Array<{ op: string; args: string; line: number; endLine: number }> {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let escape = "\\";
  const directive = /^#\s*escape\s*=\s*(\S)/i.exec(lines[0] ?? "");
  if (directive) escape = directive[1];
  const out: Array<{ op: string; args: string; line: number; endLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i].trim();
    if (!first || first.startsWith("#")) continue;
    const start = i;
    let text = lines[i].replace(/\s+$/, "");
    while (text.endsWith(escape) && i + 1 < lines.length) {
      text = text.slice(0, -1);
      i++;
      const next = lines[i];
      if (next.trim().startsWith("#")) continue;
      text += ` ${next.trim()}`;
    }
    const m = /^\s*([A-Za-z]+)\s*(.*)$/.exec(text);
    if (!m) continue;
    out.push({ op: m[1].toUpperCase(), args: m[2].trim(), line: start + 1, endLine: i + 1 });
    // heredoc (`RUN <<EOF`): skip its body
    const heredoc = /<<-?\s*["']?([A-Za-z_][\w]*)["']?/.exec(m[2]);
    if (heredoc && (m[1].toUpperCase() === "RUN" || m[1].toUpperCase() === "COPY")) {
      while (i + 1 < lines.length && lines[i + 1].trim() !== heredoc[1]) i++;
      i++;
    }
  }
  return out;
}

/** `["a", "b"]` or `a b` → words. */
function dockerWords(args: string): string[] {
  const t = args.trim();
  if (t.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* shell form after all */
    }
  }
  return shellWords(t);
}

/** Splits a command line on whitespace, honouring quotes. */
export function shellWords(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || current) out.push(current);
      current = "";
      has = false;
      continue;
    }
    current += c;
    has = true;
  }
  if (has || current) out.push(current);
  return out;
}

/** `node:20-alpine@sha256:…` → image, tag, digest. */
export function splitImage(ref: string): { image: string; tag?: string; digest?: string } {
  let rest = ref.trim();
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const slash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  let tag: string | undefined;
  if (colon > slash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { image: rest, ...(tag ? { tag } : {}), ...(digest ? { digest } : {}) };
}

function substituteArgs(text: string, args: Map<string, string | undefined>): string {
  return text.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}?/g, (whole, name: string, fallback: string | undefined) => {
    const value = args.get(name);
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    return whole;
  });
}

/** ENV `A=1 B="x y"` or legacy `ENV A 1`. */
function envPairs(args: string): Array<[string, string]> {
  const words = shellWords(args);
  if (words.length >= 1 && !words[0].includes("=")) return [[words[0], words.slice(1).join(" ")]];
  return words.filter((w) => w.includes("=")).map((w) => [w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)]);
}

export function readDockerfile(source: string): DockerStage[] {
  const stages: DockerStage[] = [];
  const globalArgs = new Map<string, string | undefined>();
  let stage: DockerStage | null = null;
  for (const ins of dockerInstructions(source)) {
    if (ins.op === "FROM") {
      const words = shellWords(ins.args).filter((w) => !w.startsWith("--"));
      const platform = /--platform=(\S+)/.exec(ins.args)?.[1];
      void platform;
      const raw = substituteArgs(words[0] ?? "scratch", globalArgs);
      const name = words[1]?.toLowerCase() === "as" ? words[2] : undefined;
      const earlier = stages.find((s) => s.name && s.name.toLowerCase() === raw.toLowerCase());
      if (stage) stage.endLine = ins.line - 1;
      stage = {
        ...(name ? { name } : {}),
        index: stages.length,
        line: ins.line,
        endLine: ins.endLine,
        from: earlier ? { raw, image: raw, stage: earlier.name } : { raw, ...splitImage(raw) },
        env: [],
        args: [],
        expose: [],
        copies: [],
      };
      stages.push(stage);
      continue;
    }
    if (!stage) {
      if (ins.op === "ARG") for (const w of shellWords(ins.args)) {
        const eq = w.indexOf("=");
        globalArgs.set(eq === -1 ? w : w.slice(0, eq), eq === -1 ? undefined : w.slice(eq + 1));
      }
      continue;
    }
    stage.endLine = ins.endLine;
    switch (ins.op) {
      case "ENV":
        stage.env.push(...envPairs(ins.args));
        break;
      case "ARG":
        for (const w of shellWords(ins.args)) {
          const eq = w.indexOf("=");
          stage.args.push([eq === -1 ? w : w.slice(0, eq), eq === -1 ? undefined : w.slice(eq + 1)]);
        }
        break;
      case "EXPOSE":
        stage.expose.push(...shellWords(ins.args));
        break;
      case "USER":
        stage.user = ins.args;
        break;
      case "WORKDIR":
        stage.workdir = ins.args;
        break;
      case "ENTRYPOINT":
        stage.entrypoint = dockerWords(ins.args).join(" ");
        break;
      case "CMD":
        stage.cmd = dockerWords(ins.args).join(" ");
        break;
      case "COPY":
      case "ADD": {
        const words = dockerWords(ins.args);
        const flags = words.filter((w) => w.startsWith("--"));
        const rest = words.filter((w) => !w.startsWith("--"));
        if (rest.length < 2 || rest.some((w) => w.startsWith("<<"))) break;
        const from = flags.find((f) => f.startsWith("--from="))?.slice(7);
        stage.copies.push({ ...(from ? { from } : {}), sources: rest.slice(0, -1), dest: rest[rest.length - 1], line: ins.line });
        break;
      }
    }
  }
  return stages;
}

// ---------------------------------------------------------------------------
// Env files, CI / build scripts
// ---------------------------------------------------------------------------

function readEnvFile(source: string): InfraFileFacts {
  const names: string[] = [];
  for (const line of source.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names.length ? { kind: "env", names } : { kind: "none" };
}

/** Flags of `docker build` that take a value. */
const VALUE_FLAGS = new Set([
  "-t", "--tag", "-f", "--file", "--build-arg", "--target", "--platform", "--label", "--cache-from", "--cache-to", "--secret",
  "--network", "--progress", "-o", "--output", "--ssh", "--iidfile", "--add-host", "--build-context", "--builder", "--metadata-file",
  "--shm-size", "-m", "--memory", "--ulimit", "--isolation", "--allow", "--annotation", "--attest", "--call",
]);

/** `docker build` / `docker buildx build` / `podman build` / `buildah bud` commands in a script's text. */
export function dockerBuildsIn(text: string, baseDir: string): CiBuild[] {
  const builds: CiBuild[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const start = i;
    while (/\\\s*$/.test(line) && i + 1 < lines.length) line = line.replace(/\\\s*$/, " ") + lines[++i];
    for (const m of line.matchAll(/\b(?:docker\s+(?:buildx\s+)?build|podman\s+build|buildah\s+(?:bud|build(?:-using-dockerfile)?))\b([^;&|`\n]*)/g)) {
      const words = shellWords(m[1]);
      let tag: string | undefined;
      let file: string | undefined;
      let context: string | undefined;
      for (let k = 0; k < words.length; k++) {
        const w = words[k];
        const [flag, inline] = w.includes("=") && w.startsWith("-") ? [w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)] : [w, undefined];
        if (flag === "-t" || flag === "--tag") tag ??= inline ?? words[++k];
        else if (flag === "-f" || flag === "--file") file = inline ?? words[++k];
        else if (VALUE_FLAGS.has(flag) && inline === undefined) k++;
        else if (!w.startsWith("-") && context === undefined) context = w;
      }
      const ctx = context !== undefined && !/^[a-z]+:\/\//.test(context) && !context.startsWith("$") ? normalizePath(join(baseDir, context)) : undefined;
      builds.push({
        ...(tag ? { tag } : {}),
        ...(file && !file.startsWith("$") ? { dockerfile: normalizePath(join(baseDir, file)) } : {}),
        ...(ctx !== undefined ? { context: ctx } : {}),
        line: start + 1,
      });
    }
  }
  return builds;
}

function readCi(path: string, source: string): InfraFileFacts {
  const dir = "";
  const builds = dockerBuildsIn(source, dir);
  const name = basename(path).toLowerCase();
  if (name.startsWith("skaffold.")) {
    for (const { text, line } of yamlDocuments(source)) {
      const doc = load(text, { json: true });
      const artifacts = isObject(doc) && isObject(doc.build) && Array.isArray(doc.build.artifacts) ? doc.build.artifacts : [];
      for (const a of artifacts.filter(isObject)) {
        const ctx = typeof a.context === "string" ? join(dir, a.context) : dir;
        const docker = isObject(a.docker) ? a.docker : {};
        builds.push({
          ...(typeof a.image === "string" ? { tag: a.image } : {}),
          context: ctx,
          ...(typeof docker.dockerfile === "string" ? { dockerfile: join(ctx, docker.dockerfile) } : {}),
          line,
        });
      }
    }
  }
  return builds.length ? { kind: "ci", builds } : { kind: "none" };
}

function readPackageJsonScripts(source: string): InfraFileFacts {
  if (!/docker|podman|buildah/.test(source)) return { kind: "none" };
  const parsed: unknown = JSON.parse(source);
  const scripts = isObject(parsed) && isObject(parsed.scripts) ? parsed.scripts : {};
  const builds: CiBuild[] = [];
  for (const value of Object.values(scripts)) if (typeof value === "string") builds.push(...dockerBuildsIn(value, "").map((b) => ({ ...b, line: 1 })));
  return builds.length ? { kind: "ci", builds } : { kind: "none" };
}
