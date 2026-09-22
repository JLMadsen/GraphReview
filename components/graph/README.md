# components/graph

> `components/graph/` Cytoscape wrapper, layout switcher, sidebar

From DESIGN.md §3 and §6.1:

> **Graph rendering — Cytoscape.js.** ...a layout registry that maps
> directly onto the required layout modes (`fcose`/`cose-bilkent` → Force,
> `circle` → Circle, `grid` → Grid), and a plugin ecosystem that covers the
> rest of the UI spec off the shelf: `cytoscape-navigator` (minimap),
> `cytoscape-popper` (tooltips/annotation popovers), `cytoscape-expand-collapse`
> (drill down from component into files).
>
> Rendering-wise, this maps directly onto Cytoscape's compound-node model
> (`cytoscape-expand-collapse`)... tiers are nested/collapsible compound
> nodes rather than three separate graphs, so a reviewer can start at the
> domain view and expand down to modules and files in place.

## Scope

- A client-component Cytoscape.js wrapper (this can never be a server
  component — Cytoscape needs a DOM canvas).
- Layout switcher: Force (`cytoscape-fcose`), Circle, Grid, Hierarchical
  (`cytoscape-elk`, added post-v1 as a fourth "another view" option
  alongside the original three — top-to-bottom layered layout, good for
  reading `DEPENDS_ON` direction).
- The Graph tab's sidebar panels: diff selection (pick a PR, or two refs)
  and, when a node is clicked, that component's file list
  (`ComponentFilesPanel`, backed by
  `GET /api/repos/[repoId]/components/[componentId]/files`) with that
  component's AI findings above it.
- The AI review surface (§9, §10), backed by
  `/api/repos/[repoId]/review`: `useReview` (auto-run on a PR/ref target,
  then poll while the job streams findings in), `ReviewPanel` (the
  full-width dock under the canvas — progress, cost counter, filter chips,
  findings grouped by component) and `review-visuals.ts` (the one place the
  four `intentMatch` colours/glyphs are defined, shared by the panel, the
  sidebar and the canvas markers).
- The AI labeling surface (§6.1), backed by `/api/repos/[repoId]/label`:
  `useLabels` (GET on mount, POST only when the user presses the button,
  then poll while the job runs and refetch the graph when it finishes) and
  `LabelsControl` (the toolbar's "Generate labels" / "Re-generate" button
  with its live phase + `done/total` + cost counter, the domain/described
  counts, the Collapse-all/Expand-all toggle once domain boxes exist, and
  the "AI not configured — Settings" note that replaces the button rather
  than offering an action that cannot work). Its wire types live in
  `label-types.ts`. Labeling is what produces the compound boxes: until it
  has run, no node has a parent and the canvas is flat.
- Three *composing* highlight layers on the canvas, each owning disjoint
  Cytoscape style properties so none can overwrite another: diff impact
  (node `background-color`), selection (`border-*`/`opacity`/`z-index`) and
  AI review markers (`underlay-*`). The one deliberate interaction is that
  a faded node also fades its marker — see `buildStylesheet`.
- No minimap. `cytoscape-navigator` was removed (plugin, dependency, CSS and
  container): it cost a permanently-occupied corner of the canvas and a
  second render pass of the whole graph on every pan/zoom, and the §3
  "minimap" line below predates the tab actually being used on a real
  100+ node repo, where it was clutter rather than navigation.
- Tooltips/annotation popovers (`cytoscape-popper`) for `Finding`
  annotations (§9), and compound-node expand/collapse
  (`cytoscape-expand-collapse`) for the domain → module → file drill-down
  (§6.1).

The wrapper (`GraphCanvas`), its orchestrator (`GraphView`) and both
sidebar panels are implemented against real `lib/neo4j`-backed data;
`cytoscape-popper` annotation popovers for `Finding`s (§9) are still
follow-up work.

### Compound (domain) boxes across the four layouts

Force (`fcose`) and Hierarchical (ELK) understand compound nodes natively —
ELK needs `elk.hierarchyHandling: "INCLUDE_CHILDREN"`, without which it lays
each box out as an isolated drawing and routes every cross-domain edge
around the outside. Circle and Grid do **not**: they place every node
independently and leave the boxes to be drawn around whatever ended up
inside them, so the canvas passes them a `sort` comparator that keeps
siblings adjacent, making each domain a contiguous arc or block instead of
a pile of overlapping rectangles.

A domain box owns no files and no `DEPENDS_ON` edges of its own, so it is
excluded from the impact legend's counts, never dimmed by an impact filter
or by the selection fade, and selecting one lights up its member modules and
the edges between them (rather than fading the entire graph, which is what
the module rule would do to a node with no edges).
