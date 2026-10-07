/**
 * Checks that a ref from a request can't smuggle a git option — no network,
 * no AI.
 *
 *   npx tsx lib/jobs/smoke-test-local-git.ts
 *
 * `--output=<path>` as a base ref would turn `git diff <base>...<head>` into
 * "write the diff to <path>...<head>". Builds a throwaway repo in the temp
 * folder, then checks that the git layer (./local-git.ts) refuses such refs
 * and writes nothing, that `--end-of-options` alone stops git even with that
 * check bypassed, and that the API edge (app/api/repos/_shared.ts) and the
 * MCP tools (lib/mcp/server.ts) refuse them before git is reached. The MCP
 * part uses a temp GRAPHREVIEW_HOME, never the real database.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "graphreview-local-git-"));
// Before anything can open the database: the MCP tools read repos from it.
process.env.GRAPHREVIEW_HOME = path.join(root, "home");
delete process.env.LOCAL_REPOS_ROOT;

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function rejects(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const repoDir = path.join(root, "repo");
const outDir = path.join(root, "out");
/** Forward slashes, like the reported exploit: git takes them on every OS. */
const out = outDir.split(path.sep).join("/");

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
    cwd: repoDir,
    encoding: "utf8",
  });
}

const nothingWritten = () => readdirSync(outDir).length === 0;
const repoClean = () => git("status", "--porcelain", "--untracked-files=all").trim() === "";

