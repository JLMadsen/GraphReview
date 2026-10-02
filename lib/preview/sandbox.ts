// The Docker sandbox the before/after preview runs PR code in (DESIGN.md §6.9).
//
// Everything goes through the `docker` CLI (the worker image ships it, and
// Compose hands the worker the host's Docker socket). Nothing is bind-
// mounted from the worker's filesystem — a host path means something
// different to the Docker daemon than to a worker that itself runs in a
// container — so files travel with `docker cp`, and the only mounts are
// named volumes the daemon owns:
//
//   graphreview-preview-harness-<v>   esbuild/react/postcss for the Node harness
//   graphreview-preview-deps-<hash>   one repo's installed dependencies,
//                                     keyed by its manifests + lockfile, so
//                                     base and head share it when unchanged
//
// A run container gets no network, capped memory/CPU/processes and a wall-
// clock limit; installs are the only step that goes online.
//
// Server-only (spawns processes). Worker-only in practice.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PreviewHarnessResult, PreviewRuntime } from "./types";

export const RESULT_MARKER = "@@GRAPHREVIEW_PREVIEW_RESULT@@";

/** Bump when the harness's own package set changes, to force a fresh harness volume. */
const HARNESS_VERSION = "1";
const HARNESS_PACKAGES = ["esbuild@0.25", "react@19", "react-dom@19", "postcss@8"];

const NODE_IMAGE = process.env.PREVIEW_NODE_IMAGE || "node:20-bookworm-slim";
const PYTHON_IMAGE = process.env.PREVIEW_PYTHON_IMAGE || "python:3.12-slim";
/** A positive number from the environment, else `fallback` — Compose passes unset optional vars as "". */
function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim() || NaN);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const RUN_TIMEOUT_MS = envMs("PREVIEW_RUN_TIMEOUT_MS", 120_000);
const INSTALL_TIMEOUT_MS = envMs("PREVIEW_INSTALL_TIMEOUT_MS", 15 * 60_000);
const MEMORY = process.env.PREVIEW_MEMORY || "1g";
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
          reject(new SandboxUnavailableError("The docker CLI is not installed where the worker runs."));
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

/** Throws {@link SandboxUnavailableError} with a fixable message when Docker can't be reached. */
export async function assertDockerAvailable(): Promise<void> {
  const result = await docker(["version", "--format", "{{.Server.Version}}"], 15_000);
  if (result.code !== 0) {
    throw new SandboxUnavailableError(
      "Docker isn't reachable from the worker, so the preview can't run. Start Docker, and under " +
        "Docker Compose make sure the worker has /var/run/docker.sock mounted (docker/docker-compose.yml)."
    );
  }
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
  const result = await withContainer(["-v", `${HARNESS_VOLUME}:/harness`, NODE_IMAGE, "sh", "-c", script], (id) =>
    startAttached(id, INSTALL_TIMEOUT_MS)
  );
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
  log: Logger
): Promise<PreparedDeps> {
  const image = imageFor(runtime);
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
    const result = await withContainer(
      ["-v", `${volume}:${mountPoint}`, "-w", workdir, "-e", "CI=1", image, "sh", "-c", script],
      async (id) => {
        await copyIn(id, treeDir, "/src");
        return startAttached(id, INSTALL_TIMEOUT_MS);
      }
    );
    if (result.code !== 0 || result.timedOut) {
      const reason = result.timedOut ? "timed out" : result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
      log(`dependency install failed: ${reason}`);
      return { status: `failed: ${reason || "unknown error"}` };
    }
    return { volume, status: "installed" };
  } catch (error) {
    log(`dependency install failed: ${(error as Error).message}`);
    return { status: `failed: ${(error as Error).message.slice(0, 300)}` };
  }
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
}

/** Runs one side in a fresh, offline container and parses the harness's result line. */
export async function runHarness(options: RunHarnessOptions): Promise<PreviewHarnessResult> {
  const { runtime, treeDir, jobDir, projectRoot, deps, log } = options;
  const image = imageFor(runtime);
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
  return JSON.parse(line.slice(RESULT_MARKER.length)) as PreviewHarnessResult;
}
