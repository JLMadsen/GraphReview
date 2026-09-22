import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowUpRight,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "cn";
import type { PullRequestListState, PullRequestSummary } from "@/lib/github";
import { getRepoPullRequests } from "@/lib/jobs";
import { getRepoById } from "@/lib/neo4j";
import {
  DatabaseErrorNotice,
  GitHubErrorNotice,
  GitHubNotice,
  NoticeCard,
} from "../github-notice";

/**
 * Pull Requests tab — DESIGN.md §4.
 *
 * "PR list fetched from GitHub (state filter: open/closed/merged), so a
 * reviewer can browse without loading the graph first." Now also GitLab
 * (its merge requests are fetched and mapped onto the same shape).
 *
 * The filter is `?state=open|closed|all`, matching GitHub's own filter
 * (lib/github's `PullRequestListState`, reused by lib/gitlab). Merged PRs
 * are not a separate GitHub-side filter — they come back under
 * `closed`/`all` and lib/github derives the three-value
 * `open | closed | merged` state per item (§7, §8), which is what the
 * per-row badge shows.
 *
 * Each row links to the Graph tab as `/repo/[repoId]/graph?pr=<number>` —
 * the convention that tab reads to pre-filter itself to a PR (§4, §10).
 */

export const dynamic = "force-dynamic";

const STATE_FILTERS: ReadonlyArray<{ value: PullRequestListState; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

function parseState(value: string | undefined): PullRequestListState {
  const match = STATE_FILTERS.find((filter) => filter.value === value);
  return match?.value ?? "open";
}

/**
 * Per-state colour + icon, following GitHub's own convention so the states
 * are recognizable without reading the label: green open, purple merged,
 * red closed.
 */
const STATE_STYLES: Record<
  PullRequestSummary["state"],
  { className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  open: {
    className: "border-success/30 bg-success/10 text-success",
    icon: GitPullRequest,
  },
  merged: {
    className: "border-chart-4/30 bg-chart-4/10 text-chart-4",
    icon: GitMerge,
  },
  closed: {
    className: "border-destructive/30 bg-destructive/10 text-destructive",
    icon: GitPullRequestClosed,
  },
};

function formatUpdated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  // Compact, UTC-pinned (see the same helper on the repo list for why).
  return `${date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })}`;
}

export default async function PullRequestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ repoId: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const [{ repoId }, { state: rawState }] = await Promise.all([
    params,
    searchParams,
  ]);
  const state = parseState(rawState);

  // Neo4j down is a degraded state, not a 404 — see the same handling in the
  // repo layout.
  let repo: Awaited<ReturnType<typeof getRepoById>> = null;
  let dbError: string | null = null;
  try {
    repo = await getRepoById(repoId);
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
  }
  if (!dbError && !repo) notFound();

  const result = repo ? await getRepoPullRequests(repo, state) : null;
  const provider = repo?.provider === "gitlab" ? "gitlab" : "github";
  const hostLabel = provider === "gitlab" ? "GitLab" : "GitHub";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <GitPullRequest className="size-4 text-muted-foreground" aria-hidden />
          Pull Requests
          {result?.linked && !result.error ? (
            <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[11px] font-normal text-muted-foreground">
              {result.pullRequests.length}
            </span>
          ) : null}
        </h2>
        <div className="flex items-center gap-1 rounded-lg bg-muted p-[3px] ring-1 ring-border/60">
          {STATE_FILTERS.map((filter) => (
            <Link
              key={filter.value}
              href={`/repo/${repoId}/pull-requests?state=${filter.value}`}
              aria-current={filter.value === state ? "page" : undefined}
              className={cn(
                "rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
                filter.value === state
                  ? "bg-elevated text-foreground shadow-sm ring-1 ring-border/60"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {filter.label}
            </Link>
          ))}
        </div>
      </div>

      {!result ? (
        <DatabaseErrorNotice message={dbError ?? "Repo unavailable."} />
      ) : !result.linked ? (
        <GitHubNotice
          reason={result.reason ?? "not_linked"}
          subject="pull requests"
          provider={provider}
        />
      ) : result.error ? (
        <GitHubErrorNotice message={result.error} provider={provider} />
      ) : result.pullRequests.length === 0 ? (
        <NoticeCard
          icon={GitPullRequest}
          title={`No ${state === "all" ? "" : state} pull requests`.replace(
            /\s+/g,
            " "
          )}
        >
          Nothing matched this filter on {hostLabel}.
        </NoticeCard>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-border">
          {result.pullRequests.map((pr) => {
            const stateStyle = STATE_STYLES[pr.state];
            const StateIcon = stateStyle.icon;
            return (
              <li
                key={pr.number}
                className="group/pr flex items-start gap-3 px-4 py-3 transition-colors hover:bg-secondary/40"
              >
                <StateIcon
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    pr.state === "open" && "text-success",
                    pr.state === "merged" && "text-chart-4",
                    pr.state === "closed" && "text-destructive"
                  )}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      // Pre-filters the Graph tab to this PR (§4).
                      href={`/repo/${repoId}/graph?pr=${pr.number}`}
                      className="text-[13px] leading-snug font-medium transition-colors hover:text-brand"
                    >
                      {pr.title}
                    </Link>
                    {pr.draft ? (
                      <Badge
                        variant="outline"
                        className="gap-1 border-border text-muted-foreground"
                      >
                        <GitPullRequestDraft aria-hidden />
                        draft
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <span className="font-mono">#{pr.number}</span>
                    <span className="mx-1.5 opacity-40">·</span>
                    {pr.author ?? "unknown"}
                    <span className="mx-1.5 opacity-40">·</span>
                    updated {formatUpdated(pr.updatedAt)}
                  </p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                    <span className="rounded bg-secondary/70 px-1.5 py-0.5">
                      {pr.baseRef}
                    </span>
                    <span className="opacity-50">←</span>
                    <span className="rounded bg-secondary/70 px-1.5 py-0.5">
                      {pr.headRef}
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline" className={cn("gap-1", stateStyle.className)}>
                    {pr.state}
                  </Badge>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${provider === "gitlab" ? "merge request" : "pull request"} #${pr.number} on ${hostLabel}`}
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    {hostLabel}
                    <ArrowUpRight className="size-3.5" aria-hidden />
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
