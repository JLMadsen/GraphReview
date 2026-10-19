/**
 * Checks plain git repos and URL handling (DESIGN.md §6.29) — no network,
 * no AI.
 *
 *   npm test -- plain-git
 *
 * Tells URLs apart by host, then clones a bare repo in the temp folder as a
 * `provider: "git"` repo and checks that its clone mirrors the server's
 * branches (so the local-repo git layer reads it in place), picks up a
 * branch pushed later, and diffs two branches. Run through `npm test`: the
 * clone lands in the temp GRAPHREVIEW_HOME, never the real data folder.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoRecord } from "@/lib/db";
import { listLocalBranches, listLocalFilePatches } from "./local-git";
import { clearMemoCaches } from "./memo-cache";
import {
  gitIn,
  inPlacePath,
  isCloneableUrl,
  isSshUrl,
  prepareRepoSource,
  providerForUrl,
  readCurrentSha,
  refreshGitMirror,
  urlHost,
} from "./source";

const root = mkdtempSync(path.join(os.tmpdir(), "graphreview-plain-git-"));
delete process.env.GITHUB_WEB_URL;
delete process.env.GITLAB_WEB_URL;
delete process.env.LOCAL_REPOS_ROOT;

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const work = path.join(root, "work");
const server = path.join(root, "server.git");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
  });
}

async function main(): Promise<void> {
  // --- URLs ------------------------------------------------------------------
  check("scp-style URL is SSH", isSshUrl("git@git.example.com:team/app.git"));
  check("ssh:// URL is SSH", isSshUrl("ssh://git@git.example.com:2222/team/app.git"));
  check("https URL is not SSH", !isSshUrl("https://git.example.com/team/app.git"));
  check("host of an scp-style URL", urlHost("git@Git.Example.com:team/app.git") === "git.example.com");
  check("host of an ssh:// URL with a port", urlHost("ssh://git@git.example.com:2222/team/app.git") === "git.example.com");
  check("host of a bare host/path", urlHost("github.com/owner/repo") === "github.com");
  check("github.com is GitHub, by SSH too", (await providerForUrl("git@github.com:owner/repo.git")) === "github");
  check("gitlab.com is GitLab", (await providerForUrl("https://gitlab.com/group/sub/project")) === "gitlab");
  check("anything else is plain git", (await providerForUrl("https://git.example.com/team/app.git")) === "git");
  check("a local path isn't a cloneable URL", !isCloneableUrl("/srv/git/app.git") && !isCloneableUrl("C:\\repos\\app"));
  check("ext:: and file:// aren't either", !isCloneableUrl("ext::sh -c touch% /tmp/x") && !isCloneableUrl("file:///srv/git/app.git"));
  check("https, ssh and scp-style are", ["https://h/a/b.git", "ssh://git@h/a/b.git", "git@h:a/b.git"].every(isCloneableUrl));

  // --- A plain git server ------------------------------------------------------
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(path.join(work, "a.ts"), "export const a = 1;\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  git(work, "checkout", "-q", "-b", "feature");
  writeFileSync(path.join(work, "b.ts"), "export const b = 1;\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "feature");
  git(work, "checkout", "-q", "main");
  git(root, "clone", "-q", "--bare", work, server);

  const repo: RepoRecord = {
    id: "plain-git-smoke",
    name: "app",
    url: server,
    provider: "git",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  };

  const first = await prepareRepoSource(repo);
  check("the first prepare clones", first.cloned);
  check("the clone sits at the default branch", first.sha === git(server, "rev-parse", "main").trim());
  check("… detached, so a fetch may move every branch", (await gitIn(first.dir).raw(["symbolic-ref", "-q", "HEAD"]).catch(() => "")).trim() === "");
  const at = inPlacePath(repo);
  check("the clone is read in place", at === first.dir);

  const names = (await listLocalBranches(at!)).map((b) => b.name).sort().join(",");
  check("the server's branches are the clone's branches", names === "feature,main", names);
  const patches = await listLocalFilePatches(at!, "main", "feature");
  check("two branches diff by name", patches.map((p) => `${p.path}:${p.status}`).join(",") === "b.ts:added");

  // A branch pushed after the clone shows up once the picker refreshes.
  git(work, "checkout", "-q", "-b", "later");
  writeFileSync(path.join(work, "c.ts"), "export const c = 1;\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "later");
  git(work, "push", "-q", server, "later");
  git(work, "push", "-q", server, ":feature");
  clearMemoCaches();
  await refreshGitMirror(repo);
  const after = (await listLocalBranches(at!)).map((b) => b.name).sort().join(",");
  check("a pushed branch appears, a deleted one goes", after === "later,main", after);

  check("the staleness probe reads the server's HEAD", (await readCurrentSha(repo)) === git(server, "rev-parse", "main").trim());
  const again = await prepareRepoSource(repo);
  check("a second prepare fetches instead of cloning", !again.cloned && again.sha === first.sha);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(root, { recursive: true, force: true }));
