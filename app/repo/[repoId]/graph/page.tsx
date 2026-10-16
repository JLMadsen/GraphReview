import { GraphHost } from "./graph-host";

/**
 * Graph tab.
 *
 * The main visualization. Opened directly with no filter, or pre-filtered
 * by a link to a PR (`?pr=<number>`) or a comparison
 * (`?base=<ref>&head=<ref>`). The
 * diff-selection control (pick a PR, or two refs) lives as a panel inside
 * this tab (`DiffPanel`, rendered by `GraphView`), not a separate screen.
 *
 * All data fetching (repo context, graph, diff-impact) happens client-side
 * in `GraphView` — see that file's comment for why. `GraphHost` lets the
 * command palette switch the target without a navigation (DESIGN.md §6.18).
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

  // Keyed on the params: a navigation to another target starts over on it.
  return (
    <GraphHost
      key={`${initialPrNumber ?? ""}|${initialBaseRef ?? ""}|${initialHeadRef ?? ""}`}
      repoId={repoId}
      initialPrNumber={initialPrNumber}
      initialBaseRef={initialPrNumber ? undefined : initialBaseRef}
      initialHeadRef={initialPrNumber ? undefined : initialHeadRef}
    />
  );
}
