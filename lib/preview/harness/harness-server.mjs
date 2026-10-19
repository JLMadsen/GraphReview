// A warm preview session's supervisor (DESIGN.md §6.9): the main process of a
// long-lived session container (lib/preview/sandbox.ts `PreviewSession`). It
// reads requests from stdin and answers on stdout, one JSON line each after
// RESULT_MARKER:
//
//   stdin   { id, spec, timeoutMs }
//   stdout  { type: "ready" }                  once, at start
//           { id, type: "head", css, cssNote } the file loaded
//           { id, type: "symbol", entry }      one symbol done
//           { id, type: "done", result }       the file's whole result
//
// The files themselves run in worker processes (harness-worker.mjs), which is
// what keeps one file's failure from becoming the session's:
//   - two workers at most, one with a DOM and one without (harness-context.mjs
//     `needsDom`), each running its files one at a time; the DOM one starts
//     at once and warms up while the job waits for the model
//   - a run that takes longer than its timeout, or a worker that dies (out
//     of memory, process.exit in the code under test), fails that file only;
//     the worker is replaced and the next file runs in a fresh one
//   - a worker is retired after GRAPHREVIEW_WORKER_FILES files (40; a warm-up
//     loads up to 10 ahead) or once it
//     holds more than GRAPHREVIEW_WORKER_RSS_MB, since every file's bundle
//     stays in its module cache
// Closing stdin ends the session.

import { fork } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { needsDom } from "./harness-context.mjs";

const RESULT_MARKER = "@@GRAPHREVIEW_PREVIEW_RESULT@@";
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "harness-worker.mjs");
const PROJECT_ROOT = process.env.GRAPHREVIEW_PROJECT_ROOT || ".";
const HEAP_MB = Number(process.env.GRAPHREVIEW_WORKER_HEAP_MB) || 1536;
const MAX_FILES = Number(process.env.GRAPHREVIEW_WORKER_FILES) || 40;
const MAX_RSS = (Number(process.env.GRAPHREVIEW_WORKER_RSS_MB) || 1200) * 1024 * 1024;

function write(message) {
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(message)}\n`);
}

class Worker {
  constructor(dom) {
    this.dom = dom;
    this.queue = [];
    this.current = null;
    this.files = 0;
    this.stderr = [];
    this.child = null;
    this.timer = null;
  }

  spawn() {
    const child = fork(WORKER, [], {
      env: { ...process.env, GRAPHREVIEW_WORKER_DOM: this.dom ? "1" : "0" },
      execArgv: [`--max-old-space-size=${HEAP_MB}`],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
      this.stderr.push(...chunk.toString().split("\n").filter((l) => l.trim()));
      this.stderr.splice(0, Math.max(0, this.stderr.length - 8));
    });
    child.on("message", (message) => this.onMessage(child, message));
    child.on("exit", (code, signal) => this.onExit(child, code, signal));
  }

  submit(request) {
    this.queue.push(request);
    this.pump();
  }

  pump() {
    if (this.current || this.queue.length === 0) return;
    if (!this.child) this.spawn();
    this.current = this.queue.shift();
    this.child.send({ type: "run", id: this.current.id, spec: this.current.spec });
  }

  onMessage(child, message) {
    if (child !== this.child || !this.current || message?.id !== this.current.id) return;
    if (message.type === "start") {
      // Timed from the start of the run, not from when it was queued behind a warm-up.
      this.timer = setTimeout(() => this.fail(child, `the run took longer than ${Math.round(this.current.timeoutMs / 1000)} s and was stopped`), this.current.timeoutMs);
      return;
    }
    if (message.type === "head") return write({ id: message.id, type: "head", css: message.css, cssNote: message.cssNote });
    if (message.type === "symbol") return write({ id: message.id, type: "symbol", entry: message.entry });
    if (message.type !== "done") return;
    clearTimeout(this.timer);
    write({ id: message.id, type: "done", result: message.result });
    this.current = null;
    this.files += 1;
    if (this.files >= MAX_FILES || message.rss > MAX_RSS) this.retire();
    this.pump();
  }

  /** Fails the running file and replaces the worker; the queue goes on in a fresh one. */
  fail(child, why) {
    if (child !== this.child || !this.current) return;
    clearTimeout(this.timer);
    write({ id: this.current.id, type: "done", result: { side: this.current.spec.side, symbols: [], fatal: `The sandbox produced no result: ${why}`, warnings: [] } });
    this.current = null;
    this.retire();
    this.pump();
  }

  onExit(child, code, signal) {
    if (child !== this.child) return;
    const why =
      signal === "SIGKILL" || code === 137
        ? "the preview process ran out of memory"
        : this.stderr.slice(-4).join(" ").slice(0, 600) || `the preview process exited (${signal ?? `code ${code}`})`;
    if (this.current) this.fail(child, why);
    else this.child = null;
  }

  retire() {
    const child = this.child;
    this.child = null;
    this.files = 0;
    this.stderr = [];
    child?.kill("SIGKILL");
  }
}

const workers = { dom: new Worker(true), plain: new Worker(false) };
// Most previews are components in a browser: that worker warms up now.
workers.dom.spawn();

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  lastActive = Date.now();
  const spec = { projectRoot: PROJECT_ROOT, ...request.spec };
  (needsDom(spec) ? workers.dom : workers.plain).submit({ id: request.id, spec, timeoutMs: request.timeoutMs || 120_000 });
});
function shutDown() {
  for (const worker of Object.values(workers)) worker.child?.kill("SIGKILL");
  process.exit(0);
}
process.stdin.on("end", shutDown);

// GraphReview closes an idle session itself; this is for when GraphReview went
// away without closing it (killed, crashed) and nothing will ask again.
const IDLE_MS = (Number(process.env.GRAPHREVIEW_SESSION_IDLE_MS) || 300_000) + 60_000;
let lastActive = Date.now();
setInterval(() => {
  const busy = Object.values(workers).some((w) => w.current || w.queue.length > 0);
  if (busy) lastActive = Date.now();
  else if (Date.now() - lastActive > IDLE_MS) shutDown();
}, 30_000).unref();

write({ type: "ready" });
