/**
 * Reading the files that set env vars (DESIGN.md §6.15 §1): `.env*` files,
 * CI workflows (GitHub Actions, GitLab CI, Jenkinsfile), Docker Compose,
 * framework config (`next.config`, `vite.config`, and the configs that only
 * say which framework an app is) and Prisma schemas (`env("X")`). One file
 * at a time, so the result is cached by the file's blob like a parse.
 *
 * Code reads and typed schemas come from the code scan
 * (../infra/code-facts.ts, ./declare.ts); Nomad, Kubernetes and Dockerfile
 * env from the infra catalog.
 */
import { load } from "js-yaml";
import type { EnvReadFlags } from "../infra/code-facts";
import type { EnvScope, EnvSourceKind } from "./types";

export type EnvReader = "dotenv" | "gha" | "gitlab" | "jenkins" | "compose" | "next" | "vite" | "framework" | "prisma";

export interface EnvSetFact {
  name: string;
  line: number;
  target: string;
  value?: string;
  ref?: string;
  interpolated?: 1;
  description?: string;
  client?: 1;
}

export type EnvFileFacts =
  | {
      kind: "env-source";
      source: EnvSourceKind | "example";
      sets: EnvSetFact[];
      /** The host's env read by a non-code file (Compose `${X:-d}`, Prisma `env("X")`). */
      reads?: Array<[string, number, EnvReadFlags?]>;
      /** Compose `env_file:` per service target. */
      envFiles?: Array<{ target: string; file: string; line: number }>;
      /** Compose `build.context` per service target, repo-relative. */
      contexts?: Record<string, string>;
      framework?: EnvScope["framework"];
      /** Vite `envPrefix`. */
      prefixes?: string[];
    }
  | { kind: "none" };

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** Which env reader a path takes, if any. */
export function envReaderFor(path: string): EnvReader | undefined {
  const name = basename(path);
  const lower = name.toLowerCase();
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return "gha";
  if (lower === ".gitlab-ci.yml") return "gitlab";
  if (lower === "jenkinsfile") return "jenkins";
  if (/^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/.test(lower)) return "compose";
  if (/^next\.config\.(js|mjs|cjs|ts|mts)$/.test(lower)) return "next";
  if (/^vite\.config\.(js|mjs|cjs|ts|mts)$/.test(lower)) return "vite";
  if (/^(astro|svelte|nuxt)\.config\.(js|mjs|cjs|ts|mts)$/.test(lower)) return "framework";
  if (lower.endsWith(".prisma")) return "prisma";
  if (lower === ".env" || lower.startsWith(".env.") || lower === ".envrc" || (lower.endsWith(".env") && !lower.startsWith("."))) return "dotenv";
  return undefined;
}

const EXAMPLE = /(^|\.)(example|sample|template|defaults|dist|tpl)($|\.)/;

/** The matrix column a `.env*` file fills: `.env` → `default`, `.env.production.local` → `production (local)`, examples → `example`. */
export function dotenvTarget(path: string): string {
  const name = basename(path).toLowerCase();
  if (name === ".envrc") return "direnv";
  const rest = name.startsWith(".env") ? name.slice(4).replace(/^\./, "") : name.replace(/\.env$/, "");
  if (EXAMPLE.test(rest)) return "example";
  if (!rest) return "default";
  const parts = rest.split(".");
  if (parts.length === 2 && parts[1] === "local") return `${parts[0]} (local)`;
  return rest;
}

/** Read one env source file. Never throws: an unreadable file is `{ kind: "none" }`. */
export function readEnvFile(reader: EnvReader, path: string, source: string): EnvFileFacts {
  try {
    switch (reader) {
      case "dotenv":
        return readDotenv(path, source);
      case "gha":
        return readGithubActions(path, source);
      case "gitlab":
        return readGitlab(source);
      case "jenkins":
        return readJenkins(source);
      case "compose":
        return readCompose(path, source);
      case "next":
        return readNextConfig(source);
      case "vite":
        return readViteConfig(source);
      case "framework": {
        const n = basename(path).toLowerCase();
        const framework = n.startsWith("astro") ? "astro" : n.startsWith("nuxt") ? "nuxt" : /@sveltejs\/kit/.test(source) ? "sveltekit" : "vite";
        return { kind: "env-source", source: "framework", sets: [], framework };
      }
      case "prisma":
        return readPrisma(source);
    }
  } catch (error) {
    console.warn(`[env] could not read ${path}: ${(error as Error).message}`);
    return { kind: "none" };
  }
}

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

