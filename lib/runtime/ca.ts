// Company CA certificates, wherever this machine already has them.
//
// - The OS store (Windows certificate store, macOS keychain): Node trusts it
//   when started with `--use-system-ca` (the launcher does), and
//   `systemOnlyCertificates()` lists what it adds over Node's built-in list.
// - `NODE_EXTRA_CA_CERTS`: a .pem/.crt file the user points at (config.env).
//
// Tools that take a CA *file* instead (git, and the tools in preview install
// containers) need one bundle that replaces their own, so `combinedCaBundle`
// writes the public roots plus those extras to the data folder.
//
// Server-only.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { getDataDir } from "./paths";

const normalize = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

type TlsWithCaApi = typeof tls & {
  getCACertificates?: (type: string) => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};

/** OS-trusted certificates that Node's built-in (Mozilla) list doesn't have — where company CAs usually live. */
export function systemOnlyCertificates(): string[] {
  const { getCACertificates } = tls as TlsWithCaApi;
  if (typeof getCACertificates !== "function") return [];
  try {
    const bundled = new Set(tls.rootCertificates.map(normalize));
    return getCACertificates("system").filter((pem) => !bundled.has(normalize(pem)));
  } catch {
    return [];
  }
}

/** The PEM certificates in a file, or [] when it can't be read. */
function readPems(file: string): string[] {
  try {
    return readFileSync(file, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  } catch {
    return [];
  }
}

/**
 * Adds a CA file to the certificates this process trusts from now on. For a
 * dev server, where NODE_EXTRA_CA_CERTS arrived after Node started (Node reads
 * it only at startup). Needs Node 22.19+/24.5+; a no-op before that.
 */
export function addCaFileToDefaults(file: string): void {
  const { getCACertificates, setDefaultCACertificates } = tls as TlsWithCaApi;
  if (typeof getCACertificates !== "function" || typeof setDefaultCACertificates !== "function") return;
  const pems = readPems(file);
  if (pems.length === 0) return;
  try {
    setDefaultCACertificates([...getCACertificates("default"), ...pems]);
  } catch {
    /* best effort */
  }
}

let cachedBundle: { key: string; file: string } | undefined;

/**
 * One CA file with the public roots, the OS store's extras and `extraFiles`,
 * for tools that replace their own bundle with it. `undefined` when there is
 * nothing beyond the public roots to add. Rewritten only when an input changes.
 */
export function combinedCaBundle(extraFiles: readonly string[], name = "ca-bundle.crt"): string | undefined {
  const files = [...new Set(extraFiles.filter((f) => f && existsSync(f)).map((f) => path.resolve(f)))];
  const system = systemOnlyCertificates();
  if (files.length === 0 && system.length === 0) return undefined;
  const key = [name, system.length, ...files.map((f) => `${f}@${statSync(f).mtimeMs}`)].join("|");
  if (cachedBundle?.key === key && existsSync(cachedBundle.file)) return cachedBundle.file;
  const file = path.join(getDataDir(), name);
  writeFileSync(file, [...tls.rootCertificates, ...system, ...files.flatMap(readPems)].join("\n"), "utf8");
  cachedBundle = { key, file };
  return file;
}

/**
 * The CA file for GraphReview's own git commands, when `NODE_EXTRA_CA_CERTS`
 * names one. Without it git keeps its own setup (Git for Windows already
 * trusts the Windows store).
 */
export function gitCaBundle(): string | undefined {
  const extra = process.env.NODE_EXTRA_CA_CERTS?.trim();
  if (!extra || !existsSync(extra)) return undefined;
  return combinedCaBundle([extra], "git-ca-bundle.crt");
}
