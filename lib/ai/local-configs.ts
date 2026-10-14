// Finding AI providers the user has already configured for a local coding
// harness — OpenCode, Codex, Claude Code, Crush, Continue, Aider, Copilot CLI
// — or in the environment, for settings' "Use local config" (DESIGN.md §6.17).
//
// Every candidate is mapped onto the one provider shape GraphReview has
// (OpenAI-compatible `{ baseUrl, apiKey, model }`): a harness's own provider
// id is looked up in KNOWN_PROVIDERS for its OpenAI-compatible base URL, and
// a key is resolved the way that harness would (its config, its auth file,
// an env var it names). Keys stay on the server: `publicCandidate` is what
// the browser gets, and the import action rediscovers by id to read the key.
//
// Nothing here throws: a missing or unparseable file is just no candidates.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";

export interface LocalProviderCandidate {
  /** Stable across scans of the same files: `<harness>:<provider id>`. */
  id: string;
  harness: string;
  /** Suggested name for the saved provider. */
  name: string;
  baseUrl: string;
  /** Models the config names for this provider, default first. */
  models: string[];
  /** The harness's default model, when it belongs to this provider. */
  defaultModel?: string;
  apiKey?: string;
  /** Where the key came from, e.g. "auth.json" or "env OPENAI_API_KEY". */
  keySource?: string;
  /** The file it was found in (home shortened to ~), or "environment". */
  source: string;
  /** Why it can't be used as-is, e.g. an OAuth sign-in instead of a key. */
  note?: string;
}

/** A candidate as the browser sees it: no key, only whether there is one. */
export interface PublicLocalProviderCandidate extends Omit<LocalProviderCandidate, "apiKey"> {
  hasKey: boolean;
  /** No key found and the base URL isn't a local server — the user has to supply one. */
  needsKey: boolean;
}

type Env = Record<string, string | undefined>;

export interface DiscoverOptions {
  home?: string;
  env?: Env;
  platform?: NodeJS.Platform;
}

interface KnownProvider {
  name: string;
  baseUrl: string;
  envKeys: string[];
}

