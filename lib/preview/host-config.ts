// The user's own package-manager setup, handed to preview install containers
// (DESIGN.md §6.9) so a private registry or a closed network works with no
// GraphReview-specific configuration.
//
// Two things are gathered from this machine:
//
// - **Config files** — the user-level `.npmrc`, `.yarnrc`, `.yarnrc.yml` and
//   pip config: registry URLs, scopes and auth tokens. They are copied into a
//   staged home folder that becomes `$HOME` in the container. Settings that
//   name a path on this machine (cache, prefix, store, …) are dropped — they
//   mean nothing in the container — and a CA file setting is pointed at the
//   container's CA bundle instead. `${VAR}` references are resolved from this
//   process's environment by forwarding those variables.
//
// - **Certificates** — internal CAs, wherever this machine already trusts
//   them: the OS certificate store (Windows/macOS keychain, via Node's
//   `tls.getCACertificates("system")`), `NODE_EXTRA_CA_CERTS`, and any `cafile`
//   / `cert` the npm/pip config points at. Combined with the public roots into
//   one bundle that replaces each tool's own.
//
// Only install containers get these (they are online anyway, running the
// dependencies' install scripts); the containers that run the previewed code
// are offline and get none of it.
//
// Server-only.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { getDataDir } from "@/lib/runtime/paths";

/** Where the CA bundle lands inside an install container. */
export const CONTAINER_CA_FILE = "/tmp/graphreview-ca.crt";
/** `$HOME` inside an install container: the staged config files go here. */
export const CONTAINER_HOME = "/tmp/graphreview-home";

export interface HostPackageConfig {
  /** Folder whose contents become `$HOME` in the container, or `null` when there is nothing to copy. */
  homeDir: string | null;
  /** CA bundle file to copy to {@link CONTAINER_CA_FILE}, or `null` when no extra CAs were found. */
  caBundle: string | null;
  /** Environment variables the copied config files reference as `${VAR}`. */
  env: Record<string, string>;
  /** Short description of what was picked up, for the job log. */
  summary: string[];
}

// ---------------------------------------------------------------------------
// Finding the files
// ---------------------------------------------------------------------------

function firstExisting(candidates: Array<string | undefined>): string | undefined {
  return candidates.find((file): file is string => Boolean(file) && existsSync(file!));
}

function npmrcPath(): string | undefined {
  return firstExisting([process.env.NPM_CONFIG_USERCONFIG, process.env.npm_config_userconfig, path.join(os.homedir(), ".npmrc")]);
}

function pipConfigPath(): string | undefined {
  const home = os.homedir();
  return firstExisting([
    process.env.PIP_CONFIG_FILE,
    process.env.APPDATA ? path.join(process.env.APPDATA, "pip", "pip.ini") : undefined,
    path.join(home, "Library", "Application Support", "pip", "pip.conf"),
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "pip", "pip.conf"),
    path.join(home, ".pip", "pip.conf"),
  ]);
}

// ---------------------------------------------------------------------------
// Rewriting them for the container
// ---------------------------------------------------------------------------

