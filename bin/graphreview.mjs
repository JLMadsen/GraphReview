#!/usr/bin/env node
// `npx graphreview` — starts GraphReview on this machine and opens it.
//
// Runs the prebuilt Next.js app shipped in this package (`next start`) with
// its background workers in the same process (instrumentation.ts). State
// lives in one folder, `~/.graphreview` by default (`--data` or
// GRAPHREVIEW_HOME to change it). The server listens on 127.0.0.1 only.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyConfigEnv, loadConfigEnv } from "../lib/runtime/config-env.mjs";

const require = createRequire(import.meta.url);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));

const MIN_NODE = [22, 13];
const DEFAULT_PORT = 3470;

function fail(message) {
  console.error(`graphreview: ${message}`);
  process.exit(1);
}

// --- arguments -------------------------------------------------------------

const HELP = `GraphReview ${pkg.version} — review pull requests against a component graph of your code.

Usage: npx graphreview [options]

Options:
  -p, --port <n>   Port to listen on (default ${DEFAULT_PORT}, or the next free one)
  --data <dir>     Data folder (default ~/.graphreview, or GRAPHREVIEW_HOME)
  --no-open        Don't open the browser
  -v, --version    Print the version
  -h, --help       Show this help

Requires Node.js ${MIN_NODE.join(".")}+ and git. Docker is optional (before/after previews only).`;

const options = { port: undefined, data: undefined, open: true };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const value = () => {
    const next = args[++i];
    if (next === undefined) fail(`${arg} needs a value`);
    return next;
  };
  if (arg === "-h" || arg === "--help") {
    console.log(HELP);
    process.exit(0);
  } else if (arg === "-v" || arg === "--version") {
    console.log(pkg.version);
    process.exit(0);
  } else if (arg === "-p" || arg === "--port") {
    options.port = Number(value());
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) fail("--port must be 1-65535");
  } else if (arg === "--data") {
    options.data = path.resolve(value());
  } else if (arg === "--no-open") {
    options.open = false;
  } else {
    fail(`unknown option ${arg} (see --help)`);
  }
}

// --- prerequisites ---------------------------------------------------------

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
  fail(`Node.js ${MIN_NODE.join(".")} or newer is required (this is ${process.versions.node}). Get it from https://nodejs.org.`);
}
if (spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0) {
  fail("git was not found on your PATH. Install it from https://git-scm.com and try again.");
}
if (!existsSync(path.join(pkgRoot, ".next", "BUILD_ID"))) {
  fail(`no build found in ${pkgRoot}. From a source checkout, run "npm run build" first.`);
}

const dataDir = options.data ?? (process.env.GRAPHREVIEW_HOME ? path.resolve(process.env.GRAPHREVIEW_HOME) : path.join(os.homedir(), ".graphreview"));
mkdirSync(dataDir, { recursive: true });

// --- settings file -----------------------------------------------------------
// ~/.graphreview/config.env, created with commented-out examples on first
// start. Applied to this process's environment (which the app inherits) before
// anything reads it — NODE_EXTRA_CA_CERTS only works if Node sees it at startup.

const config = loadConfigEnv(dataDir);
const appliedSettings = applyConfigEnv(process.env, config.values);
if (config.created) {
  console.log(`Created ${config.file} — edit it to use a self-hosted GitLab/GitHub, a registry mirror or company certificates.`);
}
const caFile = process.env.NODE_EXTRA_CA_CERTS;
if (caFile && !(existsSync(caFile) && statSync(caFile).isFile())) {
  console.warn(`graphreview: NODE_EXTRA_CA_CERTS points at ${caFile}, which isn't a file — it is ignored.`);
  delete process.env.NODE_EXTRA_CA_CERTS;
  appliedSettings.splice(appliedSettings.indexOf("NODE_EXTRA_CA_CERTS") >>> 0, 1);
}

// --- one instance per data folder -------------------------------------------
// Two servers on one database would each run workers and each treat the
// other's running jobs as interrupted.

const lockFile = path.join(dataDir, "instance.json");

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function openBrowser(url) {
  const [command, commandArgs] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, commandArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* no browser — the URL is printed anyway */
  }
}

/** Whether a GraphReview server answers at `url` (the pid alone can belong to an unrelated process by now). */
async function answers(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    return res.status < 500;
  } catch {
    return false;
  }
}

if (existsSync(lockFile)) {
  let running;
  try {
    running = JSON.parse(readFileSync(lockFile, "utf8"));
  } catch {
    /* unreadable lock — treat as stale */
  }
  if (running?.pid && running.url && isAlive(running.pid) && (await answers(running.url))) {
    console.log(`GraphReview is already running at ${running.url} (pid ${running.pid}).`);
    if (options.open) openBrowser(running.url);
    process.exit(0);
  }
}

// --- port ------------------------------------------------------------------

function canBind(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

function somethingListens(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Free for us: bindable on 127.0.0.1 *and* nobody answering there. Windows and
 * macOS let us bind 127.0.0.1 while another process listens on 0.0.0.0 (e.g. a
 * Docker-published port), and then either server may get the browser's requests.
 */
async function isFree(port) {
  return (await canBind(port, "127.0.0.1")) && !(await somethingListens(port));
}

async function pickPort() {
  if (options.port) {
    if (!(await isFree(options.port))) fail(`port ${options.port} is in use.`);
    return options.port;
  }
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 50; port++) {
    if (await isFree(port)) return port;
  }
  fail(`no free port found between ${DEFAULT_PORT} and ${DEFAULT_PORT + 49}; pass --port.`);
}

const port = await pickPort();
const url = `http://127.0.0.1:${port}`;

// --- start -------------------------------------------------------------------

const nextBin = require.resolve("next/dist/bin/next", { paths: [pkgRoot] });
const grammarDir = path.join(path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json", { paths: [pkgRoot] })), "wasm");

// Trust certificates installed in the OS (Windows store, macOS keychain), so
// an internal CA for the AI endpoint, GitHub Enterprise or GitLab works
// without NODE_EXTRA_CA_CERTS. Node 22.15+ / 23.8+.
const supportsSystemCa = major > 23 || (major === 23 && minor >= 8) || (major === 22 && minor >= 15);

const child = spawn(
  process.execPath,
  [
    // node:sqlite still prints an ExperimentalWarning on every start; it's noise for users.
    "--disable-warning=ExperimentalWarning",
    ...(supportsSystemCa ? ["--use-system-ca"] : []),
    nextBin,
    "start",
    "-H",
    "127.0.0.1",
    "-p",
    String(port),
  ],
  {
    cwd: pkgRoot,
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      GRAPHREVIEW_HOME: dataDir,
      GRAPHREVIEW_LAUNCHER_PID: String(process.pid),
      GRAPHREVIEW_ANALYSIS_LANGUAGES_DIR: path.join(pkgRoot, "lib", "analysis", "languages"),
      GRAPHREVIEW_GRAMMAR_DIR: grammarDir,
    },
  }
);

writeFileSync(lockFile, JSON.stringify({ pid: child.pid, url }));
const cleanup = () => rmSync(lockFile, { force: true });

let announced = false;
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (!announced && /Ready in|started server/i.test(String(chunk))) {
    announced = true;
    const settings = appliedSettings.length > 0 ? appliedSettings.join(", ") : "none set";
    console.log(
      `\n  GraphReview is running at ${url}\n  Data: ${dataDir}\n  Settings: ${config.file} (${settings})\n  Press Ctrl+C to stop.\n`
    );
    if (options.open) openBrowser(url);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 0 : 1));
});
