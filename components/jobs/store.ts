"use client";

// One poll of `GET /api/jobs` shared by the header indicator, the drawer and
// the inline job states (DESIGN.md §6.20 §5): every ~2 s while anything runs
// or waits (or the drawer is open), ~15 s when idle. Module state, so it
// survives client-side navigation and only one timer ever runs.

import { useEffect, useSyncExternalStore } from "react";
import type { JobDto, JobsResponse } from "./types";

const ACTIVE_MS = 2000;
const IDLE_MS = 15_000;

let snapshot: JobsResponse | null = null;
let drawerOpen = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
let subscribers = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function schedule() {
  if (timer) clearTimeout(timer);
  if (subscribers === 0) return;
  const busy = drawerOpen || Boolean(snapshot && (snapshot.running || snapshot.queued));
  timer = setTimeout(() => void refreshJobs(), busy ? ACTIVE_MS : IDLE_MS);
}

/** Polls now (after an action, or when something just started a job). */
export async function refreshJobs(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await fetch("/api/jobs", { cache: "no-store" });
    if (res.ok) {
      snapshot = (await res.json()) as JobsResponse;
      emit();
    }
  } catch {
    // Offline or restarting — keep the last snapshot.
  } finally {
    inFlight = false;
    schedule();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  subscribers++;
  if (subscribers === 1) void refreshJobs();
  return () => {
    listeners.delete(listener);
    subscribers--;
    if (subscribers === 0 && timer) clearTimeout(timer);
  };
}

export function useJobs(): JobsResponse | null {
  return useSyncExternalStore(subscribe, () => snapshot, () => null);
}

/** The job of `queue` matching `match`, from the shared poll. */
export function useJob(queue: string, match: (job: JobDto) => boolean, enabled = true): JobDto | undefined {
  const jobs = useJobs();
  if (!enabled) return undefined;
  return jobs?.jobs.find((job) => job.queue === queue && match(job));
}

// --- The drawer's open state (the indicator toggles it, the palette opens it) ---

const drawerListeners = new Set<() => void>();

export function setJobsDrawerOpen(open: boolean): void {
  drawerOpen = open;
  for (const l of drawerListeners) l();
  if (open) void refreshJobs();
}

export function toggleJobsDrawer(): void {
  setJobsDrawerOpen(!drawerOpen);
}

export function useJobsDrawerOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      drawerListeners.add(l);
      return () => drawerListeners.delete(l);
    },
    () => drawerOpen,
    () => false
  );
}

// --- Seen failures ---

const markedLocally = new Set<string>();

/** Marks failed jobs seen (server + this snapshot), once per job and finish time. */
export function markJobsSeen(jobs: JobDto[]): void {
  const fresh = jobs.filter((j) => j.state === "failed" && j.unseen && !markedLocally.has(`${j.queue}\0${j.id}\0${j.finishedAt}`));
  if (fresh.length === 0) return;
  for (const j of fresh) markedLocally.add(`${j.queue}\0${j.id}\0${j.finishedAt}`);
  if (snapshot) {
    const ids = new Set(fresh.map((j) => `${j.queue}\0${j.id}`));
    const next = snapshot.jobs.map((j) => (ids.has(`${j.queue}\0${j.id}`) ? { ...j, unseen: false } : j));
    snapshot = { ...snapshot, jobs: next, unseenFailed: next.filter((j) => j.unseen).length };
    emit();
  }
  void fetch("/api/jobs/seen", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobs: fresh.map(({ queue, id }) => ({ queue, id })) }),
  }).catch(() => undefined);
}

/** Marks `job` seen while it is shown (an inline failure, an expanded row). */
export function useMarkSeen(job: JobDto | undefined): void {
  const key = job?.state === "failed" && job.unseen ? `${job.queue}\0${job.id}\0${job.finishedAt}` : null;
  useEffect(() => {
    if (key && job) markJobsSeen([job]);
    // `key` captures what matters about `job`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** POSTs a job action; resolves to the server's error message, or null. */
export async function jobAction(job: Pick<JobDto, "queue" | "id">, action: "cancel" | "retry"): Promise<string | null> {
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(job.queue)}/${encodeURIComponent(job.id)}/${action}`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? null : (body.error ?? `Failed (${res.status}).`);
  } catch (err) {
    return err instanceof Error ? err.message : "Failed.";
  } finally {
    void refreshJobs();
  }
}
