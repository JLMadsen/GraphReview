/**
 * Typed env schemas in code (DESIGN.md §6.15 §1): the names a schema
 * declares, with type, default and whether they're optional. A lexical scan
 * like ../infra/code-facts.ts, run beside it and cached with it by blob.
 *
 *   TS/JS   t3-env `createEnv({ server, client })`, a zod / valibot object
 *           parsed from `process.env`, envalid `cleanEnv`
 *   Python  pydantic `BaseSettings` fields (`env_prefix`, `Field(alias=)`),
 *           django-environ `env("X", default=)`
 *   Go      struct tags `env:"X"` / `envconfig:"X"` with `default:` /
 *           `envDefault:` and `required:"true"`
 */
import type { EnvDeclVia } from "./types";

/** One declared name: how it's declared and what the schema says about it. */
export interface EnvDeclFact {
  via: EnvDeclVia;
  type?: string;
  default?: string;
  optional?: 1;
  client?: 1;
}

const UPPER = "[A-Z][A-Z0-9_]*";

/** The validator at the start of a schema entry's value: `z.string().url()` → `url`, `str({ default: "x" })` → `str`. */
function jsEntry(value: string): Omit<EnvDeclFact, "via"> | undefined {
  const zod = /^(?:z|v)\s*\.\s*(?:coerce\s*\.\s*)?(\w+)\s*\(/.exec(value);
  const envalid = /^(str|num|bool|url|port|email|host|json)\s*\(/.exec(value);
  if (!zod && !envalid) return undefined;
  let type = zod ? zod[1] : envalid![1];
  // A refinement names the type better (`z.string().url()`).
  const refined = /\)\s*\.\s*(url|email|uuid|int|ip|datetime)\s*\(/.exec(value);
  if (refined) type = refined[1];
  const out: Omit<EnvDeclFact, "via"> = { type };
  const def = /\.default\(\s*(["'`]?)([^)"'`]*)\1\s*\)|\bdefault\s*:\s*(["'`]?)([^,}"'`]*)\3/.exec(value);
  if (def) out.default = (def[2] ?? def[4] ?? "").trim();
  if (/\.(optional|nullish)\(\)/.test(value) || out.default !== undefined) out.optional = 1;
  return out;
}

function scanJs(source: string): Array<[string, number, EnvDeclFact]> {
  const t3 = /\bcreateEnv\s*\(/.test(source);
  const envalid = /\bcleanEnv\s*\(/.test(source);
  const zod = /\b(?:z|v)\.object\s*\(/.test(source) && /\b(?:process\.env|import\.meta\.env)\b/.test(source);
  if (!t3 && !envalid && !zod) return [];
  const via: EnvDeclVia = t3 ? "t3-env" : envalid ? "envalid" : "zod";
  const out: Array<[string, number, EnvDeclFact]> = [];
  const lines = source.split("\n");
  let section: "server" | "client" | "runtime" | undefined;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const sec = /^\s*(server|client|shared|runtimeEnv|experimental__runtimeEnv)\s*:\s*\{/.exec(text);
    if (sec) section = sec[1] === "client" ? "client" : /runtime/i.test(sec[1]) ? "runtime" : "server";
    if (section === "runtime") {
      if (/^\s*\}/.test(text)) section = undefined;
      continue;
    }
    const m = new RegExp(`^\\s*["']?(${UPPER})["']?\\s*:\\s*(.+)$`).exec(text);
    if (!m) continue;
    const entry = jsEntry(m[2].trim());
    if (!entry) continue;
    out.push([m[1], i + 1, { via, ...entry, ...(section === "client" ? { client: 1 as const } : {}) }]);
  }
  return out;
}

function scanPython(source: string): Array<[string, number, EnvDeclFact]> {
  const out: Array<[string, number, EnvDeclFact]> = [];
  const lines = source.split("\n");
  // django-environ: `env("X", default=…)`, `env.bool("X", default=False)`, when the file uses `environ`.
  if (/\bimport environ\b|\bfrom environ import\b/.test(source)) {
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(new RegExp(`\\benv(?:\\.(\\w+))?\\(\\s*["'](${UPPER})["']([^)]*)\\)`, "g"))) {
        const def = /default\s*=\s*(["']?)([^,)"']*)\1/.exec(m[3]);
        out.push([m[2], i + 1, { via: "django-environ", type: m[1] ?? "str", ...(def ? { default: def[2], optional: 1 as const } : {}) }]);
      }
    }
  }
  // pydantic BaseSettings: the class body's annotated fields.
  if (/BaseSettings/.test(source)) {
    for (let i = 0; i < lines.length; i++) {
      const cls = /^(\s*)class\s+\w+\s*\(([^)]*)\)\s*:/.exec(lines[i]);
      if (!cls || !/BaseSettings/.test(cls[2])) continue;
      const indent = cls[1].length;
      const body: Array<{ text: string; line: number }> = [];
      for (let j = i + 1; j < lines.length; j++) {
        const text = lines[j];
        if (text.trim() && (text.length - text.trimStart().length) <= indent) break;
        body.push({ text, line: j + 1 });
      }
      const prefix = /env_prefix\s*=\s*["'](\w*)["']/.exec(body.map((b) => b.text).join("\n"))?.[1] ?? "";
      for (const { text, line } of body) {
        const f = /^\s+([a-z_][a-zA-Z0-9_]*)\s*:\s*([^=#]+?)\s*(?:=\s*(.+?))?\s*(?:#.*)?$/.exec(text);
        if (!f || f[1] === "model_config" || f[1].startsWith("_")) continue;
        const alias = f[3] ? /(?:alias|validation_alias)\s*=\s*["'](\w+)["']/.exec(f[3])?.[1] : undefined;
        const name = alias ?? `${prefix}${f[1]}`.toUpperCase();
        const fieldDefault = f[3] ? (/^Field\(/.test(f[3]) ? /default\s*=\s*([^,)]+)/.exec(f[3])?.[1] ?? /^Field\(\s*([^,)=]+)\s*[,)]/.exec(f[3])?.[1] : f[3]) : undefined;
        const type = f[2].trim();
        out.push([
          name,
          line,
          {
            via: "pydantic",
            type,
            ...(fieldDefault !== undefined && fieldDefault !== "..." ? { default: fieldDefault.replace(/^["']|["']$/g, ""), optional: 1 as const } : {}),
            ...(/Optional\[|\| ?None/.test(type) ? { optional: 1 as const } : {}),
          },
        ]);
      }
    }
  }
  return out;
}

function scanGo(source: string): Array<[string, number, EnvDeclFact]> {
  if (!/`[^`]*\b(?:env|envconfig):"/.test(source)) return [];
  const out: Array<[string, number, EnvDeclFact]> = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\w+\s+([\w.*[\]]+)\s+`([^`]*)`/.exec(lines[i]);
    if (!m) continue;
    const tag = /\b(?:env|envconfig):"([A-Za-z_][A-Za-z0-9_]*)/.exec(m[2]);
    if (!tag) continue;
    const def = /\b(?:default|envDefault):"([^"]*)"/.exec(m[2]);
    const required = /\brequired:"true"|,required/.test(m[2]);
    out.push([tag[1], i + 1, { via: "go-tag", type: m[1], ...(def ? { default: def[1] } : {}), ...(!required ? { optional: 1 as const } : {}) }]);
  }
  return out;
}

/** The env schema entries of one file. */
export function scanEnvDecls(family: string, source: string): Array<[string, number, EnvDeclFact]> {
  if (family === "js") return scanJs(source);
  if (family === "python") return scanPython(source);
  if (family === "go") return scanGo(source);
  return [];
}
