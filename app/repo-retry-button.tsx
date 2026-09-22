"use client";

// Retry button for a repo card in `status: "error"`.
//
// Force-re-enqueues analysis via `POST /api/repos/[repoId]/refresh` — the
// escape hatch documented in that route: a failed job is cleared and
// re-queued regardless of staleness. Lives inside the stretched-link repo
// card (see `RepoRow` in `app/page.tsx`), so its click handler stops
// propagation to avoid also triggering the card's navigation `<Link>`.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RepoRetryButton({ repoId }: { repoId: string }) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);

  async function retry(event: React.MouseEvent<HTMLButtonElement>) {
    // The card behind this button is a stretched-link nav target (RepoRow) —
    // keep this click local to the button instead of bubbling into it.
    event.preventDefault();
    event.stopPropagation();
    if (retrying) return;

    setRetrying(true);
    try {
      const response = await fetch(`/api/repos/${repoId}/refresh`, {
        method: "POST",
      });
      if (!response.ok) {
        // Best-effort — the status badge/error block will still reflect
        // reality on next render either way.
        console.error(`Retry failed with status ${response.status}`);
      }
      router.refresh();
    } catch (err) {
      console.error("Retry failed:", err);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
      onClick={retry}
      disabled={retrying}
    >
      {retrying ? (
        <LoaderCircle className="animate-spin" aria-hidden />
      ) : (
        <RotateCw aria-hidden />
      )}
      {retrying ? "Retrying…" : "Retry"}
    </Button>
  );
}
