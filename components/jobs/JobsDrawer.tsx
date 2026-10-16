"use client";

// The header's jobs indicator and the Jobs drawer (DESIGN.md §6.20 §2):
// every background job across repos, Now (running, then queued) and Recent
// (failed, done, cancelled — newest first), each row expandable to its
// inferred trigger and log. The indicator is always there: a plain "Jobs"
// when idle.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ban, Check, ChevronRight, Clock, ListTodo, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { JobActions, JobLogs, formatAgo, formatDuration } from "./JobParts";
import { markJobsSeen, setJobsDrawerOpen, toggleJobsDrawer, useJobs, useJobsDrawerOpen } from "./store";
import type { JobDto } from "./types";

type Filter = "all" | "active" | "failed" | "repo";

function repoIdFromPath(pathname: string): string | null {
  const m = /^\/repo\/([^/]+)/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Re-renders every second while `on`, for elapsed times. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function JobsIndicator() {
  const jobs = useJobs();
  const open = useJobsDrawerOpen();
  // Always shown (a plain "Jobs" when idle), so Recent is one click away.
  const running = jobs?.running ?? 0;
  const queued = jobs?.queued ?? 0;
  const unseenFailed = jobs?.unseenFailed ?? 0;
  const parts = [running ? `${running} running` : null, queued ? `${queued} queued` : null].filter(Boolean);
  return (
    <button
      type="button"
      onClick={toggleJobsDrawer}
      aria-expanded={open}
      aria-label="Jobs"
      data-jobs-indicator
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-secondary/60",
        open && "bg-secondary"
      )}
    >
      {running + queued > 0 ? (
        <>
          <LoaderCircle className="size-3.5 animate-spin text-warning" aria-hidden />
          <span className="text-muted-foreground">{parts.join(" · ")}</span>
        </>
      ) : (
        <>
          <ListTodo className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Jobs</span>
        </>
      )}
      {unseenFailed > 0 && (
        <span className="rounded-full bg-destructive/15 px-1.5 py-px font-medium text-destructive">{unseenFailed} failed</span>
      )}
    </button>
  );
}

const STATE_ICON = {
  running: <LoaderCircle className="size-3.5 animate-spin text-warning" aria-label="Running" />,
  queued: <Clock className="size-3.5 text-muted-foreground" aria-label="Queued" />,
  failed: <TriangleAlert className="size-3.5 text-destructive" aria-label="Failed" />,
  done: <Check className="size-3.5 text-success" aria-label="Done" />,
  cancelled: <Ban className="size-3.5 text-muted-foreground" aria-label="Cancelled" />,
} as const;

function secondLine(job: JobDto, now: number, open: boolean): React.ReactNode {
  switch (job.state) {
    case "running":
      return (
        <>
          {job.progress && <span className="min-w-0 truncate">{job.progress}</span>}
          {job.startedAt && <span className="shrink-0 tabular-nums">{formatDuration(now - job.startedAt)}</span>}
        </>
      );
    case "queued":
      return (
        <>
          <span>{job.positionText ?? "Queued"}</span>
          {job.retrying && <span className="min-w-0 truncate text-warning">retrying after: {job.retrying}</span>}
        </>
      );
    case "failed":
      return (
        <>
          {/* Expanded, the whole reason shows below instead. */}
          {!open && <span className="min-w-0 truncate text-destructive">{job.failedReason ?? "Failed"}</span>}
          {job.startedAt && job.finishedAt && <span className="shrink-0">{formatDuration(job.finishedAt - job.startedAt)}</span>}
        </>
      );
    case "done":
    case "cancelled":
      return (
        <>
          <span className="min-w-0 truncate">{job.state === "cancelled" ? "Cancelled" : (job.result ?? "Done")}</span>
          {job.startedAt && job.finishedAt && <span className="shrink-0">{formatDuration(job.finishedAt - job.startedAt)}</span>}
          {job.finishedAt && <span className="shrink-0">{formatAgo(job.finishedAt, now)}</span>}
        </>
      );
  }
}

