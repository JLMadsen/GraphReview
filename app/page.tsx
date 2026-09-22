import Link from "next/link";
import {
  ChevronRight,
  Clock3,
  Github,
  HardDrive,
  Plug,
  Waypoints,
} from "lucide-react";
import { listRepoDtos, type RepoDto } from "@/lib/jobs";
import { AddRepoDialog } from "./add-repo-dialog";
import { ProviderBadge, RepoStatusBadge } from "./repo-status-badge";
import { RepoRetryButton } from "./repo-retry-button";

/**
 * Repo list (landing page) — DESIGN.md §4.
 *
 * Every added repo, with name, source (local | github) and the §10 status
 * indicator. Rendering this list is itself a "view" for §10's purposes:
 * `listRepoDtos` runs the cheap staleness check per repo and schedules a
 * background refresh for anything whose HEAD has moved, which is what makes
 * "stale, refreshing…" accurate without a manual refresh button.
 */

// Repo status is live queue/git state — never prerender this at build time.
export const dynamic = "force-dynamic";

function formatTimestamp(iso?: string): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  // Compact and scannable ("17 Sep 2026, 21:13 UTC") rather than a full
  // RFC-1123 string, which dominated the row it sat in. Pinned to UTC so
  // the server-rendered value can't disagree with a client locale.
  return `${date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })}, ${date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

function RepoRow({ repo }: { repo: RepoDto }) {
  const source = repo.provider === "github" ? repo.url : repo.localPath;
  const analyzedAt = formatTimestamp(repo.lastAnalyzedAt);
  const SourceIcon = repo.provider === "github" ? Github : HardDrive;
  const isError = repo.status === "error";

  return (
    <div className="group/repo relative rounded-xl bg-card ring-1 ring-border transition-colors hover:ring-brand/35">
      {/* Stretched link: the whole card navigates to the Graph tab. It sits
          behind the visible content (z-10 below) so the Retry button, which
          is a sibling rendered on top, stays independently clickable — a
          <button> can't nest inside this <Link> (invalid HTML, and its
          click would just navigate). */}
      <Link
        href={`/repo/${repo.id}/graph`}
        className="absolute inset-0 z-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        aria-label={`Open ${repo.name} graph`}
      />

      {/* pointer-events-none so clicks pass through to the stretched Link
          above; the Retry button below opts back in with pointer-events-auto
          so it stays individually clickable. */}
      <div className="relative z-10 flex items-start justify-between gap-4 p-4 pointer-events-none">
        <div className="min-w-0">
          <h2 className="text-[15px] leading-tight font-semibold tracking-[-0.01em] transition-colors group-hover/repo:text-brand">
            {repo.name}
          </h2>
          <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <SourceIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
            <span className="truncate font-mono">{source ?? "—"}</span>
          </p>
          {analyzedAt ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/70">
              <Clock3 className="size-3.5 shrink-0" aria-hidden />
              Last analyzed {analyzedAt}
            </p>
          ) : null}
          {isError && repo.lastError ? (
            <pre className="mt-2.5 max-h-24 max-w-full overflow-auto rounded-lg bg-background/80 px-2.5 py-2 text-left font-mono text-[11px] leading-relaxed text-muted-foreground ring-1 ring-border">
              {repo.lastError}
            </pre>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ProviderBadge provider={repo.provider} />
          <RepoStatusBadge
            status={repo.status}
            lastAnalyzedSha={repo.lastAnalyzedSha}
          />
        </div>
      </div>

      {isError ? (
        <div className="relative z-10 flex items-center justify-end gap-1 border-t border-border/70 px-4 py-2 pointer-events-none">
          <div className="pointer-events-auto">
            <RepoRetryButton repoId={repo.id} />
          </div>
        </div>
      ) : (
        <div className="pointer-events-none relative z-10 flex items-center gap-1 border-t border-border/70 px-2 py-1.5">
          <ChevronRight
            className="ml-auto mr-2 size-4 shrink-0 text-muted-foreground/30 transition-all group-hover/repo:translate-x-0.5 group-hover/repo:text-muted-foreground/70"
            aria-hidden
          />
        </div>
      )}
    </div>
  );
}

/** Icon-led placeholder shared by the empty and can't-load states. */
function EmptyState({
  icon: Icon,
  tone = "muted",
  title,
  children,
  detail,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone?: "muted" | "destructive";
  title: string;
  children: React.ReactNode;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-card/40 px-6 py-14 text-center">
      <span
        className={
          tone === "destructive"
            ? "flex size-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive ring-1 ring-destructive/20"
            : "flex size-11 items-center justify-center rounded-xl bg-brand-muted text-brand ring-1 ring-brand/20"
        }
      >
        <Icon className="size-5" />
      </span>
      <h2 className="mt-4 text-sm font-semibold tracking-tight">{title}</h2>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{children}</p>
      {detail ? (
        <pre className="mt-4 max-w-full overflow-x-auto rounded-lg bg-background/80 px-3 py-2 text-left font-mono text-[11px] text-muted-foreground ring-1 ring-border">
          {detail}
        </pre>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export default async function RepoListPage() {
  // Neo4j/Redis may not be up yet (first run, or mid-development). Degrade to
  // an explanatory empty state instead of crashing the landing page.
  let repos: RepoDto[] = [];
  let loadError: string | null = null;
  try {
    repos = await listRepoDtos({ autoEnqueue: true });
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-[-0.02em]">
              Repositories
            </h1>
            {repos.length > 0 ? (
              <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs text-muted-foreground">
                {repos.length}
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Add a local or GitHub repo to build its component graph.
          </p>
        </div>
        <AddRepoDialog />
      </div>

      {loadError ? (
        <EmptyState
          icon={Plug}
          tone="destructive"
          title="Can't load repositories"
          detail={loadError}
        >
          The graph database or job queue isn&apos;t reachable. Check that the{" "}
          <span className="font-mono text-foreground/80">neo4j</span> and{" "}
          <span className="font-mono text-foreground/80">redis</span> services
          are running.
        </EmptyState>
      ) : repos.length === 0 ? (
        <EmptyState icon={Waypoints} title="No repos yet" action={<AddRepoDialog />}>
          Add a repo to analyze it into a component graph. Analysis starts
          automatically and its status shows up here.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {repos.map((repo) => (
            <RepoRow key={repo.id} repo={repo} />
          ))}
        </div>
      )}
    </div>
  );
}
