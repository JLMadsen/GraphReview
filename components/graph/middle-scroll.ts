// Middle-click autoscroll for the code views, the way Windows does it: press
// the middle button and move the mouse, and the view scrolls toward the
// pointer, faster the further it is from where the button went down.
// Release after moving to stop; a click without moving keeps it scrolling
// until the next click (or Escape).
//
// The browser's own autoscroll latches onto the nearest scrollable box — in
// the code views that is the line table's horizontal scroller, so moving down
// did nothing. This one scrolls each axis on its own nearest scroller: down
// moves the panel, sideways moves the long lines.
//
// Use: `onMouseDown={startMiddleScroll}` on a code view or its container.

import type { MouseEvent as ReactMouseEvent } from "react";

/** Pixels the pointer can drift from the origin before anything scrolls. */
const DEAD_ZONE = 10;
/** A middle press shorter than this, without moving, toggles the sticky mode. */
const CLICK_MS = 250;

let active = false;

function scrollerFor(start: Element, axis: "x" | "y"): Element | null {
  for (let el: Element | null = start; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    const overflow = axis === "x" ? style.overflowX : style.overflowY;
    const room = axis === "x" ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    if (room > 1 && (overflow === "auto" || overflow === "scroll" || overflow === "overlay")) return el;
  }
  const page = document.scrollingElement;
  if (!page) return null;
  const room = axis === "x" ? page.scrollWidth - page.clientWidth : page.scrollHeight - page.clientHeight;
  return room > 1 ? page : null;
}

/** Scroll speed in px/s for a pointer `d` px from the origin along one axis. */
function speed(d: number): number {
  const past = Math.abs(d) - DEAD_ZONE;
  return past <= 0 ? 0 : Math.sign(d) * Math.min(6000, past ** 1.35 * 1.6);
}

function marker(x: number, y: number, axes: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    "position:fixed;z-index:2147483647;pointer-events:none;width:26px;height:26px;margin:-13px 0 0 -13px;" +
    "border-radius:999px;border:1px solid var(--border);background:var(--popover);color:var(--muted-foreground);" +
    "box-shadow:0 2px 8px rgb(0 0 0 / 40%);display:flex;align-items:center;justify-content:center;" +
    `left:${x}px;top:${y}px`;
  const arrows = [axes.includes("y") ? "M13 4l-3 4h6zM13 22l-3-4h6z" : "", axes.includes("x") ? "M4 13l4-3v6zM22 13l-4-3v6z" : ""].join("");
  el.innerHTML =
    `<svg width="26" height="26" viewBox="0 0 26 26" fill="currentColor"><path d="${arrows}"/>` +
    `<circle cx="13" cy="13" r="1.6"/></svg>`;
  document.body.appendChild(el);
  return el;
}

export function startMiddleScroll(event: ReactMouseEvent<Element>) {
  if (event.button !== 1 || active) return;
  const target = event.target as Element;
  // A middle click on a link opens it in a new tab; leave that, and text fields, alone.
  if (target.closest("a[href], input, textarea, select, [contenteditable='true']")) return;
  const xScroller = scrollerFor(target, "x");
  const yScroller = scrollerFor(target, "y");
  if (!xScroller && !yScroller) return;
  event.preventDefault();
  active = true;

  const origin = { x: event.clientX, y: event.clientY };
  const pointer = { ...origin };
  const pressedAt = performance.now();
  let moved = false;
  let sticky = false;
  const carry = { x: 0, y: 0 };
  const axes = `${xScroller ? "x" : ""}${yScroller ? "y" : ""}`;
  const dot = marker(origin.x, origin.y, axes);
  const root = document.documentElement;
  root.dataset.middleScroll = axes === "y" ? "ns" : axes === "x" ? "ew" : "all";

  let frame = 0;
  let last = performance.now();
  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (xScroller) {
      carry.x += speed(pointer.x - origin.x) * dt;
      const step = Math.trunc(carry.x);
      if (step) {
        xScroller.scrollLeft += step;
        carry.x -= step;
      }
    }
    if (yScroller) {
      carry.y += speed(pointer.y - origin.y) * dt;
      const step = Math.trunc(carry.y);
      if (step) {
        yScroller.scrollTop += step;
        carry.y -= step;
      }
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  const stop = () => {
    active = false;
    cancelAnimationFrame(frame);
    dot.remove();
    delete root.dataset.middleScroll;
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("wheel", stop, true);
    window.removeEventListener("blur", stop);
  };
  const onMove = (e: MouseEvent) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (Math.abs(e.clientX - origin.x) > DEAD_ZONE || Math.abs(e.clientY - origin.y) > DEAD_ZONE) moved = true;
  };
  const onUp = (e: MouseEvent) => {
    if (e.button !== 1 || sticky) return;
    if (!moved && performance.now() - pressedAt < CLICK_MS) sticky = true;
    else stop();
  };
  // In sticky mode the next click only stops the scroll — it doesn't press whatever is under it.
  const onDown = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const swallow = (c: MouseEvent) => {
      c.preventDefault();
      c.stopPropagation();
    };
    window.addEventListener(e.button === 0 ? "click" : "auxclick", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener(e.button === 0 ? "click" : "auxclick", swallow, true), 400);
    stop();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
    }
    stop();
  };
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("mousedown", onDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("wheel", stop, { capture: true, passive: true });
  window.addEventListener("blur", stop);
}
