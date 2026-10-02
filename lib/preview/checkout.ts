// Whole-tree checkouts for the before/after preview (DESIGN.md §6.9).
//
// A preview runs the changed file at two commits, and that file imports the
// rest of the repo, so each side needs the full tree at its commit. Local
// repos sit on a read-only bind mount, so neither `git worktree add` nor a
// plain checkout is possible there. Instead the tree is written with a
// throwaway index: `GIT_INDEX_FILE=<tmp> git read-tree <sha>` followed by
// `checkout-index --prefix=<dest>/`. Git only *reads* objects from the repo;
// every write goes to the temp index and the destination folder.
//
// Server-only (spawns git).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { PreviewRuntime } from "./types";

export { runtimeForPath } from "./runtime";

const GIT_CONFIG = ["safe.directory=*", "core.autocrlf=false", "core.symlinks=false"];
const GIT_TIMEOUT_MS = 5 * 60_000;

function git(repoDir: string) {
  return simpleGit({ baseDir: repoDir, trimmed: false, config: GIT_CONFIG, timeout: { block: GIT_TIMEOUT_MS } });
}

/**
 * Plain `git` with extra environment variables. simple-git refuses a custom
 * environment that carries the parent's EDITOR/PAGER (its unsafe-operations
 * guard), and the temp-index trick needs GIT_INDEX_FILE.
 */
function gitWithEnv(repoDir: string, env: Record<string, string>, args: string[]): Promise<void> {
  const configArgs = GIT_CONFIG.flatMap((c) => ["-c", c]);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...configArgs, ...args],
      {
        cwd: repoDir,
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, _stdout, stderr) =>
        error ? reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || error.message}`)) : resolve()
    );
  });
}

function isSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(value);
}

/** Writes the full tree of `sha` into `dest` (created if needed). */
export async function materializeTree(repoDir: string, sha: string, dest: string, scratchDir: string): Promise<void> {
  if (!isSha(sha)) throw new Error(`"${sha}" is not a commit sha.`);
  await mkdir(dest, { recursive: true });
  const indexFile = path.join(scratchDir, `index-${sha.slice(0, 12)}`);
  const env = { GIT_INDEX_FILE: indexFile };
  await gitWithEnv(repoDir, env, ["read-tree", sha]);
  const prefix = `${dest.split(path.sep).join("/").replace(/\/+$/, "")}/`;
  await gitWithEnv(repoDir, env, ["checkout-index", "--all", "--force", `--prefix=${prefix}`]);
}

/** A file's text at a commit, or `null` when it isn't there. */
export async function readFileAt(repoDir: string, sha: string, filePath: string): Promise<string | null> {
  if (!isSha(sha) || filePath.startsWith("-") || filePath.includes("..")) return null;
  try {
    return await git(repoDir).raw(["show", `${sha}:${filePath}`]);
  } catch {
    return null;
  }
}

/** The commit a three-dot diff of `base...head` is anchored on, or `base` when there is none. */
export async function mergeBaseOf(repoDir: string, base: string, head: string): Promise<string> {
  try {
    const out = (await git(repoDir).raw(["merge-base", base, head])).trim();
    return isSha(out) ? out : base;
  } catch {
    return base;
  }
}

const PROJECT_MARKERS: Record<PreviewRuntime, string[]> = {
  node: ["package.json"],
  python: ["pyproject.toml", "setup.py", "requirements.txt"],
};

/**
 * The nearest folder above `filePath` (repo-relative, posix) that holds the
 * project manifest — where dependencies get installed and the harness runs.
 * `"."` for the repo root.
 */
export function projectRootFor(treeDir: string, filePath: string, runtime: PreviewRuntime): string {
  let dir = path.posix.dirname(filePath);
  for (;;) {
    for (const marker of PROJECT_MARKERS[runtime]) {
      if (existsSync(path.join(treeDir, dir, marker))) return dir;
    }
    if (dir === "." || dir === "" || dir === "/") return ".";
    dir = path.posix.dirname(dir);
  }
}
