/**
 * Checks "Changes on disk" (DESIGN.md §6.29) — no network, no AI.
 *
 *   npm test -- worktree
 *
 * Builds a throwaway repo in the temp folder, edits, stages and adds files,
 * then checks that the snapshot commit holds exactly what is on disk (minus
 * ignored files), that the user's index, HEAD and status are untouched, that
 * the same files give the same sha, and that a clean tree is HEAD itself.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKTREE_REF } from "./git-ref";
import { listLocalFilePatches, resolveLocalRefSha, snapshotWorktree } from "./local-git";
import { clearMemoCaches } from "./memo-cache";

const root = mkdtempSync(path.join(os.tmpdir(), "graphreview-worktree-"));
delete process.env.LOCAL_REPOS_ROOT;
const repoDir = path.join(root, "repo");

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
    cwd: repoDir,
    encoding: "utf8",
  });
}

async function main(): Promise<void> {
  mkdirSync(repoDir);
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repoDir, "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(repoDir, "b.ts"), "export const b = 1;\n");
  writeFileSync(path.join(repoDir, ".gitignore"), "dist/\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const head = git("rev-parse", "HEAD").trim();

  check("a clean tree is HEAD itself", (await snapshotWorktree(repoDir)) === head);
  clearMemoCaches();

  writeFileSync(path.join(repoDir, "a.ts"), "export const a = 2;\n"); // unstaged edit
  writeFileSync(path.join(repoDir, "b.ts"), "export const b = 2;\n");
  git("add", "b.ts"); // staged edit
  writeFileSync(path.join(repoDir, "c.ts"), "export const c = 1;\n"); // untracked
  mkdirSync(path.join(repoDir, "dist"));
  writeFileSync(path.join(repoDir, "dist", "out.js"), "ignored\n"); // ignored
  const statusBefore = git("status", "--porcelain");
  const indexBefore = git("ls-files", "--stage");

  const sha = await snapshotWorktree(repoDir);
  check("the snapshot is a new commit on top of HEAD", sha !== head && git("rev-parse", `${sha}^`).trim() === head);
  const files = git("ls-tree", "-r", "--name-only", sha).trim().split("\n").sort();
  check("it holds tracked, staged and untracked files, not ignored ones", files.join(",") === ".gitignore,a.ts,b.ts,c.ts", files.join(","));
  check("it holds the unstaged edit", git("show", `${sha}:a.ts`) === "export const a = 2;\n");
  check("HEAD did not move", git("rev-parse", "HEAD").trim() === head);
  check("the index is untouched", git("ls-files", "--stage") === indexBefore);
  check("git status is unchanged", git("status", "--porcelain") === statusBefore, git("status", "--porcelain"));

  clearMemoCaches();
  check("the same files give the same sha", (await snapshotWorktree(repoDir)) === sha);

  clearMemoCaches();
  check("the pseudo-ref resolves to the snapshot", (await resolveLocalRefSha(repoDir, WORKTREE_REF)) === sha);
  const patches = await listLocalFilePatches(repoDir, "HEAD", WORKTREE_REF);
  check(
    "HEAD → changes on disk lists a, b and c",
    patches.map((p) => `${p.path}:${p.status}`).sort().join(",") === "a.ts:modified,b.ts:modified,c.ts:added",
    patches.map((p) => `${p.path}:${p.status}`).join(",")
  );

  clearMemoCaches();
  writeFileSync(path.join(repoDir, "c.ts"), "export const c = 2;\n");
  check("an edit on disk gives a new sha", (await snapshotWorktree(repoDir)) !== sha);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(root, { recursive: true, force: true }));
