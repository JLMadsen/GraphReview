// Every file of a repo at one commit, for the Graph tab's Files view: the
// paths and sizes from `git ls-tree`, plus that commit's subject line. Read
// from the same place the analysis reads — the app's clone of a hosted repo,
// or a local repo itself — at the last analysed commit, so the tree, the
// file viewer (`/file`, which reads that commit too) and the maps agree.
//
// Kept out of lib/jobs' barrel like ./pr-context: only the `/tree` and
// `/raw` routes need it.

import type { RepoRecord } from "@/lib/db";
import { gitOutput, gitStream } from "@/lib/analysis/source-tree";
import { sourceDir } from "./review-context";
import { gitIn } from "./source";

/** A tree this big is cut off (and says so) — a vendored monorepo, a checked-in dataset. */
const MAX_ENTRIES = 100_000;

export interface RepoTreeEntry {
  path: string;
  /** Bytes; absent for submodules. */
  size?: number;
  kind: "file" | "symlink" | "submodule";
}

export interface RepoTree {
  sha: string;
  /** The commit's subject line, author and date — GitHub's "latest commit" bar. */
  commit: { subject: string; author: string; date: string } | null;
  entries: RepoTreeEntry[];
  truncated: boolean;
}

/** The tree at the last analysed commit, or at the checkout's HEAD before any analysis. `null` when there is no checkout to read. */
export async function listRepoTree(repo: RepoRecord): Promise<RepoTree | null> {
  const dir = await sourceDir(repo);
  if (!dir) return null;
  const git = gitIn(dir, 60_000, ["safe.directory=*"]);

  const sha = repo.lastAnalyzedSha && /^[0-9a-f]{7,64}$/.test(repo.lastAnalyzedSha)
    ? repo.lastAnalyzedSha
    : (await git.raw(["rev-parse", "HEAD"])).trim();

  // -l: sizes; -z: raw paths (no quoting of unusual names).
  const listing = await git.raw(["ls-tree", "-r", "-l", "-z", "--full-tree", sha]);
  const entries: RepoTreeEntry[] = [];
  let truncated = false;
  for (const row of listing.split("\0")) {
    if (!row) continue;
    // <mode> SP <type> SP <object> SP+ <size> TAB <path>
    const tab = row.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, , size] = row.slice(0, tab).split(/\s+/);
    const path = row.slice(tab + 1);
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    if (type === "commit") entries.push({ path, kind: "submodule" });
    else if (type === "blob") entries.push({ path, size: Number(size) || 0, kind: mode === "120000" ? "symlink" : "file" });
  }

  let commit: RepoTree["commit"] = null;
  try {
    const [subject, author, date] = (await git.raw(["log", "-1", "--format=%s%x00%an%x00%aI", sha])).trim().split("\0");
    if (subject !== undefined) commit = { subject, author: author ?? "", date: date ?? "" };
  } catch {
    /* the subject line is decoration */
  }

  return { sha, commit, entries, truncated };
}

export interface LastCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

/** History walked per folder before the rest is left blank — a giant repo's rarely touched folder. */
const LAST_COMMITS_TIMEOUT_MS = 15_000;

/** Folders already walked, per repo, commit and folder — a commit's history never changes. */
const lastCommitCache = new Map<string, Record<string, LastCommit | null>>();
const LAST_COMMITS_CACHED = 200;

/**
 * The newest commit (at or before `sha`) touching each entry directly inside
 * `dir` ("" = the root): GitHub's per-row commit message. One `git log
 * --name-only` down the folder's history, stopped once every entry is
 * attributed. Entries still blank when the walk ends (or times out) are `null`.
 */
export async function lastCommitsIn(repo: RepoRecord, sha: string, dir: string): Promise<Record<string, LastCommit | null> | null> {
  if (!/^[0-9a-f]{7,64}$/.test(sha) || dir.startsWith("-") || dir.split("/").includes("..")) return null;
  const key = `${repo.id}\0${sha}\0${dir}`;
  const cached = lastCommitCache.get(key);
  if (cached) return cached;
  const src = await sourceDir(repo);
  if (!src) return null;

  const prefix = dir ? `${dir}/` : "";
  // `<sha>:<dir>` is the folder's own tree: its names, no pathspec to escape.
  const names = (await gitOutput(src, ["ls-tree", "-z", "--name-only", dir ? `${sha}:${dir}` : sha]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const result: Record<string, LastCommit | null> = {};
  for (const name of names) result[name] = null;
  let left = names.length;

  // Each commit: \x1e<sha>\x1f<subject>\x1f<author>\x1f<date>\0\n<path>\0<path>\0…
  let pending = "";
  const take = (block: string): boolean => {
    const parts = block.split("\0");
    const [hash, subject = "", author = "", date = ""] = parts[0].split("\x1f");
    const commit: LastCommit = { sha: hash, subject, author, date };
    for (let i = 1; i < parts.length; i++) {
      const path = parts[i].replace(/^\n/, "");
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      if (result[name] === null) {
        result[name] = commit;
        if (--left === 0) return false;
      }
    }
    return true;
  };
  if (left > 0) {
    await gitStream(
      src,
      ["log", "--format=%x1e%H%x1f%s%x1f%an%x1f%aI", "--name-only", "-z", sha, "--", ...(dir ? [`:(literal)${dir}`] : [])],
      (chunk) => {
        pending += chunk.toString("utf8");
        const blocks = pending.split("\x1e");
        // The last block may still be arriving.
        pending = blocks.pop() ?? "";
        for (const block of blocks) if (block && !take(block)) return false;
      },
      LAST_COMMITS_TIMEOUT_MS,
    );
    if (left > 0 && pending) take(pending);
  }

  if (lastCommitCache.size >= LAST_COMMITS_CACHED) lastCommitCache.delete(lastCommitCache.keys().next().value!);
  lastCommitCache.set(key, result);
  return result;
}

/** Images the Files view shows, by extension → content type. Nothing else is served raw. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/** Bigger images aren't served — a view of a repo, not a file host. */
const MAX_IMAGE_BYTES = 10_000_000;

/**
 * An image's bytes at commit `sha` (the tree's), for README images and the
 * Files view's image preview. `null` when the path isn't an image, isn't in
 * that commit, or is too big.
 */
export async function readRepoImage(repo: RepoRecord, sha: string, filePath: string): Promise<{ bytes: Buffer; type: string } | null> {
  const type = IMAGE_TYPES[filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase()];
  if (!type || !/^[0-9a-f]{7,64}$/.test(sha) || filePath.startsWith("-") || filePath.split("/").includes("..")) return null;
  const dir = await sourceDir(repo);
  if (!dir) return null;
  try {
    const size = Number((await gitOutput(dir, ["cat-file", "-s", `${sha}:${filePath}`])).toString("utf8").trim());
    if (!(size <= MAX_IMAGE_BYTES)) return null;
    return { bytes: await gitOutput(dir, ["cat-file", "blob", `${sha}:${filePath}`]), type };
  } catch {
    return null;
  }
}
