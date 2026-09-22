// POST /api/repos/[repoId]/diff-impact — the "PR diff impact" feature from
// the original prototype's Graph-tab sidebar. Accepts one of
// three request shapes and resolves the changed files to the `Component`s
// that own them via `BELONGS_TO`.
//
// This route is intentionally read-only against Neo4j — it does not upsert
// a `PullRequest`/`RefSnapshot` node or write `CHANGES` edges. Persisting
// PR/ref-comparison data is the analysis/ingestion pipeline's job (outside
// this task's owned paths); this endpoint only answers "what does this diff
// touch right now" for the graph UI.

import { NextResponse } from "next/server";
import { z } from "zod";
import { compareRefs, listPullRequestFiles } from "@/lib/github";
import { compareRefs as compareGitLabRefs, listMergeRequestFiles } from "@/lib/gitlab";
import {
  listLocalChangedFiles,
  matchFilesToComponents,
  resolveGitHubAccess,
  resolveGitLabAccess,
  toDiffImpactResponse,
  type GitHubUnavailableReason,
  type GitLabUnavailableReason,
} from "@/lib/jobs";
import { getRepoById } from "@/lib/neo4j";
import type { DiffImpactResponseDTO } from "@/components/graph/types";

export const dynamic = "force-dynamic";

const bodySchema = z.union([
  z.object({ prNumber: z.number().int().positive() }),
  z.object({ baseRef: z.string().min(1), headRef: z.string().min(1) }),
  z.object({ filePaths: z.array(z.string()) }),
]);

/** Turns a resolver's "why not" reason into the message this route already returned for that case, so the response shape stays the same for GitHub as it dispatches to GitLab too. */
function accessErrorMessage(
  host: "GitHub" | "GitLab",
  reason: GitHubUnavailableReason | GitLabUnavailableReason,
  repoUrl?: string
): string {
  if (reason === "no_token") return `No ${host} PAT configured in Settings.`;
  if (reason === "invalid_url") {
    return host === "GitLab"
      ? `Could not parse a project path from ${repoUrl ?? "the stored URL"}.`
      : `Could not parse an owner/repo from ${repoUrl ?? "the stored URL"}.`;
  }
  return `This repo has no ${host} URL on record.`;
}

// The file-path -> component resolution itself lives in
// `lib/jobs/diff-components.ts`, shared with the AI review pipeline,
// which starts from the exact same question ("what does this diff touch?")
// and additionally needs the per-component file grouping. This route only
// projects that result down to its own response shape.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) {
  const { repoId } = await params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Body must be { prNumber } or { baseRef, headRef } or { filePaths }.",
      },
      { status: 400 }
    );
  }

  try {
    const repo = await getRepoById(repoId);
    if (!repo) {
      return NextResponse.json({ error: "Repo not found." }, { status: 404 });
    }

    let changedPaths: string[];

    if ("filePaths" in parsed.data) {
      changedPaths = parsed.data.filePaths.map((p) => p.trim()).filter(Boolean);
    } else if ("baseRef" in parsed.data && repo.provider === "local") {
      // Local repos have no GitHub URL to compare against, but the refs are
      // sitting right there in the checkout — same "no PAT needed" reasoning
      // as the Branches tab's local-git path (lib/jobs/local-git.ts).
      if (!repo.localPath) {
        return NextResponse.json(
          { error: "This local repo has no path on record." },
          { status: 400 }
        );
      }
      try {
        changedPaths = await listLocalChangedFiles(
          repo.localPath,
          parsed.data.baseRef,
          parsed.data.headRef
        );
      } catch (err) {
        return NextResponse.json(
          {
            error: `Local ref comparison failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
          { status: 400 }
        );
      }
    } else if (repo.provider === "gitlab") {
      const access = await resolveGitLabAccess(repo);
      if (!access.ok) {
        return NextResponse.json(
          { error: accessErrorMessage("GitLab", access.reason, repo.url) },
          { status: 400 }
        );
      }

      if ("prNumber" in parsed.data) {
        const { data: files } = await listMergeRequestFiles(
          access.token,
          access.ref.path,
          parsed.data.prNumber
        );
        changedPaths = files.map((f) => f.filename);
      } else {
        const { data: comparison } = await compareGitLabRefs(
          access.token,
          access.ref.path,
          parsed.data.baseRef,
          parsed.data.headRef
        );
        changedPaths = comparison.files.map((f) => f.filename);
      }
    } else {
      const access = await resolveGitHubAccess(repo);
      if (!access.ok) {
        return NextResponse.json(
          { error: accessErrorMessage("GitHub", access.reason, repo.url) },
          { status: 400 }
        );
      }

      if ("prNumber" in parsed.data) {
        const { data: files } = await listPullRequestFiles(
          access.token,
          access.ref.owner,
          access.ref.repo,
          parsed.data.prNumber
        );
        changedPaths = files.map((f) => f.filename);
      } else {
        const { data: comparison } = await compareRefs(
          access.token,
          access.ref.owner,
          access.ref.repo,
          parsed.data.baseRef,
          parsed.data.headRef
        );
        changedPaths = comparison.files.map((f) => f.filename);
      }
    }

    // Dedupe defensively — GitHub shouldn't return duplicates, but a pasted
    // paths textarea easily could.
    const uniquePaths = Array.from(new Set(changedPaths));
    const match = await matchFilesToComponents(repoId, uniquePaths);
    const body: DiffImpactResponseDTO = toDiffImpactResponse(match);
    return NextResponse.json(body);
  } catch (err) {
    console.error(`POST /api/repos/${repoId}/diff-impact failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to compute diff impact." },
      { status: 500 }
    );
  }
}
