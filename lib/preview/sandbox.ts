// The Docker sandbox the before/after preview runs PR code in (DESIGN.md §6.9).
//
// Everything goes through the `docker` CLI on this machine. Nothing is
// bind-mounted from the host's filesystem (host paths are awkward across
// Docker Desktop's VM boundary on Windows/macOS), so files travel with
// `docker cp`, and the only mounts are named volumes the daemon owns:
//
//   graphreview-preview-harness-<v>   esbuild/react/postcss for the Node harness
//   graphreview-preview-deps-<hash>   one repo's installed dependencies,
//                                     keyed by its manifests + lockfile, so
//                                     base and head share it when unchanged
//
// A run container gets no network, capped memory/CPU/processes and a wall-
// clock limit. Installs are the only step that goes online, and they carry
// GraphReview's own CA settings (`NODE_EXTRA_CA_CERTS`) and registry/proxy
// settings, so a closed-network setup needs nothing extra.
//
// Docker is optional: without it, `getDockerStatus()` says why and the UI
// disables previews; nothing else in the app needs it.
//
// Server-only (spawns processes). Worker-only in practice.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { getDataDir } from "@/lib/runtime/paths";
import { DEFAULT_NODE_MAJOR } from "./node-version";
import type { PreviewHarnessResult, PreviewRuntime } from "./types";

export const RESULT_MARKER = "@@GRAPHREVIEW_PREVIEW_RESULT@@";

/** Bump when the harness's own package set changes, to force a fresh harness volume. */
const HARNESS_VERSION = "2";
const HARNESS_PACKAGES = ["esbuild@0.25", "react@19", "react-dom@19", "postcss@8", "happy-dom@15", "@happy-dom/global-registrator@15"];

/**
 * `PREVIEW_IMAGE_REGISTRY` — a registry/namespace prefix such as
 * `mirror.corp/library` for closed networks, so the sandbox images come from
 * an internal mirror instead of Docker Hub. Empty by default.
 */
function mirrorPrefix(): string {
  const prefix = process.env.PREVIEW_IMAGE_REGISTRY?.trim() ?? "";
  return prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
}

// Debian, not Alpine: native npm/pip packages mostly ship glibc builds.
/** `PREVIEW_NODE_IMAGE` pins one image for every repo; otherwise it follows the repo's Node version (./node-version.ts). */
const NODE_IMAGE_OVERRIDE = process.env.PREVIEW_NODE_IMAGE?.trim() || undefined;
/** The image for a Node major, unless `PREVIEW_NODE_IMAGE` pins one. */
export function nodeImageFor(major: number): string {
  return NODE_IMAGE_OVERRIDE ?? `${mirrorPrefix()}node:${major}-bookworm-slim`;
}
const NODE_IMAGE = nodeImageFor(DEFAULT_NODE_MAJOR);
const PYTHON_IMAGE = process.env.PREVIEW_PYTHON_IMAGE?.trim() || `${mirrorPrefix()}python:3.12-slim`;
/** A positive number from the environment, else `fallback` — Compose passes unset optional vars as "". */
function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim() || NaN);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const RUN_TIMEOUT_MS = envMs("PREVIEW_RUN_TIMEOUT_MS", 120_000);
const INSTALL_TIMEOUT_MS = envMs("PREVIEW_INSTALL_TIMEOUT_MS", 15 * 60_000);
// 2 GB: bundling a Next.js server layout with its imports (Next, a DB driver,
// a queue client…) peaked at 1.13 GB, and the kernel then kills esbuild's
// process — "The service was stopped". Set `PREVIEW_MEMORY` to change it.
const MEMORY = process.env.PREVIEW_MEMORY?.trim() || "2g";
const CPUS = process.env.PREVIEW_CPUS || "1";
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

type Logger = (message: string) => void;

export class SandboxUnavailableError extends Error {
  override readonly name = "SandboxUnavailableError";
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function docker(args: string[], timeoutMs = 60_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new SandboxUnavailableError(DOCKER_MISSING));
          return;
        }
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      }
    );
  });
}

