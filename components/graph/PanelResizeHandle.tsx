"use client";

// Drag-to-resize for the Graph tab's two side panels (diff controls on the
// left, component files on the right). Only active at `lg` and up, where
// the panels sit beside the canvas; below that they stack full-width and
// the handle is hidden.
//
// The chosen width is remembered per panel in localStorage — a per-viewer
// convenience, so every read/write is wrapped: a private window or blocked
// storage just means the default width each time.

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "cn";

function readStoredWidth(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function storeWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(Math.round(width)));
  } catch {
    // Storage unavailable — the width just won't persist.
  }
}

/**
 * A panel width in px, clamped to `[min, max]`, restored from localStorage
 * after mount (not during render, so server and client markup agree).
 */
export function usePanelWidth(
  storageKey: string,
  defaultWidth: number,
  min: number,
  max: number
): [number, (width: number) => void] {
  const [width, setWidthState] = useState(defaultWidth);

  useEffect(() => {
    const stored = readStoredWidth(storageKey);
    if (stored !== null) setWidthState(Math.min(max, Math.max(min, stored)));
  }, [storageKey, min, max]);

  const setWidth = useCallback(
    (next: number) => {
      const clamped = Math.min(max, Math.max(min, next));
      setWidthState(clamped);
      storeWidth(storageKey, clamped);
    },
    [storageKey, min, max]
  );

  return [width, setWidth];
}

export interface PanelResizeHandleProps {
  /** Which edge of its panel the handle sits on: dragging away from the panel widens it. */
  edge: "left" | "right";
  width: number;
  onResize: (width: number) => void;
  label: string;
}

export function PanelResizeHandle({ edge, width, onResize, label }: PanelResizeHandleProps) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = event.clientX - drag.current.startX;
    onResize(drag.current.startWidth + (edge === "right" ? delta : -delta));
  };

  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
    const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";
    if (event.key === grow) onResize(width + step);
    else if (event.key === shrink) onResize(width - step);
    else return;
    event.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title={`${label} — drag, or use the arrow keys`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      className={cn(
        "group absolute inset-y-0 z-10 hidden w-3 cursor-col-resize touch-none outline-none lg:block",
        edge === "right" ? "-right-1.5" : "-left-1.5"
      )}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
          dragging
            ? "bg-brand"
            : "bg-transparent group-hover:bg-brand/60 group-focus-visible:bg-brand"
        )}
        aria-hidden
      />
    </div>
  );
}
