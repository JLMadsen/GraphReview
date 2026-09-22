// The §4 status indicator ("analyzing… / up to date as of <sha> / stale,
// refreshing…"), shared by the repo list and the repo detail header.
//
// A plain server-renderable component — no client state, it just maps the
// `status` field of the repo API's response onto a Badge variant.
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

function shortSha(sha?: string): string | undefined {
  return sha ? sha.slice(0, 7) : undefined;
}

export function RepoStatusBadge({
  status,
  lastAnalyzedSha,
}: {
  status: RepoStatus;
  lastAnalyzedSha?: string;
}) {
  switch (status) {
    case "analyzing":
      return (
        <Badge
          variant="outline"
          className="gap-1.5 border-warning/30 bg-warning/10 text-warning"
        >
          <LoaderCircle className="animate-spin" aria-hidden />
          Analyzing
        </Badge>
      );
    case "stale":
      return (
        <Badge
          variant="outline"
          className="gap-1.5 border-warning/30 bg-warning/10 text-warning"
        >
          <RefreshCw className="animate-spin [animation-duration:2.5s]" aria-hidden />
          Refreshing
        </Badge>
      );
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

const PROVIDER_ICONS: Record<RepoProvider, LucideIcon> = {
  local: HardDrive,
  github: Github,
  gitlab: Gitlab,
};

const PROVIDER_LABELS: Record<RepoProvider, string> = {
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
      {PROVIDER_LABELS[provider]}
    </Badge>
  );
}