async function dockerOk(args: string[], what: string, timeoutMs?: number): Promise<string> {
  const result = await docker(args, timeoutMs);
  if (result.code !== 0) {
    throw new Error(`${what} failed: ${(result.stderr || result.stdout).trim().slice(-600)}`);
  }
  return result.stdout;
}

const DOCKER_MISSING =
  "Previews run the changed code in Docker containers, and Docker isn't installed. Install Docker Desktop " +
  "(or Docker Engine) to use them — everything else in GraphReview works without it.";
const DOCKER_STOPPED = "Docker is installed but not running. Start Docker Desktop (or the Docker engine) to run previews.";

/** Whether previews can run here, and if not, a fixable reason. */
export interface DockerStatus {
  available: boolean;
  reason?: string;
}

/** How long a Docker probe result is reused — the UI asks on every poll. */
const DOCKER_STATUS_TTL_MS = 15_000;
let dockerStatusCache: { at: number; status: Promise<DockerStatus> } | undefined;

async function probeDocker(): Promise<DockerStatus> {
  try {
    // Short: this runs inside the preview endpoints' request handlers, and a
    // daemon that is still starting can hang `docker version` for a long time.
    const result = await docker(["version", "--format", "{{.Server.Version}}"], 4_000);
    return result.code === 0 ? { available: true } : { available: false, reason: DOCKER_STOPPED };
  } catch (error) {
    if (error instanceof SandboxUnavailableError) return { available: false, reason: error.message };
    return { available: false, reason: (error as Error).message };
  }
}

/** Probes Docker (cached for a few seconds). Never throws. */
export function getDockerStatus(): Promise<DockerStatus> {
  if (!dockerStatusCache || Date.now() - dockerStatusCache.at > DOCKER_STATUS_TTL_MS) {
    dockerStatusCache = { at: Date.now(), status: probeDocker() };
  }
  return dockerStatusCache.status;
}

/** Throws {@link SandboxUnavailableError} with a fixable message when Docker can't be reached. */
export async function assertDockerAvailable(): Promise<void> {
  dockerStatusCache = undefined;
  const status = await getDockerStatus();
  if (!status.available) throw new SandboxUnavailableError(status.reason ?? DOCKER_STOPPED);
}

const pulled = new Set<string>();

async function ensureImage(image: string, log: Logger): Promise<void> {
  if (pulled.has(image)) return;
  const inspect = await docker(["image", "inspect", image, "--format", "{{.Id}}"]);
  if (inspect.code !== 0) {
    log(`pulling ${image}`);
    await dockerOk(["pull", image], `docker pull ${image}`, INSTALL_TIMEOUT_MS);
  }
  pulled.add(image);
}

export function imageFor(runtime: PreviewRuntime): string {
  return runtime === "python" ? PYTHON_IMAGE : NODE_IMAGE;
}

/** A container that is always removed, whatever happens. */
async function withContainer<T>(createArgs: string[], fn: (id: string) => Promise<T>): Promise<T> {
  const id = (await dockerOk(["create", ...createArgs], "docker create")).trim();
  try {
    return await fn(id);
  } finally {
    await docker(["rm", "-f", id]).catch(() => undefined);
  }
}

/** `docker cp <dir>/. <id>:<dest>` — copies a directory's contents. */
async function copyIn(id: string, dir: string, dest: string): Promise<void> {
  await dockerOk(["cp", `${dir}${path.sep}.`, `${id}:${dest}`], "docker cp", 10 * 60_000);
}

