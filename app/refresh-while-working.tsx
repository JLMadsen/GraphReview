"use client";

// Re-renders the (server-rendered) page every few seconds while `active` —
// used by the repo list while any repo is analyzing, so its status badge
// flips to "Up to date" (or "Analysis failed") without a manual reload. Stops
// by itself: the refreshed page passes `active={false}` once nothing is
// running any more.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const REFRESH_MS = 4000;

export function RefreshWhileWorking({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    // An interval, not a one-shot timeout: a refresh that comes back still
    // "working" leaves `active` unchanged, so this effect wouldn't re-run.
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
