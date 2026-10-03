# lib/preview

> The before/after preview's sandbox: runs the functions and components a
> change touched, at both ends of the diff, in throwaway Docker containers.
> Design and limits: [`docs/DESIGN.md` §6.9](../../docs/DESIGN.md).

## Scope

- Everything that touches PR code at runtime lives here, and only runs in
  the worker (through `lib/jobs/preview.ts`). The app imports nothing from
  this folder except the pure `types.ts` and `runtime.ts`.
- PR code never runs in the app or worker process. It only runs inside the
  containers `sandbox.ts` starts.

## Modules

| file | what it owns |
|---|---|
| `types.ts` | Shared shapes: harness output, the job's `PreviewResult`, the status DTO, and the component scan (`PreviewScanResult`, `PreviewScanDTO`). Type-only. |
| `runtime.ts` | `runtimeForPath`: which runtime (`node` / `python`) a file needs, or `null`. Pure, so the UI can use it. |
| `symbols.ts` | `detectChangedSymbols`: tree-sitter over both versions of the file; changed, added and removed top-level declarations, which of them can run, and why the rest can't. |
| `checkout.ts` | Writing a whole tree at a commit with a throwaway index (works on the read-only local-repo mount), reading a file at a commit, the merge base, and the project root (nearest `package.json` / `pyproject.toml`). |
| `sandbox.ts` | The `docker` CLI wrapper: images, the harness volume, dependency volumes keyed by lockfile, and the offline run container. Files travel by `docker cp`, never by bind mount. |
| `harness/node-harness.mjs` | Runs inside the Node container: esbuild bundle with stubbed missing imports, call the functions or SSR the components (inside a stand-in Next.js router when the repo uses Next), run the global CSS through the repo's PostCSS. |
| `harness/python-harness.py` | Runs inside the Python container: import by dotted name, call each function on a deep copy of its arguments, `repr()` the results. |

## Trying it by hand

Docker must be running; without it `getDockerStatus()` reports why and the UI disables previews. The harness volume and dependency volumes are
created on first use, and they're named `graphreview-preview-*`, so they're
easy to remove:

```bash
docker volume ls --filter name=graphreview-preview
```
