import Link from "next/link";
import { notFound } from "next/navigation";
import { GitBranch, GitCompare, Shield, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { getRepoBranches } from "@/lib/jobs";
import { getRepoById } from "@/lib/neo4j";
import {
  DatabaseErrorNotice,
  GitHubErrorNotice,
  GitHubNotice,
  NoticeCard,
} from "../github-notice";

/**
 * Branches tab — DESIGN.md §4.
 *
 * Branch list fetched through lib/github with the stored PAT (§8, §11). The
 * ad-hoc "compare two refs" tool itself lives in the Graph tab's diff panel
 * (§4), so each row links across to it rather than duplicating the control
 * here.
 */

export const dynamic = "force-dynamic";

export default async function BranchesPage({
  params,
}: {
  params: Promise<{ repoId: string }>;
}) {
  const { repoId } = await params;

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

  const result = repo ? await getRepoBranches(repo) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <GitBranch className="size-4 text-muted-foreground" aria-hidden />
          Branches
          {result?.linked && !result.error ? (
            <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[11px] font-normal text-muted-foreground">
              {result.branches.length}
            </span>
          ) : null}
        </h2>
      </div>

      {!result || !repo ? (
        <DatabaseErrorNotice message={dbError ?? "Repo unavailable."} />
      ) : !result.linked ? (
        <GitHubNotice
          reason={result.reason ?? "not_linked"}
          subject="branches"
          provider={repo.provider === "gitlab" ? "gitlab" : "github"}
        />
      ) : result.error ? (
        <GitHubErrorNotice
          message={result.error}
          provider={repo.provider === "gitlab" ? "gitlab" : "github"}
        />
      ) : result.branches.length === 0 ? (
        <NoticeCard icon={GitBranch} title="No branches">
          The host returned no branches for this repository.
        </NoticeCard>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-border">
          {result.branches.map((branch) => (
            <li
              key={branch.name}
              className="group/branch flex items-center justify-between gap-4 px-4 py-2.5 transition-colors hover:bg-secondary/40"
            >
              <div className="flex min-w-0 items-center gap-2">
                <GitBranch
                  className="size-4 shrink-0 text-muted-foreground/60"
                  aria-hidden
                />
                <span className="truncate font-mono text-[13px]">
                  {branch.name}
                </span>
                {branch.name === repo.defaultBranch ? (
                  <Badge
                    variant="outline"
                    className="gap-1 border-brand/30 bg-brand-muted text-brand"
                  >
                    <Star aria-hidden />
                    default
                  </Badge>
                ) : null}
                {branch.protected ? (
                  <Badge
                    variant="outline"
                    className="gap-1 border-border text-muted-foreground"
                  >
                    <Shield aria-hidden />
                    protected
                  </Badge>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="rounded-md bg-secondary/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {branch.commitSha.slice(0, 7)}
                </span>
                <Link
                  // Ref-comparison convention for the Graph tab's diff panel.
                  href={`/repo/${repoId}/graph?base=${encodeURIComponent(
                    repo.defaultBranch
                  )}&head=${encodeURIComponent(branch.name)}`}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground group-hover/branch:text-muted-foreground"
                >
                  <GitCompare className="size-3.5" aria-hidden />
                  Compare in graph
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
