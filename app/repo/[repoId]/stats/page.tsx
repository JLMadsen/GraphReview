import { redirect } from "next/navigation";

/**
 * The old Stats page's URL (DESIGN.md §6.19). Stats is a view in the Graph
 * tab now (§6.25); this keeps old links and bookmarks working.
 */
export default async function StatsPage({ params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  redirect(`/repo/${encodeURIComponent(repoId)}/graph?view=stats`);
}