/** Starts a created container attached, with a wall-clock limit (killed when it runs over). */
function startAttached(id: string, timeoutMs: number, log?: Logger): Promise<ExecResult & { timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["start", "-a", id], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (stderr.length < 64_000) stderr += text;
      if (log) for (const line of text.split("\n")) if (line.trim()) log(line.trim().slice(0, 300));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      void docker(["kill", id]).catch(() => undefined);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Online steps (installs): GraphReview's own network settings, carried over
// ---------------------------------------------------------------------------

/** Where the CA bundle lands inside an install container. */
const CONTAINER_CA_FILE = "/tmp/graphreview-ca.crt";

/**
 * Settings an install container inherits from GraphReview's environment, when set there:
 * package registries (npm, yarn, corepack, pip) and proxies. Empty values are
 * dropped — an empty `NPM_CONFIG_REGISTRY` would break npm, not reset it.
 *
 * Upper-case `NPM_CONFIG_*` only: npm itself injects dozens of lower-case
 * `npm_config_*` variables (cache, prefix, user config — host paths) into
 * every process it starts, GraphReview included, and those must not leak in.
 */
const FORWARDED_ENV = /^(NPM_CONFIG_\w+|YARN_NPM_\w+|COREPACK_NPM_\w+|PIP_\w+|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy)$/;

function forwardedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (FORWARDED_ENV.test(key) && value?.trim()) env[key] = value.trim();
  }
  // corepack fetches pnpm/yarn themselves from a registry of its own setting.
  const registry = env.NPM_CONFIG_REGISTRY;
  if (registry && !env.COREPACK_NPM_REGISTRY) env.COREPACK_NPM_REGISTRY = registry;
  return env;
}

/**
 * A full CA bundle for install containers when `NODE_EXTRA_CA_CERTS` is set:
 * Node's public root certificates plus the extra ones. `NODE_EXTRA_CA_CERTS`
 * usually holds only the internal CAs, and pip/curl/git need a bundle that
 * *replaces* their own, so the public roots have to be in it too. Written to
 * the data folder; `null` when no extra CAs are configured.
 */
async function caBundle(): Promise<string | null> {
  const file = process.env.NODE_EXTRA_CA_CERTS?.trim();
  if (!file || !existsSync(file)) return null;
  const bundle = path.join(getDataDir(), "preview-ca-bundle.crt");
  await writeFile(bundle, [...rootCertificates, await readFile(file, "utf8")].join("\n"), "utf8");
  return bundle;
}

/** Runs `script` in a container that may go online, with the worker's CA bundle and registry settings. */
async function runOnline(options: {
  image: string;
  mounts: string[];
  workdir?: string;
  script: string;
  timeoutMs: number;
  before?: (id: string) => Promise<void>;
}): Promise<ExecResult & { timedOut: boolean }> {
  const env: Record<string, string> = { CI: "1", ...forwardedEnv() };
  const ca = await caBundle();
  if (ca) {
    // A full bundle (public roots + internal CAs), so it can replace each tool's own.
    Object.assign(env, {
      NODE_EXTRA_CA_CERTS: CONTAINER_CA_FILE,
      PIP_CERT: CONTAINER_CA_FILE,
      SSL_CERT_FILE: CONTAINER_CA_FILE,
      REQUESTS_CA_BUNDLE: CONTAINER_CA_FILE,
      GIT_SSL_CAINFO: CONTAINER_CA_FILE,
    });
  }
  const args = [...options.mounts.flatMap((m) => ["-v", m])];
  if (options.workdir) args.push("-w", options.workdir);
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  args.push(options.image, "sh", "-c", options.script);
  return withContainer(args, async (id) => {
    if (ca) await dockerOk(["cp", ca, `${id}:${CONTAINER_CA_FILE}`], "docker cp (CA bundle)");
    await options.before?.(id);
    return startAttached(id, options.timeoutMs);
  });
}

async function volumeExists(name: string): Promise<boolean> {
  return (await docker(["volume", "inspect", name])).code === 0;
}

// ---------------------------------------------------------------------------
// Harness volume (Node only)
// ---------------------------------------------------------------------------

const HARNESS_VOLUME = `graphreview-preview-harness-${HARNESS_VERSION}`;
let harnessReady = false;

