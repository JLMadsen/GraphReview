// GET /api/repos/[repoId]/diff-impact/file — the unified diff for one file
// within a review target (PR or ref comparison), fetched on demand for the
// Graph tab's AI review dock. A `FindingDTO` only carries
// a `filePath`/`lineRange`, not the diff text itself, so a "view the code
// this finding is about" action re-fetches just that one file's patch here
// rather than shipping every touched file's diff down with the findings.
//
// Sibling of `../route.ts`: that endpoint maps changed paths onto
// components, this one hands back one file's raw patch text — from a local
// `git diff` when the commits are on disk, the host's API otherwise
// (lib/jobs/diff-files.ts) — no database write, no component matching.
// `?w=1` asks for whitespace-only changes to be left out.
//
// A path that is NOT part of the diff comes back as the whole file
// (`content`) instead of a 404: at `?sha=<head commit>` when given — what an
// impact finding points at, a caller the change left untouched, at the
// commit that was reviewed — and otherwise at the target's head, for any
// file clicked in a list while this diff is selected.
//
// With `?view=file` it returns the whole file instead of its patch
// (`FileContentResponseDTO`), read at the target's head — or at its base for
// a file the diff deletes. That is the diff modal's "File" tab. With
// `?view=file&side=base` it is read at the base instead (the "Base" tab: the
// file before the change).

import { NextResponse } from "next/server";
import { z } from "zod";
import { gitRefSchema } from "../../../_shared";
import { DiffFilesError, loadTargetDiff, pullRequestEnds, type DiffFile, type DiffFilesResult } from "@/lib/jobs/diff-files";
import type { ReviewTarget } from "@/lib/jobs/review-queue";
import { viewerRefSha } from "@/lib/jobs/local-git";
import { inPlacePath, readsInPlace } from "@/lib/jobs/source";
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

type FileQuery = z.infer<typeof querySchema>;

/**
 * The commit (or ref) one end of the target points at, for reading a whole
 * file there. A PR's ends come from the host; a ref pair is used as given,
 * except on a local repo, which can only be read at a commit.
 */
async function targetRef(repo: RepoRecord, query: FileQuery, side: "head" | "base"): Promise<string | null> {
  if (!("prNumber" in query)) {
    const ref = side === "head" ? query.headRef : query.baseRef;
    if (readsInPlace(repo)) {
      const at = inPlacePath(repo);
      return at ? viewerRefSha(at, ref) : null;
    }
    return ref;
  }
  // Shared with the diff itself, which asked the host a moment ago.
  const ends = await pullRequestEnds(repo, query.prNumber);
  return ends ? (side === "head" ? ends.head : ends.base) : null;
}

function toResponse(file: DiffFile, diff: DiffFilesResult): FileDiffResponseDTO {
  return {
    path: file.path,
    status: file.status as FileDiffResponseDTO["status"],
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
    source: diff.source,
    whitespace: diff.whitespace,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    ...(file.whitespaceOnly ? { whitespaceOnly: true } : {}),
    ...(file.binary ? { binary: true } : {}),
    ...(file.truncated ? { truncated: true } : {}),
    ...(file.fingerprint ? { fingerprint: file.fingerprint } : {}),
  };
}

function toTarget(query: FileQuery): ReviewTarget {
  return "prNumber" in query
    ? { kind: "pr", prNumber: query.prNumber }
    : { kind: "refs", baseRef: query.baseRef, headRef: query.headRef };
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

    // Git first — the checkout, or the app's clone with both ends fetched —
    // and the host's API patch only when that can't be had (DESIGN.md §6.24).
    const ignoreWhitespace = url.searchParams.get("w") === "1";
    const diff = await loadTargetDiff(repo, toTarget(parsed.data), { ignoreWhitespace, path });
    const file = diff.files.find((f) => f.path === path);
    if (url.searchParams.get("view") === "file") {
      const side = file?.status === "removed" || url.searchParams.get("side") === "base" ? "base" : "head";
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

    return NextResponse.json(toResponse(file, diff));
  } catch (err) {
    if (err instanceof DiffFilesError) return NextResponse.json({ error: err.message }, { status: 400 });
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