/** OpenAI-compatible endpoints for the provider ids harnesses use. */
const KNOWN_PROVIDERS: Record<string, KnownProvider> = {
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", envKeys: ["OPENAI_API_KEY"] },
  anthropic: { name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", envKeys: ["ANTHROPIC_API_KEY"] },
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", envKeys: ["OPENROUTER_API_KEY"] },
  google: {
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  },
  groq: { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", envKeys: ["GROQ_API_KEY"] },
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", envKeys: ["DEEPSEEK_API_KEY"] },
  mistral: { name: "Mistral", baseUrl: "https://api.mistral.ai/v1", envKeys: ["MISTRAL_API_KEY"] },
  xai: { name: "xAI", baseUrl: "https://api.x.ai/v1", envKeys: ["XAI_API_KEY"] },
  together: { name: "Together", baseUrl: "https://api.together.xyz/v1", envKeys: ["TOGETHER_API_KEY"] },
  fireworks: { name: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", envKeys: ["FIREWORKS_API_KEY"] },
  cerebras: { name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", envKeys: ["CEREBRAS_API_KEY"] },
  "github-copilot": { name: "GitHub Copilot", baseUrl: "https://api.githubcopilot.com", envKeys: [] },
  ollama: { name: "Ollama", baseUrl: "http://localhost:11434/v1", envKeys: [] },
  lmstudio: { name: "LM Studio", baseUrl: "http://localhost:1234/v1", envKeys: [] },
};

const PROVIDER_ALIASES: Record<string, string> = {
  gemini: "google",
  "google-generative-ai": "google",
  togetherai: "together",
  "x-ai": "xai",
  "lm-studio": "lmstudio",
  copilot: "github-copilot",
};

function known(id: string): KnownProvider | undefined {
  const key = id.toLowerCase();
  return KNOWN_PROVIDERS[PROVIDER_ALIASES[key] ?? key];
}

/** A server on this machine, which takes any key (or none). */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "0.0.0.0" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function publicCandidate(candidate: LocalProviderCandidate): PublicLocalProviderCandidate {
  const { apiKey, ...rest } = candidate;
  return { ...rest, hasKey: Boolean(apiKey), needsKey: !apiKey && !isLocalBaseUrl(candidate.baseUrl) };
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

interface Ctx {
  home: string;
  env: Env;
  platform: NodeJS.Platform;
}

function readText(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

/** JSON with `//` and `/* *\/` comments and trailing commas (JSONC), as most harness configs allow. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function readJson(file: string): Record<string, unknown> | null {
  const text = readText(file);
  if (text === null) return null;
  try {
    const value = parseJsonc(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function readYaml(file: string): Record<string, unknown> | null {
  const text = readText(file);
  if (text === null) return null;
  try {
    const value = yaml.load(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The TOML Codex's config.toml uses: `[a.b]` / `[a."b.c"]` tables and
 * one-line `key = value` pairs with string, number or boolean values.
 * Anything else (arrays, inline tables, multi-line strings) is skipped.
 */
export function parseSimpleToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let table = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([^[\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      table = root;
      for (const part of splitTomlKey(header[1])) {
        if (!isObject(table[part])) table[part] = {};
        table = table[part] as Record<string, unknown>;
      }
      continue;
    }
    const pair = /^("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const value = parseTomlValue(pair[2]);
    if (value === undefined) continue;
    const keys = splitTomlKey(pair[1]);
    let target = table;
    for (const part of keys.slice(0, -1)) {
      if (!isObject(target[part])) target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    target[keys[keys.length - 1]] = value;
  }
  return root;
}

function splitTomlKey(key: string): string[] {
  return (key.match(/"[^"]*"|'[^']*'|[^.\s]+/g) ?? []).map((part) => part.replace(/^["']|["']$/g, ""));
}

function parseTomlValue(raw: string): string | number | boolean | undefined {
  const value = raw.trim();
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (basic) return basic[1].replace(/\\(["\\])/g, "$1");
  const literal = /^'([^']*)'/.exec(value);
  if (literal) return literal[1];
  const bare = value.replace(/\s*#.*$/, "");
  if (bare === "true" || bare === "false") return bare === "true";
  if (/^-?\d+(\.\d+)?$/.test(bare)) return Number(bare);
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shortPath(ctx: Ctx, file: string): string {
  return file.startsWith(ctx.home) ? `~${file.slice(ctx.home.length).replace(/\\/g, "/")}` : file;
}

function xdgConfig(ctx: Ctx): string[] {
  const dirs = [ctx.env.XDG_CONFIG_HOME, path.join(ctx.home, ".config")].filter((d): d is string => Boolean(d));
  return [...new Set(dirs)];
}

function firstExisting(files: string[]): string | undefined {
  return files.find((file) => existsSync(file));
}

function envKey(ctx: Ctx, names: string[]): { key: string; source: string } | undefined {
  for (const name of names) {
    const value = str(ctx.env[name]);
    if (value) return { key: value, source: `env ${name}` };
  }
  return undefined;
}

/** `$VAR`, `${VAR}`, `{env:VAR}` → the env value; a value that only names a variable that isn't set → undefined. */
function resolveEnvRef(ctx: Ctx, value: string | undefined): { key: string; source: string } | undefined {
  if (!value) return undefined;
  const ref = /^(?:\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?|\{env:([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(value);
  if (ref) return envKey(ctx, [ref[1] ?? ref[2]]);
  // Continue's `${{ secrets.X }}` and other templating we can't resolve.
  if (value.includes("${{")) return undefined;
  return { key: value, source: "config" };
}

function uniq(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

function candidate(
  harness: string,
  providerId: string,
  fields: Omit<LocalProviderCandidate, "id" | "harness" | "models"> & { models: (string | undefined)[] }
): LocalProviderCandidate {
  const models = uniq([fields.defaultModel, ...fields.models]);
  return { ...fields, id: `${harness.toLowerCase().replace(/\s+/g, "-")}:${providerId}`, harness, models };
}

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

/** OpenCode: `~/.config/opencode/{config,opencode}.json[c]` + `~/.local/share/opencode/auth.json`. */
function openCode(ctx: Ctx): LocalProviderCandidate[] {
  const files = [
    ...xdgConfig(ctx).flatMap((dir) =>
      ["config.json", "opencode.json", "opencode.jsonc"].map((f) => path.join(dir, "opencode", f))
    ),
    ...(ctx.env.OPENCODE_CONFIG ? [ctx.env.OPENCODE_CONFIG] : []),
  ].filter((file) => existsSync(file));
  if (files.length === 0) return [];

  // OpenCode merges its config files; later ones win.
  let model: string | undefined;
  let smallModel: string | undefined;
  const providers: Record<string, Record<string, unknown>> = {};
  for (const file of files) {
    const config = readJson(file);
    if (!config) continue;
    model = str(config.model) ?? model;
    smallModel = str(config.small_model) ?? smallModel;
    if (isObject(config.provider)) {
      for (const [id, p] of Object.entries(config.provider)) {
        if (isObject(p)) providers[id] = { ...providers[id], ...p };
      }
    }
  }
  const configDir = path.dirname(files[files.length - 1]);
  const source = shortPath(ctx, files[files.length - 1]);

  const dataDir = ctx.env.XDG_DATA_HOME ?? path.join(ctx.home, ".local", "share");
  const authFile = path.join(dataDir, "opencode", "auth.json");
  const auth = readJson(authFile) ?? {};

  const split = (ref: string | undefined) => {
    const at = ref?.indexOf("/") ?? -1;
    return ref && at > 0 ? { provider: ref.slice(0, at), model: ref.slice(at + 1) } : undefined;
  };
  const main = split(model);
  const small = split(smallModel);

  const ids = uniq([...Object.keys(providers), ...Object.keys(auth), main?.provider, small?.provider]);
  const out: LocalProviderCandidate[] = [];
  for (const id of ids) {
    const p = providers[id] ?? {};
    const options = isObject(p.options) ? p.options : {};
    const k = known(id);
    const baseUrl = str(options.baseURL) ?? k?.baseUrl;
    if (!baseUrl) continue;

    let key = resolveOpenCodeValue(ctx, configDir, str(options.apiKey));
    if (key?.source === "config") key = { ...key, source };
    const entry = auth[id];
    if (!key && isObject(entry) && entry.type === "api" && str(entry.key)) {
      key = { key: str(entry.key)!, source: shortPath(ctx, authFile) };
    }
    if (!key && k) key = envKey(ctx, k.envKeys);
    const oauth = !key && isObject(entry) && entry.type === "oauth";

    out.push(
      candidate("OpenCode", id, {
        name: `${str(p.name) ?? k?.name ?? id} (OpenCode)`,
        baseUrl,
        defaultModel: main?.provider === id ? main.model : undefined,
        models: [small?.provider === id ? small.model : undefined, ...Object.keys(isObject(p.models) ? p.models : {})],
        apiKey: key?.key,
        keySource: key?.source,
        source,
        note: oauth ? "Signed in with OAuth in OpenCode, which GraphReview can't reuse. Paste an API key." : undefined,
      })
    );
  }
  return out;
}

/** OpenCode's `{env:VAR}` and `{file:path}` substitutions. */
function resolveOpenCodeValue(ctx: Ctx, configDir: string, value: string | undefined) {
  if (!value) return undefined;
  const file = /^\{file:(.+)\}$/.exec(value);
  if (file) {
    const target = file[1].startsWith("~") ? path.join(ctx.home, file[1].slice(1)) : path.resolve(configDir, file[1]);
    const text = readText(target)?.trim();
    return text ? { key: text, source: shortPath(ctx, target) } : undefined;
  }
  return resolveEnvRef(ctx, value);
}

/** Codex: `~/.codex/config.toml` (model, model_provider, [model_providers.*], [profiles.*]) + `auth.json`. */
function codex(ctx: Ctx): LocalProviderCandidate[] {
  const dir = ctx.env.CODEX_HOME ?? path.join(ctx.home, ".codex");
  const configFile = path.join(dir, "config.toml");
  const text = readText(configFile);
  if (text === null) return [];
  const config = parseSimpleToml(text);
  const auth = readJson(path.join(dir, "auth.json")) ?? {};
  const source = shortPath(ctx, configFile);

  const defaultProvider = str(config.model_provider) ?? "openai";
  const modelsByProvider = new Map<string, string[]>();
  const addModel = (provider: string, model: string | undefined) => {
    if (model) modelsByProvider.set(provider, [...(modelsByProvider.get(provider) ?? []), model]);
  };
  addModel(defaultProvider, str(config.model));
  if (isObject(config.profiles)) {
    for (const profile of Object.values(config.profiles)) {
      if (isObject(profile)) addModel(str(profile.model_provider) ?? defaultProvider, str(profile.model));
    }
  }

  const custom = isObject(config.model_providers) ? config.model_providers : {};
  const ids = uniq([...Object.keys(custom), ...modelsByProvider.keys()]);
  const out: LocalProviderCandidate[] = [];
  for (const id of ids) {
    const p = isObject(custom[id]) ? custom[id] : {};
    const k = id === "oss" ? KNOWN_PROVIDERS.ollama : known(id);
    const baseUrl = str(p.base_url) ?? k?.baseUrl;
    if (!baseUrl) continue;
    const models = modelsByProvider.get(id) ?? [];

    let key = str(p.env_key) ? envKey(ctx, [str(p.env_key)!]) : undefined;
    let note: string | undefined;
    if (!key && id === "openai") {
      const saved = str(auth.OPENAI_API_KEY);
      key = saved ? { key: saved, source: shortPath(ctx, path.join(dir, "auth.json")) } : envKey(ctx, ["OPENAI_API_KEY"]);
      if (!key && isObject(auth.tokens)) {
        note = "Signed in with ChatGPT in Codex, which GraphReview can't reuse. Paste an OpenAI API key.";
      }
    } else if (!key && k) {
      key = envKey(ctx, k.envKeys);
    }

    out.push(
      candidate("Codex", id, {
        name: `${str(p.name) ?? k?.name ?? id} (Codex)`,
        baseUrl,
        defaultModel: models[0],
        models,
        apiKey: key?.key,
        keySource: key?.source,
        source,
        note,
      })
    );
  }
  return out;
}

/** Claude Code: `~/.claude/settings.json`'s `env` block and `model`. Only with a key or a full model id. */
function claudeCode(ctx: Ctx): LocalProviderCandidate[] {
  const dir = ctx.env.CLAUDE_CONFIG_DIR ?? path.join(ctx.home, ".claude");
  const file = path.join(dir, "settings.json");
  const settings = readJson(file);
  if (!settings) return [];
  const env = { ...ctx.env, ...(isObject(settings.env) ? settings.env : {}) } as Env;
  const read = (name: string) => str(env[name]);

  // Aliases like "sonnet" or "opus[1m]" aren't model ids an API accepts.
  const fullId = (model: string | undefined) => (model && /^claude-[\w.-]+$/.test(model) ? model : undefined);
  const models = uniq([
    fullId(read("ANTHROPIC_MODEL")),
    fullId(str(settings.model)),
    fullId(read("ANTHROPIC_DEFAULT_OPUS_MODEL")),
    fullId(read("ANTHROPIC_DEFAULT_SONNET_MODEL")),
    fullId(read("ANTHROPIC_DEFAULT_HAIKU_MODEL")),
    fullId(read("ANTHROPIC_SMALL_FAST_MODEL")),
  ]);
  const keyName = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].find((name) => read(name));
  if (!keyName && models.length === 0) return [];

  const base = (read("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com").replace(/\/+$/, "");
  return [
    candidate("Claude Code", "anthropic", {
      name: "Anthropic (Claude Code)",
      baseUrl: /\/v1$/.test(base) ? base : `${base}/v1`,
      defaultModel: models[0],
      models,
      apiKey: keyName ? read(keyName) : undefined,
      keySource: keyName ? `${isObject(settings.env) && settings.env[keyName] ? shortPath(ctx, file) : "env"} ${keyName}` : undefined,
      source: shortPath(ctx, file),
      note: keyName ? undefined : "Claude Code signs in with a Claude account, which GraphReview can't reuse. Paste an Anthropic API key.",
    }),
  ];
}

/** Crush: `crush.json` with `providers` and `models.large` / `models.small`. */
function crush(ctx: Ctx): LocalProviderCandidate[] {
  const file = firstExisting([
    ...xdgConfig(ctx).map((dir) => path.join(dir, "crush", "crush.json")),
    ...(ctx.platform === "win32" && ctx.env.LOCALAPPDATA ? [path.join(ctx.env.LOCALAPPDATA, "crush", "crush.json")] : []),
  ]);
  const config = file ? readJson(file) : null;
  if (!file || !config) return [];
  const providers = isObject(config.providers) ? config.providers : {};
  const selected = isObject(config.models) ? config.models : {};
  const pick = (slot: string) => {
    const m = selected[slot];
    return isObject(m) ? { provider: str(m.provider), model: str(m.model) } : undefined;
  };
  const large = pick("large");
  const small = pick("small");

  const out: LocalProviderCandidate[] = [];
  for (const id of uniq([...Object.keys(providers), large?.provider, small?.provider])) {
    const p = isObject(providers[id]) ? providers[id] : {};
    const k = known(str(p.type) === "openai" && !p.base_url ? "openai" : id);
    const baseUrl = str(p.base_url) ?? k?.baseUrl;
    if (!baseUrl) continue;
    const listed = Array.isArray(p.models) ? p.models.map((m) => (isObject(m) ? str(m.id) : undefined)) : [];
    const key = resolveEnvRef(ctx, str(p.api_key)) ?? (k ? envKey(ctx, k.envKeys) : undefined);
    out.push(
      candidate("Crush", id, {
        name: `${str(p.name) ?? k?.name ?? id} (Crush)`,
        baseUrl,
        defaultModel: large?.provider === id ? large.model : undefined,
        models: [small?.provider === id ? small.model : undefined, ...listed],
        apiKey: key?.key,
        keySource: key?.source === "config" ? shortPath(ctx, file) : key?.source,
        source: shortPath(ctx, file),
      })
    );
  }
  return out;
}

/** Continue: `~/.continue/config.yaml` (or the older config.json); one candidate per provider + endpoint + key. */
function continueDev(ctx: Ctx): LocalProviderCandidate[] {
  const dir = path.join(ctx.home, ".continue");
  const yamlFile = path.join(dir, "config.yaml");
  const jsonFile = path.join(dir, "config.json");
  const file = existsSync(yamlFile) ? yamlFile : existsSync(jsonFile) ? jsonFile : undefined;
  const config = file ? (file === yamlFile ? readYaml(file) : readJson(file)) : null;
  if (!file || !config || !Array.isArray(config.models)) return [];

  const groups = new Map<string, { provider: string; baseUrl: string; rawKey?: string; models: string[] }>();
  for (const m of config.models) {
    if (!isObject(m)) continue;
    const provider = str(m.provider);
    const model = str(m.model);
    if (!provider || !model) continue;
    let baseUrl = str(m.apiBase) ?? known(provider)?.baseUrl;
    if (!baseUrl) continue;
    if (provider === "ollama" && !/\/v1\/?$/.test(baseUrl)) baseUrl = `${baseUrl.replace(/\/+$/, "")}/v1`;
    const rawKey = str(m.apiKey);
    const groupKey = `${provider}|${baseUrl}|${rawKey ?? ""}`;
    const group = groups.get(groupKey) ?? { provider, baseUrl, rawKey, models: [] };
    group.models.push(model);
    groups.set(groupKey, group);
  }

  return [...groups.values()].map((g, i) => {
    const k = known(g.provider);
    const key = resolveEnvRef(ctx, g.rawKey) ?? (k ? envKey(ctx, k.envKeys) : undefined);
    return candidate("Continue", groups.size > 1 ? `${g.provider}-${i}` : g.provider, {
      name: `${k?.name ?? g.provider} (Continue)`,
      baseUrl: g.baseUrl,
      defaultModel: g.models[0],
      models: g.models,
      apiKey: key?.key,
      keySource: key?.source === "config" ? shortPath(ctx, file) : key?.source,
      source: shortPath(ctx, file),
      note: !key && g.rawKey?.includes("${{") ? "The key is a Continue secret, which GraphReview can't read. Paste it." : undefined,
    });
  });
}

/** Aider: `~/.aider.conf.yml` — `model`, `openai-api-base`, `openai-api-key`, `anthropic-api-key`. */
function aider(ctx: Ctx): LocalProviderCandidate[] {
  const file = path.join(ctx.home, ".aider.conf.yml");
  const config = readYaml(file);
  if (!config) return [];
  const source = shortPath(ctx, file);
  const model = str(config.model);
  const out: LocalProviderCandidate[] = [];

  const openaiBase = str(config["openai-api-base"]);
  const openaiKey = str(config["openai-api-key"]);
  if (openaiBase || openaiKey || model?.startsWith("openai/")) {
    const key = openaiKey ? { key: openaiKey, source } : envKey(ctx, ["OPENAI_API_KEY"]);
    out.push(
      candidate("Aider", "openai", {
        name: openaiBase ? "OpenAI-compatible (Aider)" : "OpenAI (Aider)",
        baseUrl: openaiBase ?? KNOWN_PROVIDERS.openai.baseUrl,
        defaultModel: model && !/^(anthropic|openrouter|gemini|ollama)\//.test(model) ? model.replace(/^openai\//, "") : undefined,
        models: [],
        apiKey: key?.key,
        keySource: key?.source,
        source,
      })
    );
  }
  const anthropicKey = str(config["anthropic-api-key"]);
  if (anthropicKey) {
    const claude = model?.replace(/^anthropic\//, "");
    out.push(
      candidate("Aider", "anthropic", {
        name: "Anthropic (Aider)",
        baseUrl: KNOWN_PROVIDERS.anthropic.baseUrl,
        defaultModel: claude?.startsWith("claude-") ? claude : undefined,
        models: [],
        apiKey: anthropicKey,
        keySource: source,
        source,
      })
    );
  }
  return out;
}

/** GitHub Copilot CLI: `~/.copilot/settings.json` (or config.json) `model`. The sign-in lives in the OS keychain. */
function copilot(ctx: Ctx): LocalProviderCandidate[] {
  const dir = ctx.env.COPILOT_HOME ?? path.join(ctx.home, ".copilot");
  if (!existsSync(dir)) return [];
  const files = ["settings.json", "config.json"].map((f) => path.join(dir, f));
  let model: string | undefined;
  for (const file of files) model ??= str(readJson(file)?.model);
  return [
    candidate("Copilot CLI", "github-copilot", {
      name: "GitHub Copilot (Copilot CLI)",
      baseUrl: KNOWN_PROVIDERS["github-copilot"].baseUrl,
      defaultModel: model,
      models: [],
      source: shortPath(ctx, firstExisting(files) ?? dir),
      note: "Copilot CLI keeps its GitHub sign-in in the OS keychain. Paste a token the Copilot API accepts.",
    }),
  ];
}

/** Provider keys set in GraphReview's own environment (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, …). */
function environment(ctx: Ctx): LocalProviderCandidate[] {
  const out: LocalProviderCandidate[] = [];
  for (const [id, k] of Object.entries(KNOWN_PROVIDERS)) {
    const key = envKey(ctx, k.envKeys);
    if (!key) continue;
    out.push(
      candidate("Environment", id, {
        name: k.name,
        baseUrl: (id === "openai" && str(ctx.env.OPENAI_BASE_URL)) || k.baseUrl,
        models: [],
        apiKey: key.key,
        keySource: key.source,
        source: "environment",
      })
    );
  }
  return out;
}

const HARNESSES = [openCode, codex, claudeCode, crush, continueDev, aider, copilot, environment];

/** Every provider found in the usual config locations, in harness order. */
export function discoverLocalProviders(options: DiscoverOptions = {}): LocalProviderCandidate[] {
  const ctx: Ctx = {
    home: options.home ?? homedir(),
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
  };
  return HARNESSES.flatMap((harness) => {
    try {
      return harness(ctx);
    } catch {
      return [];
    }
  });
}
