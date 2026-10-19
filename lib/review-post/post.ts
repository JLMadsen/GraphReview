// Posting picked findings to the PR/MR as one review (DESIGN.md §6.23).
//
// Only ever reached from the user's "Post review" click — nothing here runs
// on a schedule or when a review finishes (locked decision #10). The draft
// (`buildPostDraft`) is what the dialog previews; `postReview` sends exactly
// that, refusing findings already posted and a second post in flight.

import {
  createPullRequestReview,
  getTokenScopes as getGitHubTokenScopes,
  GitHubApiError,
  type PullRequestReviewComment,
  type PullRequestReviewEvent,
} from "@/lib/github";
import type { GitHostAuth } from "@/lib/github";
import {
  approveMergeRequest,
  createMergeRequestDiscussion,
  createMergeRequestNote,
  getMergeRequestDiffRefs,
  getTokenScopes as getGitLabTokenScopes,
  GitLabApiError,
  unapproveMergeRequest,
} from "@/lib/gitlab";
import { listFindingsByTargetKey, type FindingWithComponent, type RepoRecord } from "@/lib/db";
import { resolveGitHubAccess, type GitHubUnavailableReason } from "@/lib/jobs/github-access";
import { resolveGitLabAccess, type GitLabUnavailableReason } from "@/lib/jobs/gitlab-access";
import { loadPrContext } from "@/lib/jobs/pr-context";
import { reviewTargetKey } from "@/lib/jobs/review-queue";
import {
  ASSESSMENT_VISUALS,
  computeVerdict,
  findingTag,
  formatLocation,
  isImpactFinding,
  isIntentFinding,
  isResolvable,
  mdFindingLine,
  mdInline,
} from "@/components/graph/review-visuals";
import type { FindingDTO } from "@/components/graph/types";
import { placeComment } from "./hunks";
import { appendPostLog, findingFingerprint, postedRecordOf, readPostLog, type PostHost, type PostVerdict, type PostedFinding } from "./store";
import type { PostDraftItem, PostDraftResponse, PostReviewRequest, PostReviewResponse } from "./types";

const MAX_RATIONALE_CHARS = 1500;

export const POST_FOOTER = "_Posted by hand from GraphReview's AI review — advisory, AI can be wrong._";

export const GITLAB_REQUEST_CHANGES_NOTE =
  "GitLab has no \"request changes\" state: the summary is posted headed \"Changes requested\" and your approval, if any, is revoked.";

/** A refusal the route turns into a status and a message as is. */
export class PostReviewError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
  }
}

function asDto(f: FindingWithComponent): FindingDTO {
  return f as unknown as FindingDTO;
}

function hostOf(repo: RepoRecord): PostHost | null {
  return repo.provider === "github" || repo.provider === "gitlab" ? repo.provider : null;
}

const UNAVAILABLE: Record<GitHubUnavailableReason | GitLabUnavailableReason, (host: string) => string> = {
  not_linked: () => "This repo isn't linked to GitHub or GitLab, so there's no PR to post to.",
  invalid_url: (host) => `The repo's ${host} URL couldn't be read.`,
  no_token: (host) => `No ${host} token is saved — add one for this server in Settings → Git servers to post reviews.`,
};

/** The Markdown an inline comment carries: verdict, tag, summary, then the reasoning. */
export function commentBody(f: FindingWithComponent): string {
  const dto = asDto(f);
  const tag = isImpactFinding(dto) ? "Caller not updated" : findingTag(dto);
  const rationale = f.rationale.trim();
  const clipped = rationale.length > MAX_RATIONALE_CHARS ? `${rationale.slice(0, MAX_RATIONALE_CHARS - 1)}…` : rationale;
  return [
    `**${ASSESSMENT_VISUALS[f.assessment].label}**${tag ? ` · ${mdInline(tag)}` : ""} — ${mdInline(f.summary)}`,
    ...(clipped ? ["", clipped] : []),
    "",
    "<sub>GraphReview · advisory, AI can be wrong</sub>",
  ].join("\n");
}

