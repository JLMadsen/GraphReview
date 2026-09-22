/**
 * Repository walker: enumerates candidate source files under a root directory.
 *
 * Returns *every* file it finds (not just analyzable ones) because import
 * resolution is a set-membership test against the real file list — a TS import
 * of `./styles.css` should still resolve even though CSS has no analyzer.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { toPosix } from "./paths";

/** Directories never worth walking: dependencies, VCS metadata, build output. */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  "venv",
  "site-packages",
];

/**
 * Directory names only ignored when the evidence that they are build output is
 * actually present in the same directory - unlike the names above, these are
 * common enough as ordinary source folders that skipping them unconditionally
 * causes real misses (a JS/TS repo can easily have a `lib/target/` full of
 * source files). `target` is Cargo's build output, but only when it sits next
 * to the `Cargo.toml` that produced it.
 */
const CONDITIONALLY_IGNORED_DIRS: ReadonlyMap<string, string> = new Map([["target", "Cargo.toml"]]);

/** Files that are technically source but never meaningful to parse. */
const IGNORED_FILE_PATTERNS: readonly RegExp[] = [
  /\.min\.[cm]?js$/i,
  /\.bundle\.[cm]?js$/i,
  /-lock\.json$/i,
];

export interface WalkOptions {
  /** Extra directory names to skip, on top of {@link DEFAULT_IGNORED_DIRS}. */
  ignoreDirs?: readonly string[];
  /** Follow symlinked directories (off by default — cycles and escapes). */
  followSymlinks?: boolean;
  /** Safety valve for pathological trees. */
  maxFiles?: number;
}

/**
 * List repo-relative POSIX paths of every file under `rootDir`.
 * Dot-directories (`.git`, `.next`, `.venv`, `.turbo`, …) are always skipped.
 */
export async function walkRepo(
  rootDir: string,
  options: WalkOptions = {},
): Promise<string[]> {
  const ignored = new Set<string>([
    ...DEFAULT_IGNORED_DIRS,
    ...(options.ignoreDirs ?? []),
  ]);
  const maxFiles = options.maxFiles ?? 200_000;
  const results: string[] = [];
  const seenDirs = new Set<string>();

  async function walk(absDir: string, relDir: string): Promise<void> {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip rather than fail the whole run
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const name = entry.name;
      const rel = relDir === "" ? name : `${relDir}/${name}`;
      const abs = path.join(absDir, name);

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) continue;
        try {
          const stats = await stat(abs);
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }

      if (isDirectory) {
        if (name.startsWith(".") || ignored.has(name) || name.endsWith(".egg-info")) continue;
        const evidenceFile = CONDITIONALLY_IGNORED_DIRS.get(name);
        if (evidenceFile && entries.some((e) => e.name === evidenceFile)) continue;
        if (seenDirs.has(abs)) continue;
        seenDirs.add(abs);
        await walk(abs, rel);
      } else if (isFile) {
        if (IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(name))) continue;
        results.push(rel);
      }
    }
  }

  await walk(path.resolve(rootDir), "");
  results.sort();
  return results.map(toPosix);
}
