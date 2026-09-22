"use client";

// Thin client-only wrapper so `repo-status-badge.tsx` can stay server-safe
// (see that file's header for why) while still offering the "hover the
// Analyzing/Refreshing badge to see the job's log" affordance.

import { JobLogHover } from "@/components/graph/JobLogHover";

export function StatusLogHover({
  repoId,
  label,
  children,
}: {
  repoId: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <JobLogHover logsUrl={`/api/repos/${encodeURIComponent(repoId)}?logs=1`} label={label}>
      {children}
    </JobLogHover>
  );
}
