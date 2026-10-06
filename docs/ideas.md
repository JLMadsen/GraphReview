# Ideas

Parked ideas worth revisiting — not planned work.

## Grouping modules by imports (Louvain) instead of by folder

GraphReview puts files into modules by folder: everything in `lib/ai/` is
one module, everything in `components/graph/` another, and so on. An
alternative, Louvain community detection, ignores folders and groups files
by who imports whom — files that import each other a lot end up together,
wherever they live.

![The same six files and four imports, grouped by folder on the left and by imports on the right](docs/images/folder-vs-louvain.svg)

Both panels show the same six files and the same four imports; only the
grouping rule differs.

**By folder (in use now).** Files that live together are grouped together.
That's predictable and matches how developers think about the repo. But one
feature (checkout, in coral) is spread across `ui/`, `api/` and `db/`, and
every import crosses from one group to another. In the graph, each crossing
is a line between two boxes — part of why larger apps turn into a tangle.

**By imports (Louvain).** Each group becomes a feature (Checkout, Login),
and most imports stay inside their own group, so far fewer lines are drawn
between boxes. Especially useful for flat `src/` layouts where folders don't
reflect how the code is really organised.

### Why it isn't used

- **Groups can change between runs.** The same code can produce slightly
  different groups each time it's analysed.
- **Groups have no natural names.** A name has to be guessed from the most
  common folder, otherwise it falls back to `cluster-3` and so on.
- **Groups move as imports change.** One new import can move a file to
  another group. Review findings, AI domains and module descriptions all hang
  off the module boundaries, so they would detach — unless there is an
  accept-or-reject screen for a suggested regrouping, which was never built.

The AI domain labeling that exists today works on top of the folder modules
instead: it keeps the predictable folder groups but puts related folders
together into larger domains, getting some of the tidiness on the right
without redrawing any boundaries.

### If it comes back

An implementation existed as an unwired library function (it was never
called from any route or UI) and was removed on 2026-09-23 together with its
two dependencies, `graphology` and `graphology-communities-louvain`. It is
still in git history:

```bash
git show 2b9adb1:lib/analysis/louvain-cluster.ts
```

The design reasoning is in [`docs/DESIGN.md`](docs/DESIGN.md) (§6 and §16).
Bringing it back safely means building the accept-or-reject step first: show
the suggested regrouping, and migrate findings, domains and descriptions only
when the reviewer accepts it.

## Letting the AI decide merge groups, not just name them

Feature merge suggestions are planned to work like this: free heuristics
(matching folder names such as `app/map` + `components/map`, plus imports
between folders) decide *which* folders to merge, and the AI only names
each group and describes what it does. That keeps suggestions cheap and the
same from run to run.

A possible refactor later: give the AI the heuristic matches as hints and
let it decide the grouping itself. That could work better for flat repos
where folder names say little, at the cost of more tokens and groups that
vary between runs.

## Trimming the context sent when naming merge groups

For now the AI naming a merge group gets everything that might help: folder
names and file paths, exported declarations of each file, the imports
between the folders (with counts), a README excerpt, and route/URL hints
(e.g. `app/map` serves `/map`). Tokens aren't a concern yet. Once naming
quality has been seen on real repos, check which of these actually improve
the names and cut the rest.

## The review verdict in the left column (parked 2026-10-06)

Under the diff summary there used to be a verdict block (`components/graph/ReviewSummary.tsx`, still in the repo but unused): "24 need a look" in large type, the per-bucket breakdown ("22 defects · 2 concerns · 6 OK"), and the PR-level "Delivers what it describes?" answer — one word ("Mostly.") with the intent finding's summary, confidence and expandable reasoning.

It was taken out because it showed too much text for what it adds: the dock's severity chips already carry the counts, and the map's badges show where they are. What it was the only home for is the **intent verdict** ("does the PR deliver what it describes") — that finding is now shown nowhere in the UI (it is still produced, stored and exported in the Markdown copy). If it comes back, consider just that part, as one short line: e.g. "Delivers what it describes? Mostly" with the summary on hover. Restoring the old block is one prop: `headline={<ReviewSummary …/>}` on `DiffPanel` in `GraphView.tsx`.

## "Not on the map" in the left column (parked 2026-10-06)

The diff summary used to end with a "Not on the map" section: the diff's files the last analysis doesn't know (added, moved or deleted since it ran — `unmatchedFiles` from diff-impact), each clickable, plus the AI-labelled "added components" for a PR (name, file count, description). It was taken out because in the PR view it repeats the PR map, which already puts every changed file on a card (unknown ones on heuristic cards like "Documentation" or `lib/neo4j`), and it sat below the fold.

What still works without it: the added components are still fetched and drawn as green nodes on the Repo view (`onAddedComponents` → `GraphView`), and the App map's footer still counts files no card holds. If the information is wanted back, the suggestion was a small "new to the graph" tag on those files in the dock's Files tab rather than a separate list. The removed markup is in git history (`DiffSummary` in `components/graph/DiffPanel.tsx`).
