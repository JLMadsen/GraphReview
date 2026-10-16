"use client";

// The pieces a job is shown with (DESIGN.md §6.20): its log tail, its
// actions, and the inline queued / failed states the views that start jobs
// show where the user is already looking (§4).

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LoaderCircle, RotateCw, Settings, Square, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { jobAction, refreshJobs, useMarkSeen } from "./store";
import type { JobDto } from "./types";

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** The job's newest log lines, re-read every ~1.5 s while it runs. */
export function JobLogs({ job, className }: { job: Pick<JobDto, "queue" | "id" | "state">; className?: string }) {
  const [logs, setLogs] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const live = job.state === "running" || job.state === "queued";

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(job.queue)}/${encodeURIComponent(job.id)}/logs`, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as { logs?: string[] } | null;
        if (cancelled) return;
        if (!res.ok || !body) setFailed(true);
        else {
          setFailed(false);
          setLogs(body.logs ?? []);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    const timer = live ? setInterval(() => void load(), 1500) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [job.queue, job.id, live]);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs]);

  return (
    <div
      ref={ref}
      className={cn(
        "max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border/60 bg-background/60 p-2 font-mono text-[10px] leading-relaxed",
        className
      )}
    >
      {logs === null && !failed && <p className="text-muted-foreground">Loading…</p>}
      {failed && <p className="text-muted-foreground">Logs unavailable.</p>}
      {logs && logs.length === 0 && !failed && <p className="text-muted-foreground">No log lines.</p>}
      {logs?.map((line, i) => (
        <p key={i} className="whitespace-pre-wrap break-words text-foreground/85">
          {line}
        </p>
      ))}
    </div>
  );
}

/**
 * Cancel (review, app map) and Run again — or the setting a config failure
 * needs. `runAgain` replaces the jobs API's retry, for a view whose own
 * re-run keeps its state in step.
 */
export function JobActions({ job, onDone, runAgain }: { job: JobDto; onDone?: () => void; runAgain?: () => void }) {
  const [busy, setBusy] = useState<"cancel" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: "cancel" | "retry") => {
    if (action === "retry" && runAgain) {
      runAgain();
      void refreshJobs();
      return;
    }
    setBusy(action);
    setError(await jobAction(job, action));
    setBusy(null);
    onDone?.();
  };

  const showRetry = job.retryable;
  if (!job.cancellable && !showRetry && !job.configIssue) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {job.cancellable && (
        <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void act("cancel")}>
          {busy === "cancel" ? <LoaderCircle className="animate-spin" aria-hidden /> : <Square aria-hidden />}
          Cancel
        </Button>
      )}
      {job.configIssue ? (
        <Link
          href={job.configIssue.href}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-foreground hover:bg-secondary"
        >
          <Settings className="size-3" aria-hidden />
          {job.configIssue.label}
        </Link>
      ) : (
        showRetry && (
          <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void act("retry")}>
            {busy === "retry" ? <LoaderCircle className="animate-spin" aria-hidden /> : <RotateCw aria-hidden />}
            Run again
          </Button>
        )
      )}
      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </div>
  );
}

/** "Queued, 2nd in the review queue." */
export function JobQueuedNote({ job, className }: { job: JobDto | undefined; className?: string }) {
  if (job?.state !== "queued" || !job.positionText) return null;
  return <span className={cn("text-muted-foreground", className)}>Queued, {job.positionText}</span>;
}

/**
 * A failed (or cancelled) job, inline: its reason, its logs behind a toggle
 * and Run again. Showing it marks the failure seen (§2).
 */
export function JobFailureInline({
  job,
  className,
  onRetry,
  runAgain,
}: {
  job: JobDto | undefined;
  className?: string;
  /** Called after the jobs API re-enqueued it. */
  onRetry?: () => void;
  /** Replaces the jobs API's retry (see `JobActions`). */
  runAgain?: () => void;
}) {
  const [showLogs, setShowLogs] = useState(false);
  useMarkSeen(job);
  if (!job || (job.state !== "failed" && job.state !== "cancelled")) return null;
  const cancelled = job.state === "cancelled";
  return (
    <div
      className={cn(
        "space-y-1.5 rounded-md border p-2 text-xs",
        cancelled ? "border-border bg-secondary/40 text-muted-foreground" : "border-destructive/30 bg-destructive/10",
        className
      )}
      data-job-failure={job.id}
    >
      <div className="flex items-start gap-1.5">
        {!cancelled && <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />}
        <p className={cn("min-w-0 flex-1 break-words", !cancelled && "text-destructive")}>
          {cancelled ? `${job.kind} cancelled.` : `${job.kind} failed: ${job.failedReason ?? "unknown error"}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <JobActions job={job} onDone={onRetry} runAgain={runAgain} />
        <button
          type="button"
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setShowLogs((v) => !v)}
        >
          {showLogs ? "Hide logs" : "Logs"}
        </button>
      </div>
      {showLogs && <JobLogs job={job} />}
    </div>
  );
}
