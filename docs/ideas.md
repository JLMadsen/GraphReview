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
