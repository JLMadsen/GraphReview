"use client";

// Hover-to-see-progress for the analyze/review/label spinners.
//
// Each of those three jobs already writes a play-by-play to `docker logs`
// (worker/index.ts's `log()` calls) — this makes the same lines reachable
// from the UI, on demand, without turning them into something the regular
// progress poll has to carry. `?logs=1` on the existing status endpoints
// reads BullMQ's own per-job log (worker/index.ts also mirrors every line
// into `job.log()`), so nothing new needs to be persisted anywhere.
//
// Deliberately built on Base UI's `Tooltip` primitives directly (rather than
// the app's `components/ui/tooltip.tsx` wrapper, whose `Popup` styling — an
// inline `bg-foreground` pill sized for a one-line hint — isn't a fit for a
// scrolling log tail) so the panel escapes any `overflow-hidden` ancestor
// (ReviewPanel's dock is one) via the same portal.

import { useEffect, useRef, useState } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { cn } from "cn";

/** While open, how often to re-fetch — the same cadence as the progress polls this rides alongside. */
const POLL_MS = 1500;

export interface JobLogHoverProps {
  /** The status endpoint to hit, with `logs=1` already merged into its query string. */
  logsUrl: string;
  /** Accessible name for the trigger — required by Base UI's tooltip a11y guidance since the popup itself is hover-only. */
  label: string;
  children: React.ReactNode;
  className?: string;
}

interface LogsResponse {
  logs?: string[];
}

export function JobLogHover({ logsUrl, label, children, className }: JobLogHoverProps) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(logsUrl, { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as LogsResponse | null;
        if (cancelled) return;
        if (!res.ok || !json) {
          setFailed(true);
          return;
        }
        setFailed(false);
        setLogs(json.logs ?? []);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, logsUrl]);

  // Reset so a re-open doesn't briefly show the previous run's tail while
  // the first fetch of the new one is still in flight.
  useEffect(() => {
    if (!open) {
      setLogs(null);
      setFailed(false);
    }
  }, [open]);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, open]);

  return (
    <Tooltip.Root onOpenChange={setOpen}>
      <Tooltip.Trigger
        render={<span className={cn("inline-flex", className)} />}
        aria-label={label}
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="bottom" sideOffset={8} className="z-50">
          <Tooltip.Popup className="w-80 max-w-[min(20rem,90vw)] rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-xl shadow-black/40">
            <div className="mb-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {label}
            </div>
            <div
              ref={scrollRef}
              className="max-h-56 space-y-0.5 overflow-y-auto font-mono text-[10px] leading-relaxed"
            >
              {logs === null && !failed && (
                <p className="text-muted-foreground">Loading…</p>
              )}
              {failed && <p className="text-muted-foreground">Logs unavailable.</p>}
              {logs && logs.length === 0 && !failed && (
                <p className="text-muted-foreground">No log lines yet.</p>
              )}
              {logs?.map((line, i) => (
                <p key={i} className="whitespace-pre-wrap break-words text-foreground/90">
                  {line}
                </p>
              ))}
            </div>
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