const INTERPOLATION = /\$\{[A-Za-z_][A-Za-z0-9_]*[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;

function readDotenv(path: string, source: string): EnvFileFacts {
  const target = dotenvTarget(path);
  const sets: EnvSetFact[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let comment: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (/^\s*#/.test(text)) {
      comment.push(text.replace(/^\s*#+\s?/, "").trim());
      continue;
    }
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s?(.*)$/.exec(text);
    if (!m) {
      comment = [];
      continue;
    }
    const line = i + 1;
    let raw = m[2];
    let value: string;
    let quote: string | undefined;
    if (/^\s*["'`]/.test(raw)) {
      raw = raw.trimStart();
      quote = raw[0];
      let body = raw.slice(1);
      // A quoted value may run over several lines.
      while (!new RegExp(`(^|[^\\\\])${quote === "`" ? "`" : quote}`).test(body) && i + 1 < lines.length) body += `\n${lines[++i]}`;
      const end = body.search(new RegExp(`(?<!\\\\)${quote}`));
      value = end === -1 ? body : body.slice(0, end);
    } else {
      value = raw.replace(/\s+#.*$/, "").trim();
    }
    const description = comment.filter(Boolean).join(" ").slice(0, 200);
    comment = [];
    sets.push({
      name: m[1],
      line,
      target,
      value,
      ...(quote !== "'" && INTERPOLATION.test(value) ? { interpolated: 1 as const } : {}),
      ...(description ? { description } : {}),
    });
    if (sets.length >= 1000) break;
  }
  if (!sets.length) return { kind: "none" };
  return { kind: "env-source", source: target === "example" ? "example" : "dotenv", sets };
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The first line at or after `from` (0-based) that sets `name` as a key, 1-based. */
function lineOf(lines: string[], name: string, from = 0): number {
  const re = new RegExp(`^\\s*(?:-\\s*)?["']?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*[:=]`);
  for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  for (let i = 0; i < from && i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return Math.max(1, from + 1);
}

function scalar(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** An env map or `KEY=value` list as `[name, value | undefined]` pairs. */
function envEntries(v: unknown): Array<[string, string | undefined]> {
  if (isObject(v)) return Object.entries(v).map(([k, x]) => [k, isObject(x) ? scalar(x.value) : scalar(x)]);
  if (Array.isArray(v)) {
    return v.flatMap((item): Array<[string, string | undefined]> => {
      const s = scalar(item);
      if (s === undefined) return [];
      const eq = s.indexOf("=");
      return eq === -1 ? [[s.trim(), undefined]] : [[s.slice(0, eq).trim(), s.slice(eq + 1)]];
    });
  }
  return [];
}

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

/** A GitHub Actions value: `${{ secrets.X }}` is a secret ref, `${{ vars.X }}` a var ref, other expressions interpolated. */
function ghaSet(name: string, raw: string | undefined, line: number, target: string): EnvSetFact {
  const value = raw ?? "";
  const ref = /^\s*\$\{\{\s*(secrets|vars)\.([A-Za-z0-9_]+)\s*\}\}\s*$/.exec(value);
  if (ref) return { name, line, target, ref: `${ref[1] === "secrets" ? "secret" : "var"} ${ref[2]}` };
  return { name, line, target, value, ...(/\$\{\{/.test(value) ? { interpolated: 1 as const } : {}) };
}

function readGithubActions(path: string, source: string): EnvFileFacts {
  const doc = load(source, { json: true });
  if (!isObject(doc)) return { kind: "none" };
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const sets: EnvSetFact[] = [];
  const workflow = basename(path).replace(/\.ya?ml$/, "");
  for (const [name, v] of envEntries(doc.env)) sets.push(ghaSet(name, v, lineOf(lines, name), `ci:${workflow}`));
  const jobs = isObject(doc.jobs) ? doc.jobs : {};
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isObject(job)) continue;
    const jobLine = Math.max(0, lineOf(lines, jobId) - 1);
    const environment = typeof job.environment === "string" ? job.environment : isObject(job.environment) ? scalar(job.environment.name) : undefined;
    const target = `ci:${environment && !/\$\{\{/.test(environment) ? environment : jobId}`;
    for (const [name, v] of envEntries(job.env)) sets.push(ghaSet(name, v, lineOf(lines, name, jobLine), target));
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (!isObject(step)) continue;
      for (const [name, v] of envEntries(step.env)) sets.push(ghaSet(name, v, lineOf(lines, name, jobLine), target));
    }
  }
  return sets.length ? { kind: "env-source", source: "ci", sets } : { kind: "none" };
}

const GITLAB_KEYWORDS = new Set(["stages", "variables", "include", "default", "workflow", "image", "services", "cache", "before_script", "after_script"]);

function readGitlab(source: string): EnvFileFacts {
  const doc = load(source, { json: true });
  if (!isObject(doc)) return { kind: "none" };
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const sets: EnvSetFact[] = [];
  const add = (vars: unknown, target: string, from: number) => {
    if (!isObject(vars)) return;
    for (const [name, v] of Object.entries(vars)) {
      const value = isObject(v) ? scalar(v.value) : scalar(v);
      const description = isObject(v) ? scalar(v.description) : undefined;
      sets.push({ name, line: lineOf(lines, name, from), target, value: value ?? "", ...(value && /\$/.test(value) ? { interpolated: 1 as const } : {}), ...(description ? { description } : {}) });
    }
  };
  add(doc.variables, "ci:gitlab", 0);
  for (const [jobId, job] of Object.entries(doc)) {
    if (GITLAB_KEYWORDS.has(jobId) || !isObject(job)) continue;
    const environment = typeof job.environment === "string" ? job.environment : isObject(job.environment) ? scalar(job.environment.name) : undefined;
    add(job.variables, `ci:${environment && !/\$/.test(environment) ? environment : jobId.replace(/^\./, "")}`, Math.max(0, lineOf(lines, jobId) - 1));
  }
  return sets.length ? { kind: "env-source", source: "ci", sets } : { kind: "none" };
}

function readJenkins(source: string): EnvFileFacts {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const sets: EnvSetFact[] = [];
  let depth = 0;
  let inEnv = false;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!inEnv && /^\s*environment\s*\{/.test(text)) {
      inEnv = true;
      depth = 0;
    }
    if (inEnv) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(text);
      if (m) {
        const cred = /^credentials\(\s*["']([^"']+)["']\s*\)/.exec(m[2]);
        if (cred) sets.push({ name: m[1], line: i + 1, target: "ci:jenkins", ref: `credentials ${cred[1]}` });
        else {
          const value = m[2].replace(/^(["'])(.*)\1$/, "$2");
          sets.push({ name: m[1], line: i + 1, target: "ci:jenkins", value, ...(/\$/.test(value) ? { interpolated: 1 as const } : {}) });
        }
      }
      for (const c of text) {
        if (c === "{") depth++;
        else if (c === "}") depth--;
      }
      if (depth <= 0 && /\}/.test(text)) inEnv = false;
    }
  }
  return sets.length ? { kind: "env-source", source: "ci", sets } : { kind: "none" };
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

/** `${X}`, `${X:-d}`, `${X-d}`, `${X:?err}`, `$X` — what `compose up` reads from the host. */
function hostReads(lines: string[]): Array<[string, number, EnvReadFlags?]> {
  const reads: Array<[string, number, EnvReadFlags?]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) continue;
    for (const m of lines[i].matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*)|(:?\?)[^}]*)?\}|(?<!\$)\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = m[1] ?? m[5];
      if (m[2] !== undefined) reads.push([name, i + 1, { f: m[3] }]);
      else if (m[4] !== undefined) reads.push([name, i + 1, { r: 1 }]);
      else reads.push([name, i + 1]);
    }
  }
  return reads;
}

function readCompose(path: string, source: string): EnvFileFacts {
  const doc = load(source, { json: true });
  if (!isObject(doc) || !isObject(doc.services)) return { kind: "none" };
  const dir = dirname(path);
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const sets: EnvSetFact[] = [];
  const envFiles: Array<{ target: string; file: string; line: number }> = [];
  const contexts: Record<string, string> = {};
  const reads = hostReads(lines);
  for (const [svc, service] of Object.entries(doc.services)) {
    if (!isObject(service)) continue;
    const target = `compose:${svc}`;
    const from = Math.max(0, lineOf(lines, svc) - 1);
    for (const [name, value] of envEntries(service.environment)) {
      const line = lineOf(lines, name, from);
      // `- KEY` / `KEY:` with no value passes the host's value through: a ref, so "maybe set".
      if (value === undefined) sets.push({ name, line, target, ref: "host env" });
      else sets.push({ name, line, target, value, ...(INTERPOLATION.test(value) ? { interpolated: 1 as const } : {}) });
    }
    const files = typeof service.env_file === "string" ? [service.env_file] : Array.isArray(service.env_file) ? service.env_file : [];
    for (const f of files) {
      const rel = typeof f === "string" ? f : isObject(f) ? scalar(f.path) : undefined;
      if (rel) envFiles.push({ target, file: join(dir, rel), line: lineOf(lines, "env_file", from) });
    }
    const build = typeof service.build === "string" ? service.build : isObject(service.build) ? scalar(service.build.context) ?? "." : undefined;
    if (build !== undefined && !/^[a-z]+:\/\//.test(build)) contexts[target] = join(dir, build);
  }
  // Compose reads `.env` next to the file for interpolation on its own.
  return { kind: "env-source", source: "compose", sets, reads, envFiles, contexts };
}

function join(dir: string, rel: string): string {
  const out: string[] = [];
  for (const part of `${dir}/${rel}`.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && out.length) out.pop();
    else out.push(part);
  }
  return out.join("/");
}

// ---------------------------------------------------------------------------
// Framework config
// ---------------------------------------------------------------------------

/** The `{ … }` body after `key:` (first occurrence), with its starting line (0-based). */
function objectAfter(source: string, key: RegExp): { body: string; line: number } | undefined {
  const m = key.exec(source);
  if (!m) return undefined;
  const open = source.indexOf("{", m.index + m[0].length - 1);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return { body: source.slice(open + 1, i), line: source.slice(0, open).split("\n").length - 1 };
  }
  return undefined;
}

function configEntries(body: string, startLine: number, keyPattern: string): Array<{ name: string; value: string; line: number }> {
  const out: Array<{ name: string; value: string; line: number }> = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(new RegExp(`(?:^|[,{\\s])["'\`]?${keyPattern}["'\`]?\\s*(?::\\s*([^,\\n}]+))?\\s*(?=,|$|})`, "g"))) {
      out.push({ name: m[1], value: (m[2] ?? m[1]).trim(), line: startLine + i + 1 });
    }
  }
  return out;
}

