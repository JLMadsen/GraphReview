// The "not linked to GitHub/GitLab" / "no PAT configured" empty states
// shared by the Branches and Pull Requests tabs (§4, decision #7).
//
// These are deliberately not errors: a `local` repo without a git-host URL
// is a perfectly valid, fully analyzable repo — it just has no branches or
// PRs to list from the API. The visual treatment says so: the informational
// states get a neutral/brand icon and the genuine failures get the
// destructive one, instead of every notice rendering as the same grey
// dashed box.

import Link from "next/link";
import {
  ArrowRight,
  Database,
  HardDrive,
  KeyRound,
  Link2Off,
  TriangleAlert,
} from "lucide-react";
import type { RepoAccessUnavailableReason } from "@/lib/jobs";

/** Which git host the notice is talking about — drives the copy and the Settings deep-link. */
export type NoticeProvider = "github" | "gitlab";

function hostLabel(provider: NoticeProvider): string {
  return provider === "gitlab" ? "GitLab" : "GitHub";
}

function NoticeCard({
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
  const destructive = tone === "destructive";
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center">
      <span
        className={
          destructive
            ? "flex size-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive ring-1 ring-destructive/20"
            : "flex size-11 items-center justify-center rounded-xl bg-secondary text-muted-foreground ring-1 ring-border"
        }
      >
        <Icon className="size-5" />
      </span>
      <h3 className="mt-4 text-sm font-semibold tracking-tight">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{children}</p>
      {detail ? (
        <pre className="mt-4 max-w-full overflow-x-auto rounded-lg bg-background/80 px-3 py-2 text-left font-mono text-[11px] text-muted-foreground ring-1 ring-border">
          {detail}
        </pre>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export { NoticeCard };

export function GitHubNotice({
  reason,
  subject,
  provider = "github",
}: {
  reason: RepoAccessUnavailableReason;
  /** What couldn't be listed, e.g. "branches" or "pull requests". */
  subject: string;
  /** Which host this repo is (or would be) linked to — defaults to "github" for existing callers. */
  provider?: NoticeProvider;
}) {
  const host = hostLabel(provider);

  if (reason === "no_token") {
    return (
      <NoticeCard
        icon={KeyRound}
        title={`No ${host} token configured`}
        action={
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/85"
          >
            Open settings
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        }
      >
        Add a Personal Access Token in Settings to list {subject} for this
        repo.
      </NoticeCard>
    );
  }

  if (reason === "invalid_url") {
    return (
      <NoticeCard icon={Link2Off} title={`Unrecognized ${host} URL`}>
        The URL stored for this repo isn&apos;t a{" "}
        <span className="font-mono text-foreground/80">
          {provider === "gitlab" ? "gitlab.com/group/project" : "github.com/owner/repo"}
        </span>{" "}
        address, so its {subject} can&apos;t be fetched.
      </NoticeCard>
    );
  }

  return (
    <NoticeCard icon={HardDrive} title={`Not linked to ${host}`}>
      This repo has no {host} URL on record, so there are no {subject} to
      list. Its component graph works exactly the same.
    </NoticeCard>
  );
}

/** Neo4j unreachable — the tab still renders, it just has nothing to show yet. */
export function DatabaseErrorNotice({ message }: { message: string }) {
  return (
    <NoticeCard
      icon={Database}
      tone="destructive"
      title="Can't reach the graph database"
      detail={message}
    >
      Check that the{" "}
      <span className="font-mono text-foreground/80">neo4j</span> service is
      running.
    </NoticeCard>
  );
}

export function GitHubErrorNotice({
  message,
  provider = "github",
}: {
  message: string;
  provider?: NoticeProvider;
}) {
  return (
    <NoticeCard
      icon={TriangleAlert}
      tone="destructive"
      title={`${hostLabel(provider)} request failed`}
      detail={message}
    >
      Check the token&apos;s scopes and that it still has access to this repo.
    </NoticeCard>
  );
}
