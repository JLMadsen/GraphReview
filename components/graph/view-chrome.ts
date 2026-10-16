// The frame every Graph-tab view (App map, API, Infra, Data, Files, PR) draws
// itself in, so they read as one surface: GraphView's view tabs across the
// column, the active view's own toolbar directly under them (tinted, so it
// reads as the inside of the selected tab), and the canvas edge to edge
// under that, no rounded box.

/** The toolbar bar above a view's canvas — the second row under the view tabs. */
// No vertical padding: its buttons, fields and segmented switches run from
// the bar's top edge to its bottom as bordered cells (globals.css,
// `.view-toolbar`), while plain text in it stays centred.
export const VIEW_TOOLBAR =
  "view-toolbar @container flex min-h-9 shrink-0 flex-wrap items-stretch gap-x-3 border-b border-border bg-secondary/40 px-4";

/** A card map's canvas pane (passed to `CardFlow`). */
export const VIEW_CANVAS = "bp-grid relative min-h-[220px] flex-1 overflow-hidden";