function JobRow({ job, now }: { job: JobDto; now: number }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) markJobsSeen([job]);
  }, [open, job]);
  return (
    <li className="border-b border-border/50 last:border-b-0" data-job-row={job.id}>
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Collapse" : "Expand"}
          className="mt-0.5 rounded text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
        </button>
        <span className="mt-0.5 shrink-0">{STATE_ICON[job.state]}</span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
            <span className="shrink-0 font-medium">{job.kind}</span>
            {job.href ? (
              <Link href={job.href} onClick={() => setJobsDrawerOpen(false)} className="min-w-0 truncate text-muted-foreground hover:text-foreground hover:underline">
                {[job.repoName, job.target].filter(Boolean).join(" · ")}
              </Link>
            ) : (
              <span className="min-w-0 truncate text-muted-foreground">{[job.repoName, job.target].filter(Boolean).join(" · ")}</span>
            )}
            {job.unseen && <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-label="Not seen yet" />}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">{secondLine(job, now, open)}</div>
          {open && (
            <div className="mt-2 space-y-2">
              {job.trigger && (
                <p className="text-[11px] text-muted-foreground">
                  Triggered by: <span className="text-foreground/85">{job.trigger}</span>
                </p>
              )}
              {job.state === "failed" && job.failedReason && <p className="break-words text-[11px] text-destructive">{job.failedReason}</p>}
              <JobActions job={job} />
              <JobLogs job={job} />
            </div>
          )}
        </div>
        {!open && (job.cancellable || job.retryable || job.configIssue) && (
          <div className="shrink-0">
            <JobActions job={job} />
          </div>
        )}
      </div>
    </li>
  );
}

export function JobsDrawer() {
  const open = useJobsDrawerOpen();
  const jobs = useJobs();
  const pathname = usePathname() ?? "/";
  const repoId = repoIdFromPath(pathname);
  const [filter, setFilter] = useState<Filter>("all");
  const now = useNow(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setJobsDrawerOpen(false);
    };
    // A press outside the drawer closes it; the indicator toggles it itself.
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.("[data-jobs-drawer], [data-jobs-indicator]")) return;
      setJobsDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const effective = filter === "repo" && !repoId ? "all" : filter;
  const { current, recent } = useMemo(() => {
    const list = (jobs?.jobs ?? []).filter((j) =>
      effective === "active"
        ? j.state === "running" || j.state === "queued"
        : effective === "failed"
          ? j.state === "failed"
          : effective === "repo"
            ? j.repoId === repoId
            : true
    );
    return {
      current: list.filter((j) => j.state === "running" || j.state === "queued"),
      recent: list.filter((j) => j.state !== "running" && j.state !== "queued"),
    };
  }, [jobs, effective, repoId]);

  if (!open) return null;
  const chips: Array<[Filter, string]> = [
    ["all", "All"],
    ["active", "Active"],
    ["failed", "Failed"],
    ...(repoId ? ([["repo", "This repo"]] as Array<[Filter, string]>) : []),
  ];

  return (
    <div
      role="dialog"
      aria-label="Jobs"
      data-jobs-drawer
      className="fixed top-12 right-3 z-40 flex max-h-[min(36rem,calc(100vh-4rem))] w-[min(30rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-b-lg border border-t-0 border-border bg-popover text-popover-foreground shadow-xl shadow-black/40"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[13px] font-semibold">Jobs</span>
        <div className="flex items-center gap-1">
          {chips.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              aria-pressed={effective === id}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                effective === id ? "border-brand/50 bg-brand-muted text-foreground" : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setJobsDrawerOpen(false)} aria-label="Close" className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!jobs && <p className="px-3 py-4 text-xs text-muted-foreground">Loading…</p>}
        {jobs && current.length === 0 && recent.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">No jobs{effective === "all" ? " — nothing ran recently." : " match."}</p>
        )}
        {current.length > 0 && (
          <section>
            <h3 className="bg-secondary/40 px-3 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Now</h3>
            <ul>
              {current.map((job) => (
                <JobRow key={`${job.queue}:${job.id}`} job={job} now={now} />
              ))}
            </ul>
          </section>
        )}
        {recent.length > 0 && (
          <section>
            <h3 className="bg-secondary/40 px-3 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Recent</h3>
            <ul>
              {recent.map((job) => (
                <JobRow key={`${job.queue}:${job.id}`} job={job} now={now} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
