"use client";

// The "Pick a diff" card's backdrop: a grid of monospace characters that keep
// changing, with the ones inside the GraphReview mark (app/icon.svg) lit in
// the mark's own colours, plain ones around it fading out with distance,
// and a soft glow following the pointer. Purely
// decorative — a canvas behind the form, no pointer events of its own (it
// listens on its parent), still under `prefers-reduced-motion`.

import { useEffect, useRef } from "react";

const GLYPHS = "{}[]()<>=+-*/;:.,_|&!?#$%01234567890abcdefxyz";
const CELL_W = 9;
const CELL_H = 14;
const FONT = '11px var(--font-mono), ui-monospace, monospace';
/** Share of cells that swap glyph each tick. */
const CHURN = 0.04;
const TICK_MS = 70;
const GLOW_RADIUS = 90;
/** Plain glyphs' opacity around the mark, and how far (in mark sizes from its centre) they fade out. */
const HALO_PEAK = 0.2;
const HALO_REACH = 2.6;

/**
 * Draws the mark (minus its navy tile) into a 32×32 space on `ctx`, so it can
 * be rasterised at grid resolution and each cell read back as a colour.
 */
function drawMark(ctx: CanvasRenderingContext2D) {
  ctx.lineCap = "round";
  ctx.fillStyle = "rgba(86,123,247,0.55)";
  ctx.beginPath();
  ctx.roundRect(4, 4, 16.5, 16.5, 4);
  ctx.fill();
  ctx.strokeStyle = "#9db6ff";
  ctx.lineWidth = 1.4;
  ctx.setLineDash([2, 1.5]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(8.5, 8.5);
  ctx.lineTo(15.5, 15.5);
  ctx.moveTo(8.5, 15.5);
  ctx.lineTo(15.5, 15.5);
  ctx.moveTo(8.5, 8.5);
  ctx.lineTo(8.5, 15.5);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  for (const [x, y, r] of [
    [8.5, 8.5, 2.1],
    [8.5, 15.5, 2.1],
    [15.5, 15.5, 2.4],
  ]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(242,184,75,0.5)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(24.5, 24.5, 5.2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "#f2b84b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(15.5, 15.5);
  ctx.lineTo(21.9, 21.9);
  ctx.stroke();
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(24.5, 24.5, 2.7, 0, Math.PI * 2);
  ctx.stroke();
}

interface Cell {
  glyph: string;
  /** Logo colour as "r,g,b", or null outside the mark. */
  rgb: string | null;
  /** Coverage of the mark in this cell, 0–1. */
  weight: number;
  /** Opacity of a plain (non-mark) glyph: highest around the mark, fading to 0 with distance. */
  halo: number;
}

function randomGlyph() {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
}

/** Rasterises the mark onto a `cols × rows` grid, centred and as large as fits. */
function buildCells(cols: number, rows: number): Cell[] {
  const off = document.createElement("canvas");
  off.width = cols;
  off.height = rows;
  const octx = off.getContext("2d", { willReadFrequently: true });
  const cells: Cell[] = [];
  let data: Uint8ClampedArray | null = null;
  // The mark's centre and size in canvas pixels, for the halo's falloff.
  let cx = 0;
  let cy = 0;
  let size = 1;
  // A hidden or collapsed panel measures 0 — getImageData throws on that.
  if (octx && cols > 0 && rows > 0) {
    // Cells are taller than wide: squash x so the mark keeps its proportions.
    // The form sits at the top, so the mark goes in the open space below it:
    // as wide as the panel allows, centred at 60% of the height.
    const w = cols * CELL_W;
    const h = rows * CELL_H;
    const sizePx = Math.min(w * 0.82, h * 0.55, 420);
    const top = Math.min(Math.max(h * 0.6 - sizePx / 2, 0), h - sizePx);
    const sx = sizePx / CELL_W / 32;
    const sy = sizePx / CELL_H / 32;
    octx.translate((cols - 32 * sx) / 2, top / CELL_H);
    cx = w / 2;
    cy = top + sizePx / 2;
    size = sizePx;
    octx.scale(sx, sy);
    drawMark(octx);
    data = octx.getImageData(0, 0, cols, rows).data;
  }
  for (let i = 0; i < cols * rows; i++) {
    const a = data ? data[i * 4 + 3] / 255 : 0;
    // Distance from the mark's centre in mark sizes: full strength out to
    // its edge, gone by HALO_REACH sizes away (smoothstep in between).
    const dx = ((i % cols) + 0.5) * CELL_W - cx;
    const dy = (Math.floor(i / cols) + 0.5) * CELL_H - cy;
    const t = Math.min(Math.max((Math.hypot(dx, dy) / size - 0.4) / (HALO_REACH - 0.4), 0), 1);
    cells.push({
      glyph: randomGlyph(),
      rgb: a > 0.08 && data ? `${data[i * 4]},${data[i * 4 + 1]},${data[i * 4 + 2]}` : null,
      weight: a,
      halo: data ? HALO_PEAK * (1 - t * t * (3 - 2 * t)) : 0,
    });
  }
  return cells;
}

export function GlyphField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    // Pointer events come from the picker itself, around the wrapper.
    const host = canvas?.parentElement?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !host || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let cols = 0;
    let rows = 0;
    let cells: Cell[] = [];
    let base = "255,255,255";
    // Pointer in canvas pixels; glow eases towards `target` so it trails softly.
    const pointer = { x: -1e4, y: -1e4, glow: 0, target: 0 };
    let raf = 0;
    let last = 0;

    function resize() {
      if (!canvas || !ctx) return;
      const { width, height } = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(width / CELL_W);
      rows = Math.ceil(height / CELL_H);
      cells = buildCells(cols, rows);
      base = getComputedStyle(canvas).color.match(/\d+(\.\d+)?/g)?.slice(0, 3).join(",") ?? base;
      draw();
    }

    function draw() {
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = FONT;
      ctx.textBaseline = "top";
      const r2 = GLOW_RADIUS * GLOW_RADIUS;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const cell = cells[row * cols + col];
          const x = col * CELL_W;
          const y = row * CELL_H;
          const dx = x + CELL_W / 2 - pointer.x;
          const dy = y + CELL_H / 2 - pointer.y;
          const d2 = dx * dx + dy * dy;
          const near = d2 < r2 ? (1 - Math.sqrt(d2) / GLOW_RADIUS) ** 2 * pointer.glow : 0;
          if (cell.rgb) {
            ctx.fillStyle = `rgba(${cell.rgb},${0.22 + 0.2 * cell.weight + near * 0.55})`;
          } else {
            ctx.fillStyle = `rgba(${base},${cell.halo + near * 0.3})`;
          }
          ctx.fillText(cell.glyph, x + 1, y + 1);
        }
      }
    }

    function frame(now: number) {
      raf = requestAnimationFrame(frame);
      const easing = pointer.glow !== pointer.target;
      if (now - last < TICK_MS && !easing) return;
      if (now - last >= TICK_MS) {
        last = now;
        const swaps = Math.ceil(cells.length * CHURN);
        for (let i = 0; i < swaps; i++) {
          const cell = cells[Math.floor(Math.random() * cells.length)];
          if (cell) cell.glyph = randomGlyph();
        }
      }
      pointer.glow += (pointer.target - pointer.glow) * 0.2;
      if (Math.abs(pointer.target - pointer.glow) < 0.01) pointer.glow = pointer.target;
      draw();
    }

    function onMove(e: PointerEvent) {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.target = 1;
      if (reduced) {
        pointer.glow = 1;
        draw();
      }
    }
    function onLeave() {
      pointer.target = 0;
      if (reduced) {
        pointer.glow = 0;
        draw();
      }
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    if (!reduced) raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  // The wrapper takes the insets (a canvas, being a replaced element, would
  // keep its intrinsic 300×150 instead of stretching between them) and bleeds
  // over the panel's padding to its edges.
  return (
    <div aria-hidden className="pointer-events-none absolute -inset-x-4 -top-3 -bottom-4 -z-10">
      <canvas ref={canvasRef} className="block size-full text-foreground" />
    </div>
  );
}
