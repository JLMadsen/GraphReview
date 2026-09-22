// `GET /api/local-repos` — candidate local repos under the local-repos root,
// for the "Add repo" dialog's dropdown (post-v1 UX fix: the root is already
// known from `LOCAL_REPOS_PATH`/the bind mount, so the user shouldn't have
// to type the whole path by hand).
//
// Lists immediate subdirectories of `getLocalReposRoot()` that look like a
// git repo — i.e. contain a `.git` entry, which may be a directory (a normal
// clone) or a file (a worktree/submodule's gitdir pointer). One level deep
// only; this is a convenience list for the dialog, not a recursive repo
// finder, and each returned `path` is exactly what `POST /api/repos`'s
// `localPath` field expects (relative to the root).

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getLocalReposRoot } from "@/lib/jobs";
import { apiError, errorMessage } from "../repos/_shared";

export const dynamic = "force-dynamic";

export interface LocalRepoCandidate {
  name: string;
  /** Relative to the local-repos root — pass straight through as `localPath` to `POST /api/repos`. */
  path: string;
}

async function looksLikeGitRepo(dirPath: string): Promise<boolean> {
  try {
    const children = await readdir(dirPath);
    return children.includes(".git");
  } catch {
    // Unreadable directory (permissions, race with deletion, etc.) — just
    // not a candidate, not an error for the whole listing.
    return false;
  }
}

export async function GET(): Promise<NextResponse> {
  let root: string;
  try {
    root = getLocalReposRoot();
  } catch (error) {
    return apiError(errorMessage(error), 503);
  }

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return apiError(`Could not read "${root}": ${errorMessage(error)}`, 503);
  }

  const dirs = entries.filter((entry) => entry.isDirectory());
  const checked = await Promise.all(
    dirs.map(async (entry) => ({
      entry,
      isRepo: await looksLikeGitRepo(path.join(root, entry.name)),
    }))
  );

  const candidates: LocalRepoCandidate[] = checked
    .filter(({ isRepo }) => isRepo)
    .map(({ entry }) => ({ name: entry.name, path: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json(candidates);
}
