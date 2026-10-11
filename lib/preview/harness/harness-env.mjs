// The preview's environment variables: committed .env.example-style files, then
// typed placeholders for every other key the bundled code reads.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { OUT, PROJECT, notes, state } from "./harness-context.mjs";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export const ENV_FILES = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.defaults",
  ".env.development",
  ".env.local.example",
  ".env.development.example",
  ".env.test",
];

/** Keys left alone: runtime/framework switches, where a fake value changes behaviour. */
export const ENV_LEAVE_ALONE = /^(NODE_ENV|NODE_\w+|NEXT_RUNTIME|NEXT_PHASE|__NEXT\w*|TURBOPACK|CI|VERCEL\w*|DEBUG|PORT|HOSTNAME|HOME|PATH|PWD|TZ|LANG|npm_\w+)$/;

/** Feature flags stay unset rather than accidentally on. */
export const ENV_FLAG = /(^|_)(ENABLE|ENABLED|DISABLE|DISABLED|FEATURE|FLAG|USE|IS|SHOW|HIDE|SKIP|MOCK)(_|$)/;

export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]] = value;
  }
  return out;
}

/** A plausible placeholder by the key's name — long enough for secret-length checks, valid as a URL where one is expected. */
export function placeholderFor(key) {
  const k = key.toUpperCase();
  if (/(DATABASE|DB|POSTGRES|PG|MYSQL|MONGO|REDIS|VALKEY)_?(URL|URI|DSN)$/.test(k)) {
    if (k.includes("MONGO")) return "mongodb://localhost.invalid:27017/preview";
    if (k.includes("REDIS") || k.includes("VALKEY")) return "redis://localhost.invalid:6379";
    if (k.includes("MYSQL")) return "mysql://preview:preview@localhost.invalid:3306/preview";
    return "postgres://preview:preview@localhost.invalid:5432/preview";
  }
  if (/(URL|URI|ENDPOINT|HOST|ORIGIN|DOMAIN)$/.test(k)) return "http://localhost.invalid";
  if (/PORT$/.test(k)) return "3000";
  if (/(SECRET|KEY|TOKEN|PASSWORD|PASS|SALT|PRIVATE|SIGNATURE)/.test(k)) return "graphreview-preview-placeholder-0123456789abcdef0123456789";
  if (/EMAIL$/.test(k)) return "preview@example.com";
  if (/(TIMEOUT|TTL|LIMIT|MAX|MIN|COUNT|SIZE|EXPIRES|EXPIRY)/.test(k)) return "60";
  return "preview-placeholder";
}

export function loadEnvFiles() {
  for (const name of ENV_FILES) {
    const file = path.join(PROJECT, name);
    if (!existsSync(file)) continue;
    const values = parseEnvFile(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (value === "" || key in state.envFileValues) continue;
      state.envFileValues[key] = value;
    }
  }
  for (const [key, value] of Object.entries(state.envFileValues)) {
    if (!process.env[key] && !ENV_LEAVE_ALONE.test(key)) process.env[key] = value;
  }
}

/** Every process.env key the bundled repo code reads statically, filled with a placeholder when still unset. */
export function fillEnvFromBundle() {
  const keys = new Set();
  for (const file of readdirSync(OUT)) {
    if (!file.endsWith(".js")) continue;
    const text = readFileSync(path.join(OUT, file), "utf8");
    for (const m of text.matchAll(/process\.env\.([A-Za-z_][\w]*)/g)) keys.add(m[1]);
    for (const m of text.matchAll(/process\.env\[\s*["']([A-Za-z_][\w]*)["']\s*\]/g)) keys.add(m[1]);
  }
  const filled = [];
  for (const key of keys) {
    if (process.env[key] || ENV_LEAVE_ALONE.test(key) || ENV_FLAG.test(key.toUpperCase())) continue;
    process.env[key] = placeholderFor(key);
    filled.push(key);
  }
  if (filled.length > 0) notes.add(`placeholder values for ${filled.slice(0, 8).join(", ")}${filled.length > 8 ? ` and ${filled.length - 8} more` : ""}`);
}

/** Vite-style import.meta.env, as a build-time constant like Vite makes it. */
export function importMetaEnv() {
  const env = { MODE: "development", DEV: true, PROD: false, SSR: false, BASE_URL: "/" };
  for (const [key, value] of Object.entries(state.envFileValues)) {
    if (/^(VITE_|PUBLIC_|REACT_APP_)/.test(key)) env[key] = value;
  }
  return env;
}