function readNextConfig(source: string): EnvFileFacts {
  const env = objectAfter(source, /\benv\s*:\s*\{/);
  const sets: EnvSetFact[] = [];
  if (env) {
    for (const e of configEntries(env.body, env.line, "([A-Z][A-Z0-9_]*)")) {
      const literal = /^(["'`])(.*)\1$/.exec(e.value);
      sets.push({ name: e.name, line: e.line, target: "next.config", value: literal ? literal[2] : e.value, client: 1, ...(literal ? {} : { interpolated: 1 as const }) });
    }
  }
  return { kind: "env-source", source: "framework", sets, framework: "next" };
}

function readViteConfig(source: string): EnvFileFacts {
  const sets: EnvSetFact[] = [];
  const define = objectAfter(source, /\bdefine\s*:\s*\{/);
  if (define) {
    for (const e of configEntries(define.body, define.line, "(?:process\\.env|import\\.meta\\.env)\\.([A-Z][A-Z0-9_]*)")) {
      const literal = /^JSON\.stringify\(\s*(["'`])(.*)\1\s*\)$/.exec(e.value) ?? /^(["'`])(.*)\1$/.exec(e.value);
      sets.push({ name: e.name, line: e.line, target: "vite.config", value: literal ? literal[2] : e.value, client: 1, ...(literal ? {} : { interpolated: 1 as const }) });
    }
  }
  const prefix = /\benvPrefix\s*:\s*(\[[^\]]*\]|["'`][^"'`]*["'`])/.exec(source);
  const prefixes = prefix ? [...prefix[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]) : undefined;
  return { kind: "env-source", source: "framework", sets, framework: "vite", ...(prefixes?.length ? { prefixes } : {}) };
}

function readPrisma(source: string): EnvFileFacts {
  const reads: Array<[string, number, EnvReadFlags?]> = [];
  source.split("\n").forEach((text, i) => {
    if (/^\s*\/\//.test(text)) return;
    for (const m of text.matchAll(/\benv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g)) reads.push([m[1], i + 1, { r: 1 }]);
  });
  return reads.length ? { kind: "env-source", source: "framework", sets: [], reads } : { kind: "none" };
}
