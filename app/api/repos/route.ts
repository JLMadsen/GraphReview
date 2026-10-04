// `GET /api/repos`  — every tracked repo with its status indicator.
// `POST /api/repos` — add a repo (local path, GitHub URL, or GitLab URL)
//                     and kick off its first analysis
//                     immediately.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  detectDefaultBranch,
  enqueueAnalysis,
  gitHubCloneUrl,
  gitHubRepoWebUrl,
  gitLabCloneUrl,
  gitLabRepoWebUrl,
  LocalPathOutsideRootError,
  listRepoDtos,
  parseGitHubUrl,
  parseGitLabUrl,
  toRepoDto,
  validateLocalRepoPath,
  type RepoDto,
} from "@/lib/jobs";
import { listRepos, upsertRepo } from "@/lib/db";
import type { RepoRecord } from "@/lib/db";
import { apiError, errorMessage } from "./_shared";

// Every response depends on live database state, so nothing here may be
// prerendered or cached at build time.
export const dynamic = "force-dynamic";

const addRepoSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("local"),
    /** Absolute path (or relative to `LOCAL_REPOS_ROOT` when that is set) — validated below. */
    localPath: z.string().trim().min(1, "localPath is required."),
    name: z.string().trim().min(1).optional(),
  }),
  z.object({
    provider: z.literal("github"),
    url: z.string().trim().min(1, "url is required."),
    name: z.string().trim().min(1).optional(),
  }),
  z.object({
    provider: z.literal("gitlab"),
    url: z.string().trim().min(1, "url is required."),
    name: z.string().trim().min(1).optional(),
  }),
]);

export async function GET(): Promise<NextResponse> {
  try {
    // Rendering the list is also a "view" for staleness purposes: a repo whose
    // HEAD has moved gets its refresh scheduled here, which is what makes
    // the "stale, refreshing…" indicator truthful.
    return NextResponse.json(await listRepoDtos({ autoEnqueue: true }));
  } catch (error) {
    return apiError(`Could not list repos: ${errorMessage(error)}`, 503);
  }
}

/**
 * What makes two repos the same: the provider plus the canonical web URL, or
 * the resolved local path. Case-insensitive — GitHub and GitLab paths are,
 * and so are Windows and macOS file systems by default.
 */
function sourceKey(repo: Pick<RepoRecord, "provider" | "url" | "localPath">): string {
  const where = repo.provider === "local" ? path.resolve(repo.localPath ?? "") : (repo.url ?? "");
  const normalized = repo.provider === "local" && process.platform === "linux" ? where : where.toLowerCase();
  return `${repo.provider}|${normalized.replace(/[\\/]+$/, "").replace(/\.git$/, "")}`;
}

/** The 409 for a repo that's already been added, or `null` when it's new. */
async function duplicateOf(candidate: Pick<RepoRecord, "provider" | "url" | "localPath">): Promise<NextResponse | null> {
  const key = sourceKey(candidate);
  const existing = (await listRepos()).find((repo) => sourceKey(repo) === key);
  if (!existing) return null;
  return NextResponse.json(
    { error: `This repo is already added as "${existing.name}".`, code: "duplicate", repoId: existing.id },
    { status: 409 }
  );
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
    // `validateLocalRepoPath` resolves the path (confining it to
    // `LOCAL_REPOS_ROOT` when that is set) and confirms the directory exists.
    let resolved: string;
    try {
      resolved = await validateLocalRepoPath(input.localPath);
    } catch (error) {
      const status = error instanceof LocalPathOutsideRootError ? 403 : 400;
      return apiError(errorMessage(error), status);
    }
    const duplicate = await duplicateOf({ provider: "local", localPath: resolved });
    if (duplicate) return duplicate;

    repoInput = {
      id,
      name: input.name ?? path.basename(resolved),
      localPath: resolved,
      provider: "local",
      defaultBranch: await detectDefaultBranch({ provider: "local", dir: resolved }),
    };
  } else if (input.provider === "gitlab") {
    const ref = parseGitLabUrl(input.url);
    if (!ref) {
      return apiError(
        `Could not parse a project path out of "${input.url}". Expected something like ${gitLabRepoWebUrl({ path: "group/project" })}.`,
        400
      );
    }
    const duplicate = await duplicateOf({ provider: "gitlab", url: gitLabRepoWebUrl(ref) });
    if (duplicate) return duplicate;
    repoInput = {
      id,
      name: input.name ?? ref.path,
      url: gitLabRepoWebUrl(ref),
      provider: "gitlab",
      defaultBranch: await detectDefaultBranch({
        provider: "gitlab",
        url: gitLabCloneUrl(ref),
      }),
    };
  } else {
    const ref = parseGitHubUrl(input.url);
    if (!ref) {
      return apiError(
        `Could not parse an owner/repo out of "${input.url}". Expected something like ${gitHubRepoWebUrl({ owner: "owner", repo: "repo" })}.`,
        400
      );
    }
    const duplicate = await duplicateOf({ provider: "github", url: gitHubRepoWebUrl(ref) });
    if (duplicate) return duplicate;
    repoInput = {
      id,
      name: input.name ?? `${ref.owner}/${ref.repo}`,
      url: gitHubRepoWebUrl(ref),
      provider: "github",
      defaultBranch: await detectDefaultBranch({
        provider: "github",
        url: gitHubCloneUrl(ref),
      }),
    };
  }

  // Checked again after the (slow) default-branch probe above: two quick
  // submits of the same URL both pass the first check while they wait.
  const duplicate = await duplicateOf(repoInput);
  if (duplicate) return duplicate;

  let repo: Awaited<ReturnType<typeof upsertRepo>>;
  try {
    repo = await upsertRepo(repoInput);
  } catch (error) {
    return apiError(`Could not add the repo: ${errorMessage(error)}`, 503);
  }

  // "Adding a repo triggers a full analysis immediately." A queue that
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
