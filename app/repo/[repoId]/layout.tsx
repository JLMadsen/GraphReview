import { notFound } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { loadRepo } from "./load-repo";

/**
 * Repo detail shell.
 *
 * The repo's name, source and status live in the app's top bar (the `@nav`
 * slot, app/@nav/repo/[repoId]/repo-nav.tsx), so this shell is only
 * the content width — and the 404 for an unknown repo. Both read the repo
 * through `loadRepo`, which also enqueues a background re-analysis when the
 * stored graph is behind.
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

  // `notFound()` signals by throwing, so it is called outside any try block.
  const { missing, loadError } = await loadRepo(repoId);
  if (missing) notFound();

  return (
    // Width is capped at `max-w-6xl` for the reading-oriented tabs
    // (Branches, Pull Requests), but the Graph tab is an analysis surface
    // that wants every pixel: the canvas is the content, and a 100+ node
    // component graph squeezed into 72rem is the "this is an analysis tool"
    // complaint. Rather than hoisting the container into each of the three
    // pages, the cap lifts when the rendered tab marks itself wide with
    // `data-wide-shell` — `:has()` lets this shared shell respond to which
    // child route is inside it (the top bar does the same in app/layout.tsx).
    // See `components/graph/GraphView.tsx` for the only element that sets it.
    // The Graph tab also drops the shell's padding: its columns run edge to
    // edge, and each column pads itself.
    <div className="group/shell mx-auto w-full max-w-6xl px-6 py-4 has-[[data-wide-shell]]:max-w-none has-[[data-wide-shell]]:p-0">
      {loadError ? (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-destructive group-has-[[data-wide-shell]]/shell:px-4 group-has-[[data-wide-shell]]/shell:pt-2">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          Could not load repo details: {loadError}
        </p>
      ) : null}

      {children}
    </div>
  );
}
