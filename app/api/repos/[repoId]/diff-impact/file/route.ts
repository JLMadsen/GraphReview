// GET /api/repos/[repoId]/diff-impact/file — the unified diff for one file
// within a review target (PR or ref comparison), fetched on demand for the
// Graph tab's AI review dock. A `FindingDTO` only carries
// a `filePath`/`lineRange`, not the diff text itself, so a "view the code
// this finding is about" action re-fetches just that one file's patch here
// rather than shipping every touched file's diff down with the findings.
//
// Sibling of `../route.ts`: that endpoint maps changed paths onto
// components, this one re-fetches the same diff source (PR files / ref
// comparison / local git) and hands back one file's raw patch text — no
// database write, no component matching.
//
// A path that is NOT part of the diff comes back as the whole file
// (`content`) instead of a 404: at `?sha=<head commit>` when given — what an
// impact finding points at, a caller the change left untouched, at the
// commit that was reviewed — and otherwise at the target's head, for any
// file clicked in a list while this diff is selected.
//
// With `?view=file` it returns the whole file instead of its patch
// (`FileContentResponseDTO`), read at the target's head — or at its base for
// a file the diff deletes. That is the diff modal's "File" tab.

import { NextResponse } from "next/server";
import { z } from "zod";
import { gitRefSchema } from "../../../_shared";
import { compareRefs, getPullRequest, listPullRequestFiles } from "@/lib/github";
import type { PullRequestFile } from "@/lib/github";
import { compareRefs as compareGitLabRefs, getMergeRequest, listMergeRequestFiles } from "@/lib/gitlab";
import { listLocalFilePatches, resolveGitHubAccess, resolveGitLabAccess } from "@/lib/jobs";
import { resolveLocalRefSha } from "@/lib/jobs/local-git";
import { MAX_FILE_CHARS, readFileAtCommit } from "@/lib/jobs/pr-context";
import { getRepoById } from "@/lib/db";
import type { RepoRecord } from "@/lib/db";
import type { FileContentResponseDTO, FileDiffResponseDTO } from "@/components/graph/types";

export const dynamic = "force-dynamic";

const shaSchema = z.string().regex(/^[0-9a-f]{7,64}$/).optional();
const querySchema = z.union([
  z.object({
    path: z.string().min(1),
    prNumber: z.coerce.number().int().positive(),
    sha: shaSchema,
  }),
  z.object({
    path: z.string().min(1),
    baseRef: gitRefSchema,
    headRef: gitRefSchema,
    sha: shaSchema,
  }),
]);

