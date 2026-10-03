// The user's settings file: `config.env` in the data folder
// (`~/.graphreview/config.env`, or `.data/config.env` under `npm run dev`).
//
// Plain `KEY=value` lines, read every time GraphReview starts. It is created
// on first start with every setting a user is likely to need, commented out,
// so turning one on is uncommenting a line. Variables already set in the
// environment win over the file.
//
// Plain JavaScript on purpose: the `npx graphreview` launcher (bin/) loads it
// before the app exists, and the app (instrumentation.ts) loads it under
// `npm run dev`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CONFIG_FILE_NAME = "config.env";

const TEMPLATE = `# GraphReview settings — read every time GraphReview starts.
#
# To use a setting, remove the "#" in front of it and fill in your value.
# Restart GraphReview afterwards. A variable that is also set in your
# environment (the terminal) wins over this file.

# --- Self-hosted GitLab -----------------------------------------------------
# GITLAB_API_URL=https://gitlab.example.com/api/v4
# GITLAB_WEB_URL=https://gitlab.example.com

# --- GitHub Enterprise ------------------------------------------------------
# GITHUB_API_URL=https://github.example.com/api/v3
# GITHUB_WEB_URL=https://github.example.com

# --- Docker images for previews, instead of Docker Hub ----------------------
# Your registry and the path where it mirrors Docker Hub's official images.
# Previews then pull e.g. <this>/node:22-bookworm-slim. If the registry needs
# a login, run "docker login registry.example.com" once.
# PREVIEW_IMAGE_REGISTRY=registry.example.com/dockerhub/library

# --- Company certificates ---------------------------------------------------
# Usually not needed: certificates installed in Windows / macOS are trusted
# automatically. Otherwise, a .pem or .crt file with your CA certificate(s);
# GraphReview, git clones and preview installs then all trust it.
# NODE_EXTRA_CA_CERTS=C:\\certs\\company-ca.pem

# --- Package registries for preview installs --------------------------------
# Usually not needed: your own .npmrc / .yarnrc / pip config is used.
# NPM_CONFIG_REGISTRY=https://nexus.example.com/repository/npm/
# PIP_INDEX_URL=https://nexus.example.com/repository/pypi/simple
# HTTPS_PROXY=http://proxy.example.com:8080
# NO_PROXY=localhost,127.0.0.1,.example.com
`;

/**
 * Parses `KEY=value` lines: `#` comments, blank lines and an optional
 * `export ` prefix are skipped; '...' and "..." quotes are removed (inside
 * double quotes, \n becomes a newline). Unquoted values are taken as written
 * — backslashes included, so Windows paths need no escaping — up to a " #"
 * comment.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseConfigEnv(text) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.lastIndexOf('"') > 0) {
      value = value.slice(1, value.lastIndexOf('"')).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.lastIndexOf("'") > 0) {
      value = value.slice(1, value.lastIndexOf("'"));
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

/**
 * The settings file in `dataDir`: created from the template when missing,
 * then parsed.
 * @param {string} dataDir
 * @returns {{ file: string, created: boolean, values: Record<string, string> }}
 */
export function loadConfigEnv(dataDir) {
  const file = path.join(dataDir, CONFIG_FILE_NAME);
  let created = false;
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true });
    try {
      writeFileSync(file, TEMPLATE, { encoding: "utf8", flag: "wx" });
      created = true;
    } catch {
      /* created concurrently, or not writable — read whatever is there */
    }
  }
  let values = {};
  try {
    values = parseConfigEnv(readFileSync(file, "utf8"));
  } catch {
    /* unreadable: no settings */
  }
  return { file, created, values };
}

/**
 * Copies settings into `env` where `env` doesn't already have them.
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, string>} values
 * @returns {string[]} the names that were applied
 */
export function applyConfigEnv(env, values) {
  const applied = [];
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined || env[key] === "") {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}
