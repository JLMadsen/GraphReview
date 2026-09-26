// The status indicator ("analyzing… / up to date as of <sha> / stale,
// refreshing…"), shared by the repo list and the repo detail header.
//
// A plain server-renderable component — no client state of its own, it just
// maps the `status` field of the repo API's response onto a Badge variant.
// The two in-progress states delegate their hover-to-see-progress affordance
// to `StatusLogHover` (a separate `"use client"` file): this file must stay
// server-safe because `providerIcon` below is called as a plain function
// from the server layout, and a file's exports all become client-only
// references the moment it carries a top-level `"use client"`.
//
// Each state carries its own icon and hue so the four statuses are
// distinguishable at a glance in a list, instead of four identically-grey
// pills you have to read word by word: amber pulse = working, green = done,
// red = failed.

import {
  CircleCheck,
  Github,
  Gitlab,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { RepoStatus } from "@/lib/jobs";
import type { RepoProvider } from "@/lib/neo4j";
import { StatusLogHover } from "./status-log-hover";

function shortSha(sha?: string): string | undefined {
  return sha ? sha.slice(0, 7) : undefined;
}

export function RepoStatusBadge({
  status,
  lastAnalyzedSha,
  /** Enables the hover-to-see-progress affordance on the two in-progress states. Omitted where no repo id is at hand — the badge still renders, just without the hover. */
  repoId,
}: {
  status: RepoStatus;
  lastAnalyzedSha?: string;
  repoId?: string;
}) {
  switch (status) {
    case "analyzing": {
      const badge = (
        <Badge
          variant="outline"
          className="cursor-default gap-1.5 border-warning/30 bg-warning/10 text-warning"
        >
          <LoaderCircle className="animate-spin" aria-hidden />
          Analyzing
        </Badge>
      );
      if (!repoId) return badge;
      return (
        <StatusLogHover repoId={repoId} label="Analysis job log">
          {badge}
        </StatusLogHover>
      );
    }
    case "stale": {
      const badge = (
        <Badge
          variant="outline"
          className="cursor-default gap-1.5 border-warning/30 bg-warning/10 text-warning"
        >
          <RefreshCw className="animate-spin [animation-duration:2.5s]" aria-hidden />
          Refreshing
        </Badge>
      );
      if (!repoId) return badge;
      return (
        <StatusLogHover repoId={repoId} label="Analysis job log">
          {badge}
        </StatusLogHover>
      );
    }
    case "error":
      return (
        <Badge
          variant="outline"
          className="gap-1.5 border-destructive/30 bg-destructive/10 text-destructive"
        >
          <TriangleAlert aria-hidden />
          Analysis failed
        </Badge>
      );
    case "up_to_date":
    default: {
      const sha = shortSha(lastAnalyzedSha);
      return (
        <Badge
          variant="outline"
          className="gap-1.5 border-success/25 bg-success/10 text-success"
        >
          <CircleCheck aria-hidden />
          <span>Up to date</span>
          {sha ? (
            <span className="font-mono text-[10px] text-success/70">{sha}</span>
          ) : null}
        </Badge>
      );
    }
  }
}

/**
 * The same status as plain text with a status dot — the repo detail header's
 * quieter form of `RepoStatusBadge` (the repo list keeps the badge).
 */
export function RepoStatusText({
  status,
  lastAnalyzedSha,
  repoId,
}: {
  status: RepoStatus;
  lastAnalyzedSha?: string;
  repoId?: string;
}) {
  const working = status === "analyzing" || status === "stale";
  const [dot, text, label] =
    status === "analyzing"
      ? ["bg-warning animate-pulse", "text-warning", "Analyzing"]
      : status === "stale"
        ? ["bg-warning animate-pulse", "text-warning", "Refreshing"]
        : status === "error"
          ? ["bg-destructive", "text-destructive", "Analysis failed"]
          : ["bg-success", "text-muted-foreground", "Up to date"];
  const sha = shortSha(lastAnalyzedSha);
  const content = (
    <span className={`flex cursor-default items-center gap-1.5 text-xs ${text}`}>
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
      {label}
      {status === "up_to_date" && sha ? <span className="font-mono text-[11px]">{sha}</span> : null}
    </span>
  );
  if (working && repoId) {
    return (
      <StatusLogHover repoId={repoId} label="Analysis job log">
        {content}
      </StatusLogHover>
    );
  }
  return content;
}

const PROVIDER_ICONS: Record<RepoProvider, LucideIcon> = {
  local: HardDrive,
  github: Github,
  gitlab: Gitlab,
};

export const PROVIDER_NAMES: Record<RepoProvider, string> = {
  local: "Local",
  github: "GitHub",
  gitlab: "GitLab",
};

/** The icon for a repo's source — shared by the repo list, the repo detail header, and the repo switcher, so the three don't each hand-roll the same lookup. */
export function providerIcon(provider: RepoProvider): LucideIcon {
  return PROVIDER_ICONS[provider];
}

export function ProviderBadge({ provider }: { provider: RepoProvider }) {
  const Icon = providerIcon(provider);
  return (
    <Badge
      variant="outline"
      className="gap-1.5 border-border bg-secondary/60 font-medium text-muted-foreground"
    >
      <Icon aria-hidden />
      {PROVIDER_NAMES[provider]}
    </Badge>
  );
}
