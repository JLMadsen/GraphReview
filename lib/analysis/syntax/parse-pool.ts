/**
 * Parsing off the main thread.
 *
 * One `worker_threads` worker (./parse-worker.mjs) parses files with
 * tree-sitter and returns plain data: query matches for the import queries
 * and, for the languages that have them, symbol facts (./extract.mjs). The
 * server process stays responsive during a big analysis, and a file that
 * hangs or crashes the WASM runtime costs that file, not the app: the pool
 * gives up on it after {@link PARSE_TIMEOUT_MS}, terminates the worker and
 * starts a fresh one for the next file.
 *
 * When no worker can be started (the script isn't on disk, or
 * `GRAPHREVIEW_PARSE_IN_PROCESS=1`), parsing runs in-process with the same
 * extractor.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { GrammarSpec, QueryMatchData } from "../analyzer";
import type { SymbolFacts } from "../ir";
import { loadGrammarPath, runQuery, withSyntaxTree } from "../tree-sitter";
import { extractSymbols } from "./extract.mjs";

/** Which extractor of ./extract.mjs to run. */
export type SymbolFamily = "js" | "python" | "java";

export interface ParseRequest {
  grammar: GrammarSpec;
  /** The analyzer's import query; omitted when only symbols are wanted. */
  queryPath?: string;
  family?: SymbolFamily;
  source: string;
}

export interface ParseResult {
  matches: QueryMatchData[];
  symbols: SymbolFacts | null;
}

/** Longest one file may take to parse before it is given up on. */
const PARSE_TIMEOUT_MS = 20_000;
/** A worker is replaced after this many files, returning its WASM heap. */
const FILES_PER_WORKER = 4000;

interface Pending {
  id: number;
  message: Record<string, unknown>;
  resolve: (result: ParseResult) => void;
  reject: (error: Error) => void;
}

/** `lib/analysis/syntax/` on disk — next to the analyzers' query files. */
function syntaxDir(): string | undefined {
  const candidates: string[] = [];
  const languages = process.env.GRAPHREVIEW_ANALYSIS_LANGUAGES_DIR;
  if (languages) candidates.push(path.join(languages, "..", "syntax"));
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, "lib", "analysis", "syntax"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates.find((candidate) => existsSync(path.join(candidate, "parse-worker.mjs")));
}

class ParsePool {
  private worker: Worker | null = null;
  private parsed = 0;
  private nextId = 1;
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly script: string;

  constructor(script: string) {
    this.script = script;
  }

  parse(message: Record<string, unknown>): Promise<ParseResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, message, resolve, reject });
      this.pump();
    });
  }

  private start(): Worker {
    // Its own streams, not piped into the server's stdout, and deliberately
    // not read: a listener on them would keep the process alive. Nothing it
    // prints is wanted — a crash shows up as the "error"/"exit" below.
    const worker = new Worker(this.script, { stdout: true, stderr: true });
    worker.on("message", (response: { id: number; error?: string; matches?: QueryMatchData[]; symbols?: SymbolFacts | null }) => {
      const job = this.current;
      if (!job || job.id !== response.id) return;
      this.finish();
      if (response.error) job.reject(new Error(response.error));
      else job.resolve({ matches: response.matches ?? [], symbols: response.symbols ?? null });
    });
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      const job = this.current;
      this.finish();
      job?.reject(error);
    };
    worker.on("error", (error) => fail(error));
    worker.on("exit", (code) => fail(new Error(`the parse worker stopped (exit code ${code})`)));
    this.parsed = 0;
    return worker;
  }

  private finish(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    this.parsed++;
    if (this.parsed >= FILES_PER_WORKER && this.worker) {
      const old = this.worker;
      this.worker = null;
      void old.terminate();
    }
    queueMicrotask(() => {
      this.pump();
      // Idle: don't keep the process alive just for the worker.
      if (!this.current) this.worker?.unref();
    });
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    this.current = job;
    this.worker ??= this.start();
    const worker = this.worker;
    worker.ref();
    this.timer = setTimeout(() => {
      // The file never finished: drop this worker (and its stuck WASM call).
      if (this.current !== job) return;
      this.worker = null;
      void worker.terminate();
      this.finish();
      job.reject(new Error(`parsing took longer than ${PARSE_TIMEOUT_MS / 1000}s`));
    }, PARSE_TIMEOUT_MS);
    this.timer.unref();
    worker.postMessage({ ...job.message, id: job.id });
  }
}

const POOL_KEY = Symbol.for("graphreview.analysis.parse-pool");

/** The process-wide pool, or `null` when parsing runs in-process. */
function pool(): ParsePool | null {
  const g = globalThis as typeof globalThis & { [POOL_KEY]?: ParsePool | null };
  if (g[POOL_KEY] !== undefined) return g[POOL_KEY];
  const dir = process.env.GRAPHREVIEW_PARSE_IN_PROCESS === "1" ? undefined : syntaxDir();
  g[POOL_KEY] = dir ? new ParsePool(path.join(dir, "parse-worker.mjs")) : null;
  return g[POOL_KEY];
}

/** Parses one file: the import query's matches and (with `family`) its symbol facts. */
export async function parseSource(request: ParseRequest): Promise<ParseResult> {
  const workers = pool();
  if (workers) {
    const grammarPath = loadGrammarPath(request.grammar);
    return workers.parse({
      grammarId: request.grammar.id,
      grammarPath,
      queryPath: request.queryPath,
      family: request.family,
      source: request.source,
    });
  }
  const matches = request.queryPath ? await runQuery(request.grammar, request.queryPath, request.source) : [];
  const symbols = request.family
    ? ((await withSyntaxTree(request.grammar, request.source, (root) => extractSymbols(root, request.family!))) as SymbolFacts | null)
    : null;
  return { matches, symbols };
}
