"use client";

// The repo's analysis job, inline where its status shows (DESIGN.md §6.20
// §4): "queued, 2nd" beside the Analyzing/Refreshing badge while it waits,
// and a failed run's reason, logs and Run again on the repo card. Both read
// the shared jobs poll (components/jobs/store.ts).

import { useRouter } from "next/navigation";
import { JobFailureInline } from "@/components/jobs/JobParts";
import { useJob } from "@/components/jobs/store";

export function AnalysisQueuedNote({ repoId }: { repoId: string }) {
  const job = useJob("analysis", (j) => j.repoId === repoId);
  if (job?.state !== "queued" || !job.position) return null;
  return <span className="font-normal opacity-80">· queued, {job.positionText?.split(" ")[0]}</span>;
}

/** A failed analysis with its logs and Run again; `fallback` once the job row has aged out. */
export function AnalysisFailureInline({ repoId, fallback }: { repoId: string; fallback: React.ReactNode }) {
  const router = useRouter();
  const job = useJob("analysis", (j) => j.repoId === repoId);
  if (job?.state !== "failed") return <>{fallback}</>;
  return <JobFailureInline job={job} className="pointer-events-auto mt-2" onRetry={() => router.refresh()} />;
}
