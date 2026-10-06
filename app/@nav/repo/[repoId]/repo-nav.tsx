import { PROVIDER_NAMES, RepoStatusText, providerIcon } from "@/app/repo-status-badge";
import { RepoDeleteButton } from "@/app/repo-delete-button";
import { RepoSwitcher } from "@/app/repo-switcher";
import { ReanalyzeButton } from "@/app/repo/[repoId]/reanalyze-button";
import { loadRepo } from "@/app/repo/[repoId]/load-repo";

/**
 * The repo's identity in the app's top bar, on every /repo/[repoId] page:
 * its name (a switcher to the other repos), where it comes from (a link to
 * the hosted repo, in a new tab), its
 * analysis status as a dot and a word, and the two repo actions as quiet
 * icon buttons. It used to be a header row above every repo tab; in the top
 * bar it costs the Graph tab no height.
 *
 * Shares one request-cached lookup with the repo layout (`loadRepo`), which
 * renders the 404 and any load error — this renders nothing in those cases.
 */

/** A hosted repo's URL opens in a new tab; a local repo's folder path can't be linked from a web page. */
function isWebUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

export async function RepoNav({ params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const { repo } = await loadRepo(repoId);
  if (!repo) return null;

  const source = repo.provider === "local" ? repo.localPath : repo.url;
  const SourceIcon = providerIcon(repo.provider);

  return (
    <div className="flex min-w-0 items-center gap-3">
      <RepoSwitcher repoId={repo.id} repoName={repo.name} className="text-[13px] font-semibold text-foreground" />
      {source && isWebUrl(source) ? (
        <a
          href={source}
          target="_blank"
          rel="noreferrer"
          className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground md:flex"
          title={`Open on ${PROVIDER_NAMES[repo.provider]} · ${source}`}
        >
          <SourceIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
          <span className="max-w-[28rem] truncate font-mono text-[11px]">{source}</span>
        </a>
      ) : source ? (
        <span
          className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground md:flex"
          title={`${PROVIDER_NAMES[repo.provider]} · ${source}`}
        >
          <SourceIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
          <span className="max-w-[28rem] truncate font-mono text-[11px]">{source}</span>
        </span>
      ) : null}
      <span className="shrink-0">
        <RepoStatusText status={repo.status} lastAnalyzedSha={repo.lastAnalyzedSha} repoId={repo.id} />
      </span>
      <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
      <span className="flex shrink-0 items-center gap-0.5">
        {repo.status !== "analyzing" ? <ReanalyzeButton repoId={repo.id} compact /> : null}
        <RepoDeleteButton repoId={repo.id} repoName={repo.name} local={repo.provider === "local"} redirectTo="/" compact />
      </span>
    </div>
  );
}
