/**
 * Where the analysed files come from.
 *
 * - {@link gitSourceTree}: one commit, read from git's object store
 *   (`git ls-tree` + `git cat-file --batch`). Exactly what was committed —
 *   no uncommitted edits, untracked or ignored files — and every file carries
 *   its blob id, which keys the parse cache. This is what the app analyses.
 * - {@link diskSourceTree}: a folder on disk, walked (./walk.ts). Used for
 *   fixtures and scripts.
 *
 * Both skip binary files (a NUL byte in the first 8 KB) and files over the
 * size cap, and count what they skipped.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isWalkIgnored, walkRepo, type WalkOptions } from "./walk";

export interface SourceTree {
  /** Absolute path of the repo (the checkout or git directory the files belong to). */
  readonly rootDir: string;
  /** Every file, repo-relative with POSIX separators. */
  readonly files: string[];
  /** Content id (a git blob sha) for the parse cache; `undefined` when unknown. */
  blobOf(relPath: string): string | undefined;
  /**
   * The file's text, or `null` when it is missing, binary or larger than
   * `maxBytes` (counted in {@link skipped}).
   */
  read(relPath: string, maxBytes: number): Promise<string | null>;
  /**
   * A config file the resolvers need (tsconfig, go.mod, …). Files outside
   * the tree (a shared tsconfig inside `node_modules`) are read from disk
   * when the tree has a checkout there.
   */
  readConfig(relPath: string): Promise<string | null>;
  readonly skipped: { binary: number; large: number };
  close(): void;
}

const BINARY_SNIFF_BYTES = 8000;

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

async function readDiskFile(absolute: string): Promise<Buffer | null> {
  try {
    return await readFile(absolute);
  } catch {
    return null;
  }
}

/** A folder on disk, as the walk sees it. */
export async function diskSourceTree(rootDir: string, options: WalkOptions = {}): Promise<SourceTree> {
  const root = path.resolve(rootDir);
  const files = await walkRepo(root, options);
  const skipped = { binary: 0, large: 0 };
  return {
    rootDir: root,
    files,
    skipped,
    blobOf: () => undefined,
    async read(relPath, maxBytes) {
      const absolute = path.join(root, relPath);
      const info = await stat(absolute).catch(() => undefined);
      if (!info?.isFile()) return null;
      if (info.size > maxBytes) {
        skipped.large++;
        return null;
      }
      const buffer = await readDiskFile(absolute);
      if (!buffer) return null;
      if (isBinary(buffer)) {
        skipped.binary++;
        return null;
      }
      return buffer.toString("utf8");
    },
    async readConfig(relPath) {
      const buffer = await readDiskFile(path.join(root, ...relPath.split("/")));
      return buffer ? buffer.toString("utf8") : null;
    },
    close() {},
  };
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

const GIT_ARGS = ["-c", "safe.directory=*", "-c", "core.quotepath=off"];

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

/** Runs git to completion and returns stdout as a Buffer. */
function gitOutput(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...GIT_ARGS, ...args], { cwd, env: gitEnv(), windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`git ${args[0]} failed: ${Buffer.concat(err).toString("utf8").trim() || `exit ${code}`}`));
    });
  });
}

/** One long-running `git cat-file --batch`, answering blob reads in order. */
class BlobReader {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly waiting: Array<{ resolve: (data: Buffer | null) => void; reject: (error: Error) => void }> = [];
  private failed: Error | null = null;

  constructor(cwd: string) {
    this.child = spawn("git", [...GIT_ARGS, "cat-file", "--batch"], { cwd, env: gitEnv(), windowsHide: true });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    const fail = (error: Error) => {
      this.failed ??= error;
      for (const waiter of this.waiting.splice(0)) waiter.reject(this.failed);
    };
    this.child.on("error", fail);
    this.child.on("close", () => fail(new Error("git cat-file stopped")));
    this.child.stdin.on("error", fail);
  }

  private drain(): void {
    for (;;) {
      if (this.waiting.length === 0) return;
      const newline = this.buffer.indexOf(10);
      if (newline === -1) return;
      const header = this.buffer.subarray(0, newline).toString("utf8");
      if (header.endsWith(" missing")) {
        this.buffer = this.buffer.subarray(newline + 1);
        this.waiting.shift()!.resolve(null);
        continue;
      }
      const size = Number(header.split(" ")[2]);
      if (!Number.isFinite(size)) {
        this.buffer = this.buffer.subarray(newline + 1);
        this.waiting.shift()!.resolve(null);
        continue;
      }
      const end = newline + 1 + size;
      if (this.buffer.length < end + 1) return; // content + trailing LF not here yet
      const data = Buffer.from(this.buffer.subarray(newline + 1, end));
      this.buffer = this.buffer.subarray(end + 1);
      this.waiting.shift()!.resolve(data);
    }
  }

  read(blob: string): Promise<Buffer | null> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.child.stdin.write(`${blob}\n`);
    });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

/** Whether `dir` is inside a git work tree or is a git directory. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await gitOutput(dir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/** The files of commit `sha` in the repository at `repoDir`. */
export async function gitSourceTree(repoDir: string, sha: string, options: WalkOptions = {}): Promise<SourceTree> {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new Error(`"${sha}" is not a commit sha.`);
  const root = path.resolve(repoDir);
  // -l: sizes, so oversized blobs are never read; -z: raw paths.
  const listing = (await gitOutput(root, ["ls-tree", "-r", "-l", "-z", "--full-tree", sha])).toString("utf8");
  const blobs = new Map<string, { blob: string; size: number }>();
  for (const entry of listing.split("\0")) {
    if (!entry) continue;
    // <mode> SP <type> SP <object> SP+ <size> TAB <path>
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, object, size] = entry.slice(0, tab).split(/\s+/);
    if (type !== "blob" || mode === "120000") continue; // submodules and symlinks
    blobs.set(entry.slice(tab + 1), { blob: object, size: Number(size) });
  }
  const files = [...blobs.keys()]
    .filter((file) => !isWalkIgnored(file, (p) => blobs.has(p), options.ignoreDirs))
    .sort()
    .slice(0, options.maxFiles ?? 200_000);

  let reader: BlobReader | null = null;
  const skipped = { binary: 0, large: 0 };
  const readBlob = async (relPath: string, maxBytes: number): Promise<Buffer | null> => {
    const entry = blobs.get(relPath);
    if (!entry) return null;
    if (entry.size > maxBytes) {
      skipped.large++;
      return null;
    }
    reader ??= new BlobReader(root);
    return reader.read(entry.blob);
  };

  return {
    rootDir: root,
    files,
    skipped,
    blobOf: (relPath) => blobs.get(relPath)?.blob,
    async read(relPath, maxBytes) {
      const buffer = await readBlob(relPath, maxBytes);
      if (!buffer) return null;
      if (isBinary(buffer)) {
        skipped.binary++;
        return null;
      }
      return buffer.toString("utf8");
    },
    async readConfig(relPath) {
      const buffer = await readBlob(relPath, 2_000_000);
      if (buffer) return buffer.toString("utf8");
      // A config the commit points at but doesn't contain (an npm package's
      // shared tsconfig): only a checkout on disk can have it.
      if (!relPath.split("/").includes("node_modules")) return null;
      const absolute = path.join(root, ...relPath.split("/"));
      return existsSync(absolute) ? (await readDiskFile(absolute))?.toString("utf8") ?? null : null;
    },
    close() {
      reader?.close();
      reader = null;
    },
  };
}
