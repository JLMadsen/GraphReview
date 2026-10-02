// Reading a review target's code *at its head commit*.
//
// The review's related-code context and the impact check both need the
// code as the PR leaves it, not as the default branch has it: a caller the
// PR already updated must look updated, and the callee's new signature must
// be the one shown. For a local repo that is the checkout's own object
// store; for GitHub/GitLab it is the app-managed clone, with the head commit
// fetched into it on demand (the same mechanism the before/after preview
// uses). Everything here is best-effort — `null` means "read the old way".

import type { RepoRecord } from "@/lib/neo4j";
import type { JobLogger } from "./analyze";
import type { ReviewTarget } from "./review-queue";
import { ensureCommitsInCache, gitIn, validateLocalRepoPath } from "./source";

const GIT_CONFIG = ["safe.directory=*"];
/** Files bigger than this are not read — generated bundles, fixtures. */
const MAX_FILE_BYTES = 400_000;
/** Source extensions the analyzers understand; usages are only searched in these. */
const SOURCE_PATHSPECS = [
  "*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs",
  "*.py", "*.go", "*.java", "*.kt", "*.kts", "*.rs",
];

export interface GrepHit {
  path: string;
  /** 1-based. */
  line: number;
  text: string;
}

export interface HeadSource {
  dir: string;
  sha: string;
  /** The file's text at the head, or `null` when it isn't there (or is too big). Cached. */
  read(path: string): Promise<string | null>;
  /** Whole-word, fixed-string search across the source files at the head. */
  grepWord(word: string, maxHits: number): Promise<{ hits: GrepHit[]; truncated: boolean }>;
}

/** The refs to fetch when a host won't serve a commit by sha. */
function fallbackRefspecs(repo: RepoRecord, target: ReviewTarget): string[] {
  if (target.kind === "refs") return [target.headRef];
  return repo.provider === "gitlab" ? [`merge-requests/${target.prNumber}/head`] : [`pull/${target.prNumber}/head`];
}

/** Opens the head commit for reading, or `null` (logged) when that isn't possible. */
export async function openHeadSource(
  repo: RepoRecord,
  target: ReviewTarget,
  headSha: string | undefined,
  log: JobLogger
): Promise<HeadSource | null> {
  if (!headSha || !/^[0-9a-f]{7,64}$/.test(headSha)) {
    log("head commit unknown — related code and the impact check read the default branch / are skipped");
    return null;
  }
  let dir: string;
  try {
    dir =
      repo.provider === "local"
        ? await validateLocalRepoPath(repo.localPath ?? "")
        : await ensureCommitsInCache(repo, [headSha], fallbackRefspecs(repo, target), log);
  } catch (error) {
    log(`could not open the head commit (${(error as Error).message.split("\n")[0]})`);
    return null;
  }

  const git = gitIn(dir, undefined, GIT_CONFIG);
  const cache = new Map<string, Promise<string | null>>();

  const read = (filePath: string): Promise<string | null> => {
    if (filePath.startsWith("-") || filePath.includes("..")) return Promise.resolve(null);
    let pending = cache.get(filePath);
    if (!pending) {
      pending = git
        .raw(["show", `${headSha}:${filePath}`])
        .then((out) => (out.length > MAX_FILE_BYTES ? null : out))
        .catch(() => null);
      cache.set(filePath, pending);
    }
    return pending;
  };

  const grepWord = async (word: string, maxHits: number) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(word)) return { hits: [], truncated: false };
    let out = "";
    try {
      out = await git.raw([
        "grep", "-n", "-I", "-w", "-F", "--no-color", "-e", word, headSha, "--", ...SOURCE_PATHSPECS,
      ]);
    } catch {
      return { hits: [], truncated: false }; // git grep exits non-zero when nothing matches
    }
    const hits: GrepHit[] = [];
    let truncated = false;
    for (const row of out.split("\n")) {
      // <sha>:<path>:<line>:<text>
      const match = /^[0-9a-f]+:(.+?):(\d+):(.*)$/.exec(row);
      if (!match) continue;
      if (hits.length >= maxHits) {
        truncated = true;
        break;
      }
      hits.push({ path: match[1], line: Number(match[2]), text: match[3] });
    }
    return { hits, truncated };
  };

  return { dir, sha: headSha, read, grepWord };
}