/** The prefilled, editable part of the summary: the verdict and the intent line. */
export function defaultSummary(findings: FindingWithComponent[]): string {
  const dtos = findings.map(asDto);
  const verdict = computeVerdict(dtos);
  const intent = dtos.find(isIntentFinding);
  const lines = ["## GraphReview review"];
  if (verdict) {
    lines.push("", `**Overall: ${ASSESSMENT_VISUALS[verdict.intent].label}** — ${verdict.open} open finding${verdict.open === 1 ? "" : "s"}, ${verdict.resolved} resolved.`);
  }
  if (intent) lines.push("", `**Delivers what it describes: ${ASSESSMENT_VISUALS[intent.assessment].label}** — ${mdInline(intent.summary)}`);
  return lines.join("\n");
}

/** What follows the user's summary: findings that couldn't go inline, and the footer. */
export function summaryTail(notInline: FindingWithComponent[]): string {
  const lines: string[] = [];
  if (notInline.length > 0) {
    lines.push("", "### Not on a diff line", "", ...notInline.map((f) => `- ${mdFindingLine(asDto(f))}`));
  }
  lines.push("", POST_FOOTER);
  return lines.join("\n");
}

interface Prepared {
  host: PostHost;
  headSha?: string;
  reviewedHeadSha?: string;
  items: Array<PostDraftItem & { finding: FindingWithComponent; oldLine?: number }>;
}

/** The findings a review could post — every one with a file, below OK — placed against the PR's current diff. */
async function prepare(repo: RepoRecord, prNumber: number): Promise<Prepared> {
  const host = hostOf(repo);
  if (!host) throw new PostReviewError(UNAVAILABLE.not_linked(""), 400, "not_linked");
  const target = { kind: "pr" as const, prNumber };
  const targetKey = reviewTargetKey(target);
  const [findings, ctx] = await Promise.all([listFindingsByTargetKey(repo.id, targetKey), loadPrContext(repo, target)]);
  const log = readPostLog(repo.id, targetKey);
  const patchOf = new Map(ctx.files.map((f) => [f.path, f]));
  const headSha = ctx.reviewed.headSha;
  const reviewedHeadSha = findings.find((f) => f.reviewedHeadSha)?.reviewedHeadSha;

  const postable = findings.filter((f) => f.filePath && isResolvable(asDto(f)) && !isIntentFinding(asDto(f)) && !f.callFailed);
  const items = postable.map((f) => {
    const file = patchOf.get(f.filePath!);
    const placement = placeComment(file?.patch, f.lineRange, Boolean(file) && file?.status !== "removed");
    const posted = postedRecordOf(log, f);
    return {
      finding: f,
      ...(placement.ok && placement.oldLine ? { oldLine: placement.oldLine } : {}),
      findingId: f.id,
      assessment: f.assessment,
      resolved: Boolean(f.resolvedAt),
      title: mdFindingLine(asDto(f)),
      summary: f.summary,
      location: formatLocation(asDto(f)),
      inline: placement.ok ? { path: f.filePath!, line: placement.line, ...(placement.startLine ? { startLine: placement.startLine } : {}) } : null,
      ...(placement.ok ? {} : { notInlineReason: placement.reason }),
      body: commentBody(f),
      picked: !posted && !f.resolvedAt && (f.assessment === "defect" || f.assessment === "concern"),
      ...(posted ? { posted: { postedAt: posted.postedAt, url: posted.url } } : {}),
    };
  });
  return {
    host,
    headSha,
    ...(reviewedHeadSha && headSha && reviewedHeadSha !== headSha ? { reviewedHeadSha } : {}),
    items,
  };
}

/** The dialog's preview. Never throws for a fixable reason — it comes back as `unavailable`. */
export async function buildPostDraft(repo: RepoRecord, prNumber: number): Promise<PostDraftResponse> {
  const host = hostOf(repo);
  const targetKey = reviewTargetKey({ kind: "pr", prNumber });
  const reviews = readPostLog(repo.id, targetKey).reviews;
  const base: PostDraftResponse = {
    host,
    prNumber,
    items: [],
    summary: "",
    reviews,
    ...(host === "gitlab" ? { requestChangesNote: GITLAB_REQUEST_CHANGES_NOTE } : {}),
  };
  const access = await accessFor(repo);
  if (!access.ok) return { ...base, unavailable: access.message };
  const prepared = await prepare(repo, prNumber);
  const findings = await listFindingsByTargetKey(repo.id, targetKey);
  return {
    ...base,
    headSha: prepared.headSha,
    ...(prepared.reviewedHeadSha ? { reviewedHeadSha: prepared.reviewedHeadSha } : {}),
    items: prepared.items.map((full) => {
      const item: PostDraftItem & { finding?: unknown; oldLine?: unknown } = { ...full };
      delete item.finding;
      delete item.oldLine;
      return item;
    }),
    summary: defaultSummary(findings),
  };
}

