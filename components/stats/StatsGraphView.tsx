"use client";

// The Graph tab's Stats view (DESIGN.md §6.19, §6.25): fetches the git-only
// stats and draws `StatsView` in the view frame, a list taking the whole
// column. Re-read whenever `refreshKey` changes (a finished analysis).

import { useEffect, useState } from "react";
import { BarChart3, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import type { RepoStats } from "@/lib/jobs/repo-stats";
import { VIEW_TOOLBAR } from "@/components/graph/view-chrome";
import { StatsView } from "./StatsView";

interface StatsResponse {
  stats: RepoStats | null;
  ciHost: "GitHub" | "GitLab" | null;
}

export function StatsGraphView({ repoId, refreshKey, className }: { repoId: string; refreshKey: unknown; className?: string }) {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/repos/${encodeURIComponent(repoId)}/stats`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as StatsResponse | { error: string } | null;
        if (!res.ok || !json || "error" in json) throw new Error(json && "error" in json ? json.error : `Request failed (${res.status}).`);
        return json;
      })
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load the stats.");
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, refreshKey]);

  return (
    <div className={cn("min-h-0", className)}>
      <div className={VIEW_TOOLBAR}>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          Lines of code, contributors and a timeline of commits and CI
          {data?.stats ? (
            <span className="rounded-md bg-secondary/70 px-1.5 py-0.5 font-mono text-[11px]" title="The commit these stats are read at">
              {data.stats.sha.slice(0, 7)}
            </span>
          ) : null}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <Notice icon={TriangleAlert} title="Couldn't read the repo's history" detail={error}>
            The stats are read with git from the repo&apos;s checkout.
          </Notice>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Counting lines and commits…</p>
        ) : !data.stats ? (
          <Notice icon={BarChart3} title="Not fetched yet">
            The stats appear once the first analysis has cloned the repo.
          </Notice>
        ) : (
          <StatsView repoId={repoId} stats={data.stats} ciHost={data.ciHost} />
        )}
      </div>
    </div>
  );
}

function Notice({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center">
      <Icon className="size-5 text-muted-foreground" />
      <h3 className="mt-3 text-sm font-semibold tracking-tight">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{children}</p>
      {detail ? (
        <pre className="mt-4 max-w-full overflow-x-auto rounded-lg bg-background/80 px-3 py-2 text-left font-mono text-[11px] text-muted-foreground ring-1 ring-border">
          {detail}
        </pre>
      ) : null}
    </div>
  );
}
