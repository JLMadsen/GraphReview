// GET /api/repos/[repoId]/file?path=<file> — one file of the repo as it was
// analyzed: its text at the last analyzed commit, or, when that commit can't
// be read, the app's checkout of the default branch (a local repo: the
// working copy). The Graph tab's file viewer uses it for a file clicked in
// any list while no diff is selected; with a diff selected it goes through
// `diff-impact/file` instead, which knows the diff's two ends.

import { NextResponse } from "next/server";
import { getRepoById } from "@/lib/db";
import { MAX_FILE_CHARS, readFileAtCommit } from "@/lib/jobs/pr-context";
import type { FileContentResponseDTO } from "@/components/graph/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const path = new URL(request.url).searchParams.get("path")?.trim();
  if (!path) {
    return NextResponse.json({ error: "Query must include ?path=<file path>." }, { status: 400 });
  }

  try {
    const repo = await getRepoById(repoId);
    if (!repo) return NextResponse.json({ error: "Repo not found." }, { status: 404 });

    const whole = await readFileAtCommit(repo, repo.lastAnalyzedSha, path);
    if (!whole) {
      return NextResponse.json(
        { error: `Couldn't read "${path}" (missing, binary, or too large).` },
        { status: 404 }
      );
    }
    const body: FileContentResponseDTO = {
      path,
      side: "head",
      ref:
        whole.source === "commit" && repo.lastAnalyzedSha
          ? repo.lastAnalyzedSha
          : repo.provider === "local"
            ? "working copy"
            : repo.defaultBranch,
      content: whole.text,
      truncated: whole.text.length >= MAX_FILE_CHARS,
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error(`GET /api/repos/${repoId}/file failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read the file." },
      { status: 500 }
    );
  }
}