type Access =
  | { ok: true; host: "github"; owner: string; repo: string; token: GitHostAuth }
  | { ok: true; host: "gitlab"; project: string; token: GitHostAuth }
  | { ok: false; message: string };

async function accessFor(repo: RepoRecord): Promise<Access> {
  if (repo.provider === "github") {
    const access = await resolveGitHubAccess(repo);
    return access.ok
      ? { ok: true, host: "github", owner: access.ref.owner, repo: access.ref.repo, token: access.token }
      : { ok: false, message: UNAVAILABLE[access.reason]("GitHub") };
  }
  if (repo.provider === "gitlab") {
    const access = await resolveGitLabAccess(repo);
    return access.ok
      ? { ok: true, host: "gitlab", project: access.ref.path, token: access.token }
      : { ok: false, message: UNAVAILABLE[access.reason]("GitLab") };
  }
  return { ok: false, message: UNAVAILABLE.not_linked("") };
}

/** Refuses up front when the token's scopes are readable and can't write a review. */
async function checkScopes(access: Exclude<Access, { ok: false }>): Promise<void> {
  if (access.host === "github") {
    const { data: scopes } = await getGitHubTokenScopes(access.token);
    if (scopes && !scopes.includes("repo") && !scopes.includes("public_repo")) {
      throw new PostReviewError(
        `Your GitHub token can't post reviews: it has ${scopes.length ? scopes.map((s) => `"${s}"`).join(", ") : "no scopes"}, ` +
          `and needs "repo" ("public_repo" is enough for a public repo). Make a token with that scope and save it in Settings → Git servers.`,
        403,
        "missing_scope"
      );
    }
    return;
  }
  const { data: scopes } = await getGitLabTokenScopes(access.token);
  if (scopes && !scopes.includes("api")) {
    throw new PostReviewError(
      `Your GitLab token can't post reviews: it has ${scopes.length ? scopes.map((s) => `"${s}"`).join(", ") : "no scopes"}, ` +
        `and needs "api" ("read_api" can't write). Make a token with that scope and save it in Settings → Git servers.`,
      403,
      "missing_scope"
    );
  }
}

/** A host's refusal, said in terms of what to fix. */
function describeHostError(err: unknown, host: PostHost): PostReviewError {
  if (err instanceof PostReviewError) return err;
  if (err instanceof GitHubApiError || err instanceof GitLabApiError) {
    if (err.status === 401) return new PostReviewError(`${host === "github" ? "GitHub" : "GitLab"} rejected the token (401) — save a valid one in Settings → Git servers.`, 403, "bad_token");
    if (host === "github" && (err.status === 403 || err.status === 404)) {
      return new PostReviewError(
        `GitHub refused the review (${err.status}). A classic token needs the "repo" scope; a fine-grained token needs "Pull requests: Read and write" on this repo. ${err.message}`,
        403,
        "missing_scope"
      );
    }
    if (host === "gitlab" && err.status === 403) {
      return new PostReviewError(`GitLab refused (403): the token needs the "api" scope and at least Reporter access to the project. ${err.message}`, 403, "missing_scope");
    }
    return new PostReviewError(err.message, 502, "host_error");
  }
  return new PostReviewError(err instanceof Error ? err.message : String(err), 502, "host_error");
}

const inFlight = new Set<string>();

const GITHUB_EVENT: Record<PostVerdict, PullRequestReviewEvent> = {
  comment: "COMMENT",
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
};

