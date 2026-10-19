// `GET /api/repos`  — every tracked repo with its status indicator.
// `POST /api/repos` — add a repo (a local path, or any git URL — GitHub,
//                     GitLab or another server, told apart by its host)
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
  isCloneableUrl,
  isSshUrl,
  LocalPathOutsideRootError,
  listRepoDtos,
  parseGitHubUrl,
  parseGitLabUrl,
  probeRemote,
  providerForUrl,
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
    /** Any git URL; the host decides the provider (`providerForUrl`). */
    provider: z.literal("url"),
    url: z.string().trim().min(1, "url is required."),
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

/** `group/project` out of a clone URL in any form, for a plain git repo's default name. */
function nameFromUrl(url: string): string {
  const pathname = isSshUrl(url) && !url.includes("://") ? url.slice(url.indexOf(":") + 1) : new URL(url).pathname;
  const segments = pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
  return segments.slice(-2).join("/") || url;
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
  // A URL's provider comes from its host — see `providerForUrl`.
  const provider = input.provider === "local" ? "local" : input.provider === "url" ? await providerForUrl(input.url) : input.provider;
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
  } else if (provider === "git") {
    // Any other git server: cloned as entered, with the user's SSH key for an
    // SSH URL. Reached once now, so a typo or a key without access is said
    // here rather than as a failed analysis.
    const url = input.url.replace(/\/+$/, "");
    if (!isCloneableUrl(url)) {
      return apiError(`"${input.url}" isn't a URL git can clone — expected https://host/group/repo.git or git@host:group/repo.git.`, 400);
    }
    const duplicate = await duplicateOf({ provider: "git", url });
    if (duplicate) return duplicate;
    let defaultBranch: string | undefined;
    try {
      defaultBranch = (await probeRemote(url, "git")).defaultBranch;
    } catch (error) {
      return apiError(`Could not reach ${url}: ${errorMessage(error)}`, 400);
    }
    repoInput = { id, name: input.name ?? nameFromUrl(url), url, provider: "git", defaultBranch: defaultBranch ?? "main" };
  } else if (provider === "gitlab") {
    const ref = parseGitLabUrl(input.url);
    if (!ref) {
      return apiError(
        `Could not parse a project path out of "${input.url}". Expected something like ${gitLabRepoWebUrl({ origin: "https://gitlab.com", path: "group/project" })}.`,
        400
      );
    }
    const duplicate = await duplicateOf({ provider: "gitlab", url: gitLabRepoWebUrl(ref) });
    if (duplicate) return duplicate;
    // An SSH URL is cloned as entered, with the user's SSH key; the API
    // (pull requests, CI) still uses the PAT from Settings.
    const cloneUrl = isSshUrl(input.url) ? input.url : undefined;
    repoInput = {
      id,
      name: input.name ?? ref.path,
      url: gitLabRepoWebUrl(ref),
      cloneUrl,
      provider: "gitlab",
      defaultBranch: await detectDefaultBranch({
        provider: "gitlab",
        url: cloneUrl ?? gitLabCloneUrl(ref),
      }),
    };
  } else {
    const ref = parseGitHubUrl(input.url);
    if (!ref) {
      return apiError(
        `Could not parse an owner/repo out of "${input.url}". Expected something like ${gitHubRepoWebUrl({ origin: "https://github.com", owner: "owner", repo: "repo" })}.`,
        400
      );
    }
    const duplicate = await duplicateOf({ provider: "github", url: gitHubRepoWebUrl(ref) });
    if (duplicate) return duplicate;
    const cloneUrl = isSshUrl(input.url) ? input.url : undefined;
    repoInput = {
      id,
      name: input.name ?? `${ref.owner}/${ref.repo}`,
      url: gitHubRepoWebUrl(ref),
      cloneUrl,
      provider: "github",
      defaultBranch: await detectDefaultBranch({
        provider: "github",
        url: cloneUrl ?? gitHubCloneUrl(ref),
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
