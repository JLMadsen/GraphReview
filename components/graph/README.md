# components/graph

The Graph tab: everything on `/repo/[repoId]/graph`, client-side.
`GraphView.tsx` is the orchestrator — it fetches, holds the selection, and
wires the pieces below together. Wire types shared with the API routes live
in the `*-types.ts` files and `types.ts`; they import nothing server-only, so
client components can use them.

## Layout

Three columns, edge to edge (DESIGN.md §6.4–§6.7), with drag-resizable side
columns (`PanelResizeHandle.tsx`, width remembered per browser):

- **Left** — `DiffPanel.tsx`: pick a PR (any state), two branches, two
  commits (`CommitPicker`) or paste paths; once a check succeeds it folds into
  a summary (the diff as a picker button, author/branch/size lines) with
  `ChecklistPanel.tsx` (the PR prerequisite checks; `ChecklistEditor.tsx` is
  the per-repo editor behind its gear) and `LooksDifferentPanel.tsx` (the
  before/after preview scan) under it. It reports a `DiffTargetMeta` with
  each result: whether the review may start on its own and whether the diff
  is historical.
- **Middle** — the map, with the review dock under it when a diff is
  selected. Two views share one grid cell, both kept mounted once opened
  (the inactive one transparent and `inert`):
  - **App map** (`AppMapView.tsx`, `AppMapCard.tsx`, `useAppMap.ts`,
    `app-map-types.ts`) — the whole codebase as cards at an architecture,
    feature or module level; the default with no diff selected.
  - **PR** (`PrMapCanvas.tsx`, `PrMapNode.tsx`, `usePrMap.ts`,
    `pr-map-types.ts`) — only what the diff touches, one card per *area*.
    Clicking a card selects the area: the dock and the inspector scope to it.
    `pr-areas.ts` (`buildPrAreas`) is what the canvas, the dock and the
    inspector all read — each card's files, lines and findings by bucket, and
    which card a finding belongs to.

  Both draw through `CardFlow.tsx` (React Flow + elkjs: cards measured
  offscreen, laid out and edge-routed by ELK, refit on resize).
  `view-chrome.ts` is the shared frame: one toolbar bar per view, the view
  switch first (passed in as `leading`), the canvas edge to edge under it.
- **Right** — the inspector for what is selected (`AppMapPanel.tsx` for an
  app map card, `PrAreaPanel.tsx` for a PR area or the list of areas), and
  `ChatPanel.tsx` / `usePrChat.ts` under it (about the diff when one is
  selected, about the repo otherwise).

## The review

Backed by `/api/repos/[repoId]/review`: `useReview.ts` auto-runs on an open
PR or branch comparison and polls while findings stream in. `ReviewPanel.tsx`
is the dock — Findings and Files tabs, severity toggles, impact findings
grouped by the declaration they use, keyboard triage (J/K, Enter, R, D),
scoped to the selected area. `review-visuals.ts` is the one place a verdict's
colour, glyph and word are defined. Findings can be resolved/reopened
(`PATCH /api/repos/[repoId]/review/findings/[id]`); a resolved finding counts
as OK everywhere. `ReviewSummary.tsx` (the old verdict block) is unused for
now — see docs/ideas.md.

## Files

`FileDiffModal.tsx` is the one file viewer: any file clicked anywhere opens
it — Diff (`DiffViewer.tsx`, `diff-utils.ts`), File (the whole file at the
diff's head, changed lines marked) and, for JS/TS and Python, Before / after
(`PreviewPanel.tsx`, `usePreview.ts`). With no diff selected it shows the
file as analyzed.

## Removed

The Cytoscape **Repo** view (the whole component graph with layout modes,
domain boxes, impact filters and review halos), its component panel, the
Relabel and Merge suggestions controls that lived in its toolbar, the sample
graph for unanalyzed repos, and the "added components" labelling of a PR's
unknown files were removed on 2026-10-06, and their routes with them
(`label`, `merges/**`, `components/[id]/files`, `diff-impact/added-components`).
The labelling and merge job backends are kept, unused, so the features can
come back. See docs/ideas.md.
