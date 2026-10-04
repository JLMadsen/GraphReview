# Agent instructions

## Running the app

GraphReview is one Node process: `npm run dev` starts the Next.js dev server
*and* the background job workers (instrumentation.ts → worker/index.ts).
There is no separate worker, database server or queue to start. Dev data
lives in `.data/` (SQLite file, clone cache, generated credential key);
delete that folder to start from scratch.

Requires Node.js 22.13+ (`node:sqlite`).

## Building while the user's copy runs

The user may be running GraphReview from this checkout (`npx graphreview`
linked to it, or `npm start`), which serves `.next/`. `npm run dev` is safe:
it always builds into `.next-dev/` (next.config.mjs). Never `npm run build`
into `.next/` while the user's copy is running — check `~/.graphreview/instance.json` for a live
pid. To verify a build, use a separate folder:

```bash
GRAPHREVIEW_DIST_DIR=.next-check npx next build
```

`npm pack` builds into `.next/` (prepack), so only pack when the user's copy
isn't running from here, and tell them to restart it afterwards.

## Packaging

The app ships as an npm package run with `npx graphreview`
(bin/graphreview.mjs → `next start`). `npm pack` builds and packs it; test a
change to the launcher or the `files` list by installing that tarball into
an empty folder and running `npx graphreview --no-open --data <tmp dir>`.
Never `npm publish` without the user asking. `npm pack` packs the working
copy, not the commit: `bin/graphreview.mjs` must have LF line endings (a CRLF
shebang breaks it on macOS/Linux) — `git checkout -- bin` restores them.

Releases are cut with `npm run release` on Master: it bumps the patch number
(versions are a plain counter, not semver), tags and pushes. The `v*` tag
starts .github/workflows/release.yml, which builds the Linux x64 offline bundle
(.github/scripts/offline-bundle.sh), starts it with no network
(offline-smoke-test.sh), creates the GitHub Release and publishes to npm
(NPM_TOKEN secret). Never push a release tag without the user asking. To try
the bundle locally, run both scripts inside a `node:22-bookworm` container
on a copy of the working tree, without node_modules or `.next*`.
