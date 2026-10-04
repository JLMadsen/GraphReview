// `GET /api/local-repos` — git repos found on this machine, for the "Add
// repo" dialog's dropdown, so the user can usually pick instead of typing
// a path.
//
// Looks one level deep inside a few likely folders: `LOCAL_REPOS_ROOT` when
// it is set (the only place local repos may come from then), otherwise the
// usual homes for checkouts (`~/code`, `~/Documents/GitHub`, `~/source/repos`,
// …) that exist on this machine. A folder counts as a repo when it contains
// a `.git` entry — a directory (a normal clone) or a file (a worktree or
// submodule's gitdir pointer). Each returned `path` is absolute and goes
// straight into `POST /api/repos`'s `localPath`.

import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { getLocalReposRoot } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export interface LocalRepoCandidate {
  name: string;
  /** Absolute path — pass straight through as `localPath` to `POST /api/repos`. */
  path: string;
}

/** Folders under the home directory where people tend to keep checkouts. */
const LIKELY_FOLDERS = [
  "code",
  "Code",
  "dev",
  "Developer",
  "git",
  "GitHub",
  "projects",
  "Projects",
  "repos",
  "src",
  "workspace",
  path.join("Documents", "GitHub"),
  path.join("Documents", "GitLab"),
  path.join("Documents", "code"),
  path.join("Documents", "Projects"),
  path.join("source", "repos"),
];

/** Upper bound on results, so a huge folder can't make the dropdown unusable. */
const MAX_CANDIDATES = 300;

async function looksLikeGitRepo(dirPath: string): Promise<boolean> {
  try {
    return (await readdir(dirPath)).includes(".git");
  } catch {
    // Unreadable (permissions, race with deletion) — just not a candidate.
    return false;
  }
}

async function reposIn(folder: string): Promise<LocalRepoCandidate[]> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  const checked = await Promise.all(
    dirs.map(async (entry) => {
      const full = path.join(folder, entry.name);
      return (await looksLikeGitRepo(full)) ? { name: entry.name, path: full } : undefined;
    })
  );
  return checked.filter((c): c is LocalRepoCandidate => c !== undefined);
}

export async function GET(): Promise<NextResponse> {
  const root = getLocalReposRoot();
  const home = os.homedir();
  const folders = root ? [root] : LIKELY_FOLDERS.map((folder) => path.join(home, folder));

  const seen = new Set<string>();
  const candidates: LocalRepoCandidate[] = [];
  for (const found of await Promise.all(folders.map(reposIn))) {
    for (const candidate of found) {
      // Windows and macOS file systems are case-insensitive by default, so
      // `~/code` and `~/Code` list the same repos.
      const key = process.platform === "linux" ? candidate.path : candidate.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return NextResponse.json(candidates.slice(0, MAX_CANDIDATES));
}
