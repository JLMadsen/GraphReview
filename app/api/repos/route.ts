// `GET /api/repos`  — every tracked repo with its §4 status indicator.
// `POST /api/repos` — add a repo (local path or GitHub URL, decision #4) and
//                     kick off its first analysis immediately (§10).

import { randomUUID } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  detectDefaultBranch,
  enqueueAnalysis,
  gitHubCloneUrl,
  LocalPathOutsideRootError,
  listRepoDtos,
  parseGitHubUrl,
  toRepoDto,
  validateLocalRepoPath,
  type RepoDto,
} from "@/lib/jobs";
import { upsertRepo } from "@/lib/neo4j";
import { apiError, errorMessage } from "./_shared";

// Every response depends on live Neo4j/Redis state, so nothing here may be
// prerendered or cached at build time.
export const dynamic = "force-dynamic";

const addRepoSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("local"),
    /** Absolute (or relative to the local-repos root) path — validated against the bind mount below. */
    localPath: z.string().trim().min(1, "localPath is required."),
    name: z.string().trim().min(1).optional(),
  }),
  z.object({
    provider: z.literal("github"),
    url: z.string().trim().min(1, "url is required."),
    name: z.string().trim().min(1).optional(),
  }),
]);

export async function GET(): Promise<NextResponse> {
  try {
    // Rendering the list is also a "view" for §10 purposes: a repo whose
    // HEAD has moved gets its refresh scheduled here, which is what makes
    // the "stale, refreshing…" indicator truthful.
    return NextResponse.json(await listRepoDtos({ autoEnqueue: true }));
  } catch (error) {
    return apiError(`Could not list repos: ${errorMessage(error)}`, 503);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.json().catch(() => undefined);
  const parsed = addRepoSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      "Invalid request body.",
      400,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }))
    );
  }
  const input = parsed.data;
  const id = randomUUID();

  let repoInput: Parameters<typeof upsertRepo>[0];
  if (input.provider === "local") {
    // Security boundary (§14): a local source must resolve inside the
    // read-only bind mount. `validateLocalRepoPath` rejects `..` escapes and
    // absolute paths pointing elsewhere, and confirms the directory exists.
    let resolved: string;
    try {
      resolved = await validateLocalRepoPath(input.localPath);
    } catch (error) {
      const status = error instanceof LocalPathOutsideRootError ? 403 : 400;
      return apiError(errorMessage(error), status);
    }

    repoInput = {
      id,
      name: input.name ?? path.basename(resolved),
      localPath: resolved,
      provider: "local",
      defaultBranch: await detectDefaultBranch({ provider: "local", dir: resolved }),
    };
  } else {
    const ref = parseGitHubUrl(input.url);
    if (!ref) {
      return apiError(
        `Could not parse an owner/repo out of "${input.url}". Expected something like https://github.com/owner/repo.`,
        400
      );
    }
    repoInput = {
      id,
      name: input.name ?? `${ref.owner}/${ref.repo}`,
      url: `https://github.com/${ref.owner}/${ref.repo}`,
      provider: "github",
      defaultBranch: await detectDefaultBranch({
        provider: "github",
        url: gitHubCloneUrl(ref),
      }),
    };
  }

  let repo: Awaited<ReturnType<typeof upsertRepo>>;
  try {
    repo = await upsertRepo(repoInput);
  } catch (error) {
    return apiError(`Could not add the repo: ${errorMessage(error)}`, 503);
  }

  // §10: "Adding a repo triggers a full analysis immediately." A queue that
  // is temporarily unreachable must not lose the repo that was just created
  // — it is reported as `error` and can be retried from the UI
  // (POST /api/repos/[repoId]/refresh).
  let status: RepoDto["status"] = "analyzing";
  try {
    await enqueueAnalysis(repo.id);
  } catch (error) {
    console.error(
      `[api/repos] repo ${repo.id} created but its initial analysis could not be queued: ${errorMessage(error)}`
    );
    status = "error";
  }

  return NextResponse.json(toRepoDto(repo, status), { status: 201 });
}
