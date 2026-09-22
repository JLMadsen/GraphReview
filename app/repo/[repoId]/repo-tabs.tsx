"use client";

// Tab bar for the repo detail shell (§4). The active tab comes from the URL
// segment rather than component state, so a deep link or a full reload lands
// on the right tab — `useSelectedLayoutSegment` is the App Router's way to
// read that from inside a layout.

import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { GitBranch, GitPullRequest, Network } from "lucide-react";
import { cn } from "cn";

const TABS = [
  { segment: "branches", label: "Branches", icon: GitBranch },
  { segment: "pull-requests", label: "Pull Requests", icon: GitPullRequest },
  { segment: "graph", label: "Graph", icon: Network },
] as const;

export function RepoTabs({ repoId }: { repoId: string }) {
  const active = useSelectedLayoutSegment();

  return (
    <nav className="mb-6 flex gap-1 border-b border-border">
      {TABS.map((tab) => {
        const isActive = active === tab.segment;
        const Icon = tab.icon;
        return (
          <Link
            key={tab.segment}
            href={`/repo/${repoId}/${tab.segment}`}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              // -1px pulls the active rule onto the container's own border
              // so the two read as one line rather than a double stroke.
              "-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
              isActive
                ? "border-brand text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
            )}
          >
            <Icon
              className={cn("size-4", isActive ? "text-brand" : "opacity-70")}
              aria-hidden
            />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