/** A value that is a path on this machine: `C:\…`, `\\server\…`, `~/…`, or an absolute POSIX path. */
function isHostPath(value: string): boolean {
  const v = value.trim().replace(/^["']|["']$/g, "");
  return /^[A-Za-z]:[\\/]/.test(v) || v.startsWith("\\\\") || v.startsWith("~") || (v.startsWith("/") && !v.startsWith("//"));
}

const CA_KEYS = new Set(["cafile", "cert", "httpscafilepath", "cafilepath"]);

interface Rewritten {
  text: string;
  /** Host files referenced as CA files, to fold into the bundle. */
  caFiles: string[];
  /** `${VAR}` names used in the kept lines. */
  envRefs: string[];
}

/**
 * Rewrites an ini-style (`key = value`) or YAML (`key: value`) config file:
 * CA-file settings point at the container bundle, other settings whose value
 * is a host path are dropped, everything else (registries, scopes, tokens)
 * is kept verbatim.
 */
function rewriteConfig(text: string, separator: "=" | ":"): Rewritten {
  const caFiles: string[] = [];
  const envRefs = new Set<string>();
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(separator);
    const trimmed = line.trim();
    if (at === -1 || trimmed.startsWith("#") || trimmed.startsWith(";") || trimmed.startsWith("[")) {
      lines.push(line);
      continue;
    }
    const key = line.slice(0, at).trim().toLowerCase().replace(/^["']|["']$/g, "");
    const value = line.slice(at + 1).trim();
    if (CA_KEYS.has(key)) {
      if (isHostPath(value)) caFiles.push(value.replace(/^["']|["']$/g, "").replace(/^~(?=[\\/])/, os.homedir()));
      lines.push(`${line.slice(0, at + 1)} ${separator === ":" ? JSON.stringify(CONTAINER_CA_FILE) : CONTAINER_CA_FILE}`);
      continue;
    }
    if (isHostPath(value)) continue;
    for (const m of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) envRefs.add(m[1]);
    lines.push(line);
  }
  return { text: lines.join("\n"), caFiles, envRefs: [...envRefs] };
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

const normalize = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

/** OS-trusted certificates that Node's built-in (Mozilla) list doesn't have — where corporate CAs live. */
function systemOnlyCertificates(): string[] {
  const getCA = (tls as unknown as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  if (typeof getCA !== "function") return [];
  try {
    const bundled = new Set(tls.rootCertificates.map(normalize));
    return getCA("system").filter((pem) => !bundled.has(normalize(pem)));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

let cached: { at: number; config: Promise<HostPackageConfig> } | undefined;
/** The files rarely change; re-read at most this often. */
const TTL_MS = 60_000;

async function stage(): Promise<HostPackageConfig> {
  // A fresh folder per staging: an install may still be copying from the
  // previous one. Stagings older than a few minutes are no longer in use.
  const parent = path.join(getDataDir(), "preview-host");
  await mkdir(parent, { recursive: true });
  for (const name of await readdir(parent).catch(() => [] as string[])) {
    if (Date.now() - Number(name) > 10 * 60_000) await rm(path.join(parent, name), { recursive: true, force: true }).catch(() => undefined);
  }
  const root = path.join(parent, String(Date.now()));
  const homeDir = path.join(root, "home");
  await mkdir(homeDir, { recursive: true });

  const summary: string[] = [];
  const caFiles: string[] = [];
  const envRefs = new Set<string>();
  let copied = 0;

  const copy = async (source: string | undefined, target: string, separator: "=" | ":", label: string) => {
    if (!source) return;
    try {
      const rewritten = rewriteConfig(await readFile(source, "utf8"), separator);
      const file = path.join(homeDir, target);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, rewritten.text, "utf8");
      caFiles.push(...rewritten.caFiles);
      rewritten.envRefs.forEach((name) => envRefs.add(name));
      copied++;
      summary.push(label);
    } catch {
      /* unreadable — leave it out */
    }
  };

  await copy(npmrcPath(), ".npmrc", "=", "your .npmrc");
  await copy(firstExisting([path.join(os.homedir(), ".yarnrc")]), ".yarnrc", "=", "your .yarnrc");
  await copy(firstExisting([path.join(os.homedir(), ".yarnrc.yml")]), ".yarnrc.yml", ":", "your .yarnrc.yml");
  await copy(pipConfigPath(), path.join(".config", "pip", "pip.conf"), "=", "your pip config");

  // Certificates: OS store, NODE_EXTRA_CA_CERTS, and CA files the configs named.
  const extraPems: string[] = [];
  const systemCerts = systemOnlyCertificates();
  if (systemCerts.length > 0) {
    extraPems.push(...systemCerts);
    summary.push(`${systemCerts.length} certificate(s) from the system store`);
  }
  for (const file of new Set([process.env.NODE_EXTRA_CA_CERTS?.trim(), ...caFiles].map((f) => f && path.resolve(f)))) {
    if (!file || !existsSync(file)) continue;
    try {
      extraPems.push(await readFile(file, "utf8"));
      summary.push(`CA file ${path.basename(file)}`);
    } catch {
      /* unreadable */
    }
  }
  let caBundle: string | null = null;
  if (extraPems.length > 0) {
    caBundle = path.join(root, "ca-bundle.crt");
    await writeFile(caBundle, [...tls.rootCertificates, ...extraPems].join("\n"), "utf8");
  }

  const env: Record<string, string> = {};
  for (const name of envRefs) {
    const value = process.env[name];
    if (value) env[name] = value;
  }

  return { homeDir: copied > 0 ? homeDir : null, caBundle, env, summary };
}

/** This machine's package-manager config and CAs, staged for install containers. Cached briefly. */
export function hostPackageConfig(): Promise<HostPackageConfig> {
  if (!cached || Date.now() - cached.at > TTL_MS) {
    cached = { at: Date.now(), config: stage() };
  }
  return cached.config;
}
