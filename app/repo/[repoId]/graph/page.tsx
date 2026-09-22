import { GraphView } from "@/components/graph";

/**
 * Graph tab.
 *
 * The main visualization. Opened directly with no filter, or pre-filtered
 * when arrived at from a PR row (`?pr=<number>`) or a branch's "Compare in
 * graph" link (`?base=<ref>&head=<ref>`, set by the Branches tab). The
 * diff-selection control (pick a PR, or two refs) lives as a panel inside
 * this tab (`DiffPanel`, rendered by `GraphView`), not a separate screen.
 *
 * All data fetching (repo context, graph, diff-impact) happens client-side
 * in `GraphView` — see that file's comment for why.
 */
export default async function GraphPage({
  params,
  searchParams,
}: {
  params: Promise<{ repoId: string }>;
  searchParams: Promise<{ pr?: string; base?: string; head?: string }>;
}) {
  const { repoId } = await params;
  const { pr, base, head } = await searchParams;

  const prNumber = pr ? Number(pr) : undefined;
  const initialPrNumber =
    prNumber && Number.isFinite(prNumber) && prNumber > 0 ? prNumber : undefined;

  const initialBaseRef = base?.trim() || undefined;
  const initialHeadRef = head?.trim() || undefined;

  return (
    <GraphView
      repoId={repoId}
      initialPrNumber={initialPrNumber}
      initialBaseRef={initialPrNumber ? undefined : initialBaseRef}
      initialHeadRef={initialPrNumber ? undefined : initialHeadRef}
    />
  );
}
