"use client";

// "Re-analyze" button in the repo header.
//
// Re-analysis normally only happens when HEAD moves past `lastAnalyzedSha`
// (see lib/jobs/staleness.ts), so an unchanged repo keeps a graph built by
// whatever analyzer version last ran. This forces a fresh run via
// `POST /api/repos/[repoId]/refresh` — e.g. after an analyzer upgrade. The
// layout hides it while an analysis is already running.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ReanalyzeButton({ repoId }: { repoId: string }) {
  const router = useRouter();
  const [queueing, setQueueing] = useState(false);

  async function reanalyze() {
    if (queueing) return;
    setQueueing(true);
    try {
      const response = await fetch(`/api/repos/${repoId}/refresh`, { method: "POST" });
      if (!response.ok) {
        // Best-effort — the status text still reflects reality after the refresh.
        console.error(`Re-analyze failed with status ${response.status}`);
      }
      router.refresh();
    } catch (err) {
      console.error("Re-analyze failed:", err);
    } finally {
      setQueueing(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={reanalyze}
      disabled={queueing}
      title="Run the analysis again on the current commit"
    >
      {queueing ? <LoaderCircle className="animate-spin" aria-hidden /> : <RotateCw aria-hidden />}
      Re-analyze
    </Button>
  );
}
