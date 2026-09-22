import { notFound } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { getRepoDto } from "@/lib/jobs";
import type { RepoDto } from "@/lib/jobs";
import { getRepoById } from "@/lib/neo4j";
import { ProviderBadge, RepoStatusBadge, providerIcon } from "@/app/repo-status-badge";

/**
 * Repo detail shell — DESIGN.md §4.
 *
 * Shows the real repo name, source and §10 status, then hosts the Graph
 * tab. Computing the status here is also what implements "opening a repo's
 * Graph tab … enqueues a background re-analysis when the stored graph is
 * behind" (§10): the check is one cheap HEAD probe and it never blocks the
 * render on the analysis itself.
 */

// Status reflects live queue/git state, so this layout can't be prerendered.
export const dynamic = "force-dynamic";

export default async function RepoDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ repoId: string }>;
}) {
  const { repoId } = await params;
  if (!repoId) notFound();

  // Neo4j being unreachable is a different failure from "this repo doesn't
  // exist": only the latter is a 404. The former degrades to a bare header so
  // the tabs still work once the database comes back.
  //
  // `notFound()` signals by throwing, so it is called outside the try block
  // rather than being caught as a load failure.
  let record: Awaited<ReturnType<typeof getRepoById>> = null;
  let loadError: string | null = null;
  try {
    record = await getRepoById(repoId);
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }
  if (!loadError && !record) notFound();

  let repo: RepoDto | null = null;
  if (record) {
    try {
      repo = await getRepoDto(record, { autoEnqueue: true });
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  }

  const source = repo?.provider === "local" ? repo.localPath : repo?.url;
  const SourceIcon = providerIcon(repo?.provider ?? "local");

  return (
    // Width is capped at `max-w-6xl` for the reading-oriented tabs
    // (Branches, Pull Requests), but the Graph tab is an analysis surface
    // that wants every pixel: the canvas is the content, and a 100+ node
    // component graph squeezed into 72rem is the "this is an analysis tool"
    // complaint. Rather than hoisting the container into each of the three
    // pages (duplicating the header/tabs shell), the cap lifts when the
    // rendered tab marks itself wide with `data-wide-shell` — `:has()` lets
    // this shared shell respond to which child route is inside it. See
    // `components/graph/GraphView.tsx` for the only element that sets it.
    <div className="mx-auto w-full max-w-6xl px-6 py-4 has-[[data-wide-shell]]:max-w-[2000px]">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl leading-tight font-semibold tracking-[-0.02em]">
            {repo?.name ?? repoId}
          </h1>
          {source ? (
            <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <SourceIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
              <span className="truncate font-mono">{source}</span>
            </p>
          ) : null}
          {loadError ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-destructive">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              Could not load repo details: {loadError}
            </p>
          ) : null}
        </div>
        {repo ? (
          <div className="flex shrink-0 items-center gap-2">
            <ProviderBadge provider={repo.provider} />
            <RepoStatusBadge
              status={repo.status}
              lastAnalyzedSha={repo.lastAnalyzedSha}
              repoId={repo.id}
            />
          </div>
        ) : null}
      </div>

      {children}
    </div>
  );
}
