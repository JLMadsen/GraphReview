// The frame every Graph-tab view (App map, Repo, PR) draws itself in, so the
// three read as one surface: a single toolbar bar across the column — the
// view switch first (GraphView passes it in as `leading`), then the view's
// own controls — and the canvas edge to edge under it, no rounded box.

/** The toolbar bar above a view's canvas. */
export const VIEW_TOOLBAR =
  "flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-card px-4 py-1.5";

/** A card map's canvas pane (passed to `CardFlow`). */
export const VIEW_CANVAS = "bp-grid relative min-h-[220px] flex-1 overflow-hidden";
