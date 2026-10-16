import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { getRepoById } from "@/lib/db";
import { loadRepoStats } from "@/lib/jobs/repo-stats";
import { StatsView } from "@/components/stats/StatsView";
import { DatabaseErrorNotice, NoticeCard } from "../github-notice";

/**
 * Stats tab (DESIGN.md §6.19).
 *
 * Numbers about the repo itself, at its last analysed commit — no PR or
 * diff. The git-only part (languages, contributors, commits and lines per
 * day) is computed here on the server; the CI runs on the timeline are
 * fetched by the view, since they need the host.
 */

export const dynamic = "force-dynamic";

export default async function StatsPage({ params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;

  let repo: Awaited<ReturnType<typeof getRepoById>> = null;
  let error: string | null = null;
  try {
    repo = await getRepoById(repoId);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (!error && !repo) notFound();

  let stats: Awaited<ReturnType<typeof loadRepoStats>> = null;
  let gitError: string | null = null;
  if (repo) {
    try {
      stats = await loadRepoStats(repo);
    } catch (e) {
      gitError = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <BarChart3 className="size-4 text-muted-foreground" aria-hidden />
        Stats
        {stats ? (
          <span className="rounded-md bg-secondary/70 px-1.5 py-0.5 font-mono text-[11px] font-normal text-muted-foreground">
            {stats.sha.slice(0, 7)}
          </span>
        ) : null}
      </h2>
      <Link
        href={`/repo/${repoId}/graph`}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to the App map
      </Link>
      </div>
      {error || !repo ? (
        <DatabaseErrorNotice message={error ?? "Repo unavailable."} />
      ) : gitError ? (
        <NoticeCard icon={BarChart3} tone="destructive" title="Couldn't read the repo's history" detail={gitError}>
          The stats are read with git from the repo&apos;s checkout.
        </NoticeCard>
      ) : !stats ? (
        <NoticeCard icon={BarChart3} title="Not fetched yet">
          The stats appear once the first analysis has cloned the repo.
        </NoticeCard>
      ) : (
        <StatsView repoId={repo.id} stats={stats} ciHost={repo.provider === "local" ? null : repo.provider === "gitlab" ? "GitLab" : "GitHub"} />
      )}
    </div>
  );
}