interface FileLike {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

function fromPullRequestFile(file: PullRequestFile): FileLike {
  return {
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  };
}

type FileQuery = z.infer<typeof querySchema>;

/**
 * The commit (or ref) one end of the target points at, for reading a whole
 * file there. A PR's ends come from the host; a ref pair is used as given,
 * except on a local repo, which can only be read at a commit.
 */
async function targetRef(repo: RepoRecord, query: FileQuery, side: "head" | "base"): Promise<string | null> {
  if (!("prNumber" in query)) {
    const ref = side === "head" ? query.headRef : query.baseRef;
    if (repo.provider === "local") return repo.localPath ? resolveLocalRefSha(repo.localPath, ref) : null;
    return ref;
  }
  if (repo.provider === "gitlab") {
    const access = await resolveGitLabAccess(repo);
    if (!access.ok) return null;
    const { data: mr } = await getMergeRequest(access.token, access.ref.path, query.prNumber);
    return side === "head" ? mr.headSha : mr.baseSha;
  }
  if (repo.provider === "local") return null;
  const access = await resolveGitHubAccess(repo);
  if (!access.ok) return null;
  const { data: pr } = await getPullRequest(access.token, access.ref.owner, access.ref.repo, query.prNumber);
  return side === "head" ? pr.headSha : pr.baseSha;
}

function toResponse(file: FileLike): FileDiffResponseDTO {
  return {
    path: file.path,
    status: file.status as FileDiffResponseDTO["status"],
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) {
  const { repoId } = await params;

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Query must include ?path=<file path> plus either ?prNumber=<n> or ?baseRef=<ref>&headRef=<ref>.",
      },
      { status: 400 }
    );
  }
  const { path } = parsed.data;

  try {
    const repo = await getRepoById(repoId);
    if (!repo) {
      return NextResponse.json({ error: "Repo not found." }, { status: 404 });
    }

    let file: FileLike | undefined;

    if (repo.provider === "local") {
      // Same rule the review job enforces (lib/jobs/review.ts): a local
      // checkout has no PR concept, only refs sitting in its own `.git`.
      if ("prNumber" in parsed.data) {
        return NextResponse.json(
          {
            error:
              "A pull/merge request cannot be diffed on a repo with no git-host link — compare two refs instead.",
          },
          { status: 400 }
        );
      }
      if (!repo.localPath) {
        return NextResponse.json(
          { error: "This local repo has no path on record." },
          { status: 400 }
        );
      }
      const files = await listLocalFilePatches(
        repo.localPath,
        parsed.data.baseRef,
        parsed.data.headRef
      );
      const match = files.find((f) => f.path === path);
      if (match) {
        file = {
          path: match.path,
          status: match.status,
          additions: match.additions,
          deletions: match.deletions,
          patch: match.patch,
        };
      }
    } else if (repo.provider === "gitlab") {
      const access = await resolveGitLabAccess(repo);
      if (!access.ok) {
        return NextResponse.json(
          {
            error:
              access.reason === "no_token"
                ? "No GitLab PAT configured in Settings."
                : "This repo is not linked to GitLab.",
          },
          { status: 400 }
        );
      }
      const { path: projectPath } = access.ref;

      if ("prNumber" in parsed.data) {
        const { data: files } = await listMergeRequestFiles(
          access.token,
          projectPath,
          parsed.data.prNumber
        );
        const match = files.find((f) => f.filename === path);
        if (match) file = fromPullRequestFile(match);
      } else {
        const { data: comparison } = await compareGitLabRefs(
          access.token,
          projectPath,
          parsed.data.baseRef,
          parsed.data.headRef
        );
        const match = comparison.files.find((f) => f.filename === path);
        if (match) file = fromPullRequestFile(match);
      }
    } else {
      const access = await resolveGitHubAccess(repo);
      if (!access.ok) {
        return NextResponse.json(
          {
            error:
              access.reason === "no_token"
                ? "No GitHub PAT configured in Settings."
                : "This repo is not linked to GitHub.",
          },
          { status: 400 }
        );
      }
      const { owner, repo: repoName } = access.ref;

      if ("prNumber" in parsed.data) {
        const { data: files } = await listPullRequestFiles(
          access.token,
          owner,
          repoName,
          parsed.data.prNumber
        );
        const match = files.find((f) => f.filename === path);
        if (match) file = fromPullRequestFile(match);
      } else {
        const { data: comparison } = await compareRefs(
          access.token,
          owner,
          repoName,
          parsed.data.baseRef,
          parsed.data.headRef
        );
        const match = comparison.files.find((f) => f.filename === path);
        if (match) file = fromPullRequestFile(match);
      }
    }

    if (url.searchParams.get("view") === "file") {
      const side = file?.status === "removed" ? "base" : "head";
      const ref = await targetRef(repo, parsed.data, side);
      const whole = ref ? await readFileAtCommit(repo, ref, path) : null;
      if (!ref || whole?.source !== "commit") {
        return NextResponse.json(
          { error: `Couldn't read "${path}" at the ${side === "head" ? "head" : "base"} of this diff (missing, binary, or too large).` },
          { status: 404 }
        );
      }
      const body: FileContentResponseDTO = {
        path,
        side,
        ref,
        content: whole.text,
        truncated: whole.text.length >= MAX_FILE_CHARS,
      };
      return NextResponse.json(body);
    }

    if (!file) {
      const ref = parsed.data.sha ?? (await targetRef(repo, parsed.data, "head"));
      const whole = ref ? await readFileAtCommit(repo, ref, path) : null;
      if (ref && whole?.source === "commit") {
        const body: FileDiffResponseDTO = {
          path,
          status: "unchanged",
          additions: 0,
          deletions: 0,
          content: whole.text,
          ref,
        };
        return NextResponse.json(body);
      }
    }

    if (!file) {
      return NextResponse.json(
        { error: `"${path}" isn't in this diff, and couldn't be read at its head (missing, binary, or too large).` },
        { status: 404 }
      );
    }

    return NextResponse.json(toResponse(file));
  } catch (err) {
    console.error(`GET /api/repos/${repoId}/diff-impact/file failed:`, err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to load the file diff.",
      },
      { status: 500 }
    );
  }
}