/** Posts the picked findings and the summary as one review, and records what was posted. */
export async function postReview(repo: RepoRecord, request: PostReviewRequest): Promise<PostReviewResponse> {
  const target = { kind: "pr" as const, prNumber: request.prNumber };
  const targetKey = reviewTargetKey(target);
  const lockKey = `${repo.id}|${targetKey}`;
  if (inFlight.has(lockKey)) throw new PostReviewError("A review of this PR is being posted already.", 409, "in_flight");
  inFlight.add(lockKey);
  try {
    const access = await accessFor(repo);
    if (!access.ok) throw new PostReviewError(access.message, 400, "unavailable");

    const prepared = await prepare(repo, request.prNumber);
    if (request.headSha && prepared.headSha && request.headSha !== prepared.headSha) {
      throw new PostReviewError("The PR has new commits since the preview — reopen the dialog to check the lines again.", 409, "head_moved");
    }
    const byId = new Map(prepared.items.map((i) => [i.findingId, i]));
    const picked = [...new Set(request.findingIds)].map((id) => byId.get(id));
    if (picked.some((i) => !i)) throw new PostReviewError("A picked finding isn't in this review any more — reopen the dialog.", 409, "stale_draft");
    const items = picked as NonNullable<(typeof picked)[number]>[];
    const already = items.filter((i) => i.posted);
    if (already.length > 0) {
      throw new PostReviewError(`${already.length} of the picked findings ${already.length === 1 ? "was" : "were"} posted already — untick ${already.length === 1 ? "it" : "them"}.`, 409, "already_posted");
    }
    const summary = request.summary.trim();
    if (items.length === 0 && !summary && request.verdict === "comment") {
      throw new PostReviewError("Nothing to post: pick findings or write a summary.", 400, "empty");
    }

    await checkScopes(access).catch((err) => {
      throw describeHostError(err, access.host);
    });

    const inline = items.filter((i) => i.inline);
    const notInline = items.filter((i) => !i.inline);
    const heading = access.host === "gitlab" && request.verdict === "request_changes" ? "**Changes requested**\n\n" : "";
    const body = `${heading}${summary}${summaryTail(notInline.map((i) => i.finding))}`.trim();
    const now = () => new Date().toISOString();
    const record = (i: (typeof items)[number], url: string, isInline: boolean): PostedFinding => ({
      findingId: i.findingId,
      fingerprint: findingFingerprint(i.finding),
      postedAt: now(),
      url,
      inline: isInline,
    });

    let reviewUrl: string;
    try {
      if (access.host === "github") {
        const comments: PullRequestReviewComment[] = inline.map((i) => ({
          path: i.inline!.path,
          line: i.inline!.line,
          ...(i.inline!.startLine ? { startLine: i.inline!.startLine } : {}),
          body: i.body,
        }));
        const { data } = await createPullRequestReview(access.token, access.owner, access.repo, request.prNumber, {
          commitId: prepared.headSha,
          event: GITHUB_EVENT[request.verdict],
          body,
          comments,
        });
        reviewUrl = data.url;
        appendPostLog(repo.id, targetKey, {
          findings: [
            ...inline.map((i, n) => record(i, data.commentUrls[n] ?? data.url, true)),
            ...notInline.map((i) => record(i, data.url, false)),
          ],
        });
      } else {
        const { data: diffRefs } = await getMergeRequestDiffRefs(access.token, access.project, request.prNumber);
        for (const i of inline) {
          const { data } = await createMergeRequestDiscussion(access.token, access.project, request.prNumber, i.body, {
            diffRefs,
            oldPath: i.inline!.path,
            newPath: i.inline!.path,
            newLine: i.inline!.line,
            ...(i.oldLine ? { oldLine: i.oldLine } : {}),
          });
          // Recorded one by one: a failure midway keeps what already landed.
          appendPostLog(repo.id, targetKey, { findings: [record(i, data.url, true)] });
        }
        const { data: note } = await createMergeRequestNote(access.token, access.project, request.prNumber, body, diffRefs.webUrl);
        reviewUrl = note.url || diffRefs.webUrl;
        appendPostLog(repo.id, targetKey, { findings: notInline.map((i) => record(i, reviewUrl, false)) });
        if (request.verdict === "approve") await approveMergeRequest(access.token, access.project, request.prNumber);
        if (request.verdict === "request_changes") await unapproveMergeRequest(access.token, access.project, request.prNumber);
      }
    } catch (err) {
      throw describeHostError(err, access.host);
    }

    appendPostLog(repo.id, targetKey, {
      review: {
        postedAt: now(),
        url: reviewUrl,
        host: access.host,
        verdict: request.verdict,
        ...(prepared.headSha ? { headSha: prepared.headSha } : {}),
        findings: items.length,
      },
    });
    return { url: reviewUrl, inline: inline.length, inSummary: notInline.length, verdict: request.verdict };
  } finally {
    inFlight.delete(lockKey);
  }
}