async function ensureHarnessVolume(log: Logger): Promise<void> {
  if (harnessReady) return;
  await ensureImage(NODE_IMAGE, log);
  const script = [
    "set -e",
    "if [ -f /harness/.ready ]; then exit 0; fi",
    "cd /harness",
    "echo '{\"name\":\"graphreview-preview-harness\",\"private\":true}' > package.json",
    `npm install --no-audit --no-fund --loglevel=error ${HARNESS_PACKAGES.join(" ")}`,
    "touch /harness/.ready",
  ].join("\n");
  if (!(await volumeExists(HARNESS_VOLUME))) log("installing the preview harness (first run only)");
  const result = await runOnline({
    image: NODE_IMAGE,
    mounts: [`${HARNESS_VOLUME}:/harness`],
    script,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(`Installing the preview harness failed: ${result.stderr.trim().slice(-600)}`);
  }
  harnessReady = true;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

const NODE_MANIFESTS = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"];
const PYTHON_MANIFESTS = ["requirements.txt", "pyproject.toml", "setup.py", "setup.cfg", "Pipfile.lock", "poetry.lock"];

async function manifestHash(projectDir: string, files: readonly string[], image: string): Promise<string | null> {
  const hash = createHash("sha1").update(image);
  let found = false;
  for (const name of files) {
    const file = path.join(projectDir, name);
    if (!existsSync(file)) continue;
    found = true;
    hash.update(name).update(await readFile(file));
  }
  return found ? hash.digest("hex").slice(0, 16) : null;
}

function nodeInstallCommand(projectDir: string): string {
  const has = (name: string) => existsSync(path.join(projectDir, name));
  if (has("pnpm-lock.yaml")) {
    // Hoisted: a flat node_modules, so everything lives inside the one mounted volume.
    return "corepack enable && pnpm install --frozen-lockfile --config.node-linker=hoisted || pnpm install --config.node-linker=hoisted";
  }
  if (has("yarn.lock")) {
    return "corepack enable && (YARN_NODE_LINKER=node-modules yarn install --frozen-lockfile || YARN_NODE_LINKER=node-modules yarn install)";
  }
  if (has("package-lock.json") || has("npm-shrinkwrap.json")) {
    return "npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error";
  }
  return "npm install --no-audit --no-fund --loglevel=error";
}

function pythonInstallCommand(projectDir: string): string {
  const has = (name: string) => existsSync(path.join(projectDir, name));
  if (has("requirements.txt")) return "pip install --quiet --disable-pip-version-check --target /deps -r requirements.txt";
  if (has("pyproject.toml") || has("setup.py")) return "pip install --quiet --disable-pip-version-check --target /deps .";
  return "true";
}

export interface PreparedDeps {
  /** Named volume to mount, or undefined when there's nothing to install or the install failed. */
  volume?: string;
  /** Shown to the user: "cached", "installed", "none", "failed: …". */
  status: string;
}

/**
 * Installs the project's dependencies into a named volume keyed by its
 * manifests, unless that volume is already complete. Never throws for a
 * failed install: the preview still runs, with unresolved imports stubbed.
 */
export async function prepareDeps(
  runtime: PreviewRuntime,
  treeDir: string,
  projectRoot: string,
  log: Logger,
  /** The image both sides run on; defaults to the runtime's default image. Part of the cache key, since native modules differ per Node version. */
  image: string = imageFor(runtime)
): Promise<PreparedDeps> {
  const projectDir = path.join(treeDir, projectRoot);
  const key = await manifestHash(projectDir, runtime === "python" ? PYTHON_MANIFESTS : NODE_MANIFESTS, image);
  if (!key) return { status: "none" };
  await ensureImage(image, log);

  const volume = `graphreview-preview-deps-${runtime}-${key}`;
  const workdir = path.posix.join("/src", projectRoot.split(path.sep).join("/"));
  const mountPoint = runtime === "python" ? "/deps" : path.posix.join(workdir, "node_modules");
  const marker = path.posix.join(mountPoint, ".graphreview-ready");

  // Base and head usually share a volume; the second caller waits for the first install.
  const pending = installsInFlight.get(volume);
  if (pending) return pending;
  const work = installInto({ runtime, image, volume, workdir, mountPoint, marker, projectDir, treeDir, log });
  installsInFlight.set(volume, work);
  try {
    return await work;
  } finally {
    installsInFlight.delete(volume);
  }
}

const installsInFlight = new Map<string, Promise<PreparedDeps>>();

async function installInto(options: {
  runtime: PreviewRuntime;
  image: string;
  volume: string;
  workdir: string;
  mountPoint: string;
  marker: string;
  projectDir: string;
  treeDir: string;
  log: Logger;
}): Promise<PreparedDeps> {
  const { runtime, image, volume, workdir, mountPoint, marker, projectDir, treeDir, log } = options;
  const probe = await docker(["run", "--rm", "-v", `${volume}:${mountPoint}`, image, "test", "-f", marker]);
  if (probe.code === 0) return { volume, status: "cached" };

  log(`installing ${runtime === "python" ? "Python" : "npm"} dependencies (cached for next time)`);
  const install = runtime === "python" ? pythonInstallCommand(projectDir) : nodeInstallCommand(projectDir);
  const script = `cd ${workdir} && (${install}) && touch ${marker}`;
  try {
    const result = await runOnline({
      image,
      mounts: [`${volume}:${mountPoint}`],
      workdir,
      script,
      timeoutMs: INSTALL_TIMEOUT_MS,
      before: (id) => copyIn(id, treeDir, "/src"),
    });
    if (result.code !== 0 || result.timedOut) {
      const reason = result.timedOut ? "timed out" : result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
      log(`dependency install failed: ${reason}`);
      await removeVolume(volume);
      return { status: `failed: ${reason || "unknown error"}` };
    }
    return { volume, status: "installed" };
  } catch (error) {
    log(`dependency install failed: ${(error as Error).message}`);
    await removeVolume(volume);
    return { status: `failed: ${(error as Error).message.slice(0, 300)}` };
  }
}

/** Best effort: a half-filled cache from a failed install would only be retried into anyway. */
async function removeVolume(name: string): Promise<boolean> {
  return (await docker(["volume", "rm", name]).catch(() => ({ code: 1 }))).code === 0;
}

// ---------------------------------------------------------------------------
// Dependency cache cleanup
// ---------------------------------------------------------------------------

const DEPS_VOLUME_PREFIX = "graphreview-preview-deps-";

/** Caches unused for longer than this are removed (`PREVIEW_DEPS_MAX_AGE_HOURS`, default 48 h). */
const DEPS_MAX_AGE_MS = envMs("PREVIEW_DEPS_MAX_AGE_HOURS", 48) * 60 * 60 * 1000;
/** At most this many caches are kept, most recently used first (`PREVIEW_DEPS_KEEP`, default 6). */
const DEPS_KEEP = envMs("PREVIEW_DEPS_KEEP", 6);

/**
 * Removes dependency caches that weren't used within {@link DEPS_MAX_AGE_MS},
 * then all but the {@link DEPS_KEEP} most recently used. Each cache is a full
 * `node_modules` (hundreds of MB) and a new one appears whenever a lockfile
 * changes, so without this they only ever accumulate.
 *
 * `lastUsed` (volume → ms) comes from the caller; a cache it doesn't know
 * falls back to its creation time. Caches being installed right now are
 * skipped, and Docker itself refuses to remove one a container still uses.
 */
export async function pruneDepsVolumes(lastUsed: ReadonlyMap<string, number>, log: Logger): Promise<string[]> {
  const listed = await docker(["volume", "ls", "-q", "--filter", `name=${DEPS_VOLUME_PREFIX}`]);
  const names = listed.stdout.split("\n").map((n) => n.trim()).filter((n) => n.startsWith(DEPS_VOLUME_PREFIX));
  if (names.length === 0) return [];

  const inspected = await docker(["volume", "inspect", "--format", "{{.Name}} {{.CreatedAt}}", ...names]);
  const volumes = inspected.stdout
    .split("\n")
    .map((row) => row.trim().split(" "))
    .filter(([name]) => name && !installsInFlight.has(name))
    .map(([name, createdAt]) => ({ name, used: lastUsed.get(name) ?? (Date.parse(createdAt ?? "") || 0) }))
    .sort((a, b) => b.used - a.used);

  const now = Date.now();
  const removed: string[] = [];
  for (const [index, volume] of volumes.entries()) {
    const stale = now - volume.used > DEPS_MAX_AGE_MS;
    if (!stale && index < DEPS_KEEP) continue;
    if (await removeVolume(volume.name)) removed.push(volume.name);
  }
  if (removed.length > 0) log(`removed ${removed.length} unused dependency cache(s)`);
  return removed;
}

// ---------------------------------------------------------------------------
// Running a harness
// ---------------------------------------------------------------------------

/** Directory holding the harness scripts, in the source tree (tsx) and the worker image alike. */
function harnessDir(): string {
  const candidates = [
    typeof __dirname === "string" ? path.join(__dirname, "harness") : undefined,
    path.join(process.cwd(), "lib", "preview", "harness"),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((dir) => existsSync(path.join(dir, "node-harness.mjs")));
  if (!found) throw new Error(`Preview harness scripts not found (looked in ${candidates.join(", ")}).`);
  return found;
}

export function harnessScript(runtime: PreviewRuntime): string {
  return path.join(harnessDir(), runtime === "python" ? "python-harness.py" : "node-harness.mjs");
}

export interface RunHarnessOptions {
  runtime: PreviewRuntime;
  /** The repo checked out at one commit. */
  treeDir: string;
  /** Holds spec.json + the harness script; copied to /job. */
  jobDir: string;
  projectRoot: string;
  deps: PreparedDeps;
  log: Logger;
  /** The image to run in (the one `prepareDeps` installed with); defaults to the runtime's default image. */
  image?: string;
}

/** Runs one side in a fresh, offline container and parses the harness's result line. */
export async function runHarness(options: RunHarnessOptions): Promise<PreviewHarnessResult> {
  const { runtime, treeDir, jobDir, projectRoot, deps, log } = options;
  const image = options.image ?? imageFor(runtime);
  await ensureImage(image, log);
  if (runtime === "node") await ensureHarnessVolume(log);

  const workdir = path.posix.join("/src", projectRoot.split(path.sep).join("/"));
  const args = [
    "--network",
    "none",
    "--memory",
    MEMORY,
    "--cpus",
    CPUS,
    "--pids-limit",
    "512",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-w",
    workdir,
    "-e",
    "HOME=/tmp",
    "-e",
    `GRAPHREVIEW_MEMORY=${MEMORY}`,
  ];
  if (runtime === "node") {
    args.push("-v", `${HARNESS_VOLUME}:/harness:ro`);
    if (deps.volume) args.push("-v", `${deps.volume}:${path.posix.join(workdir, "node_modules")}:ro`);
    args.push(image, "node", "/job/node-harness.mjs");
  } else {
    if (deps.volume) args.push("-v", `${deps.volume}:/deps:ro`);
    args.push("-e", "PYTHONDONTWRITEBYTECODE=1", image, "python", "/job/python-harness.py");
  }

  const result = await withContainer(args, async (id) => {
    await copyIn(id, treeDir, "/src");
    await copyIn(id, jobDir, "/job");
    return startAttached(id, RUN_TIMEOUT_MS);
  });

  const line = result.stdout.split("\n").find((row) => row.startsWith(RESULT_MARKER));
  if (!line) {
    const why = result.timedOut
      ? `the run took longer than ${Math.round(RUN_TIMEOUT_MS / 1000)} s and was stopped`
      : result.code === 137
        ? "the container ran out of memory"
        : (result.stderr || result.stdout).trim().split("\n").slice(-4).join(" ").slice(0, 600) || `exit code ${result.code}`;
    throw new Error(`The sandbox produced no result: ${why}`);
  }
  const parsed = JSON.parse(line.slice(RESULT_MARKER.length)) as PreviewHarnessResult;
  // A fatal load error often has its real cause only on stderr (a crashed bundler, the OOM killer).
  const stderr = result.stderr.trim();
  if (parsed.fatal && stderr) log(`sandbox stderr: ${stderr.split("\n").slice(-6).join(" | ").slice(0, 800)}`);
  return parsed;
}