async function main(): Promise<void> {
  mkdirSync(repoDir);
  mkdirSync(outDir);
  git("init", "--quiet");
  writeFileSync(path.join(repoDir, "a.ts"), "export const a = 1;\n");
  git("add", "a.ts");
  git("commit", "--quiet", "-m", "first");
  writeFileSync(path.join(repoDir, "a.ts"), "export const a = 2;\n");
  git("commit", "--quiet", "-am", "second");

  const { isSafeGitRef } = await import("./git-ref");
  const { gitIn } = await import("./source");
  const { listLocalChangedFiles, listLocalCommits, listLocalFilePatches, localMergeBase, resolveLocalRefSha } =
    await import("./local-git");

  console.log("the ref check:");
  for (const ref of ["main", "feature/x-y", "HEAD~1", "HEAD^", "v1.2.3", "a".repeat(40), "@{u}"]) {
    check(`accepts ${JSON.stringify(ref)}`, isSafeGitRef(ref));
  }
  for (const ref of ["", "-", "--output=x", "-ox", " --output=x", "a b", "a\tb", "HEAD\n--output=x", "a\u0000b", "a\u007fb"]) {
    // JSON.stringify leaves DEL as is, which prints as nothing.
    check(`refuses ${JSON.stringify(ref).replace(/\u007f/g, "\\u007f")}`, !isSafeGitRef(ref));
  }

  console.log("\ncontrol (plain git, no protection):");
  {
    execFileSync("git", ["diff", "--name-only", `--output=${out}/control...HEAD`, "--"], { cwd: repoDir });
    check("git diff does write --output=<path>...HEAD — the vector is real", existsSync(path.join(outDir, "control...HEAD")));
    rmSync(path.join(outDir, "control...HEAD"), { force: true });
  }

  console.log("\nlistLocalFilePatches:");
  {
    const files = await listLocalFilePatches(repoDir, "HEAD~1", "HEAD");
    check(
      "a normal comparison still works",
      files.length === 1 && files[0].path === "a.ts" && files[0].status === "modified" && Boolean(files[0].patch?.includes("+export const a = 2;")),
      JSON.stringify(files)
    );

    const error = await rejects(() => listLocalFilePatches(repoDir, `--output=${out}/x`, "HEAD"));
    check("--output=<path> as the base ref throws", error?.includes("is not a valid git ref") ?? false, error ?? "resolved");
    check("… and no file was written", nothingWritten() && !existsSync(`${out}/x...HEAD`), readdirSync(outDir).join(", "));

    const relative = await rejects(() => listLocalFilePatches(repoDir, "--output=pwned", "HEAD"));
    check("a relative --output throws too, and nothing lands in the repo", relative !== null && repoClean());

    const head = await rejects(() => listLocalFilePatches(repoDir, "HEAD~1", `--output=${out}/y`));
    check("an option-shaped head ref throws", head !== null && nothingWritten());

    const newline = await rejects(() => listLocalFilePatches(repoDir, `HEAD\n--output=${out}/z`, "HEAD"));
    check("a ref with a line break throws", newline !== null && nothingWritten());
  }

  console.log("\nthe other local-git calls:");
  {
    const changed = await listLocalChangedFiles(repoDir, "HEAD~1", "HEAD");
    check("listLocalChangedFiles: a normal comparison still works", changed.length === 1 && changed[0] === "a.ts");
    const error = await rejects(() => listLocalChangedFiles(repoDir, `--output=${out}/c`, "HEAD"));
    check("listLocalChangedFiles: refuses --output", error !== null && nothingWritten());

    const commits = await listLocalCommits(repoDir, "HEAD", 5);
    check("listLocalCommits: still lists commits", commits.length === 2 && commits[0].subject === "second");
    check("listLocalCommits: refuses --output", (await rejects(() => listLocalCommits(repoDir, `--output=${out}/l`))) !== null && nothingWritten());

    check("resolveLocalRefSha: still resolves HEAD", /^[0-9a-f]{40}$/.test(await resolveLocalRefSha(repoDir, "HEAD")));
    check("resolveLocalRefSha: refuses an option", (await rejects(() => resolveLocalRefSha(repoDir, "--all"))) !== null);

    check("localMergeBase: still finds the merge base", /^[0-9a-f]{40}$/.test((await localMergeBase(repoDir, "HEAD~1", "HEAD")) ?? ""));
    check("localMergeBase: an option-shaped ref is no merge base", (await localMergeBase(repoDir, "--all", "HEAD")) === null);
  }

  console.log("\n--end-of-options on its own (the ref check bypassed):");
  {
    const error = await rejects(() =>
      gitIn(repoDir, undefined, ["safe.directory=*"]).raw(["diff", "--name-only", "--end-of-options", `--output=${out}/raw...HEAD`, "--"])
    );
    check("git reads the ref as a revision and fails", error !== null, "resolved");
    check("… and writes no file", nothingWritten(), readdirSync(outDir).join(", "));
  }

  console.log("\nAPI edge:");
  {
    const { gitRefSchema, targetBodySchema, targetFromSearchParams } = await import("@/app/api/repos/_shared");
    check("gitRefSchema refuses --output", !gitRefSchema.safeParse(`--output=${out}/s`).success);
    check("targetBodySchema refuses an option-shaped baseRef", !targetBodySchema.safeParse({ baseRef: "--output=x", headRef: "HEAD" }).success);
    check("targetBodySchema refuses a ref with whitespace", !targetBodySchema.safeParse({ baseRef: "main", headRef: "a b" }).success);
    check("targetBodySchema still takes two refs", targetBodySchema.safeParse({ baseRef: "main", headRef: "feature/x" }).success);
    const params = (query: string) => targetFromSearchParams(new URLSearchParams(query));
    check("targetFromSearchParams refuses --output", params("baseRef=--output%3Dx&headRef=HEAD") === null);
    check("targetFromSearchParams refuses a control character", params("baseRef=main&headRef=a%00b") === null);
    check("targetFromSearchParams still takes two refs", params("baseRef=main&headRef=feature%2Fx")?.kind === "refs");
  }

  console.log("\nMCP tools:");
  {
    const { upsertRepo } = await import("@/lib/db");
    const { closeDb } = await import("@/lib/db/client");
    const { createGraphReviewMcpServer } = await import("@/lib/mcp/server");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const repo = await upsertRepo({ id: "smoke-local", name: "smoke", localPath: repoDir, defaultBranch: "main", provider: "local" });
    const server = createGraphReviewMcpServer();
    const client = new Client({ name: "smoke-test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const text = (result: Awaited<ReturnType<typeof client.callTool>>) =>
      (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");

    try {
      for (const tool of ["get_changed_components", "get_review"]) {
        const result = await client.callTool({ name: tool, arguments: { repoId: repo.id, target: `refs:--output=${out}/mcp...HEAD` } });
        check(
          `${tool}: refs:--output=… is a tool error`,
          result.isError === true && text(result).includes("not a valid review target"),
          text(result).slice(0, 200)
        );
      }
      check("… and no file was written", nothingWritten(), readdirSync(outDir).join(", "));

      const ok = await client.callTool({ name: "get_changed_components", arguments: { repoId: repo.id, target: "refs:HEAD~1...HEAD" } });
      check("get_changed_components: a normal target still works", !ok.isError && text(ok).includes("a.ts"), text(ok).slice(0, 200));
    } finally {
      await client.close();
      await server.close();
      closeDb();
    }
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows can hold the SQLite file a moment longer; it's the temp folder.
    }
  });
