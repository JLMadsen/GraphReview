"use client";

// A map's key, folded behind one small "Legend" button so it doesn't sit on
// the canvas (or wrap a status bar) all the time. Opens upwards from a
// bottom bar, downwards from a canvas corner; closes on an outside click
// or Escape.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Shapes } from "lucide-react";
import { cn } from "cn";

export function LegendToggle({
  children,
  placement = "up",
  className,
}: {
  children: ReactNode;
  /** "up" for a bottom bar (panel above, left-aligned); "down" for a top corner (panel below, right-aligned). */
  placement?: "up" | "down";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1 rounded-sm px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground",
          placement === "down" && "border border-border bg-background/70 backdrop-blur-sm",
          open && "text-foreground"
        )}
      >
        <Shapes className="size-3" aria-hidden />
        Legend
      </button>
      {open && (
        <span
          className={cn(
            "absolute z-20 flex w-max max-w-64 flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground shadow-md",
            placement === "up" ? "bottom-full left-0 mb-1.5" : "top-full right-0 mt-1.5"
          )}
        >
          {children}
        </span>
      )}
    </span>
  );
}
